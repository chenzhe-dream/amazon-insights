"use client";

import { useEffect, useState } from "react";

import { localAgentFetch } from "./local-agent-browser";

export type SyncRunContext = { projectId: string; runId: string };

type RunResponse = { run?: { projectId?: unknown } };

export function useResumedSyncScope(input: {
  resumeJobId: string | null;
  runId: string | null;
  fallbackContext: SyncRunContext | null;
}) {
  const key = input.resumeJobId && input.runId ? `${input.resumeJobId}:${input.runId}` : null;
  const [resolved, setResolved] = useState<{ key: string | null; context: SyncRunContext | null }>({
    key: null,
    context: input.fallbackContext,
  });

  useEffect(() => {
    if (!key || !input.runId) {
      setResolved({ key: null, context: input.fallbackContext });
      return;
    }
    let cancelled = false;
    setResolved(current => current.key === key ? current : { key: null, context: null });
    void localAgentFetch(`/v1/runs/${encodeURIComponent(input.runId)}`)
      .then(async response => {
        const payload = (await response.json()) as RunResponse;
        const projectId = payload.run?.projectId;
        if (cancelled) return;
        setResolved({
          key,
          context: response.ok && typeof projectId === "string" && projectId
            ? { projectId, runId: input.runId! }
            : null,
        });
      })
      .catch(() => {
        if (!cancelled) setResolved({ key, context: null });
      });
    return () => {
      cancelled = true;
    };
  }, [input.fallbackContext, input.runId, key]);

  return {
    context: key ? resolved.context : input.fallbackContext,
    resolving: Boolean(key && resolved.key !== key),
  };
}
