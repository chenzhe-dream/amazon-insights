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

export type SyncProgressPresentation = {
  executionPercent: number;
  completenessPercent: number;
  remainingSeconds: number;
  finishAt: string | null;
  terminal: boolean;
  rows: SyncProgressRow[];
};

const TERMINAL_JOB = new Set(["completed", "completed-with-gaps", "failed"]);
const TERMINAL_STAGE = new Set(["done", "partial", "skipped", "failed", "manual"]);

function selectedStages(stages: readonly SyncStage[], focusStageIds?: readonly string[]) {
  if (!focusStageIds?.length) return stages;
  return stages.filter(stage => focusStageIds.includes(stage.id));
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
  return {
    id: stage.id,
    label: stage.label,
    detail: stage.detail,
    status: stage.status,
    mode: "automatic",
    executionPercent: automaticStagePercent(stage, now, terminal),
    statusCopy: automaticStatusCopy(stage.status),
    finishAt: automaticStageFinishAt(stage),
  };
}

export function presentSyncProgress(job: SyncJob, now: number, focusStageIds?: readonly string[]): SyncProgressPresentation {
  const terminal = TERMINAL_JOB.has(job.status);
  const automatic = selectedStages(job.stages, focusStageIds).filter(stage => stage.kind === "auto");
  const executed = automatic.filter(stage => terminal || TERMINAL_STAGE.has(stage.status)).length;
  const complete = automatic.filter(stage => stage.status === "done").length;
  const remainingSeconds = terminal ? 0 : remainingAutomaticSeconds(automatic, now);
  return {
    terminal,
    executionPercent: Math.round((executed / Math.max(automatic.length, 1)) * 100),
    completenessPercent: Math.round((complete / Math.max(automatic.length, 1)) * 100),
    remainingSeconds,
    finishAt: terminal ? null : new Date(now + remainingSeconds * 1000).toISOString(),
    rows: job.stages.map(stage => presentStage(stage, now, terminal)),
  };
}
