import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const root = path.resolve(import.meta.dirname, "../..");
export const syncJobsDir = path.join(root, "data", "sync-jobs");

export function ensureSyncJobsDir() {
  fs.mkdirSync(syncJobsDir, { recursive: true });
}

export function jobFilePath(jobId) {
  return path.join(syncJobsDir, `${jobId}.json`);
}

export function readSyncJob(jobId) {
  const file = jobFilePath(jobId);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function writeSyncJob(job) {
  ensureSyncJobsDir();
  job.updatedAt = new Date().toISOString();
  fs.writeFileSync(jobFilePath(job.jobId), JSON.stringify(job, null, 2), "utf8");
}

export function createSyncJob({ asins, marketplace = "US" }) {
  const jobId = randomUUID();
  const now = new Date().toISOString();
  const job = {
    jobId,
    asins,
    marketplace,
    createdAt: now,
    updatedAt: now,
    status: "queued",
    message: "任务已排队",
    currentStageId: "queue",
    stages: buildInitialStages(asins),
    asinProgress: Object.fromEntries(
      asins.map(asin => [
        asin,
        { keywords: "pending", reviews: "pending", sales: "pending", voc: "pending" },
      ])
    ),
  };
  writeSyncJob(job);
  return job;
}

function buildInitialStages(asins) {
  const count = asins.length;
  return [
    {
      id: "queue",
      label: "排队",
      kind: "auto",
      status: "active",
      estimatedSeconds: 3,
      startedAt: null,
      completedAt: null,
    },
    {
      id: "keywords",
      label: "SIF 关键词 MCP",
      kind: "auto",
      status: "pending",
      estimatedSeconds: count * 55,
      detail: "流量词信号 + 月搜索量 enrichment",
      startedAt: null,
      completedAt: null,
    },
    {
      id: "reviews",
      label: "Sorftime 评论 MCP",
      kind: "auto",
      status: "pending",
      estimatedSeconds: count * 35,
      detail: "Customers Say + 评论样本",
      startedAt: null,
      completedAt: null,
    },
    {
      id: "sales",
      label: "Sorftime 销量 MCP",
      kind: "auto",
      status: "pending",
      estimatedSeconds: count * 30,
      detail: "ASIN 月销量/销售额 + BSR 小类市场趋势",
      startedAt: null,
      completedAt: null,
    },
    {
      id: "alexa_voc",
      label: "Alexa VOC 核心主题",
      kind: "manual",
      status: "pending",
      estimatedSeconds: count * 480,
      detail: "需在 Alexa for Shopping 对话框提问并手工录入",
      startedAt: null,
      completedAt: null,
      manualNote:
        "Alexa 响应通常很快：商品页提交七问 → 展开 See more → 在「竞品 VOC 汇总」页粘贴全文录入，或运行 npm run alexa:import -- ASIN。",
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
  const job = readSyncJob(jobId);
  if (!job) return null;
  const next = { ...job, ...patch };
  writeSyncJob(next);
  return next;
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
