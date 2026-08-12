"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

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
};

function formatCountdown(totalSeconds: number) {
  const seconds = Math.max(0, totalSeconds);
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

function stageIcon(status: string) {
  if (status === "done" || status === "skipped") return "✓";
  if (status === "active") return "◉";
  if (status === "manual") return "⏳";
  if (status === "failed") return "✕";
  return "○";
}

function funnelWidth(index: number, total: number) {
  const min = 42;
  const max = 100;
  if (total <= 1) return max;
  return min + ((max - min) * (total - index - 1)) / (total - 1);
}

type Props = {
  asins: string[];
  marketplace: string;
  onComplete?: () => void;
  onDismiss?: () => void;
};

export function AsinSyncFunnel({ asins, marketplace, onComplete, onDismiss }: Props) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<SyncJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const startSync = useCallback(async () => {
    setStarting(true);
    setError(null);
    try {
      const response = await fetch("/api/sync-asins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asins, marketplace }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "启动同步失败");
      setJobId(payload.jobId);
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
  }, [asins, marketplace]);

  useEffect(() => {
    startSync();
  }, [startSync]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let reloadTimer: number | undefined;

    const poll = async () => {
      try {
        const response = await fetch(`/api/sync-asins/${jobId}`);
        const payload = (await response.json()) as SyncJob;
        if (cancelled) return;
        setJob(payload);
        if (payload.status === "completed") {
          onComplete?.();
          if (payload.needsReload) {
            reloadTimer = window.setTimeout(() => window.location.reload(), 2500);
          }
        }
        if (payload.status === "failed") {
          setError(payload.message);
        }
      } catch {
        if (!cancelled) setError("无法读取同步进度");
      }
    };

    poll();
    const interval = window.setInterval(poll, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      if (reloadTimer) window.clearInterval(reloadTimer);
    };
  }, [jobId, onComplete]);

  const alexaRemaining = useMemo(() => {
    if (!job?.alexaVoc?.deadlineAt) return null;
    const deadline = new Date(job.alexaVoc.deadlineAt).getTime();
    return Math.ceil((deadline - now) / 1000);
  }, [job?.alexaVoc?.deadlineAt, now]);

  const autoRemaining = useMemo(() => {
    if (!job) return null;
    const pending = job.stages.filter(
      stage => stage.kind === "auto" && !["done", "skipped"].includes(stage.status)
    );
    return pending.reduce((sum, stage) => sum + stage.estimatedSeconds, 0);
  }, [job]);

  if (error && !job) {
    return (
      <section className="card asin-sync-funnel error">
        <div className="section-head">
          <div>
            <h3>MCP 数据同步失败</h3>
            <p>{error}</p>
          </div>
          <button type="button" className="ghost-btn" onClick={onDismiss}>
            关闭
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="card asin-sync-funnel">
      <div className="section-head">
        <div>
          <span className="status-chip">数据同步漏斗</span>
          <h3>{starting ? "正在启动 MCP 同步…" : job?.message ?? "同步进行中"}</h3>
          <p>
            自动拉取 SIF 关键词、Sorftime 评论与销量；VOC 核心主题需在 Alexa 对话框手工录入，下方显示预估剩余时间。
          </p>
        </div>
        <div className="sync-funnel-meta">
          {autoRemaining != null && job?.status === "running" ? (
            <span className="sync-countdown auto">
              MCP 预估 <b>{formatCountdown(autoRemaining)}</b>
            </span>
          ) : null}
          {alexaRemaining != null && job?.alexaVoc?.pendingAsins.length ? (
            <span className="sync-countdown manual">
              Alexa VOC <b>{formatCountdown(alexaRemaining)}</b>
            </span>
          ) : null}
          {onDismiss ? (
            <button type="button" className="ghost-btn" onClick={onDismiss}>
              收起
            </button>
          ) : null}
        </div>
      </div>

      <div className="sync-funnel-body">
        <ol className="sync-funnel-stages">
          {(job?.stages ?? []).map((stage, index, list) => {
            const width = funnelWidth(index, list.length);
            const isAlexa = stage.id === "alexa_voc";
            const showAlexaCountdown =
              isAlexa && stage.status === "manual" && alexaRemaining != null && alexaRemaining > 0;
            return (
              <li
                key={stage.id}
                className={`sync-funnel-stage status-${stage.status}${stage.id === job?.currentStageId ? " current" : ""}`}
                style={{ width: `${width}%` }}
              >
                <div className="sync-funnel-stage-head">
                  <span className="sync-funnel-icon" aria-hidden>
                    {stageIcon(stage.status)}
                  </span>
                  <div>
                    <strong>{stage.label}</strong>
                    {stage.detail ? <small>{stage.detail}</small> : null}
                  </div>
                  <span className="sync-funnel-est">
                    {showAlexaCountdown
                      ? formatCountdown(alexaRemaining)
                      : `~${formatCountdown(stage.estimatedSeconds)}`}
                  </span>
                </div>
                {isAlexa && stage.manualNote ? (
                  <p className="sync-funnel-manual-note">
                    {stage.manualNote}
                    {job?.alexaVoc?.pendingAsins.length ? (
                      <>
                        {" "}
                        待录入：<code>{job.alexaVoc.pendingAsins.join(", ")}</code>
                      </>
                    ) : null}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ol>

        {job?.asinProgress ? (
          <div className="sync-asin-grid">
            {asins.map(asin => {
              const progress = job.asinProgress[asin] ?? {};
              return (
                <div key={asin} className="sync-asin-chip">
                  <b>{asin}</b>
                  <span data-ready={progress.keywords === "ready"}>关键词</span>
                  <span data-ready={progress.reviews === "ready"}>评论</span>
                  <span data-ready={progress.sales === "ready"}>销量</span>
                  <span
                    data-ready={progress.voc === "ready"}
                    data-manual={progress.voc === "awaiting_manual"}
                  >
                    VOC
                  </span>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

      {job?.status === "completed" ? (
        <p className="sync-funnel-foot">
          {job.needsReload ? "构建完成，页面将在数秒后自动刷新以载入新数据。" : "同步已完成。"}
        </p>
      ) : null}
      {error ? <p className="sync-funnel-foot error">{error}</p> : null}
    </section>
  );
}
