import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ASIN_SYNC_STAGE_IDS } from "./asin-data-status.mjs";
import { getProjectRoot } from "./project-root.mjs";

const root = getProjectRoot();
export const syncJobsDir = path.join(root, "data", "sync-jobs");

const ACTIVE_SYNC_STATUSES = new Set(["queued", "running", "base-ready", "enriching"]);
const UNSCOPED_PROJECT = "unscoped";

function canonicalScope(input) {
  const source = input.scope ?? input;
  if (!source.organizationId) throw new TypeError("organizationId is required for scoped sync jobs");
  const asins = [...new Set((source.asins ?? []).map(asin => String(asin).trim().toUpperCase()))].sort();
  if (!asins.length) throw new TypeError("asins are required for scoped sync jobs");
  return {
    organizationId: String(source.organizationId),
    projectId: source.projectId ? String(source.projectId) : UNSCOPED_PROJECT,
    runId: source.runId ? String(source.runId) : null,
    marketplace: String(source.marketplace ?? "US"),
    asins,
  };
}

function scopeFingerprint(scope) {
  return createHash("sha256").update(JSON.stringify(scope)).digest("hex");
}

export function createSyncJobStore({ directory = syncJobsDir } = {}) {
  const activeByFingerprint = new Map();

  function filePath(jobId) {
    return path.join(directory, `${jobId}.json`);
  }

  function ensureDir() {
    fs.mkdirSync(directory, { recursive: true });
  }

  function read(jobId) {
    const file = filePath(jobId);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  }

  function write(job) {
    ensureDir();
    job.updatedAt = new Date().toISOString();
    fs.writeFileSync(filePath(job.jobId), JSON.stringify(job, null, 2), "utf8");
    if (job.fingerprint) {
      if (ACTIVE_SYNC_STATUSES.has(job.status)) activeByFingerprint.set(job.fingerprint, job.jobId);
      else activeByFingerprint.delete(job.fingerprint);
    }
  }

  function rebuildActiveIndex() {
    activeByFingerprint.clear();
    if (!fs.existsSync(directory)) return;
    for (const file of fs.readdirSync(directory)) {
      if (!file.endsWith(".json")) continue;
      const job = read(path.basename(file, ".json"));
      if (job?.fingerprint && ACTIVE_SYNC_STATUSES.has(job.status)) {
        activeByFingerprint.set(job.fingerprint, job.jobId);
      }
    }
  }

  function create(input) {
    const { asins, marketplace = "US", mcpAsinCount, vocPendingCount = 0, catalogAsinCount = 0 } = input;
    const jobId = randomUUID();
    const now = new Date().toISOString();
    const mcpCount = mcpAsinCount ?? asins.length;
    const job = {
      jobId,
      asins,
      marketplace,
      mcpAsinCount: mcpCount,
      vocPendingCount,
      catalogAsinCount,
      createdAt: now,
      updatedAt: now,
      status: "queued",
      message: "任务已排队",
      currentStageId: "queue",
      stages: buildInitialStages({ mcpCount, vocCount: vocPendingCount, catalogCount: catalogAsinCount }),
      asinProgress: createAsinProgress(asins),
    };
    if (input.scope ?? input.organizationId) {
      const scope = canonicalScope(input);
      job.asins = scope.asins;
      job.marketplace = scope.marketplace;
      job.scope = scope;
      job.fingerprint = scopeFingerprint(scope);
    }
    write(job);
    return job;
  }

  function createOrReuse(input) {
    const scope = canonicalScope(input);
    const fingerprint = scopeFingerprint(scope);
    const activeId = activeByFingerprint.get(fingerprint);
    const active = activeId ? read(activeId) : null;
    if (active && ACTIVE_SYNC_STATUSES.has(active.status)) return { job: active, reused: true };
    if (activeId) activeByFingerprint.delete(fingerprint);
    const job = create({ ...input, scope });
    return { job, reused: false };
  }

  function patch(jobId, patch) {
    const job = read(jobId);
    if (!job) return null;
    const next = { ...job, ...patch };
    write(next);
    return next;
  }

  rebuildActiveIndex();
  return {
    ensureSyncJobsDir: ensureDir,
    jobFilePath: filePath,
    readSyncJob: read,
    writeSyncJob: write,
    createSyncJob: create,
    createOrReuseSyncJob: createOrReuse,
    patchSyncJob: patch,
    rebuildActiveIndex,
  };
}

export function createSyncJobStartCoordinator({ store, launch }) {
  return {
    async start(input) {
      const result = store.createOrReuseSyncJob(input);
      if (!result.reused) await launch(result.job);
      return result;
    },
  };
}

const defaultStore = createSyncJobStore();

export function ensureSyncJobsDir() {
  defaultStore.ensureSyncJobsDir();
}

export function jobFilePath(jobId) {
  return defaultStore.jobFilePath(jobId);
}

export function readSyncJob(jobId) {
  return defaultStore.readSyncJob(jobId);
}

export function writeSyncJob(job) {
  defaultStore.writeSyncJob(job);
}

export function createAsinProgress(asins) {
  return Object.fromEntries(
    asins.map(asin => [
      asin,
      Object.fromEntries(ASIN_SYNC_STAGE_IDS.map(stageId => [stageId, "pending"])),
    ]),
  );
}

export function createSyncJob({ asins, marketplace = "US", mcpAsinCount, vocPendingCount = 0, catalogAsinCount = 0 }) {
  return defaultStore.createSyncJob({ asins, marketplace, mcpAsinCount, vocPendingCount, catalogAsinCount });
}

export function createOrReuseSyncJob(input) {
  return defaultStore.createOrReuseSyncJob(input);
}

function buildInitialStages({ mcpCount, vocCount, catalogCount }) {
  return [
    {
      id: "queue",
      label: "任务排队",
      kind: "auto",
      status: "active",
      estimatedSeconds: 3,
      detail: "校验 ASIN 并启动后台任务",
      startedAt: null,
      completedAt: null,
    },
    {
      id: "catalog",
      label: "卖家精灵商品底库",
      kind: "auto",
      status: "pending",
      estimatedSeconds: catalogCount * 18,
      detail: "asin_detail + 销量趋势 → competitor-data.ts",
      startedAt: null,
      completedAt: null,
    },
    {
      id: "keywords",
      label: "SIF 关键词 MCP",
      kind: "auto",
      status: "pending",
      estimatedSeconds: mcpCount * 55,
      detail: "流量词信号 + 月搜索量 enrichment",
      startedAt: null,
      completedAt: null,
    },
    {
      id: "reviews",
      label: "Sorftime 评论 MCP",
      kind: "auto",
      status: "pending",
      estimatedSeconds: mcpCount * 35,
      detail: "product_detail 评分/评论 + Customers Say + 评论样本",
      startedAt: null,
      completedAt: null,
    },
    {
      id: "sales_trend",
      label: "销量 / 价格 / BSR 趋势",
      kind: "auto",
      status: "pending",
      estimatedSeconds: mcpCount * 28,
      detail: "Sorftime · 月销量 / 销售额 / 历史价格 / 大类 BSR",
      startedAt: null,
      completedAt: null,
    },
    {
      id: "child_sales",
      label: "近30天子体销量",
      kind: "auto",
      status: "pending",
      estimatedSeconds: mcpCount * 18,
      detail: "product_variations 变体评论占比 + 近30天子体销量",
      startedAt: null,
      completedAt: null,
    },
    {
      id: "price_strategy",
      label: "价格策略分析",
      kind: "auto",
      status: "pending",
      estimatedSeconds: mcpCount * 12,
      detail: "Sorftime · 定价锚点 / 促销手法",
      startedAt: null,
      completedAt: null,
    },
    {
      id: "fba",
      label: "FBA 费用",
      kind: "auto",
      status: "pending",
      estimatedSeconds: mcpCount * 10,
      detail: "Sorftime · 包装尺寸估费",
      startedAt: null,
      completedAt: null,
    },
    {
      id: "listing",
      label: "主辅图 / A+",
      kind: "auto",
      status: "pending",
      estimatedSeconds: mcpCount * 12,
      detail: "Sorftime · main_image / a_plus",
      startedAt: null,
      completedAt: null,
    },
    {
      id: "image_remarks",
      label: "主辅图视觉备注",
      kind: "auto",
      status: "pending",
      estimatedSeconds: mcpCount * 45,
      detail: "OpenAI 视觉分析每张主辅图 · 需 OPENAI_API_KEY",
      startedAt: null,
      completedAt: null,
    },
    {
      id: "category",
      label: "BSR 小类市场趋势",
      kind: "auto",
      status: "pending",
      estimatedSeconds: mcpCount * 15,
      detail: "Sorftime · 小类 Top100 口径",
      startedAt: null,
      completedAt: null,
    },
    {
      id: "alexa_voc",
      label: "Alexa VOC 核心主题",
      kind: "auto",
      status: "pending",
      estimatedSeconds: vocCount * 120,
      detail: "Playwright 自动提交七问并写入 rufus-voc-data",
      startedAt: null,
      completedAt: null,
      manualNote:
        "Alexa VOC 待录入时可到「竞品 VOC 汇总」页粘贴报告，或由管理员配置服务器自动采集。",
    },
    {
      id: "traffic",
      label: "竞品流量结构",
      kind: "auto",
      status: "pending",
      estimatedSeconds: mcpCount * 25,
      detail: "SIF · Listing 流量结构 + 子体拆解 + 近6月月趋势",
      startedAt: null,
      completedAt: null,
    },
    {
      id: "build",
      label: "构建并热更新",
      kind: "auto",
      status: "pending",
      estimatedSeconds: 65,
      detail: "npm run build + 重启团队服务",
      startedAt: null,
      completedAt: null,
    },
  ];
}

export function patchSyncJob(jobId, patch) {
  return defaultStore.patchSyncJob(jobId, patch);
}

export function failSyncJob(jobId, message, { now = () => new Date().toISOString() } = {}) {
  const job = readSyncJob(jobId);
  if (!job) return null;
  const completedAt = now();
  job.stages = job.stages.map(stage =>
    stage.status === "active"
      ? { ...stage, status: "failed", detail: message, completedAt }
      : stage,
  );
  job.status = "failed";
  job.message = message;
  job.completedAt = completedAt;
  writeSyncJob(job);
  return job;
}

export function setStage(jobId, stageId, patch) {
  const job = readSyncJob(jobId);
  if (!job) return null;
  job.stages = job.stages.map(stage => (stage.id === stageId ? { ...stage, ...patch } : stage));
  job.currentStageId = stageId;
  writeSyncJob(job);
  return job;
}

export function markAsinModule(jobId, asin, module, status) {
  const job = readSyncJob(jobId);
  if (!job) return null;
  if (!job.asinProgress[asin]) job.asinProgress[asin] = {};
  job.asinProgress[asin][module] = status;
  writeSyncJob(job);
  return job;
}
