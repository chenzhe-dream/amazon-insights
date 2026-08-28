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

export type SyncPublication =
  | { status: "not-required" }
  | {
    status: "pending";
    requestId: string;
    artifactId: string;
    requestedAt: string;
  }
  | {
    status: "applied";
    requestId: string;
    artifactId: string;
    requestedAt: string;
    appliedAt: string;
  }
  | {
    status: "failed";
    requestId: string;
    artifactId: string;
    requestedAt: string;
    failedAt: string;
    code: "WEB_PUBLICATION_FAILED";
  };

export type SyncJob = {
  jobId: string;
  jobVersion?: number;
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
  publication?: SyncPublication;
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
const TERMINAL_ASIN_MODULE = new Set<AsinModuleResult["status"]>([
  "ready",
  "upstream-empty",
  "timeout",
  "connector-failed",
  "manual",
]);
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

function imageRemarkCoverage(job: SyncJob): number {
  const detail = job.stages.find(stage => stage.id === "image_remarks")?.detail;
  const match = detail?.match(/已完成\s*(\d+)\s*\/\s*(\d+)\s*张\s*·\s*就绪\s*(\d+)/);
  if (!match) return 1;
  const total = Number(match[2]);
  const ready = Number(match[3]);
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(ready) || total < 1 || ready < 0 || ready > total) {
    return 1;
  }
  return ready / total;
}

function hasReadyModule(job: SyncJob, moduleId: "keywords" | "traffic") {
  const asins = job.asins ?? Object.keys(job.asinProgress);
  return asins.some(asin => job.asinProgress[asin]?.[moduleId]?.status === "ready");
}

type AuthoritativeStageProgress = {
  completed: number;
  total: number;
  unit: "个 ASIN" | "张";
};

function imageStageProgress(detail: string | undefined): AuthoritativeStageProgress | null {
  const match = detail?.match(/已完成\s*(\d+)\s*\/\s*(\d+)\s*张/);
  if (!match) return null;
  const completed = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isSafeInteger(completed) || !Number.isSafeInteger(total) || total < 1 || completed < 0 || completed > total) {
    return null;
  }
  return { completed, total, unit: "张" };
}

function asinStageProgress(job: SyncJob, stageId: string): AuthoritativeStageProgress {
  const asins = job.asins ?? Object.keys(job.asinProgress);
  const completed = asins.filter((asin) => {
    const status = job.asinProgress[asin]?.[stageId]?.status;
    return status !== undefined && TERMINAL_ASIN_MODULE.has(status);
  }).length;
  return { completed, total: asins.length, unit: "个 ASIN" };
}

function activeStageProgress(job: SyncJob, stage: SyncStage): AuthoritativeStageProgress {
  if (stage.id === "image_remarks") {
    const imageProgress = imageStageProgress(stage.detail);
    if (imageProgress) return imageProgress;
  }
  return asinStageProgress(job, stage.id);
}

function activeStagePercent(progress: AuthoritativeStageProgress) {
  if (progress.total === 0) return 0;
  return Math.min(99, Math.floor((progress.completed / progress.total) * 100));
}

function automaticStagePercent(job: SyncJob, stage: SyncStage) {
  if (TERMINAL_STAGE.has(stage.status)) return 100;
  if (stage.status !== "active") return 0;
  return activeStagePercent(activeStageProgress(job, stage));
}

function automaticStageFinishAt(stage: SyncStage) {
  if (["done", "skipped"].includes(stage.status)) return stage.completedAt ?? null;
  if (stage.status !== "active" || !stage.startedAt) return null;
  return new Date(new Date(stage.startedAt).getTime() + stage.estimatedSeconds * 1000).toISOString();
}

function remainingAutomaticSeconds(stages: readonly SyncStage[], now: number) {
  return stages.reduce((sum, stage) => {
    if (TERMINAL_STAGE.has(stage.status)) return sum;
    if (stage.status !== "active" || !stage.startedAt) return sum + stage.estimatedSeconds;
    const elapsed = (now - new Date(stage.startedAt).getTime()) / 1000;
    return sum + Math.max(0, stage.estimatedSeconds - elapsed);
  }, 0);
}

function automaticStatusCopy(status: string, progress?: AuthoritativeStageProgress) {
  if (status === "done") return "已完成";
  if (status === "skipped") return "已跳过";
  if (status === "active" && progress) return `处理中 · ${progress.completed}/${progress.total} ${progress.unit}`;
  if (status === "active") return "处理中";
  if (status === "failed") return "失败";
  if (status === "partial") return "部分缺口";
  return "排队中";
}

function presentStage(job: SyncJob, stage: SyncStage): SyncProgressRow {
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
  const terminalGap = stage.status === "partial" || stage.status === "skipped";
  const activeProgress = stage.status === "active" ? activeStageProgress(job, stage) : undefined;
  return {
    id: stage.id,
    label: stage.label,
    detail: stage.detail,
    status: stage.status,
    mode: "automatic",
    executionPercent: terminalGap ? 0 : automaticStagePercent(job, stage),
    statusCopy: terminalGap ? "流程已结束 · 数据缺口" : automaticStatusCopy(stage.status, activeProgress),
    finishAt: automaticStageFinishAt(stage),
  };
}

export function presentSyncProgress(job: SyncJob, now: number, focusStageIds?: readonly string[]): SyncProgressPresentation {
  const terminal = TERMINAL_JOB.has(job.status);
  const automatic = selectedStages(job.stages, focusStageIds).filter(stage => stage.kind === "auto");
  const executed = automatic.reduce(
    (sum, stage) => sum + automaticStagePercent(job, stage) / 100,
    0,
  );
  const remainingSeconds = terminal ? 0 : remainingAutomaticSeconds(automatic, now);
  const baseCompletenessPercent = dataCompletenessPercent(job, focusStageIds);
  return {
    terminal,
    executionPercent: terminal
      ? 100
      : Math.min(99, Math.round((executed / Math.max(automatic.length, 1)) * 100)),
    completenessPercent: Math.round(baseCompletenessPercent * imageRemarkCoverage(job)),
    remainingSeconds,
    finishAt: terminal ? null : new Date(now + remainingSeconds * 1000).toISOString(),
    rows: job.stages.map(stage => presentStage(job, stage)),
    sifDestinations: [
      ...(hasReadyModule(job, "keywords") ? [{ tab: "keywords" as const, label: "查看关键词调研" as const }] : []),
      ...(hasReadyModule(job, "traffic") ? [{ tab: "traffic" as const, label: "查看竞品流量分析" as const }] : []),
    ],
  };
}
