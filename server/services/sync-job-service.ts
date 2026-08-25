import { createHash, randomUUID } from "node:crypto";

import type {
  AsinModuleStatus,
  SyncJob,
  SyncJobScope,
} from "../../app/lib/sync-server";
import type {
  ProjectableSyncStage,
  StageOutputProjection,
  SyncJobRecord,
  SyncJobRepository,
  SyncJobStageRecord,
} from "../db/sync-job-repository";
import type {
  SyncProviderReadinessDetail,
  SyncProviderReadinessService,
} from "./sync-provider-readiness-service";

const defaultWholeJobLimit = 4;
const projectableSyncStages = [
  "keywords", "reviews", "sales_trend", "fba", "listing", "category", "traffic",
] as const;
const CONNECTOR_STAGES = Object.freeze({
  sellerSprite: ["catalog"],
  sif: ["keywords", "traffic"],
  sorftime: ["reviews", "sales_trend", "child_sales", "price_strategy", "fba", "listing", "category"],
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
  loadStatusModule?: () => Promise<StatusModule>;
  now?: () => string;
  providerReadiness?: Pick<SyncProviderReadinessService, "plan"> | null;
  bypassProviderReadiness?: boolean;
};

export class SyncJobService {
  readonly #syncJobs: SyncJobRepository;
  readonly #loadStatusModule: () => Promise<StatusModule>;
  readonly #now: () => string;
  readonly #providerReadiness: Pick<SyncProviderReadinessService, "plan"> | null;
  readonly #bypassProviderReadiness: boolean;

  constructor(
    syncJobs: SyncJobRepository,
    dependencies: SyncJobServiceDependencies = {},
  ) {
    this.#syncJobs = syncJobs;
    this.#loadStatusModule = dependencies.loadStatusModule ?? loadStatusModule;
    this.#now = dependencies.now ?? (() => new Date().toISOString());
    this.#providerReadiness = dependencies.providerReadiness ?? null;
    this.#bypassProviderReadiness = dependencies.bypassProviderReadiness ?? false;
  }

  async start(input: SyncJobScope & { asins: string[]; marketplace: string }) {
    const marketplace = normalizeMarketplace(input.marketplace);
    const asins = normalizeAsins(input.asins);
    const statusMod = await this.#loadStatusModule();
    const catalogPending = statusMod.asinsNeedingCatalogSync(asins);
    const needing = statusMod.asinsNeedingMcpSync(asins);
    const trafficPending = statusMod.asinsNeedingTrafficSync(asins);
    const listingPending = statusMod.asinsNeedingListingSync(asins);
    const imageRemarksPending = statusMod.asinsNeedingImageRemarksSync(asins);
    const statuses = statusMod.getAsinDataStatus(asins);
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
        createdAt,
        automaticStages,
        unavailable: readinessPlan?.unavailable ?? [],
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
        imageRemarksCount: imageRemarksPending.length,
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
    const resumed = await this.#syncJobs.resume({
      ...input,
      resumedAt: this.#now(),
    });
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
  createdAt: string;
  automaticStages: readonly string[];
  unavailable: readonly SyncProviderReadinessDetail[];
}): readonly SyncJobStageRecord[] {
  const automaticStageIds = new Set(input.automaticStages);
  const unavailableStages = new Map<string, keyof typeof CONNECTOR_DISPLAY_NAMES>();
  for (const unavailable of input.unavailable) {
    if (!(unavailable.connectorId in CONNECTOR_STAGES)) continue;
    const connectorId = unavailable.connectorId as keyof typeof CONNECTOR_STAGES;
    for (const stageId of CONNECTOR_STAGES[connectorId]) {
      if (automaticStageIds.has(stageId)) unavailableStages.set(stageId, connectorId);
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
    ["image_remarks", "主辅图视觉备注", "auto", "pending", input.mcpCount * 45, "最多同时分析 2 张图片"],
    ["alexa_voc", "Alexa VOC 核心主题", "manual", "manual", input.vocCount * 120, "需人工录入，不阻塞基础数据"],
    ["build", "构建并热更新", "auto", "pending", 65, "等待后台调度器处理"],
  ] as const;
  return stages.map(([id, label, kind, status, estimatedSeconds, detail]) => {
    const connectorId = unavailableStages.get(id);
    return {
      id,
      label,
      kind,
      status: connectorId ? "partial" : status,
      estimatedSeconds,
      detail: connectorId
        ? `${CONNECTOR_DISPLAY_NAMES[connectorId]} 数据源不可用，本阶段已跳过。`
        : detail,
      startedAt: null,
      completedAt: connectorId ? input.createdAt : null,
      ...(id === "alexa_voc"
        ? { manualNote: "Alexa VOC 可到「竞品 VOC 汇总」页粘贴报告。" }
        : {}),
    };
  });
}
