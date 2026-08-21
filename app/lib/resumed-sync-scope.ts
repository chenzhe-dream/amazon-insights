"use client";

import { useEffect, useState } from "react";

import { localAgentFetch } from "./local-agent-browser";

export type SyncRunContext = { projectId: string; runId: string };
export type ResumedSyncScopeStatus = "unscoped" | "resolving" | "resolved" | "invalid";

type RunResponse = { run?: { projectId?: unknown } };
type ResolvedScope = { runId: string | null; status: ResumedSyncScopeStatus; context: SyncRunContext | null };

export function useResumedSyncScope(input: {
  runId: string | null;
  fallbackContext: SyncRunContext | null;
}) {
  const [stored, setStored] = useState<ResolvedScope>(() => input.runId
    ? { runId: input.runId, status: "resolving", context: null }
    : { runId: null, status: "unscoped", context: input.fallbackContext });
  const current: ResolvedScope = stored.runId === input.runId
    ? stored
    : input.runId
      ? { runId: input.runId, status: "resolving", context: null }
      : { runId: null, status: "unscoped", context: input.fallbackContext };

  useEffect(() => {
    if (!input.runId) {
      setStored({ runId: null, status: "unscoped", context: input.fallbackContext });
      return;
    }
    let cancelled = false;
    setStored(previous => previous.runId === input.runId ? previous : {
      runId: input.runId, status: "resolving", context: null,
    });
    void localAgentFetch(`/v1/runs/${encodeURIComponent(input.runId)}`)
      .then(async response => {
        const payload = (await response.json()) as RunResponse;
        const projectId = payload.run?.projectId;
        if (cancelled) return;
        setStored(
          response.ok && typeof projectId === "string" && projectId
            ? { runId: input.runId!, status: "resolved", context: { projectId, runId: input.runId! } }
            : { runId: input.runId!, status: "invalid", context: null },
        );
      })
      .catch(() => {
        if (!cancelled) setStored({ runId: input.runId!, status: "invalid", context: null });
      });
    return () => {
      cancelled = true;
    };
  }, [input.fallbackContext, input.runId]);

  return {
    status: current.status,
    context: current.context,
    resolving: current.status === "resolving",
    canStart: current.status === "unscoped" || current.status === "resolved",
    canAdopt: current.status === "unscoped" || current.status === "resolved",
  };
}
