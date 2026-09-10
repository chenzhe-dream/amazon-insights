import { createHash, randomUUID } from "node:crypto";
import {
  estimateImageRemarkSeconds,
  IMAGE_REMARK_POLICY_DETAIL,
} from "../../scripts/lib/image-remark-policy.mjs";
import { readSyncJob } from "../../scripts/lib/sync-job-store.mjs";
import { asinsNeedingXydcRepair } from "../../scripts/lib/xydc-repair-readiness";

import type {
  AsinModuleStatus,
  SyncJob,
  SyncJobScope,
} from "../../app/lib/sync-server";
import type {
  ProjectableSyncStage,
  BuildPublicationRecoveryEvidence,
  StageOutputProjection,
  SyncJobRecord,
  SyncJobRepository,
  SyncJobStageRecord,
} from "../db/sync-job-repository";
import { stageOutputPatches } from "./sync-job-worker-handler";
import type {
  SyncProviderReadinessDetail,
  SyncProviderReadinessService,
} from "./sync-provider-readiness-service";

const defaultWholeJobLimit = 4;
const projectableSyncStages = [
  "keywords", "reviews", "sales_trend", "fba", "listing", "category", "traffic",
  "child_sales", "price_strategy", "image_remarks",
] as const;
const STAGE_CONNECTORS = Object.freeze({
  catalog: ["sellerSprite", "sorftime"],
  keywords: ["sif"],
  reviews: ["sorftime"],
  sales_trend: ["sorftime"],
  child_sales: ["sorftime"],
  price_strategy: ["sorftime"],
  fba: ["sorftime"],
  listing: ["sorftime"],
  category: ["sorftime"],
  traffic: ["sif"],
} as const);
const CONNECTOR_DISPLAY_NAMES = Object.freeze({
  sellerSprite: "SellerSprite",
  sif: "SIF",
  sorftime: "Sorftime",
} as const);
type StatusModule = {
  getAsinDataStatus(asins: string[]): AsinModuleStatus[];
  asinsNeedingMcpSync(asins: string[]): AsinModuleStatus[];
  asinsNeedingListingSync(asins: string[]): AsinModuleStatus[];
  asinsNeedingImageRemarksSync(asins: string[]): AsinModuleStatus[];
  asinsNeedingTrafficSync(asins: string[]): AsinModuleStatus[];
  asinsNeedingCatalogSync(asins: string[]): string[];
  countPendingImageRemarks(asins: string[]): number;
  estimateAutoSyncSeconds(
    count: number,
    opts?: {
      catalogCount?: number;
      trafficCount?: number;
      listingCount?: number;
      imageRemarksCount?: number;
    },
  ): number;
  estimateAlexaVocSeconds(count: number): number;
};

type SyncJobServiceDependencies = {
  findXydcRepairAsins?: (asins: readonly string[], marketplace: string) => Promise<string[]>;
  loadStatusModule?: () => Promise<StatusModule>;
  now?: () => string;
  providerReadiness?: Pick<SyncProviderReadinessService, "plan"> | null;
  bypassProviderReadiness?: boolean;
  loadSyncJobMirror?: (jobId: string) => unknown | Promise<unknown>;
};

export class SyncRepairScopeError extends Error {}
export type SyncJobStartInput = SyncJobScope & {
  asins: string[];
  marketplace: string;
  mode?: "repair-incomplete";
  parentJobId?: string;
};
export type SyncJobStartedResult = {
  job: SyncJob;
  reused: boolean;
  mcpAsinsPending: string[];
  estimatedAutoSeconds: number;
  estimatedAlexaSeconds: number;
};
export type SyncJobStartResult = SyncJobStartedResult | { noWork: true; message: "暂无待补抓数据" };

export class SyncJobService {
  readonly #syncJobs: SyncJobRepository;
  readonly #findXydcRepairAsins: (asins: readonly string[], marketplace: string) => Promise<string[]>;
  readonly #loadStatusModule: () => Promise<StatusModule>;
  readonly #now: () => string;
  readonly #providerReadiness: Pick<SyncProviderReadinessService, "plan"> | null;
  readonly #bypassProviderReadiness: boolean;
  readonly #loadSyncJobMirror: (jobId: string) => unknown | Promise<unknown>;

  constructor(
    syncJobs: SyncJobRepository,
    dependencies: SyncJobServiceDependencies = {},
  ) {
    this.#syncJobs = syncJobs;
    this.#findXydcRepairAsins = dependencies.findXydcRepairAsins ?? asinsNeedingXydcRepair;
    this.#loadStatusModule = dependencies.loadStatusModule ?? loadStatusModule;
    this.#now = dependencies.now ?? (() => new Date().toISOString());
    this.#providerReadiness = dependencies.providerReadiness ?? null;
    this.#bypassProviderReadiness = dependencies.bypassProviderReadiness ?? false;
    this.#loadSyncJobMirror = dependencies.loadSyncJobMirror ?? readSyncJob;
  }

  async start(input: SyncJobStartInput & { mode?: undefined }): Promise<SyncJobStartedResult>;
  async start(input: SyncJobStartInput): Promise<SyncJobStartResult>;
  async start(input: SyncJobStartInput): Promise<SyncJobStartResult> {
    const marketplace = normalizeMarketplace(input.marketplace);
    const asins = normalizeAsins(input.asins);
    if (input.mode === "repair-incomplete") {
      if (!input.projectId || !input.parentJobId || input.runId) {
        throw new SyncRepairScopeError("Repair requires a project and parent without run reuse");
      }
      const parent = await this.#syncJobs.findById(input.parentJobId);
      if (!parent || parent.organizationId !== input.organizationId || parent.projectId !== input.projectId || parent.marketplace !== marketplace || !sameStringArray(normalizeAsins(parent.asins), asins)) {
        throw new SyncRepairScopeError("Repair parent scope does not match");
      }
      if (["queued", "running"].includes(parent.status)) {
        return { job: toPublicSyncJob(parent), reused: true, mcpAsinsPending: [], estimatedAutoSeconds: 0, estimatedAlexaSeconds: 0 };
      }
      if (!["completed", "failed"].includes(parent.status)) throw new SyncRepairScopeError("Repair parent must be terminal");
    } else if (input.parentJobId) throw new SyncRepairScopeError("Repair parent requires repair mode");
    const statusMod = await this.#loadStatusModule();
    const catalogPending = statusMod.asinsNeedingCatalogSync(asins);
    const needing = statusMod.asinsNeedingMcpSync(asins);
    const trafficPending = statusMod.asinsNeedingTrafficSync(asins);
    const listingPending = statusMod.asinsNeedingListingSync(asins);
    const imageRemarksCount = statusMod.countPendingImageRemarks(asins);
    const statuses = statusMod.getAsinDataStatus(asins);
    const repairTargets = input.mode === "repair-incomplete" ? repairTargetsFor(statuses) : undefined;
    const repairXydcAsins = repairTargets ? await this.#findXydcRepairAsins(asins, marketplace) : undefined;
    if (repairTargets && !Object.values(repairTargets).some(targets => targets.length) && !repairXydcAsins?.length) {
      return { noWork: true, message: "暂无待补抓数据" };
    }
    const vocPending = statuses.filter((item) => item.voc === "missing");
    const automaticStages = automaticStagesNeedingSync(statuses);
    const readinessPlan = !this.#bypassProviderReadiness && this.#providerReadiness
      ? await this.#providerReadiness.plan({
        organizationId: input.organizationId,
        automaticStages,
      })
      : null;
    const createdAt = this.#now();
    const canonicalRun = input.projectId && input.actorId && !input.runId
      ? {
          runId: randomUUID(),
          stageId: randomUUID(),
          dataCutoffAt: createdAt,
        }
      : undefined;
    const admitted = await this.#syncJobs.admit({
      jobId: randomUUID(),
      organizationId: input.organizationId,
      projectId: input.projectId ?? null,
      runId: input.runId ?? canonicalRun?.runId ?? null,
      actorId: input.actorId ?? null,
      fingerprint: syncJobFingerprint({
        organizationId: input.organizationId,
        projectId: input.projectId ?? null,
        marketplace,
        asins,
      }),
      asins,
      marketplace,
      createdAt,
      stages: buildInitialStages({
        mcpCount: needing.length,
        vocCount: vocPending.length,
        catalogCount: catalogPending.length,
        imageRemarksCount,
        createdAt,
        automaticStages,
        unavailable: readinessPlan?.unavailable ?? [],
        ...(repairTargets ? { repairTargets, repairParentJobId: input.parentJobId, repairXydcAsins } : {}),
      }),
      currentStageId: "queue",
      message: "任务已排队",
      ...(canonicalRun ? { canonicalRun } : {}),
    });

    return {
      job: toPublicSyncJob(admitted.job),
      reused: admitted.disposition === "deduplicated",
      mcpAsinsPending: needing.map((item) => item.asin),
      estimatedAutoSeconds: statusMod.estimateAutoSyncSeconds(needing.length, {
        catalogCount: catalogPending.length,
        trafficCount: trafficPending.length,
        listingCount: listingPending.length,
        imageRemarksCount,
      }),
      estimatedAlexaSeconds: statusMod.estimateAlexaVocSeconds(vocPending.length),
    };
  }

  async read(jobId: string): Promise<SyncJob | null> {
    const job = await this.#syncJobs.findById(jobId);
    return job ? toPublicSyncJob(job) : null;
  }

  async readStageOutput(input: {
    organizationId: string;
    projectId: string;
    runId: string;
    jobId: string;
    stage: ProjectableSyncStage;
  }): Promise<StageOutputProjection | null> {
    return await this.#syncJobs.readStageOutput(input);
  }

  async readPublicationView(
    jobId: string,
    organizationId: string,
  ): Promise<{
    jobVersion: number;
    stageContentHashes: Readonly<Partial<Record<ProjectableSyncStage, string>>>;
  } | null> {
    const job = await this.#syncJobs.findById(jobId);
    if (
      !job ||
      job.organizationId !== organizationId ||
      !job.projectId ||
      !job.runId ||
      !Number.isSafeInteger(job.jobVersion) || Number(job.jobVersion) < 1
    ) return null;
    const outputs = await Promise.all(projectableSyncStages.map((stage) =>
      this.#syncJobs.readStageOutput({
        organizationId,
        projectId: job.projectId as string,
        runId: job.runId as string,
        jobId,
        stage,
      })
    ));
    const stageContentHashes = Object.fromEntries(outputs.flatMap((output) =>
      output ? [[output.stage, output.contentHash]] : []
    ));
    return {
      jobVersion: Number(job.jobVersion),
      stageContentHashes,
    };
  }

  async resume(input: {
    jobId: string;
    organizationId: string;
    actorId: string | null;
  }) {
    const candidate = await this.#syncJobs.findById(input.jobId);
    const buildPublicationRecoveryEvidence = candidate && exactFailedBuildOnly(candidate)
      ? buildRecoveryEvidence(
          await this.#loadSyncJobMirror(input.jobId),
          candidate,
        )
      : undefined;
    const resumed = await this.#syncJobs.resume({
      ...input,
      resumedAt: this.#now(),
      ...(buildPublicationRecoveryEvidence ? { buildPublicationRecoveryEvidence } : {}),
    });
    if (resumed && !(
      resumed.job.jobId === input.jobId &&
      (
        (resumed.resumedStages.length === 1 && resumed.resumedStages[0] === "category") ||
        (resumed.resumedStages.length === 1 && resumed.resumedStages[0] === "build") ||
        (resumed.resumedStages.length === 2 &&
          resumed.resumedStages[0] === "image_remarks" &&
          resumed.resumedStages[1] === "build")
      )
    )) {
      throw new Error("Sync job repository returned an unsupported resume selection");
    }
    return resumed
      ? {
          job: toPublicSyncJob(resumed.job),
          reused: resumed.disposition === "deduplicated",
          resumedStages: [...resumed.resumedStages],
        }
      : null;
  }

  async claimNext(input: {
    workerId: string;
    leaseMs: number;
    wholeJobLimit?: number;
    claimedAt?: string;
  }) {
    return await this.#syncJobs.claimNext({
      ...input,
      wholeJobLimit: input.wholeJobLimit ?? defaultWholeJobLimit,
    });
  }
}

function exactFailedBuildOnly(job: SyncJobRecord): boolean {
  if (job.status !== "failed" || job.stages.find((stage) => stage.id === "build")?.status !== "failed") {
    return false;
  }
  const unfinished = job.stages.filter((stage) =>
    stage.kind === "auto" &&
    stage.id !== "queue" &&
    ["failed", "pending", "active", "running"].includes(stage.status)
  );
  return unfinished.length === 1 && unfinished[0]?.id === "build";
}

function buildRecoveryEvidence(
  value: unknown,
  job: SyncJobRecord,
): BuildPublicationRecoveryEvidence | undefined {
  if (!job.projectId || !job.runId || !isRecord(value)) return undefined;
  const scope = isRecord(value.scope) ? value.scope : null;
  if (
    value.jobId !== job.jobId ||
    value.fingerprint !== job.fingerprint ||
    !scope ||
    scope.organizationId !== job.organizationId ||
    scope.projectId !== job.projectId ||
    scope.runId !== job.runId ||
    scope.marketplace !== job.marketplace ||
    !sameStringArray(scope.asins, job.asins) ||
    !Array.isArray(value.outputs)
  ) return undefined;
  const expected = new Map(job.stages.flatMap((stage) =>
    projectableSyncStages.includes(stage.id as ProjectableSyncStage) &&
      ["done", "partial", "failed"].includes(stage.status)
      ? [[stage.id as ProjectableSyncStage, stage.status] as const]
      : []
  ));
  const outputs = stageOutputPatches(value, job, { verifyContentHash: true });
  const actual = new Set(outputs.map((output) => output.stage));
  if (
    expected.size === 0 ||
    value.outputs.length !== expected.size ||
    outputs.length !== expected.size ||
    actual.size !== expected.size ||
    outputs.some((output) => expected.get(output.stage) !== output.stageStatus) ||
    [...expected.keys()].some((stage) => !actual.has(stage))
  ) return undefined;
  return {
    jobId: job.jobId,
    organizationId: job.organizationId,
    projectId: job.projectId,
    runId: job.runId,
    fingerprint: job.fingerprint,
    marketplace: job.marketplace,
    asins: [...job.asins],
    outputs,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sameStringArray(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length &&
    value.every((item, index) => item === expected[index]);
}

function automaticStagesNeedingSync(statuses: readonly AsinModuleStatus[]) {
  const stages: string[] = [];
  const needs = (predicate: (status: AsinModuleStatus) => boolean) => statuses.some(predicate);
  if (needs((status) => !status.inCatalog)) stages.push("catalog");
  if (needs((status) => status.keywords === "missing")) stages.push("keywords");
  if (needs((status) => status.reviews === "missing")) stages.push("reviews");
  if (needs((status) => status.sales === "missing")) stages.push("sales_trend");
  if (needs((status) => status.childSales === "missing")) stages.push("child_sales");
  if (needs((status) => status.priceStrategy === "missing")) stages.push("price_strategy");
  if (needs((status) => status.fba === "missing")) stages.push("fba");
  if (needs((status) => status.listing === "missing")) stages.push("listing");
  if (needs((status) => status.category === "missing")) stages.push("category");
  if (needs((status) => status.traffic === "missing")) stages.push("traffic");
  return stages;
}

function repairTargetsFor(statuses: readonly AsinModuleStatus[]): Record<string, string[]> {
  const fields = { catalog: "inCatalog", keywords: "keywords", reviews: "reviews", sales_trend: "sales", child_sales: "childSales", price_strategy: "priceStrategy", fba: "fba", listing: "listing", category: "category", traffic: "traffic", image_remarks: "imageRemarks" } as const;
  return Object.fromEntries(Object.entries(fields).map(([stage, field]) => [stage, statuses.filter(status => field === "inCatalog" ? !status.inCatalog : status[field] === "missing").map(status => status.asin)]));
}

export function isSyncJobAdmissionLimitError(error: unknown): boolean {
  return error instanceof Error &&
    /(?:queued sync job limit|sync job backlog limit)/i.test(error.message);
}

async function loadStatusModule(): Promise<StatusModule> {
  return await import("../../scripts/lib/asin-data-status.mjs") as StatusModule;
}

function normalizeMarketplace(value: string): "US" {
  const marketplace = value.trim().toUpperCase();
  if (marketplace !== "US") throw new TypeError("Unsupported sync job marketplace");
  return "US";
}

function normalizeAsins(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toUpperCase()))].sort();
}

function syncJobFingerprint(input: {
  organizationId: string;
  projectId: string | null;
  marketplace: "US";
  asins: readonly string[];
}): string {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
}

function toPublicSyncJob(job: SyncJobRecord): SyncJob {
  return {
    jobId: job.jobId,
    jobVersion: Number(job.jobVersion ?? 1),
    asins: [...job.asins],
    marketplace: job.marketplace,
    status: job.status,
    message: job.message,
    currentStageId: job.currentStageId,
    stages: [...job.stages],
    asinProgress: job.asinProgress,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.completedAt ? { completedAt: job.completedAt } : {}),
    ...(job.dynamicSnapshot ? { dynamicSnapshot: job.dynamicSnapshot } : {}),
    ...(job.resumableStages
      ? { resumableStages: [...job.resumableStages] }
      : {}),
    ...(typeof job.queuePosition === "number"
      ? { queuePosition: job.queuePosition }
      : {}),
    scope: {
      organizationId: job.organizationId,
      projectId: job.projectId ?? "unscoped",
      runId: job.runId,
      marketplace: job.marketplace,
      asins: [...job.asins],
    },
    fingerprint: job.fingerprint,
  };
}

function buildInitialStages(input: {
  mcpCount: number;
  vocCount: number;
  catalogCount: number;
  imageRemarksCount: number;
  createdAt: string;
  automaticStages: readonly string[];
  unavailable: readonly SyncProviderReadinessDetail[];
  repairTargets?: Record<string, string[]>;
  repairParentJobId?: string;
  repairXydcAsins?: string[];
}): readonly SyncJobStageRecord[] {
  const automaticStageIds = new Set(input.automaticStages);
  const unavailableConnectorIds = new Set(input.unavailable.map(item => item.connectorId));
  const catalogProviderPlan = automaticStageIds.has("catalog")
    && !(unavailableConnectorIds.has("sellerSprite") && unavailableConnectorIds.has("sorftime"))
    ? {
        preferredConnectorId: unavailableConnectorIds.has("sellerSprite")
          ? "sorftime" as const
          : "sellerSprite" as const,
        unavailableConnectorIds: (["sellerSprite", "sorftime"] as const)
          .filter(connectorId => unavailableConnectorIds.has(connectorId)),
      }
    : null;
  const unavailableStages = new Map<string, readonly (keyof typeof CONNECTOR_DISPLAY_NAMES)[]>();
  for (const stageId of automaticStageIds) {
    if (!(stageId in STAGE_CONNECTORS)) continue;
    const connectors = STAGE_CONNECTORS[stageId as keyof typeof STAGE_CONNECTORS];
    if (connectors.every(connectorId => unavailableConnectorIds.has(connectorId))) {
      unavailableStages.set(stageId, connectors);
    }
  }
  const stages = [
    ["queue", "任务排队", "auto", "active", 3, "校验 ASIN 并进入后台队列"],
    ["catalog", "卖家精灵商品底库", "auto", "pending", input.catalogCount * 18, "asin_detail + 销量趋势"],
    ["keywords", "SIF 关键词 MCP", "auto", "pending", input.mcpCount * 55, "流量词信号 + 月搜索量 enrichment"],
    ["reviews", "Sorftime 评论 MCP", "auto", "pending", input.mcpCount * 35, "评分/评论 + Customers Say"],
    ["sales_trend", "销量 / 价格 / BSR 趋势", "auto", "pending", input.mcpCount * 28, "月销量 / 销售额 / 历史价格"],
    ["child_sales", "近30天子体销量", "auto", "pending", input.mcpCount * 18, "变体评论占比 + 近30天销量"],
    ["price_strategy", "价格策略分析", "auto", "pending", input.mcpCount * 12, "定价锚点 / 促销手法"],
    ["fba", "FBA 费用", "auto", "pending", input.mcpCount * 10, "包装尺寸估费"],
    ["listing", "主辅图 / A+", "auto", "pending", input.mcpCount * 12, "main_image / a_plus"],
    ["category", "BSR 小类市场趋势", "auto", "pending", input.mcpCount * 15, "小类 Top100 口径"],
    ["traffic", "竞品流量结构", "auto", "pending", input.mcpCount * 25, "Listing 流量结构 + 子体拆解"],
    ["image_remarks", "主辅图视觉备注", "auto", "pending", estimateImageRemarkSeconds(input.imageRemarksCount), IMAGE_REMARK_POLICY_DETAIL],
    ["alexa_voc", "Alexa VOC 核心主题", "manual", "manual", input.vocCount * 120, "需人工录入，不阻塞基础数据"],
    ["build", "构建并热更新", "auto", "pending", 65, "等待后台调度器处理"],
  ] as const;
  return stages.map(([id, label, kind, status, estimatedSeconds, detail]) => {
    const connectorIds = unavailableStages.get(id);
    return {
      id,
      label,
      kind,
      status: connectorIds ? "partial" : status,
      estimatedSeconds,
      detail: connectorIds
        ? `${connectorIds.map(connectorId => CONNECTOR_DISPLAY_NAMES[connectorId]).join(" / ")} 数据源不可用，本阶段已跳过。`
        : detail,
      startedAt: null,
      completedAt: connectorIds ? input.createdAt : null,
      ...(input.repairTargets && id in input.repairTargets ? { repairAsins: input.repairTargets[id], repairParentJobId: input.repairParentJobId } : {}),
      ...(input.repairTargets && id === "catalog" ? { repairXydcAsins: input.repairXydcAsins ?? [] } : {}),
      ...(id === "alexa_voc"
        ? { manualNote: "Alexa VOC 可到「竞品 VOC 汇总」页粘贴报告。" }
        : {}),
      ...(id === "catalog" && catalogProviderPlan
        ? { catalogProviderPlan }
        : {}),
    };
  });
}
