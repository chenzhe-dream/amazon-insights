"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { localAgentErrorMessage, localAgentFetch } from "./lib/local-agent-browser";
import { createSyncStartGate, isSyncJobScopeMatch } from "./lib/asin-sync-session";

type SyncStage = {
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

type SyncJob = {
  jobId: string;
  asins?: string[];
  marketplace?: string;
  status: string;
  message: string;
  currentStageId: string;
  stages: SyncStage[];
  asinProgress: Record<string, Record<string, string>>;
  alexaVoc?: {
    pendingAsins: string[];
    estimatedSeconds: number;
    deadlineAt: string;
  };
  needsReload?: boolean;
  createdAt?: string;
  scope?: { projectId: string | null; runId: string | null };
};

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

function statusLabel(status: string) {
  if (status === "done") return "已完成";
  if (status === "skipped") return "已跳过";
  if (status === "active") return "拉取中";
  if (status === "manual") return "待手工";
  if (status === "failed") return "失败";
  return "排队中";
}

function stageProgress(stage: SyncStage, now: number, alexaRemaining: number | null) {
  if (stage.status === "done" || stage.status === "skipped") return 100;
  if (stage.status === "failed") return 100;
  if (stage.status === "manual") {
    if (stage.id === "alexa_voc" && alexaRemaining != null && stage.estimatedSeconds > 0) {
      const elapsed = stage.estimatedSeconds - alexaRemaining;
      return Math.max(8, Math.min(92, Math.round((elapsed / stage.estimatedSeconds) * 100)));
    }
    return 18;
  }
  if (stage.status === "active" && stage.startedAt) {
    const elapsed = (now - new Date(stage.startedAt).getTime()) / 1000;
    return Math.max(6, Math.min(96, Math.round((elapsed / Math.max(stage.estimatedSeconds, 1)) * 100)));
  }
  return 0;
}

function stageRemainingSeconds(stage: SyncStage, now: number, alexaRemaining: number | null) {
  if (["done", "skipped"].includes(stage.status)) return 0;
  if (stage.kind === "manual") return 0;
  if (stage.status === "active" && stage.startedAt) {
    const elapsed = (now - new Date(stage.startedAt).getTime()) / 1000;
    return Math.max(0, stage.estimatedSeconds - elapsed);
  }
  return stage.estimatedSeconds;
}

function vocRemainingSeconds(stage: SyncStage | undefined, alexaRemaining: number | null) {
  if (!stage || ["done", "skipped"].includes(stage.status)) return 0;
  if (stage.status === "manual" && alexaRemaining != null) return alexaRemaining;
  return stage.estimatedSeconds;
}

function stageFinishText(stage: SyncStage, now: number, alexaRemaining: number | null) {
  if (stage.status === "done" || stage.status === "skipped") {
    return formatClock(stage.completedAt);
  }
  if (stage.status === "active" && stage.startedAt) {
    return formatClock(new Date(new Date(stage.startedAt).getTime() + stage.estimatedSeconds * 1000).toISOString());
  }
  if (stage.status === "manual" && stage.id === "alexa_voc" && alexaRemaining != null) {
    return formatClock(new Date(now + alexaRemaining * 1000).toISOString());
  }
  return "—";
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
  onDismiss?: () => void;
  onReload?: () => void;
};

export const SYNC_STAGE_TEMPLATE = [
  { id: "catalog", label: "卖家精灵商品底库", detail: "asin_detail + 销量趋势 → competitor-data.ts", kind: "auto" as const },
  { id: "keywords", label: "SIF 关键词 MCP", detail: "流量词信号 + 月搜索量 enrichment", kind: "auto" as const },
  { id: "reviews", label: "Sorftime 评论 MCP", detail: "product_detail 评分/评论 + Customers Say + 评论样本", kind: "auto" as const },
  { id: "sales_trend", label: "销量 / 价格 / BSR 趋势", detail: "Sorftime · 月销量 / 销售额 / 历史价格 / 大类 BSR", kind: "auto" as const },
  { id: "child_sales", label: "近30天子体销量", detail: "Sorftime · product_variations 变体评论占比 + 子体销量", kind: "auto" as const },
  { id: "price_strategy", label: "价格策略分析", detail: "Sorftime · 定价锚点 / 促销手法", kind: "auto" as const },
  { id: "fba", label: "FBA 费用", detail: "Sorftime · 包装尺寸估费", kind: "auto" as const },
  { id: "listing", label: "主辅图 / A+", detail: "Sorftime · main_image / a_plus", kind: "auto" as const },
  { id: "image_remarks", label: "主辅图视觉备注", detail: "OpenAI 视觉分析每张主辅图 · 需 OPENAI_API_KEY", kind: "auto" as const },
  { id: "category", label: "BSR 小类市场趋势", detail: "Sorftime · 小类 Top100 口径", kind: "auto" as const },
  { id: "alexa_voc", label: "Alexa VOC 核心主题", detail: "Playwright 自动提交七问并写入 rufus-voc-data", kind: "auto" as const },
  { id: "traffic", label: "竞品流量结构", detail: "SIF · Listing 流量结构 + 子体拆解 + 近6月月趋势", kind: "auto" as const },
] as const;

export type AsinDataStatusItem = {
  asin: string;
  inCatalog: boolean;
  keywords: "ready" | "missing";
  reviews: "ready" | "missing";
  sales: "ready" | "missing";
  childSales: "ready" | "missing";
  priceStrategy: "ready" | "missing";
  fba: "ready" | "missing";
  listing: "ready" | "missing";
  imageRemarks: "ready" | "missing";
  category: "ready" | "missing";
  traffic: "ready" | "missing";
  voc: "ready" | "missing";
};

type AsinSyncStatusPayload = {
  needsSync: boolean;
  vocPending: string[];
  items: AsinDataStatusItem[];
};

const STATUS_FIELD_BY_STAGE = {
  keywords: "keywords",
  reviews: "reviews",
  sales_trend: "sales",
  child_sales: "childSales",
  price_strategy: "priceStrategy",
  fba: "fba",
  listing: "listing",
  image_remarks: "imageRemarks",
  category: "category",
  alexa_voc: "voc",
  traffic: "traffic",
} as const satisfies Record<Exclude<(typeof SYNC_STAGE_TEMPLATE)[number]["id"], "catalog">, keyof AsinDataStatusItem>;

export function idleStageStatus(
  stageId: (typeof SYNC_STAGE_TEMPLATE)[number]["id"],
  items: AsinDataStatusItem[]
): "done" | "pending" | "manual" {
  if (!items.length) return "pending";
  if (stageId === "catalog") return items.every(item => item.inCatalog) ? "done" : "pending";
  const field = STATUS_FIELD_BY_STAGE[stageId];
  const ready = items.every(item => item[field] === "ready");
  if (stageId === "alexa_voc" && !ready) return "manual";
  return ready ? "done" : "pending";
}

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
  terminalJobId: string | null;
  projectId: string | null;
  runId: string | null;
  resumePending: boolean;
  resumeBlocked: boolean;
  workspaceReady: boolean;
  onSyncJobId?: (jobId: string) => void;
  onDismiss?: () => void;
  onComplete?: (jobId: string) => void;
  onReload?: () => void;
};

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
  const resumeJobId = resume.syncJobId ?? resume.terminalJobId;
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
      asins={syncRequest ?? asins}
      marketplace={marketplace}
      projectId={resume.projectId}
      runId={resume.runId}
      resumeJobId={resumeJobId}
      onJobId={resume.onSyncJobId}
      focusStageIds={focusStageIds}
      onComplete={job => {
        resume.onComplete?.(job.jobId);
        onComplete?.();
      }}
      onReload={resume.onReload}
      onDismiss={() => {
        resume.onDismiss?.();
        onDismiss?.();
      }}
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
  onSyncDismiss,
}: SectionProps) {
  const [status, setStatus] = useState<AsinSyncStatusPayload | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    if (asins.length < 1) {
      setStatus(null);
      return;
    }
    try {
      const response = await localAgentFetch(`/v1/local-data/sync-asins?asins=${encodeURIComponent(asins.join(","))}`);
      const payload = (await response.json()) as AsinSyncStatusPayload & { error?: unknown };
      if (!response.ok) throw new Error(localAgentErrorMessage(payload, "无法读取 MCP 状态"));
      setStatus(payload);
      setStatusError(null);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : "无法读取 MCP 状态");
    }
  }, [asins]);

  useEffect(() => {
    if (syncRequest || syncResume.syncJobId || syncResume.terminalJobId) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void refreshStatus();
    });
    return () => {
      cancelled = true;
    };
  }, [refreshStatus, syncRequest, syncResume.syncJobId, syncResume.terminalJobId]);

  if (syncRequest || syncResume.syncJobId || syncResume.terminalJobId) {
    return (
      <UrlResumableAsinSyncFunnel
        asins={syncRequest ?? asins}
        marketplace={marketplace}
        syncRequest={syncRequest}
        resume={syncResume}
        onComplete={() => {
          onSyncComplete?.();
          onSyncDismiss?.();
        }}
        onDismiss={() => {
          refreshStatus();
        }}
      />
    );
  }

  const items = status?.items ?? [];
  const autoStages = SYNC_STAGE_TEMPLATE.filter(stage => stage.kind === "auto");
  const readyAutoCount = autoStages.filter(stage => idleStageStatus(stage.id, items) === "done").length;
  const autoPercent = Math.round((readyAutoCount / Math.max(autoStages.length, 1)) * 100);
  const needsSync = status?.needsSync ?? false;
  const vocPending = status?.vocPending ?? [];

  return (
    <section className="card asin-sync-progress asin-sync-progress-idle">
      <div className="sync-progress-head">
        <div className="sync-progress-head-copy">
          <span className="status-chip">MCP 拉取进度</span>
          <h3>{needsSync ? "部分 MCP 数据待拉取" : "MCP 数据已就绪"}</h3>
          <p>
            {asins.length} 个 ASIN · 新 ASIN 自动入库底库 · 模块串行拉取 · 含 Alexa VOC 全自动采集
          </p>
        </div>
        <div className="sync-progress-summary">
          <span>
            就绪 <b>{autoPercent}%</b>
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

      <div className="sync-progress-overall">
        <i style={{ width: `${autoPercent}%` }} />
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

export function AsinSyncFunnel({ asins, marketplace, projectId = null, runId = null, resumeJobId = null, onJobId, focusStageIds, onComplete, onDismiss, onReload }: Props) {
  const [jobId, setJobId] = useState<string | null>(resumeJobId);
  const [job, setJob] = useState<SyncJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const startOnce = useRef(createSyncStartGate());
  const completedJobs = useRef(new Set<string>());
  const scheduledReloadJobId = useRef<string | null>(null);
  const reloadTimer = useRef<number | null>(null);
  const onCompleteRef = useRef(onComplete);
  const onReloadRef = useRef(onReload);
  const focused = Boolean(focusStageIds?.length);
  const dismissSync = useCallback(() => {
    setJobId(null);
    setJob(null);
    setError(null);
    onDismiss?.();
  }, [onDismiss]);

  useEffect(() => () => {
    if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current);
  }, []);

  useEffect(() => {
    onCompleteRef.current = onComplete;
    onReloadRef.current = onReload;
  }, [onComplete, onReload]);

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
    } catch (err) {
      setError(err instanceof Error ? err.message : "启动同步失败");
    } finally {
      setStarting(false);
    }
  }, [asins, marketplace, onJobId, projectId, runId]);

  useEffect(() => {
    if (resumeJobId) {
      setJobId(resumeJobId);
      return;
    }
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
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!jobId || completedJobs.current.has(jobId)) return;
    let cancelled = false;
    let pollingStopped = false;
    let interval: number | undefined;

    const stopPolling = () => {
      pollingStopped = true;
      if (interval !== undefined) window.clearInterval(interval);
    };

    const poll = async () => {
      if (pollingStopped) return;
      try {
        const response = await localAgentFetch(`/v1/local-data/sync-asins/${encodeURIComponent(jobId)}`);
        const payload = (await response.json()) as SyncJob & { error?: unknown };
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
          { asins, marketplace, projectId, runId },
        )) {
          setError("同步任务与当前工作区不匹配，请确认后手动重新发起同步。");
          stopPolling();
          return;
        }
        setError(null);
        setJob(payload);
        if (payload.status === "completed" || payload.status === "completed-with-gaps") {
          completedJobs.current.add(jobId);
          stopPolling();
          onCompleteRef.current?.(payload);
          if (payload.needsReload && scheduledReloadJobId.current !== jobId) {
            scheduledReloadJobId.current = jobId;
            reloadTimer.current = window.setTimeout(() => {
              reloadTimer.current = null;
              const reload = onReloadRef.current;
              if (reload) reload();
              else window.location.reload();
            }, 2500);
          }
          return;
        }
        if (payload.status === "failed") {
          setError(payload.message);
          stopPolling();
          return;
        }
      } catch {
        if (!cancelled) setError("无法读取同步进度");
      }
    };

    poll();
    interval = window.setInterval(poll, 1500);
    if (pollingStopped) window.clearInterval(interval);
    return () => {
      cancelled = true;
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [asins, jobId, marketplace, projectId, resumeJobId, runId]);

  const alexaRemaining = job?.alexaVoc?.deadlineAt
    ? Math.max(0, Math.ceil((new Date(job.alexaVoc.deadlineAt).getTime() - now) / 1000))
    : null;

  const visibleStages = useMemo(() => {
    const stages = job?.stages ?? [];
    if (!focusStageIds?.length) return stages;
    return stages.filter(stage => focusStageIds.includes(stage.id));
  }, [job?.stages, focusStageIds]);

  const focusCopy = useMemo(() => {
    const ids = focusStageIds ?? [];
    if (ids.includes("traffic")) {
      return {
        chip: "流量相关拉取",
        readyTitle: "流量模块已就绪",
        description: `${asins.length} 个 ASIN · 本页关注商品底库 + SIF Listing 流量结构 / 月趋势`,
        progressLabel: "流量进度",
        footnote: "商品底库与流量结构已完成；后台仍在补齐其他 MCP 模块，本页可先查看推广能力分析。",
      };
    }
    if (ids.includes("keywords")) {
      return {
        chip: "关键词相关拉取",
        readyTitle: "流量词模块已就绪",
        description: `${asins.length} 个 ASIN · 本页关注商品底库 + SIF 关键词 / 月搜 enrichment`,
        progressLabel: "关键词进度",
        footnote: "商品底库与 SIF 关键词已完成；后台仍在补齐其他 MCP 模块，本页可先查看流量词分析。",
      };
    }
    return {
      chip: "聚焦模块拉取",
      readyTitle: "关注模块已就绪",
      description: `${asins.length} 个 ASIN · 本页仅展示关注的同步阶段`,
      progressLabel: "聚焦进度",
      footnote: "关注模块已完成；后台仍在补齐其他 MCP 模块。",
    };
  }, [focusStageIds, asins.length]);

  const overall = useMemo(() => {
    if (!job) return { percent: 0, remainingSeconds: 0, finishAt: "—", vocRemainingSeconds: 0, focusReady: false };
    const scopeStages = (focused ? visibleStages : job.stages).filter(stage => stage.kind === "auto");
    const doneCount = scopeStages.filter(stage => ["done", "skipped"].includes(stage.status)).length;
    const percent = Math.round((doneCount / Math.max(scopeStages.length, 1)) * 100);
    const remainingSeconds = scopeStages.reduce(
      (sum, stage) => sum + stageRemainingSeconds(stage, now, alexaRemaining),
      0
    );
    const vocStage = job.stages.find(stage => stage.id === "alexa_voc");
    const vocRemaining = focused ? 0 : vocRemainingSeconds(vocStage, alexaRemaining);
    return {
      percent,
      remainingSeconds,
      finishAt: formatClock(new Date(now + remainingSeconds * 1000).toISOString()),
      vocRemainingSeconds: vocRemaining,
      focusReady: focused && scopeStages.length > 0 && doneCount === scopeStages.length,
    };
  }, [job, now, alexaRemaining, focused, visibleStages]);

  if (error && !job) {
    return (
      <section className="card asin-sync-progress error">
        <div className="sync-progress-head">
          <div>
            <h3>数据拉取失败</h3>
            <p>{error}</p>
          </div>
          {onDismiss ? (
            <button type="button" className="ghost-btn" onClick={dismissSync}>
              关闭
            </button>
          ) : null}
        </div>
      </section>
    );
  }

  return (
    <section className={`card asin-sync-progress${focused ? " asin-sync-progress-focused" : ""}`}>
      <div className="sync-progress-head">
        <div className="sync-progress-head-copy">
          <span className="status-chip">{focused ? focusCopy.chip : "MCP 拉取进度"}</span>
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
              : `${asins.length} 个 ASIN · 模块串行拉取 · MCP 与 VOC 全自动，完成后页面自动刷新`}
          </p>
        </div>
        <div className="sync-progress-summary">
          <span>
            {focused ? focusCopy.progressLabel : "MCP 进度"} <b>{overall.percent}%</b>
          </span>
          <span>
            剩余 <b>{formatCountdown(overall.remainingSeconds)}</b>
          </span>
          <span>
            预计完成 <b>{overall.finishAt}</b>
          </span>
          {overall.vocRemainingSeconds > 0 ? (
            <span className="sync-progress-voc-eta">
              手工 VOC <b>{formatCountdown(overall.vocRemainingSeconds)}</b>
              <i>（不阻塞刷新）</i>
            </span>
          ) : null}
          {onDismiss && (job?.status === "completed" || job?.status === "completed-with-gaps" || job?.status === "failed" || overall.focusReady) ? (
            <button type="button" className="ghost-btn sync-progress-dismiss" onClick={dismissSync}>
              {job?.status === "failed" ? "关闭" : "收起"}
            </button>
          ) : null}
        </div>
      </div>

      <div className="sync-progress-overall">
        <i style={{ width: `${overall.percent}%` }} />
      </div>

      <ul className="sync-progress-list">
        {visibleStages.map(stage => {
          const color = STAGE_COLORS[stage.id] ?? "#2f80ed";
          const percent = stageProgress(stage, now, alexaRemaining);
          const isActive = stage.status === "active" || stage.id === job?.currentStageId;
          const finishLabel = stage.status === "done" || stage.status === "skipped" ? "完成" : "预计";
          return (
            <li
              key={stage.id}
              className={`sync-progress-row status-${stage.status}${isActive ? " is-current" : ""}`}
              style={{ "--stage-color": color } as CSSProperties}
            >
              <div className="sync-progress-row-main">
                <div className="sync-progress-row-title">
                  <strong>{stage.label}</strong>
                  {stage.detail ? <span className="sync-progress-detail">{stage.detail}</span> : null}
                </div>
                <div className="sync-progress-row-side">
                  <span className="sync-progress-status">{statusLabel(stage.status)}</span>
                  <span className="sync-progress-percent">{percent}%</span>
                  <span className="sync-progress-eta">
                    {stage.kind === "manual" ? (
                      <>
                        参考 ~{formatCountdown(stage.estimatedSeconds)} · 不阻塞 MCP 刷新
                      </>
                    ) : (
                      <>
                        ~{formatCountdown(stage.estimatedSeconds)} · {finishLabel}{" "}
                        {stageFinishText(stage, now, alexaRemaining)}
                      </>
                    )}
                  </span>
                </div>
              </div>
              <div className="sync-progress-track">
                <i style={{ width: `${percent}%` }} />
              </div>
              {stage.id === "alexa_voc" && stage.manualNote && stage.status === "manual" ? (
                <p className="sync-progress-manual-note">
                  {job?.alexaVoc?.pendingAsins.length ? (
                    <>
                      待录入 <code>{job.alexaVoc.pendingAsins.join(", ")}</code>
                    </>
                  ) : (
                    stage.manualNote
                  )}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>

      {job?.status === "completed" || job?.status === "completed-with-gaps" ? (
        <p className="sync-progress-foot">
          {job.needsReload ? "MCP 模块已完成，页面将在数秒后自动刷新。" : "同步已完成。"}
        </p>
      ) : null}
      {overall.focusReady && job?.status !== "completed" ? (
        <p className="sync-progress-foot">
          {focusCopy.footnote}
        </p>
      ) : null}
      {error ? <p className="sync-progress-foot error">{error}</p> : null}
    </section>
  );
}
