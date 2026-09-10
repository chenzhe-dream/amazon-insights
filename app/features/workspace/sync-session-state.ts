"use client";

import { createRuntimeAnalysisScopeGuard } from "../../lib/runtime-analysis-data";
import { useState, useRef, useCallback } from "react";
import { type SyncJob } from "../sync/asin-sync-funnel";
import { type TrafficStageReceipt } from "../../lib/traffic-detail-view";
import { createIncompleteSyncRepair } from "../../lib/sync-incomplete-repair-browser";
import { localAgentFetch } from "../../lib/local-agent-browser";
import type { useWorkspaceLocation } from "./workspace-location";

type useSyncSessionStateInputs = Pick<ReturnType<typeof useWorkspaceLocation>, "slugParam" | "projectParam">;

export function useSyncSessionState({ slugParam, projectParam }: useSyncSessionStateInputs) {
  const [syncAsins, setSyncAsins] = useState<string[] | null>(null);

  const [syncRunContext, setSyncRunContext] = useState<{ projectId: string; runId: string } | null>(null);

  const [terminalSyncJob, setTerminalSyncJob] = useState<SyncJob | null>(null);

  const [publicationConvergenceNotice, setPublicationConvergenceNotice] = useState<string | null>(null);

  const [stageOutputReceipt, setStageOutputReceipt] = useState<(TrafficStageReceipt & { ownerToken: object }) | null>(null);

  const [terminalPointerRetained, setTerminalPointerRetained] = useState(false);

  const [terminalRepairPending, setTerminalRepairPending] = useState(false);

  const terminalRepairInFlight = useRef(false);

  const terminalRepair = useRef(createIncompleteSyncRepair(localAgentFetch));

  const terminalRepairScope = useRef(createRuntimeAnalysisScopeGuard());

  const analysisStartInFlight = useRef(false);

  const workspaceKey = slugParam || projectParam;

  const [hydratedWorkspaceKey, setHydratedWorkspaceKey] = useState<string | null>(workspaceKey ? null : "");

  const syncSuppressedKey = useRef<string | null>(null);

  const autoSyncStartedKey = useRef<string | null>(null);

  const [syncSessionJobIds, setSyncSessionJobIds] = useState<Set<string>>(() => new Set());

  const rememberSyncJob = useCallback((jobId: string) => {
    setSyncSessionJobIds(current => {
      if (current.has(jobId)) return current;
      const next = new Set(current);
      next.add(jobId);
      return next;
    });
  }, []);

  return {
    syncAsins, setSyncAsins, syncRunContext, setSyncRunContext, terminalSyncJob, setTerminalSyncJob,
    publicationConvergenceNotice, setPublicationConvergenceNotice, stageOutputReceipt, setStageOutputReceipt,
    terminalPointerRetained, setTerminalPointerRetained, terminalRepairPending, setTerminalRepairPending,
    terminalRepairInFlight, terminalRepair, terminalRepairScope, analysisStartInFlight, workspaceKey, hydratedWorkspaceKey,
    setHydratedWorkspaceKey, syncSuppressedKey, autoSyncStartedKey, syncSessionJobIds, rememberSyncJob,
  };
}
