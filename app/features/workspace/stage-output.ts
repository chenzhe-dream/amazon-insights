"use client";

import { useMemo, useCallback } from "react";
import { isPrimaryAdministrator } from "../../lib/primary-admin";
import { type StageOutputSnapshot, type SyncResumeBundle } from "../sync/asin-sync-funnel";
import { trafficStageFromReceipt } from "../../lib/traffic-detail-view";
import { searchWithSyncJobId } from "../../lib/asin-sync-session";
import { useVocReviewOutput } from "../../lib/use-voc-review-output";
import { replaceAppUrl } from "../projects/workspace-navigation";
import type { useRuntimeRefresh } from "./workspace-runtime";
import type { useSyncSessionState } from "./sync-session-state";
import type { useWorkspaceResume } from "./workspace-resume";
import type { useWorkspaceInput } from "./workspace-input";
import type { useWorkspaceLocation } from "./workspace-location";
import type { useTerminalSync } from "./terminal-sync";
import type { AuthenticatedWebSession } from "../../auth-session-gate";

type useStageOutputInputs = Pick<ReturnType<typeof useRuntimeRefresh>, "syncJobId" | "baseSyncRunId">
  & Pick<ReturnType<typeof useSyncSessionState>, "terminalSyncJob" | "setStageOutputReceipt" | "stageOutputReceipt" | "rememberSyncJob" | "setTerminalSyncJob" | "setTerminalPointerRetained" | "syncSessionJobIds" | "terminalRepairPending" | "terminalPointerRetained">
  & Pick<ReturnType<typeof useWorkspaceResume>, "resumedSyncScope" | "resumedProjectId" | "workspaceReady">
  & Pick<ReturnType<typeof useWorkspaceInput>, "market" | "activeAsins">
  & Pick<ReturnType<typeof useWorkspaceLocation>, "workspacePath" | "activeTab">
  & Pick<ReturnType<typeof useTerminalSync>, "dismissSyncJob" | "handleTerminalSyncJob" | "restartTerminalSync">
  & { authSession: AuthenticatedWebSession };

export function useStageOutput({
    syncJobId, terminalSyncJob, baseSyncRunId, resumedSyncScope, authSession, market, activeAsins, workspacePath,
    resumedProjectId, setStageOutputReceipt, stageOutputReceipt, activeTab, workspaceReady, rememberSyncJob,
    setTerminalSyncJob, setTerminalPointerRetained, syncSessionJobIds, dismissSyncJob, handleTerminalSyncJob,
    restartTerminalSync, terminalRepairPending, terminalPointerRetained,
  }: useStageOutputInputs) {
  const stageOutputJobId = syncJobId ?? terminalSyncJob?.jobId ?? null;

  const stageOutputRunId = baseSyncRunId ?? resumedSyncScope.context?.runId ?? null;

  const stageOutputScopeKey = [
    authSession.sessionIdentity,
    authSession.logoutPending ? "logout" : "active",
    market, [...activeAsins].sort().join(","),
    authSession.user.organizationId,
    workspacePath,
    resumedProjectId ?? "",
    stageOutputRunId ?? "",
    stageOutputJobId ?? "",
  ].join("|");

  const stageOutputOwnerToken = useMemo(() => ({ scopeKey: stageOutputScopeKey }), [stageOutputScopeKey]);

  const onScopedStageOutput = useCallback((snapshot: StageOutputSnapshot, reason?: "owner-disposed") => {
    // Tab disposal is not a new data result. Explicit retry updates (including {}) still apply.
    if (reason === "owner-disposed") return;
    setStageOutputReceipt({ scopeKey: stageOutputOwnerToken.scopeKey, ownerToken: stageOutputOwnerToken, snapshot });
  }, [stageOutputOwnerToken, setStageOutputReceipt]);

  const currentStageReceipt = stageOutputReceipt?.ownerToken === stageOutputOwnerToken ? stageOutputReceipt : null;

  const reviewScope = useMemo(() => !authSession.logoutPending && resumedProjectId && stageOutputRunId && stageOutputJobId ? {
    organizationId: authSession.user.organizationId, projectId: resumedProjectId,
    runId: stageOutputRunId, jobId: stageOutputJobId, marketplace: market, asins: activeAsins,
  } : null, [authSession.logoutPending, authSession.user.organizationId, resumedProjectId, stageOutputRunId, stageOutputJobId, market, activeAsins]);

  const { snapshot: pageReviewOutput, refreshFailed: reviewRefreshFailed } = useVocReviewOutput(stageOutputScopeKey, reviewScope, activeTab === "voc", currentStageReceipt?.snapshot.reviews);

  const stageOutputSnapshot = useMemo<StageOutputSnapshot>(() => !authSession.logoutPending && currentStageReceipt
    ? { ...currentStageReceipt.snapshot, ...(activeTab === "voc" ? { reviews: pageReviewOutput.reviews } : {}) } : pageReviewOutput, [authSession.logoutPending, currentStageReceipt, pageReviewOutput, activeTab]);

  const visibleTrafficStage = trafficStageFromReceipt(currentStageReceipt, {
    scopeKey: stageOutputScopeKey, projectId: resumedProjectId, runId: stageOutputRunId, jobId: stageOutputJobId,
    enabled: !authSession.logoutPending,
  });

  const syncResume = useMemo<SyncResumeBundle>(() => ({
    organizationId: authSession.logoutPending ? null : authSession.user.organizationId,
    sessionIdentity: authSession.sessionIdentity,
    stageOutputScopeKey,
    syncJobId,
    terminalJob: terminalSyncJob,
    projectId: resumedProjectId,
    runId: resumedSyncScope.context?.runId ?? null,
    resumePending: resumedSyncScope.resolving,
    resumeBlocked: !resumedSyncScope.canAdopt,
    workspaceReady,
    onStageOutput: onScopedStageOutput,
    onSyncJobId: jobId => {
      rememberSyncJob(jobId);
      setTerminalSyncJob(null);
      setTerminalPointerRetained(false);
      replaceAppUrl(searchWithSyncJobId(window.location.search, jobId), window.location.pathname);
    },
    knownSessionJobIds: syncSessionJobIds,
    onSyncJobObserved: rememberSyncJob,
    onDismiss: dismissSyncJob,
    onComplete: handleTerminalSyncJob,
    onTerminal: handleTerminalSyncJob,
    onRestart: restartTerminalSync,
    restartPending: terminalRepairPending,
    canResumeFailedStages: isPrimaryAdministrator(authSession.user),
    allowDismiss: !terminalPointerRetained,
  }), [authSession.logoutPending, authSession.sessionIdentity, authSession.user.organizationId, onScopedStageOutput, dismissSyncJob, handleTerminalSyncJob, rememberSyncJob, restartTerminalSync, terminalRepairPending, resumedProjectId, resumedSyncScope.canAdopt, resumedSyncScope.context, resumedSyncScope.resolving, stageOutputScopeKey, syncJobId, syncSessionJobIds, terminalPointerRetained, terminalSyncJob, workspaceReady, setTerminalPointerRetained, setTerminalSyncJob]);

  return { reviewRefreshFailed, stageOutputSnapshot, visibleTrafficStage, syncResume };
}
