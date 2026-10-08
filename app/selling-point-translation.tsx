"use client";

import { useEffect, useState } from "react";
import { SellingTranslationResponse, type SellingTranslationResult } from "../shared/selling-point-translation-contracts";
import { localAgentFetch, localAgentErrorMessage } from "./lib/local-agent-browser";

export function SellingPointTranslation({ projectId, versionId, asin }: { projectId: string | null; versionId?: string | null; asin: string }) {
  const [result, setResult] = useState<SellingTranslationResult | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    setResult(null);
    setError("");
    if (!projectId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const basePath = `/v1/projects/${encodeURIComponent(projectId)}/selling-point-translations/${encodeURIComponent(asin)}`;
    const readPath = `${basePath}${versionId ? `?versionId=${encodeURIComponent(versionId)}` : ""}`;
    async function request(method: "GET" | "POST") {
      const response = await localAgentFetch(method === "GET" ? readPath : basePath, {
        method, signal: controller.signal, cache: "no-store",
        ...(method === "POST" ? { body: JSON.stringify(versionId ? { versionId } : {}) } : {}),
      });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(localAgentErrorMessage(payload, "中文翻译暂不可用，请重试。"));
      return SellingTranslationResponse.parse(payload);
    }
    async function poll(initial: boolean) {
      try {
        let next = await request("GET");
        if (initial && (next.state === "missing" || (retry > 0 && next.state === "failed"))) next = await request("POST");
        if (controller.signal.aborted) return;
        setResult(next);
        if (next.state === "pending") {
          if (Date.now() - started < 660_000) timer = setTimeout(() => void poll(false), 5000);
          else setError("翻译等待时间较长，请稍后重新查看。");
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "中文翻译暂不可用，请重试。");
      }
    }
    void poll(true);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [projectId, versionId, asin, retry]);

  if (!projectId) return <p className="muted">请先打开来源项目，查看中文卖点。</p>;
  return <div aria-live="polite">
    {result?.state === "ready" ? <>
      <ul>{result.points.map((point, index) => <li key={index}>{point}</li>)}</ul>
      {!result.sourceComplete && <small className="muted">历史原文仅保留部分卖点，已翻译现有完整内容。</small>}
      <details><summary>查看原文</summary><ul>{result.original.map((point, index) => <li key={index}>{point}</li>)}</ul></details>
    </> : <p className="muted">{error || result?.message || (result?.state === "unavailable" ? "暂无可翻译的卖点原文。" : "正在准备中文卖点…")}</p>}
    {(error || result?.state === "failed") && <button type="button" className="small-button" onClick={() => setRetry(value => value + 1)}>重新翻译</button>}
  </div>;
}
