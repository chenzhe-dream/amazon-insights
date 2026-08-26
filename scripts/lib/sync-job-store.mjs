import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ASIN_SYNC_STAGE_IDS } from "./asin-data-status.mjs";
import {
  estimateImageRemarkSeconds,
  IMAGE_REMARK_POLICY_DETAIL,
} from "./image-remark-policy.mjs";
import { getProjectRoot } from "./project-root.mjs";
import { acquireInterprocessLock, acquireInterprocessLockSync } from "./interprocess-lock.mjs";

const root = getProjectRoot();
export const syncJobsDir = path.join(root, "data", "sync-jobs");

const ACTIVE_SYNC_STATUSES = new Set(["queued", "running", "base-ready", "enriching"]);
const UNSCOPED_PROJECT = "unscoped";
export const ASIN_MODULE_STATUSES = [
  "ready", "upstream-empty", "timeout", "connector-failed", "pending", "manual",
];
const TERMINAL_MODULE_STATUSES = new Set(["ready", "upstream-empty", "timeout", "connector-failed", "manual"]);
function mirrorLockPath(file) {
  return `${file}.lock`;
}

function atomicMirrorPath(file) {
  return `${file}.tmp-${process.pid}-${randomUUID()}`;
}

function readMirrorFileSync(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function atomicWriteMirrorSync(file, value) {
  const temporary = atomicMirrorPath(file);
  try {
    fs.writeFileSync(temporary, JSON.stringify(sanitizeSyncJobDiagnosticMirror(value), null, 2), {
      encoding: "utf8", flag: "wx", mode: 0o600,
    });
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
}

export function mutateSyncJobMirrorSync(file, updater) {
  const release = acquireInterprocessLockSync(mirrorLockPath(file));
  try {
    const current = readMirrorFileSync(file);
    const next = updater(current);
    if (next == null) return current;
    atomicWriteMirrorSync(file, next);
    return next;
  } finally {
    release();
  }
}

export async function mutateSyncJobMirror(file, updater, lockOptions) {
  const release = await acquireInterprocessLock(mirrorLockPath(file), lockOptions);
  try {
    const current = readMirrorFileSync(file);
    const update = updater(current);
    const next = update && typeof update.then === "function" ? await update : update;
    if (next == null) return current;
    atomicWriteMirrorSync(file, next);
    return next;
  } finally {
    await release();
  }
}

export async function compareAndSwapSyncJobMirror(file, input, lockOptions) {
  const release = await acquireInterprocessLock(mirrorLockPath(file), lockOptions);
  try {
    let raw;
    try {
      raw = fs.readFileSync(file);
    } catch (error) {
      if (error?.code === "ENOENT") return "conflict";
      throw error;
    }
    const currentDigest = createHash("sha256").update(raw).digest("hex");
    if (currentDigest === input.nextDigest) return "already-applied";
    if (currentDigest !== input.expectedDigest) return "conflict";
    const next = Buffer.from(JSON.stringify(input.nextJob));
    if (createHash("sha256").update(next).digest("hex") !== input.nextDigest) {
      throw new Error("Mirror replacement digest mismatch");
    }
    const temporary = atomicMirrorPath(file);
    try {
      fs.writeFileSync(temporary, next, { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, file);
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }); } catch {}
      throw error;
    }
    return "applied";
  } finally {
    await release();
  }
}

function safeStatusReason(reason) {
  if (reason == null) return null;
  return String(reason)
    .replace(/\b((?:postgres(?:ql)?|https?):\/\/)[^@\s/]+@/gi, "$1[REDACTED]@")
    .replace(/\b(authorization|cookie|token|secret|password|credential|api[-_ ]?key)\b\s*[:=]\s*[^\s,;]+/gi, "$1: [REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240) || null;
}

function redactDiagnosticMirrorValue(value) {
  if (Array.isArray(value)) return value.map(redactDiagnosticMirrorValue);
  if (!value || typeof value !== "object") return value;
  const blocked = new Set([
    "leasedBy",
    "leaseGeneration",
    "leaseExpiresAt",
    "workerId",
    "command",
    "logPath",
    "stdout",
    "stderr",
    "env",
  ]);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !blocked.has(key))
      .map(([key, child]) => [key, redactDiagnosticMirrorValue(child)]),
  );
}

export function sanitizeSyncJobDiagnosticMirror(job) {
  return redactDiagnosticMirrorValue(job);
}

export function createAsinModuleResult(status = "pending", reason = null, updatedAt = new Date().toISOString()) {
  const publicStatus = ASIN_MODULE_STATUSES.includes(status) ? status : "connector-failed";
  return { status: publicStatus, reason: safeStatusReason(reason), updatedAt };
}

function moduleStatus(value) {
  return typeof value === "string" ? value : value?.status;
}

export function aggregateAsinModuleStatuses(statuses) {
  const normalized = statuses.map(moduleStatus).filter(Boolean);
  if (!normalized.length || normalized.every(status => status === "pending")) return "pending";
  if (normalized.every(status => status === "manual")) return "manual";
  if (normalized.every(status => status === "ready")) return "done";
  if (normalized.some(status => status === "pending")) return "active";
  return "partial";
}

export function deriveFinalSyncJobStatus(asinProgress) {
  const statuses = Object.values(asinProgress ?? {})
    .flatMap(progress => Object.entries(progress ?? {}))
    .filter(([stageId]) => stageId !== "alexa_voc")
    .map(([, value]) => moduleStatus(value));
  if (statuses.some(status => !TERMINAL_MODULE_STATUSES.has(status))) return null;
  return statuses.every(status => status === "ready") ? "completed" : "completed-with-gaps";
}

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
  return createHash("sha256").update(JSON.stringify({
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    marketplace: scope.marketplace,
    asins: scope.asins,
  })).digest("hex");
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
    return readMirrorFileSync(filePath(jobId));
  }

  function write(job) {
    ensureDir();
    if (job.scope?.organizationId) job.fingerprint = scopeFingerprint(canonicalScope(job.scope));
    job.updatedAt = new Date().toISOString();
    mutateSyncJobMirrorSync(filePath(job.jobId), () => job);
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
        const fingerprint = job.scope?.organizationId
          ? scopeFingerprint(canonicalScope(job.scope))
          : job.fingerprint;
        activeByFingerprint.set(fingerprint, job.jobId);
      }
    }
  }

  function create(input) {
    const {
      asins,
      marketplace = "US",
      mcpAsinCount,
      vocPendingCount = 0,
      catalogAsinCount = 0,
      imageRemarksCount = 0,
    } = input;
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
      imageRemarksCount,
      createdAt: now,
      updatedAt: now,
      status: "queued",
      message: "任务已排队",
      currentStageId: "queue",
      stages: buildInitialStages({
        mcpCount,
        vocCount: vocPendingCount,
        catalogCount: catalogAsinCount,
        imageRemarksCount,
      }),
      asinProgress: createAsinProgress(asins),
      dynamicSnapshot: "pending",
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

  function mutate(jobId, updater) {
    let next = null;
    mutateSyncJobMirrorSync(filePath(jobId), (current) => {
      if (!current) return null;
      next = updater(current);
      if (!next) return null;
      if (next.scope?.organizationId) next.fingerprint = scopeFingerprint(canonicalScope(next.scope));
      next.updatedAt = new Date().toISOString();
      return next;
    });
    if (next?.fingerprint) {
      if (ACTIVE_SYNC_STATUSES.has(next.status)) activeByFingerprint.set(next.fingerprint, next.jobId);
      else activeByFingerprint.delete(next.fingerprint);
    }
    return next;
  }

  function patch(jobId, patch) {
    return mutate(jobId, (job) => ({ ...job, ...patch }));
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
    mutateSyncJob: mutate,
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

export function mutateSyncJob(jobId, updater) {
  return defaultStore.mutateSyncJob(jobId, updater);
}

export function createAsinProgress(asins) {
  return Object.fromEntries(
    asins.map(asin => [
      asin,
      Object.fromEntries(ASIN_SYNC_STAGE_IDS.map(stageId => [
        stageId,
        stageId === "alexa_voc"
          ? createAsinModuleResult("manual", "需人工录入 Alexa VOC")
          : createAsinModuleResult(),
      ])),
    ]),
  );
}

export function createSyncJob({
  asins,
  marketplace = "US",
  mcpAsinCount,
  vocPendingCount = 0,
  catalogAsinCount = 0,
  imageRemarksCount = 0,
}) {
  return defaultStore.createSyncJob({
    asins,
    marketplace,
    mcpAsinCount,
    vocPendingCount,
    catalogAsinCount,
    imageRemarksCount,
  });
}

export function createOrReuseSyncJob(input) {
  return defaultStore.createOrReuseSyncJob(input);
}

function buildInitialStages({ mcpCount, vocCount, catalogCount, imageRemarksCount }) {
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
      id: "image_remarks",
      label: "主辅图视觉备注",
      kind: "auto",
      status: "pending",
      estimatedSeconds: estimateImageRemarkSeconds(imageRemarksCount),
      detail: IMAGE_REMARK_POLICY_DETAIL,
      startedAt: null,
      completedAt: null,
    },
    {
      id: "alexa_voc",
      label: "Alexa VOC 核心主题",
      kind: "manual",
      status: "manual",
      estimatedSeconds: vocCount * 120,
      detail: "需人工录入，不阻塞基础数据或任务完成",
      startedAt: null,
      completedAt: null,
      manualNote: "Alexa VOC 可到「竞品 VOC 汇总」页粘贴报告。",
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
  return mutateSyncJob(jobId, (job) => {
    const completedAt = now();
    return {
      ...job,
      stages: job.stages.map(stage => stage.status === "active"
        ? { ...stage, status: "failed", detail: message, completedAt }
        : stage),
      status: "failed", message, completedAt,
    };
  });
}

export function setStage(jobId, stageId, patch) {
  return mutateSyncJob(jobId, (job) => ({
    ...job,
    stages: job.stages.map(stage => (stage.id === stageId ? { ...stage, ...patch } : stage)),
    currentStageId: stageId,
  }));
}

export function commitProjectableStage(jobId, { stageId, stagePatch, output }) {
  return mutateSyncJob(jobId, (job) => {
    const scope = job.scope;
    let outputs = job.outputs;
    if (output && scope?.organizationId && typeof scope.projectId === "string" && typeof scope.runId === "string") {
      const scopedOutput = { ...output, organizationId: scope.organizationId, projectId: scope.projectId, runId: scope.runId };
      const previous = Array.isArray(job.outputs) ? job.outputs : [];
      outputs = [...previous.filter(candidate => candidate?.stage !== stageId), scopedOutput];
    }
    return {
      ...job,
      stages: job.stages.map(stage => (stage.id === stageId ? { ...stage, ...stagePatch } : stage)),
      currentStageId: stageId,
      ...(outputs ? { outputs } : {}),
    };
  });
}

export function markAsinModule(jobId, asin, module, status) {
  return mutateSyncJob(jobId, (job) => {
    const input = typeof status === "string" ? { status } : status ?? {};
    return {
      ...job,
      asinProgress: {
        ...job.asinProgress,
        [asin]: { ...job.asinProgress?.[asin], [module]: createAsinModuleResult(input.status, input.reason) },
      },
    };
  });
}

export function aggregateStageFromProgress(job, stageId) {
  return aggregateAsinModuleStatuses(job.asins.map(asin => job.asinProgress?.[asin]?.[stageId]));
}

export function reconcileStageStatus(job, stageId) {
  return { status: aggregateStageFromProgress(job, stageId) };
}

export function markSyncJobBaseReady(jobId) {
  return mutateSyncJob(jobId, (job) => ({
    ...job, status: "base-ready", baseReadyAt: new Date().toISOString(), message: "基础数据已就绪，正在补充图片备注。",
  }));
}

export function markSyncJobEnriching(jobId) {
  return mutateSyncJob(jobId, (job) => ({
    ...job, status: "enriching", message: "基础数据已就绪，正在补充图片备注。",
  }));
}
