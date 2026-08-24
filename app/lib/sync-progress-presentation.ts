import type { AsinModuleResult } from "./sync-job-display";

export type SyncStage = {
  id: string;
  label: string;
  kind: "auto" | "manual";
  status: string;
  estimatedSeconds: number;
  detail?: string;
  manualNote?: string;
  startedAt?: string | null;
  completedAt?: string | null;
};

export type SyncJob = {
  jobId: string;
  asins?: string[];
  marketplace?: string;
  status: string;
  message: string;
  currentStageId: string;
  stages: SyncStage[];
  asinProgress: Record<string, Record<string, AsinModuleResult>>;
  alexaVoc?: {
    pendingAsins: string[];
    estimatedSeconds: number;
    deadlineAt: string;
  };
  needsReload?: boolean;
  queuePosition?: number | null;
  createdAt?: string;
  scope?: { projectId: string | null; runId: string | null };
  resumableStages?: string[];
};

export type SyncProgressRow = {
  id: string;
  label: string;
  detail?: string;
  status: string;
  mode: "automatic" | "manual" | "disabled";
  executionPercent: number;
  statusCopy: string;
  finishAt: string | null;
};

export type SifDiscoveryDestination = {
  tab: "keywords" | "traffic";
  label: "查看关键词调研" | "查看竞品流量分析";
};

export type SyncProgressPresentation = {
  executionPercent: number;
  completenessPercent: number;
  remainingSeconds: number;
  finishAt: string | null;
  terminal: boolean;
  rows: SyncProgressRow[];
  sifDestinations: readonly SifDiscoveryDestination[];
};

const TERMINAL_JOB = new Set(["completed", "completed-with-gaps", "failed"]);
const TERMINAL_STAGE = new Set(["done", "partial", "skipped", "failed", "manual"]);
const DATA_MODULE_IDS = [
  "catalog",
  "keywords",
  "reviews",
  "sales_trend",
  "child_sales",
  "price_strategy",
  "fba",
  "listing",
  "category",
  "traffic",
] as const;

function selectedStages(stages: readonly SyncStage[], focusStageIds?: readonly string[]) {
  if (!focusStageIds?.length) return stages;
  return stages.filter(stage => focusStageIds.includes(stage.id));
}

function dataCompletenessPercent(job: SyncJob, focusStageIds?: readonly string[]) {
  const asins = job.asins ?? Object.keys(job.asinProgress);
  const moduleIds = focusStageIds?.length
    ? DATA_MODULE_IDS.filter(moduleId => focusStageIds.includes(moduleId))
    : DATA_MODULE_IDS;
  const total = asins.length * moduleIds.length;
  if (total === 0) return 0;
  const ready = asins.reduce((count, asin) => (
    count + moduleIds.filter(moduleId => job.asinProgress[asin]?.[moduleId]?.status === "ready").length
  ), 0);
  return Math.round((ready / total) * 100);
}

function hasReadyModule(job: SyncJob, moduleId: "keywords" | "traffic") {
  const asins = job.asins ?? Object.keys(job.asinProgress);
  return asins.some(asin => job.asinProgress[asin]?.[moduleId]?.status === "ready");
}

function automaticStagePercent(stage: SyncStage, now: number, terminal: boolean) {
  if (terminal || TERMINAL_STAGE.has(stage.status)) return 100;
  if (stage.status !== "active" || !stage.startedAt) return 0;
  const elapsed = (now - new Date(stage.startedAt).getTime()) / 1000;
  return Math.max(6, Math.min(96, Math.round((elapsed / Math.max(stage.estimatedSeconds, 1)) * 100)));
}

function automaticStageFinishAt(stage: SyncStage) {
  if (["done", "skipped"].includes(stage.status)) return stage.completedAt ?? null;
  if (stage.status !== "active" || !stage.startedAt) return null;
  return new Date(new Date(stage.startedAt).getTime() + stage.estimatedSeconds * 1000).toISOString();
}

function remainingAutomaticSeconds(stages: readonly SyncStage[], now: number) {
  return stages.reduce((sum, stage) => {
    if (stage.id === "image_remarks" || TERMINAL_STAGE.has(stage.status)) return sum;
    if (stage.status !== "active" || !stage.startedAt) return sum + stage.estimatedSeconds;
    const elapsed = (now - new Date(stage.startedAt).getTime()) / 1000;
    return sum + Math.max(0, stage.estimatedSeconds - elapsed);
  }, 0);
}

function automaticStatusCopy(status: string) {
  if (status === "done") return "已完成";
  if (status === "skipped") return "已跳过";
  if (status === "active") return "拉取中";
  if (status === "failed") return "失败";
  if (status === "partial") return "部分缺口";
  return "排队中";
}

function presentStage(stage: SyncStage, now: number, terminal: boolean): SyncProgressRow {
  if (stage.id === "alexa_voc") {
    return {
      id: stage.id,
      label: stage.label,
      detail: stage.detail,
      status: stage.status,
      mode: "manual",
      executionPercent: 0,
      statusCopy: stage.status === "done" ? "已人工录入" : "待人工录入",
      finishAt: null,
    };
  }
  if (stage.id === "image_remarks") {
    return {
      id: stage.id,
      label: stage.label,
      detail: stage.detail,
      status: stage.status,
      mode: "disabled",
      executionPercent: 0,
      statusCopy: "已停用，待后续分析",
      finishAt: null,
    };
  }
  const terminalGap = stage.status === "partial" || stage.status === "skipped";
  return {
    id: stage.id,
    label: stage.label,
    detail: stage.detail,
    status: stage.status,
    mode: "automatic",
    executionPercent: terminalGap ? 0 : automaticStagePercent(stage, now, terminal),
    statusCopy: terminalGap ? "流程已结束 · 数据缺口" : automaticStatusCopy(stage.status),
    finishAt: automaticStageFinishAt(stage),
  };
}

export function presentSyncProgress(job: SyncJob, now: number, focusStageIds?: readonly string[]): SyncProgressPresentation {
  const terminal = TERMINAL_JOB.has(job.status);
  const automatic = selectedStages(job.stages, focusStageIds).filter(stage => stage.kind === "auto");
  const executed = automatic.filter(stage => terminal || TERMINAL_STAGE.has(stage.status)).length;
  const remainingSeconds = terminal ? 0 : remainingAutomaticSeconds(automatic, now);
  return {
    terminal,
    executionPercent: Math.round((executed / Math.max(automatic.length, 1)) * 100),
    completenessPercent: dataCompletenessPercent(job, focusStageIds),
    remainingSeconds,
    finishAt: terminal ? null : new Date(now + remainingSeconds * 1000).toISOString(),
    rows: job.stages.map(stage => presentStage(stage, now, terminal)),
    sifDestinations: [
      ...(hasReadyModule(job, "keywords") ? [{ tab: "keywords" as const, label: "查看关键词调研" as const }] : []),
      ...(hasReadyModule(job, "traffic") ? [{ tab: "traffic" as const, label: "查看竞品流量分析" as const }] : []),
    ],
  };
}
