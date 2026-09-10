"use client";

import { type VocRunObservation } from "../../lib/voc-run-browser";

export function VocRunStatusSummary({ observation }: { observation: VocRunObservation | null }) {
  if (!observation) {
    return <>
      <strong>VOC Agent · 尚未开始</strong>
      <p>VOC 分析尚未开始</p>
    </>;
  }
  const stage = observation.stage;
  const stageStatus = typeof stage?.status === "string" ? stage.status.trim() : "";
  const queueTimeout = (stage?.lastError as { code?: string } | null)?.code === "QUEUE_TIMEOUT";

  return <>
    <strong>VOC Agent · {queueTimeout ? "排队超时" : observation.kind}</strong>
    <p>{observation.message}</p>
    {observation.runId ? <small>Run {observation.runId}</small> : null}
    {stage && stageStatus ? <>
      <p>
        {queueTimeout ? "阶段：已失败" : `Stage: ${stageStatus}`} · {String(stage.progress ?? 0)}%
      </p>
      {stage.lastError && !queueTimeout ? (
        <p>{typeof stage.lastError === "object" && "message" in stage.lastError
          ? String(stage.lastError.message)
          : String(stage.lastError)}</p>
      ) : null}
    </> : null}
  </>;
}
