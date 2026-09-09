"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { localAgentErrorMessage, localAgentFetch } from "./lib/local-agent-browser";
import { createSyncStartGate, isSyncJobScopeMatch } from "./lib/asin-sync-session";
import { createStageOutputOwner, type StageOutputSnapshot } from "./lib/stage-output-browser";
import { presentSyncProgress, type SyncJob } from "./lib/sync-progress-presentation";
import { publicationIsSettled, syncObservationKey, terminalSyncIsQuiescent } from "./lib/sync-terminal-convergence";
import { LocalDataSyncResumeResponseSchema } from "../shared/agent-contracts";
import {
  calculateAutoModuleReadiness,
  collectAsinModuleGaps,
  collectUnavailableProviderWarnings,
  jobLifecycleLabel,
  moduleStatusLabel,
  parseUnavailableProviderCapabilities,
  type AsinDataStatusItem,
  type UnavailableProviderCapabilities,
} from "./lib/sync-job-display";

export type { SyncJob } from "./lib/sync-progress-presentation";
export type { StageOutputSnapshot } from "./lib/stage-output-browser";

const STAGE_COLORS: Record<string, string> = {
  queue: "#8b97a6",
  catalog: "#4a90d9",
  keywords: "#2f80ed",
  reviews: "#e55353",
  sales_trend: "#7a67d8",
  child_sales: "#1aa8a1",
  price_strategy: "#e8912d",
  fba: "#1a9f63",
  listing: "#5b8def",
  image_remarks: "#9b6bdf",
  category: "#6366f1",
  alexa_voc: "#f0923e",
  traffic: "#2f80ed",
  build: "#34465d",
};

function formatCountdown(totalSeconds: number) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins}m`;
  }
  if (minutes > 0) return `${minutes}m ${rest.toString().padStart(2, "0")}s`;
  return `${rest}s`;
}

function formatClock(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function navigateToSifDestination(tab: "keywords" | "traffic") {
  const params = new URLSearchParams(window.location.search);
  params.set("tab", tab);
  window.location.assign(`${window.location.pathname}?${params.toString()}`);
}

type Props = {
  asins: string[];
  marketplace: string;
  projectId?: string | null;
  runId?: string | null;
  resumeJobId?: string | null;
  onJobId?: (jobId: string) => void;
  /** 仅展示这些阶段（仍跑完整同步任务）；用于关键词页等聚焦场景 */
  focusStageIds?: string[];
  onComplete?: (job: SyncJob) => void;
  onTerminal?: (job: SyncJob) => void;
  onDismiss?: () => void;
  onRestart?: () => void;
  canResumeFailedStages?: boolean;
  allowDismiss?: boolean;
  restoredFromHistory?: boolean;
  onSyncJobObserved?: (jobId: string) => void;
};

type AsinSyncStatusPayload = {
  needsSync: boolean;
  vocPending: string[];
  items: AsinDataStatusItem[];
};

type SectionProps = {
  asins: string[];
  marketplace: string;
  syncRequest: string[] | null;
  syncResume: SyncResumeBundle;
  onRequestSync: () => void;
  onSyncComplete?: () => void;
  onSyncDismiss?: () => void;
};

export type SyncResumeBundle = {
  syncJobId: string | null;
  terminalJob: SyncJob | null;
  projectId: string | null;
  runId: string | null;
  resumePending: boolean;
  resumeBlocked: boolean;
  workspaceReady: boolean;
  organizationId?: string | null;
  sessionIdentity?: string;
  stageOutputScopeKey?: string;
  onStageOutput?: (snapshot: StageOutputSnapshot, reason?: "owner-disposed") => void;
  onSyncJobId?: (jobId: string) => void;
  onDismiss?: () => void;
  onComplete?: (job: SyncJob) => SyncCompletionDisposition;
  onTerminal?: (job: SyncJob) => void;
  onRestart?: () => void;
  canResumeFailedStages?: boolean;
  allowDismiss?: boolean;
  knownSessionJobIds?: ReadonlySet<string>;
  onSyncJobObserved?: (jobId: string) => void;
};

export type SyncCompletionDisposition = "settled" | "navigation-started" | "convergence-blocked";

type UrlResumableFunnelProps = {
  asins: string[];
  marketplace: string;
  syncRequest: string[] | null;
  resume: SyncResumeBundle;
  focusStageIds?: string[];
  onComplete?: () => void;
  onDismiss?: () => void;
};

export function UrlResumableAsinSyncFunnel({
  asins,
  marketplace,
  syncRequest,
  resume,
  focusStageIds,
  onComplete,
  onDismiss,
}: UrlResumableFunnelProps) {
  const resumeJobId = resume.syncJobId ?? resume.terminalJob?.jobId ?? null;
  if (!syncRequest && !resumeJobId) return null;
  if (!resume.workspaceReady) {
    return <section className="card asin-sync-progress" aria-busy="true">正在加载工作区…</section>;
  }
  if (resume.resumePending) {
    return <section className="card asin-sync-progress" aria-busy="true">正在恢复同步任务…</section>;
  }
  if (resume.resumeBlocked) {
    return <section className="card asin-sync-progress" data-sync-resume="invalid">同步任务工作区无效，未启动同步。</section>;
  }
  return (
    <AsinSyncFunnel
      key={resumeJobId ?? "new"}
      asins={syncRequest ?? asins}
      marketplace={marketplace}
      projectId={resume.projectId}
      runId={resume.runId}
      resumeJobId={resumeJobId}
      terminalJob={resume.terminalJob}
      organizationId={resume.organizationId}
      sessionIdentity={resume.sessionIdentity}
      stageOutputScopeKey={resume.stageOutputScopeKey}
      restoredFromHistory={Boolean(resumeJobId && !syncRequest && !resume.knownSessionJobIds?.has(resumeJobId))}
      onSyncJobObserved={resume.onSyncJobObserved}
      onStageOutput={resume.onStageOutput}
      onJobId={resume.onSyncJobId}
      focusStageIds={focusStageIds}
      onComplete={job => {
        const disposition = resume.onComplete?.(job);
        if (!resume.onComplete || disposition === "settled") onComplete?.();
      }}
      onTerminal={job => resume.onTerminal?.(job)}
      onDismiss={() => {
        resume.onDismiss?.();
        onDismiss?.();
      }}
      onRestart={resume.onRestart}
      canResumeFailedStages={resume.canResumeFailedStages}
      allowDismiss={resume.allowDismiss}
    />
  );
}

export function AsinSyncProgressSection({
  asins,
  marketplace,
  syncRequest,
  syncResume,
  onRequestSync,
  onSyncComplete,
}: SectionProps) {
  const [status, setStatus] = useState<AsinSyncStatusPayload | null>(null);
  const [capabilities, setCapabilities] = useState<UnavailableProviderCapabilities | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    if (asins.length < 1) {
      setStatus(null);
      setCapabilities(null);
      return;
    }
    try {
      const [response, capabilitiesResponse] = await Promise.all([
        localAgentFetch(`/v1/local-data/sync-asins?asins=${encodeURIComponent(asins.join(","))}`),
        localAgentFetch("/v1/capabilities").catch(() => null),
      ]);
      const payload = (await response.json()) as AsinSyncStatusPayload & { error?: unknown };
      if (!response.ok) throw new Error(localAgentErrorMessage(payload, "无法读取 MCP 状态"));
      let nextCapabilities: UnavailableProviderCapabilities | null = null;
      if (capabilitiesResponse?.ok) {
        try {
          const capabilitiesPayload = await capabilitiesResponse.json() as unknown;
          nextCapabilities = parseUnavailableProviderCapabilities(capabilitiesPayload);
        } catch {
          nextCapabilities = null;
        }
      }
      setStatus(payload);
      setCapabilities(nextCapabilities);
      setStatusError(null);
    } catch (err) {
      setCapabilities(null);
      setStatusError(err instanceof Error ? err.message : "无法读取 MCP 状态");
    }
  }, [asins]);

  useEffect(() => {
    if (syncRequest || syncResume.syncJobId || syncResume.terminalJob) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void refreshStatus();
    });
    return () => {
      cancelled = true;
    };
  }, [refreshStatus, syncRequest, syncResume.syncJobId, syncResume.terminalJob]);

  if (syncRequest || syncResume.syncJobId || syncResume.terminalJob) {
    return (
      <UrlResumableAsinSyncFunnel
        asins={syncRequest ?? asins}
        marketplace={marketplace}
        syncRequest={syncRequest}
        resume={syncResume}
        onComplete={() => {
          onSyncComplete?.();
        }}
        onDismiss={() => {
          refreshStatus();
        }}
      />
    );
  }

  const items = status?.items ?? [];
  const autoReadiness = calculateAutoModuleReadiness(items);
  const needsSync = status?.needsSync ?? false;
  const vocPending = status?.vocPending ?? [];
  const providerWarnings = collectUnavailableProviderWarnings(items, capabilities);

  return (
    <section className="card asin-sync-progress asin-sync-progress-idle">
      <div className="sync-progress-head">
        <div className="sync-progress-head-copy">
          <span className="status-chip">MCP 拉取进度</span>
          <h3>{needsSync ? "部分 MCP 数据待拉取" : "MCP 数据已就绪"}</h3>
          <p>
            {asins.length} 个 ASIN · 新 ASIN 自动入库底库 · 模块串行拉取 · Alexa VOC 需人工录入
          </p>
        </div>
        <div className="sync-progress-summary">
          <span>
            自动模块就绪 <b>{autoReadiness.ready}/{autoReadiness.total}（{autoReadiness.percent}%）</b>
          </span>
          {vocPending.length > 0 ? (
            <span className="sync-progress-voc-eta">
              待录入 VOC <b>{vocPending.length}</b> 个
            </span>
          ) : null}
          {needsSync ? (
            <button type="button" className="ghost-btn sync-progress-dismiss" onClick={onRequestSync}>
              拉取缺失数据
            </button>
          ) : null}
        </div>
      </div>

      {providerWarnings.length > 0 ? (
        <div className="sync-provider-warning" role="status" data-provider-warning="true">
          <strong>部分数据源不可用，仍可继续分析</strong>
          {providerWarnings.map(warning => <p key={warning.connectorId}>{warning.message}</p>)}
        </div>
      ) : null}

      <div className="sync-progress-overall">
        <i style={{ width: `${autoReadiness.percent}%` }} />
      </div>

      {statusError ? <p className="sync-progress-foot error">{statusError}</p> : null}
      {vocPending.length > 0 ? (
        <p className="sync-progress-foot">
          待 Alexa 录入：<code>{vocPending.join(", ")}</code>
        </p>
      ) : null}
    </section>
  );
}

export function AsinSyncFunnel({ asins, marketplace, projectId = null, runId = null, resumeJobId = null, terminalJob = null, organizationId = null, sessionIdentity = "", stageOutputScopeKey = "", onStageOutput, onJobId, focusStageIds, onComplete, onTerminal, onDismiss, onRestart, canResumeFailedStages = false, allowDismiss = true, restoredFromHistory = false, onSyncJobObserved }: Props & { terminalJob?: SyncJob | null; organizationId?: string | null; sessionIdentity?: string; stageOutputScopeKey?: string; onStageOutput?: (snapshot: StageOutputSnapshot, reason?: "owner-disposed") => void }) {
  const [jobId, setJobId] = useState<string | null>(resumeJobId);
  const [job, setJob] = useState<SyncJob | null>(terminalJob);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [repairNotice, setRepairNotice] = useState<string | null>(null);
  const [pollRevision, setPollRevision] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [historicalOrigin, setHistoricalOrigin] = useState(restoredFromHistory);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const startOnce = useRef(createSyncStartGate());
  const completedJobs = useRef(new Set(terminalJob ? [terminalJob.jobId] : []));
  const authorizedOwner = useRef({ organizationId, sessionIdentity });
  const pollInFlightJobId = useRef<string | null>(null);
  const clockTimerRef = useRef<number | null>(null);
  const lastObservationKey = useRef<string | null>(null);
  const repairInFlight = useRef(false);
  const onCompleteRef = useRef(onComplete);
  const onTerminalRef = useRef(onTerminal);
  const onStageOutputRef = useRef(onStageOutput);
  const stageOutputOwnerRef = useRef<{
    key: string;
    owner: ReturnType<typeof createStageOutputOwner>;
  } | null>(null);
  const pollAsinKey = [...new Set(asins.map(asin => asin.trim().toUpperCase()).filter(Boolean))].sort().join(",");
  const pollAsins = useMemo(() => pollAsinKey ? pollAsinKey.split(",") : [], [pollAsinKey]);
  const focused = Boolean(focusStageIds?.length);
  const stopClock = useCallback(() => {
    if (clockTimerRef.current === null) return;
    window.clearInterval(clockTimerRef.current);
    clockTimerRef.current = null;
  }, []);
  const dismissSync = useCallback(() => {
    setJobId(null);
    setJob(null);
    setError(null);
    onDismiss?.();
  }, [onDismiss]);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  useEffect(() => {
    onTerminalRef.current = onTerminal;
  }, [onTerminal]);

  useEffect(() => {
    onStageOutputRef.current = onStageOutput;
  }, [onStageOutput]);

  useEffect(() => {
    lastObservationKey.current = null;
  }, [jobId, organizationId, projectId, runId, stageOutputScopeKey]);

  useEffect(() => {
    const previous = authorizedOwner.current;
    authorizedOwner.current = { organizationId, sessionIdentity };
    // Only a real auth transition rearms a settled job. Mounts, tab changes and
    // terminal publication updates must retain their once-only completion guard.
    if (previous.organizationId !== organizationId || previous.sessionIdentity !== sessionIdentity) {
      completedJobs.current.clear();
    }
  }, [organizationId, sessionIdentity]);

  useEffect(() => {
    return () => {
      stageOutputOwnerRef.current?.owner.clear();
      stageOutputOwnerRef.current = null;
      onStageOutputRef.current?.({}, "owner-disposed");
    };
  }, [organizationId, projectId, runId, resumeJobId, sessionIdentity, stageOutputScopeKey]);

  const startSync = useCallback(async () => {
    setStarting(true);
    setError(null);
    try {
      const response = await localAgentFetch("/v1/local-data/sync-asins", {
        method: "POST",
        body: JSON.stringify({ asins, marketplace, ...(projectId ? { projectId } : {}), ...(runId ? { runId } : {}) }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(localAgentErrorMessage(payload, "启动同步失败"));
      setJobId(payload.jobId);
      onJobId?.(payload.jobId);
      setJob({
        jobId: payload.jobId,
        status: payload.status,
        message: payload.message,
        currentStageId: "queue",
        stages: payload.stages ?? [],
        asinProgress: {},
      });
      onSyncJobObserved?.(payload.jobId);
      setHistoricalOrigin(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "启动同步失败");
    } finally {
      setStarting(false);
    }
  }, [asins, marketplace, onJobId, onSyncJobObserved, projectId, runId]);

  const resumeFailedStages = useCallback(async () => {
    const activeJobId = job?.jobId ?? jobId;
    if (
      repairInFlight.current ||
      !activeJobId ||
      !canResumeFailedStages ||
      (historicalOrigin && job?.status === "failed" && job.publication?.status === "pending") ||
      !hasResumableFailedStages(job)
    ) return;
    repairInFlight.current = true;
    setRepairing(true);
    setRepairNotice(null);
    setError(null);
    try {
      const response = await localAgentFetch(
        `/v1/admin/sync-asins/${encodeURIComponent(activeJobId)}/resume`,
        { method: "POST" },
      );
      const rawPayload: unknown = await response.json();
      const parsedPayload = LocalDataSyncResumeResponseSchema.safeParse(rawPayload);
      if (!response.ok || !parsedPayload.success || parsedPayload.data.job.jobId !== activeJobId) {
        throw new Error(localAgentErrorMessage(rawPayload, "续跑失败阶段失败"));
      }
      const payload = parsedPayload.data;
      const owner = stageOutputOwnerRef.current?.owner;
      if (owner) {
        const before = owner.snapshot();
        const restarted = owner.restartTerminalEpisode(payload.resumedStages);
        if (restarted !== before) onStageOutputRef.current?.(restarted);
      }
      completedJobs.current.delete(activeJobId);
      lastObservationKey.current = null;
      setJobId(activeJobId);
      setJob(payload.job);
      onSyncJobObserved?.(activeJobId);
      setHistoricalOrigin(false);
      setRepairNotice(failedStageRepairMessage(Boolean(payload.reused)));
      onJobId?.(activeJobId);
      setPollRevision((revision) => revision + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "续跑失败阶段失败");
    } finally {
      repairInFlight.current = false;
      setRepairing(false);
    }
  }, [canResumeFailedStages, historicalOrigin, job, jobId, onJobId, onSyncJobObserved]);

  useEffect(() => {
    if (resumeJobId) return;
    if (jobId && completedJobs.current.has(jobId)) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled && startOnce.current()) void startSync();
    });
    return () => {
      cancelled = true;
    };
  }, [jobId, resumeJobId, startSync]);

  useEffect(() => {
    if (
      !jobId ||
      completedJobs.current.has(jobId) ||
      (stageOutputScopeKey && !organizationId) ||
      clockTimerRef.current !== null
    ) return;
    clockTimerRef.current = window.setInterval(() => setNow(Date.now()), 1_000);
    return stopClock;
  }, [jobId, organizationId, pollRevision, sessionIdentity, stageOutputScopeKey, stopClock]);

  useEffect(() => {
    if (!jobId || completedJobs.current.has(jobId) || (stageOutputScopeKey && !organizationId)) return;
    let cancelled = false;
    let pollingStopped = false;

    const stopPolling = () => {
      pollingStopped = true;
      window.clearInterval(interval);
    };

    const poll = async () => {
      if (pollingStopped || pollInFlightJobId.current === jobId) return;
      // Capture the callback for this owner; a later session must not relabel its response.
      const emitStageOutput = onStageOutputRef.current;
      pollInFlightJobId.current = jobId;
      try {
        let outputsSettled = true;
        const response = await localAgentFetch(`/v1/local-data/sync-asins/${encodeURIComponent(jobId)}`);
        const payload = (await response.json()) as SyncJob & { error?: unknown };
        if (cancelled || pollingStopped || completedJobs.current.has(jobId)) return;
        if (!response.ok) {
          const message = localAgentErrorMessage(payload, "无法读取同步进度");
          if (response.status >= 400 && response.status < 500) {
            if (!cancelled) setError(message);
            stopPolling();
            return;
          }
          throw new Error(message);
        }
        if (cancelled) return;
        if (resumeJobId && !isSyncJobScopeMatch(
          { asins: payload.asins ?? [], marketplace: payload.marketplace ?? "", scope: payload.scope },
          { asins: pollAsins, marketplace, projectId, runId },
        )) {
          setError("同步任务与当前工作区不匹配，请确认后手动重新发起同步。");
          stopPolling();
          return;
        }
        if (organizationId && projectId && runId && payload.jobId === jobId) {
          const ownerKey = [sessionIdentity, stageOutputScopeKey, organizationId, projectId, runId, jobId].join(":");
          if (stageOutputOwnerRef.current?.key !== ownerKey) {
            stageOutputOwnerRef.current?.owner.clear();
            stageOutputOwnerRef.current = {
              key: ownerKey,
              owner: createStageOutputOwner({ organizationId, projectId, runId, jobId }),
            };
          }
          const owner = stageOutputOwnerRef.current.owner;
          const stages = owner.observeJob(payload);
          await Promise.all(stages.map(async stage => {
            const before = owner.snapshot();
            try {
              const stageResponse = await localAgentFetch(
                `/v1/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/sync-jobs/${encodeURIComponent(jobId)}/stages/${stage}/output`,
              );
              if (cancelled || pollingStopped) return null;
              const stagePayload: unknown = stageResponse.ok ? await stageResponse.json() : null;
              if (cancelled || pollingStopped) return null;
              const outcome = stageResponse.ok
                ? owner.accept(stage, stagePayload)
                : owner.missing(stage);
              if (
                owner.snapshot() !== before &&
                (outcome.kind === "applied" || outcome.kind === "missing-output")
              ) {
                emitStageOutput?.(owner.snapshot());
              }
              return outcome;
            } catch {
              if (cancelled || pollingStopped) return null;
              const outcome = owner.missing(stage);
              if (owner.snapshot() !== before && outcome.kind === "missing-output") {
                emitStageOutput?.(owner.snapshot());
              }
              return outcome;
            }
          }));
          outputsSettled = owner.outputsSettled(payload);
        }
        if (cancelled || pollingStopped) return;
        if (!["completed", "completed-with-gaps", "failed"].includes(payload.status)) {
          onSyncJobObserved?.(jobId);
          setHistoricalOrigin(false);
        }
        const observationKey = syncObservationKey(payload);
        if (observationKey === null || observationKey !== lastObservationKey.current) {
          lastObservationKey.current = observationKey;
          setError(null);
          setJob(payload);
        }
        if (terminalSyncIsQuiescent(payload, outputsSettled)) {
          completedJobs.current.add(jobId);
          stopPolling();
          stopClock();
          if (payload.status === "failed") {
            setError(payload.message);
            onTerminalRef.current?.(payload);
          } else {
            onCompleteRef.current?.(payload);
          }
          return;
        }
      } catch {
        if (!cancelled) setError("无法读取同步进度");
      } finally {
        if (pollInFlightJobId.current === jobId) pollInFlightJobId.current = null;
      }
    };

    const interval = window.setInterval(poll, 1500);
    void poll();
    if (pollingStopped) window.clearInterval(interval);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [jobId, marketplace, onSyncJobObserved, organizationId, pollAsinKey, pollAsins, pollRevision, projectId, resumeJobId, runId, sessionIdentity, stageOutputScopeKey, stopClock]);

  const focusCopy = useMemo(() => {
    const ids = focusStageIds ?? [];
    if (ids.includes("traffic")) {
      return {
        chip: "流量相关拉取",
        readyTitle: "流量模块已就绪",
        description: `${asins.length} 个 ASIN · 本页关注商品底库 + SIF Listing 流量结构 / 月趋势`,
        footnote: "商品底库与流量结构已完成；后台仍在补齐其他 MCP 模块，本页可先查看推广能力分析。",
      };
    }
    if (ids.includes("keywords")) {
      return {
        chip: "关键词相关拉取",
        readyTitle: "流量词模块已就绪",
        description: `${asins.length} 个 ASIN · 本页关注商品底库 + SIF 关键词 / 月搜 enrichment`,
        footnote: "商品底库与 SIF 关键词已完成；后台仍在补齐其他 MCP 模块，本页可先查看流量词分析。",
      };
    }
    return {
      chip: "聚焦模块拉取",
      readyTitle: "关注模块已就绪",
      description: `${asins.length} 个 ASIN · 本页仅展示关注的同步阶段`,
      footnote: "关注模块已完成；后台仍在补齐其他 MCP 模块。",
    };
  }, [focusStageIds, asins.length]);

  const overall = useMemo(() => {
    if (!job) {
      return {
        terminal: false,
        executionPercent: 0,
        completenessPercent: 0,
        remainingSeconds: 0,
        finishAt: null,
        rows: [],
        sifDestinations: [],
        focusReady: false,
      };
    }
    const progress = presentSyncProgress(job, now, focusStageIds);
    const focusedAutomaticStages = focusStageIds?.length
      ? job.stages.filter(stage => focusStageIds.includes(stage.id) && stage.kind === "auto")
      : [];
    return {
      ...progress,
      rows: focused ? progress.rows.filter(row => focusStageIds?.includes(row.id)) : progress.rows,
      focusReady: focused && focusedAutomaticStages.length > 0
        && focusedAutomaticStages.every(stage => ["done", "skipped"].includes(stage.status)),
    };
  }, [focusStageIds, focused, job, now]);
  const publicationBlocksTerminalActions = Boolean(
    job &&
    (job.status === "completed" || job.status === "completed-with-gaps") &&
    !publicationIsSettled(job),
  );
  const historicalFailure = historicalOrigin && job?.status === "failed";
  const historicalActionsBlocked = historicalFailure && job?.publication?.status === "pending";

  if (historicalFailure && !historyExpanded) {
    return (
      <section className="card asin-sync-progress asin-sync-progress-idle" data-sync-history="collapsed">
        <div className="sync-progress-head">
          <div className="sync-progress-head-copy">
            <span className="status-chip">历史任务</span>
            <h3>{jobLifecycleLabel(job.status)}</h3>
            <p>{job.message}</p>
          </div>
          <div className="sync-progress-summary">
            <button type="button" className="ghost-btn sync-progress-dismiss" aria-expanded="false" onClick={() => setHistoryExpanded(true)}>
              查看详情
            </button>
            {!publicationBlocksTerminalActions && !historicalActionsBlocked && onRestart ? <button type="button" className="ghost-btn sync-progress-dismiss" onClick={onRestart}>重新发起</button> : null}
            {!publicationBlocksTerminalActions && !historicalActionsBlocked && onDismiss && allowDismiss ? <button type="button" className="ghost-btn sync-progress-dismiss" onClick={dismissSync}>关闭</button> : null}
          </div>
        </div>
      </section>
    );
  }

  if (error && !job) {
    return (
      <section className="card asin-sync-progress error">
        <div className="sync-progress-head">
          <div>
            <h3>数据拉取失败</h3>
            <p>{error}</p>
          </div>
          {onDismiss && allowDismiss ? (
            <button type="button" className="ghost-btn" onClick={dismissSync}>
              关闭
            </button>
          ) : null}
        </div>
      </section>
    );
  }

  return (
    <section className={`card asin-sync-progress${focused ? " asin-sync-progress-focused" : ""}`} data-sync-history={historicalFailure ? "expanded" : undefined}>
      <div className="sync-progress-head">
        <div className="sync-progress-head-copy">
          <span className="status-chip">{focused ? focusCopy.chip : job ? jobLifecycleLabel(job.status) : "MCP 拉取进度"}</span>
          <h3>
            {starting
              ? "正在启动…"
              : overall.focusReady && job?.status !== "completed"
                ? focusCopy.readyTitle
                : job?.message ?? "同步进行中"}
          </h3>
          <p>
            {focused
              ? focusCopy.description
              : `${asins.length} 个 ASIN · 基础模块优先，traffic 完成后才补充图片备注；Alexa VOC 需人工录入`}
          </p>
        </div>
        <div className="sync-progress-summary">
          {overall.terminal ? (
            <span>
              流程 <b>已结束</b>
            </span>
          ) : (
            <span>
              执行进度 <b>{overall.executionPercent}%</b>
            </span>
          )}
          <span>
            数据完整度 <b>{overall.completenessPercent}%</b>
          </span>
          {typeof job?.queuePosition === "number" && job.queuePosition > 0 ? (
            <span>{`队列 #${job.queuePosition}`}</span>
          ) : null}
          {overall.sifDestinations.map(destination => (
            <button
              key={destination.tab}
              type="button"
              className="ghost-btn sync-progress-dismiss"
              onClick={() => navigateToSifDestination(destination.tab)}
            >
              {destination.label}
            </button>
          ))}
          {!overall.terminal ? (
            <>
              <span>
                剩余 <b>{formatCountdown(overall.remainingSeconds)}</b>
              </span>
              <span>
                预计完成 <b>{formatClock(overall.finishAt)}</b>
              </span>
            </>
          ) : null}
          {!publicationBlocksTerminalActions && !historicalActionsBlocked && canResumeFailedStages && hasResumableFailedStages(job) ? (
            <button
              type="button"
              className="ghost-btn sync-progress-dismiss"
              disabled={repairing}
              onClick={() => void resumeFailedStages()}
            >
              {repairing ? "续跑中…" : "续跑失败阶段"}
            </button>
          ) : null}
          {!publicationBlocksTerminalActions && !historicalActionsBlocked && onRestart && (job?.status === "completed" || job?.status === "completed-with-gaps" || job?.status === "failed") ? (
            <button type="button" className="ghost-btn sync-progress-dismiss" onClick={onRestart}>
              重新发起
            </button>
          ) : null}
          {!publicationBlocksTerminalActions && !historicalActionsBlocked && onDismiss && allowDismiss && (job?.status === "completed" || job?.status === "completed-with-gaps" || job?.status === "failed" || overall.focusReady) ? (
            <button type="button" className="ghost-btn sync-progress-dismiss" onClick={dismissSync}>
              {job?.status === "failed" ? "关闭" : "收起"}
            </button>
          ) : null}
          {historicalFailure ? (
            <button type="button" className="ghost-btn sync-progress-dismiss" aria-expanded="true" onClick={() => setHistoryExpanded(false)}>
              收起历史
            </button>
          ) : null}
        </div>
      </div>

      <div className="sync-progress-overall">
        <i style={{ width: `${overall.executionPercent}%` }} />
      </div>

      <ul className="sync-progress-list">
        {overall.rows.map(row => {
          const color = STAGE_COLORS[row.id] ?? "#2f80ed";
          const isActive = row.mode === "automatic" && (row.status === "active" || row.id === job?.currentStageId);
          const gapTerminal = row.status === "partial" || row.status === "skipped";
          const finishLabel = row.status === "done" || row.status === "skipped" ? "完成" : "预计";
          return (
            <li
              key={row.id}
              data-testid={`sync-stage-${row.id}`}
              className={`sync-progress-row status-${row.status} mode-${row.mode}${isActive ? " is-current" : ""}`}
              style={{ "--stage-color": color } as CSSProperties}
            >
              <div className="sync-progress-row-main">
                <div className="sync-progress-row-title">
                  <strong>{row.label}</strong>
                  {row.detail ? <span className="sync-progress-detail">{row.detail}</span> : null}
                </div>
                <div className="sync-progress-row-side">
                  <span className="sync-progress-status">{row.statusCopy}</span>
                  {row.mode === "automatic" && !gapTerminal ? (
                    <>
                      <span className="sync-progress-percent">{row.executionPercent}%</span>
                      {!overall.terminal ? (
                        <span className="sync-progress-eta">
                          ~{formatCountdown(job?.stages.find(stage => stage.id === row.id)?.estimatedSeconds ?? 0)} · {finishLabel}{" "}
                          {formatClock(row.finishAt)}
                        </span>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </div>
              {row.mode === "automatic" && !gapTerminal ? (
                <div className="sync-progress-track">
                  <i style={{ width: `${row.executionPercent}%` }} />
                </div>
              ) : null}
              {row.id === "alexa_voc" && job?.stages.find(stage => stage.id === row.id)?.manualNote && row.status === "manual" ? (
                <p className="sync-progress-manual-note">
                  {job?.alexaVoc?.pendingAsins.length ? (
                    <>
                      待录入 <code>{job.alexaVoc.pendingAsins.join(", ")}</code>
                    </>
                  ) : (
                    job.stages.find(stage => stage.id === row.id)?.manualNote
                  )}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>

      {job?.status === "completed" || job?.status === "completed-with-gaps" ? (
        <p className="sync-progress-foot">
          {job.status === "completed-with-gaps"
            ? "同步已完成，但下方列出的 ASIN/模块存在明确缺口；基础数据仍可使用。"
            : "同步已完成。"}
        </p>
      ) : null}
      {job?.publication?.status === "pending" ? (
        <p role="status">数据已生成，正在发布到页面，请勿重复提交。</p>
      ) : job?.publication?.status === "failed" ? (
        <p role="alert" className="error">数据已生成，但页面发布失败。数据不会重新抓取。</p>
      ) : job?.publication?.status === "applied" ? (
        <p role="status">数据已发布。</p>
      ) : null}
      {job && collectAsinModuleGaps(job.asinProgress).length ? (
        <div className="sync-progress-foot" data-asin-module-gaps="true">
          {collectAsinModuleGaps(job.asinProgress).map(gap => (
            <p key={`${gap.asin}-${gap.module}`}>
              {gap.asin} · {gap.module}：{moduleStatusLabel[gap.status]}{gap.reason ? `（${gap.reason}）` : ""}
            </p>
          ))}
        </div>
      ) : null}
      {overall.focusReady && job?.status !== "completed" ? (
        <p className="sync-progress-foot">
          {focusCopy.footnote}
        </p>
      ) : null}
      {repairNotice ? <p className="sync-progress-foot" role="status">{repairNotice}</p> : null}
      {error ? <p className="sync-progress-foot error">{error}</p> : null}
    </section>
  );
}

const resumableRepairStageStatuses = new Set(["failed", "partial", "pending", "active", "running"]);

export function hasResumableFailedStages(job: SyncJob | null | undefined): boolean {
  if (!job || !["completed", "completed-with-gaps", "failed"].includes(job.status)) return false;
  if (job.resumableStages) return job.resumableStages.length > 0;
  return job.stages.some((stage) =>
    stage.kind === "auto" && stage.id !== "queue" && resumableRepairStageStatuses.has(stage.status)
  );
}

export function failedStageRepairMessage(reused: boolean): string {
  return reused ? "已复用正在续跑的原任务" : "失败阶段已提交续跑";
}
