import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getProjectRoot } from "./project-root.mjs";

const root = getProjectRoot();
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

export function createSyncJob({ asins, marketplace = "US", mcpAsinCount, vocPendingCount = 0, catalogAsinCount = 0 }) {
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
    asinProgress: Object.fromEntries(
      asins.map(asin => [
        asin,
        { keywords: "pending", reviews: "pending", sales: "pending", listing: "pending", imageRemarks: "pending", traffic: "pending", voc: "pending" },
      ])
    ),
  };
  writeSyncJob(job);
  return job;
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
