"use client";

import { useState, useCallback } from "react";
import { type AnalysisProject } from "../projects/project-library-panel";
import { useResumedSyncScope } from "../../lib/resumed-sync-scope";
import { useXydcOrderProgress } from "../../lib/use-xydc-order-progress";
import { resolveAlexaVocPageScope } from "../../lib/alexa-voc-page-scope";
import type { useRuntimeRefresh } from "./workspace-runtime";
import type { useSyncSessionState } from "./sync-session-state";
import type { useProjectState } from "./project-state";
import type { useWorkspaceInput } from "./workspace-input";
import type { useRuntimeDataState } from "./workspace-runtime";
import type { AuthenticatedWebSession } from "../../auth-session-gate";

type useWorkspaceResumeInputs = Pick<ReturnType<typeof useRuntimeRefresh>, "baseSyncRunId" | "refreshRuntimeAnalysisData" | "runtimeScopeKey">
  & Pick<ReturnType<typeof useSyncSessionState>, "syncRunContext" | "workspaceKey" | "hydratedWorkspaceKey">
  & Pick<ReturnType<typeof useProjectState>, "currentProjectId">
  & Pick<ReturnType<typeof useWorkspaceInput>, "activeAsins" | "setMessage">
  & Pick<ReturnType<typeof useRuntimeDataState>, "runtimeAnalysisDataScope" | "runtimeAnalysisData">
  & { authSession: AuthenticatedWebSession };

export function useWorkspaceResume({
    baseSyncRunId, syncRunContext, workspaceKey, hydratedWorkspaceKey, currentProjectId, refreshRuntimeAnalysisData,
    activeAsins, setMessage, runtimeScopeKey, authSession, runtimeAnalysisDataScope, runtimeAnalysisData,
  }: useWorkspaceResumeInputs) {
  const [workspaces, setWorkspaces] = useState<AnalysisProject[]>([]);

  const [workspaceLabel, setWorkspaceLabel] = useState("");

  const resumedSyncScope = useResumedSyncScope({
    runId: baseSyncRunId,
    fallbackContext: syncRunContext,
  });

  const workspaceReady = !workspaceKey || hydratedWorkspaceKey === workspaceKey;

  const refreshXydcProgress = useCallback(async (signal: AbortSignal, isCurrent: () => boolean) => {
    if (!currentProjectId) return undefined;
    const result = await refreshRuntimeAnalysisData(currentProjectId, activeAsins, signal, isCurrent);
    if (!result.ok && result.reason === "failed" && !signal.aborted && isCurrent()) setMessage(result.message);
    return result.ok ? result.snapshot.xydcOrderProgress : undefined;
  }, [currentProjectId, activeAsins, refreshRuntimeAnalysisData, setMessage]);

  useXydcOrderProgress({
    scopeKey: runtimeScopeKey,
    enabled: workspaceReady && Boolean(currentProjectId) && !authSession.logoutPending,
    view: runtimeAnalysisDataScope === runtimeScopeKey ? runtimeAnalysisData?.xydcOrderProgress ?? null : null,
    refresh: refreshXydcProgress,
  });

  const alexaVocPageScope = resolveAlexaVocPageScope({
    currentProjectId,
    workspaceReady,
    resumedSyncScope,
  });

  const resumedProjectId = resumedSyncScope.context?.projectId ?? (baseSyncRunId ? null : currentProjectId);

  return { workspaces, setWorkspaces, workspaceLabel, setWorkspaceLabel, resumedSyncScope, workspaceReady, alexaVocPageScope, resumedProjectId };
}
