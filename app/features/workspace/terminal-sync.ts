"use client";

import { useLayoutEffect, useCallback } from "react";
import { clearVocRunFromSearch } from "../../lib/voc-run-browser";
import { type SyncJob, type SyncCompletionDisposition, hasResumableFailedStages } from "../sync/asin-sync-funnel";
import { clearSyncJobFromSearch, searchWithSyncJobId } from "../../lib/asin-sync-session";
import { createTerminalSyncOwner, browserSessionStorage } from "../../lib/sync-terminal-owner";
import { publicationArtifactNotice } from "../../lib/publication-artifact-notice";
import { replaceAppUrl } from "../projects/workspace-navigation";
import { currentWebArtifactId } from "./workspace-runtime-contracts";
import type { useSyncSessionState } from "./sync-session-state";
import type { useWorkspaceResume } from "./workspace-resume";
import type { useRuntimeRefresh } from "./workspace-runtime";
import type { useWorkspaceLocation } from "./workspace-location";
import type { useWorkspaceInput } from "./workspace-input";
import type { useProjectState } from "./project-state";
import type { useVocRunState } from "./workspace-voc-run";
import type { AuthenticatedWebSession } from "../../auth-session-gate";

type useTerminalSyncInputs = Pick<ReturnType<typeof useSyncSessionState>, "terminalRepairScope" | "terminalPointerRetained" | "syncSuppressedKey" | "autoSyncStartedKey" | "setSyncAsins" | "setTerminalSyncJob" | "terminalRepairInFlight" | "setTerminalRepairPending" | "terminalRepair" | "rememberSyncJob" | "setTerminalPointerRetained" | "setSyncRunContext" | "setPublicationConvergenceNotice">
  & Pick<ReturnType<typeof useWorkspaceResume>, "workspaceReady" | "resumedSyncScope" | "resumedProjectId">
  & Pick<ReturnType<typeof useRuntimeRefresh>, "runtimeScopeKey">
  & Pick<ReturnType<typeof useWorkspaceLocation>, "workspacePath">
  & Pick<ReturnType<typeof useWorkspaceInput>, "market" | "activeAsins" | "setMessage">
  & Pick<ReturnType<typeof useProjectState>, "setRefreshingProjectId">
  & Pick<ReturnType<typeof useVocRunState>, "restoringVocRun" | "setVocRun" | "setSelectedReportIds">
  & { authSession: AuthenticatedWebSession };

export function useTerminalSync({
    terminalRepairScope: terminalRepairScopeRef, workspaceReady, authSession, resumedSyncScope, runtimeScopeKey,
    workspacePath, market, resumedProjectId, terminalPointerRetained, syncSuppressedKey: syncSuppressedKeyRef, activeAsins,
    autoSyncStartedKey: autoSyncStartedKeyRef, setSyncAsins, setTerminalSyncJob, setRefreshingProjectId,
    terminalRepairInFlight: terminalRepairInFlightRef, setTerminalRepairPending, terminalRepair: terminalRepairRef,
    setMessage, rememberSyncJob, setTerminalPointerRetained, setSyncRunContext, restoringVocRun: restoringVocRunRef,
    setVocRun, setSelectedReportIds, setPublicationConvergenceNotice,
  }: useTerminalSyncInputs) {
  useLayoutEffect(() => {
    const guard = terminalRepairScopeRef.current;
    guard.activate(workspaceReady && !authSession.logoutPending && resumedSyncScope.canAdopt
      ? `${runtimeScopeKey}:${workspacePath}:${market}:${resumedProjectId}` : null);
    return () => guard.activate(null);
  }, [runtimeScopeKey, workspacePath, market, resumedProjectId, workspaceReady, authSession.logoutPending, resumedSyncScope.canAdopt, terminalRepairScopeRef]);

  const terminalOwnerFor = useCallback((values: string[], options?: { projectId?: string | null; marketplace?: string }) => createTerminalSyncOwner({
    storage: browserSessionStorage(),
    pathname: workspacePath,
    organizationId: authSession.user.organizationId,
    projectId: options?.projectId ?? resumedProjectId,
    marketplace: options?.marketplace ?? market,
    asins: values,
  }), [authSession.user.organizationId, market, resumedProjectId, workspacePath]);

  const dismissSyncJob = useCallback(() => {
    if (terminalPointerRetained) return;
    syncSuppressedKeyRef.current = activeAsins.join(",");
    autoSyncStartedKeyRef.current = null;
    setSyncAsins(null);
    setTerminalSyncJob(null);
    setRefreshingProjectId(null);
    replaceAppUrl(clearSyncJobFromSearch(window.location.search), window.location.pathname);
  }, [activeAsins, terminalPointerRetained, autoSyncStartedKeyRef, setRefreshingProjectId, setSyncAsins, setTerminalSyncJob, syncSuppressedKeyRef]);

  const restartTerminalSync = useCallback(async (parentJob: SyncJob) => {
    if (terminalRepairInFlightRef.current || !workspaceReady || !resumedSyncScope.canAdopt || !resumedProjectId || authSession.logoutPending) return;
    const captured = terminalRepairScopeRef.current.capture();
    const isCurrent = () => terminalRepairScopeRef.current.isCurrent(captured);
    terminalRepairInFlightRef.current = true;
    setTerminalRepairPending(true);
    try {
      const result = await terminalRepairRef.current({ asins: activeAsins, marketplace: market, projectId: resumedProjectId, parentJobId: parentJob.jobId }, isCurrent);
      if (!result || !isCurrent()) return;
      if ("noWork" in result) {
        setMessage(result.message);
        return;
      }
      terminalOwnerFor(activeAsins).clearForExplicitStart();
      syncSuppressedKeyRef.current = null;
      autoSyncStartedKeyRef.current = activeAsins.join(",");
      rememberSyncJob(result.jobId);
      setTerminalSyncJob(null);
      setTerminalPointerRetained(false);
      setSyncAsins(null);
      setSyncRunContext(result.scope);
      restoringVocRunRef.current = null;
      setVocRun(null);
      setSelectedReportIds({});
      const params = clearVocRunFromSearch(new URLSearchParams(searchWithSyncJobId(window.location.search, result.jobId)));
      params.set("run", result.scope.runId);
      replaceAppUrl(params, window.location.pathname);
      setMessage("补抓未完成数据已启动");
    } catch (error) {
      if (isCurrent()) setMessage(error instanceof Error ? error.message : "补抓启动失败");
    } finally {
      terminalRepairInFlightRef.current = false;
      setTerminalRepairPending(false);
    }
  }, [activeAsins, authSession.logoutPending, market, rememberSyncJob, resumedProjectId, resumedSyncScope.canAdopt, setMessage, terminalOwnerFor, workspaceReady, autoSyncStartedKeyRef, restoringVocRunRef, setSelectedReportIds, setSyncAsins, setSyncRunContext, setTerminalPointerRetained, setTerminalRepairPending, setTerminalSyncJob, setVocRun, syncSuppressedKeyRef, terminalRepairInFlightRef, terminalRepairRef, terminalRepairScopeRef]);

  const handleTerminalSyncJob = useCallback((job: SyncJob): SyncCompletionDisposition => {
    const resumable = hasResumableFailedStages(job);
    const terminalOwner = terminalOwnerFor(job.asins ?? activeAsins, {
      projectId: job.scope?.projectId ?? resumedSyncScope.context?.projectId ?? null,
      marketplace: job.marketplace ?? market,
    });
    const applied = job.publication?.status === "applied" ? job.publication : null;
    const artifactId = applied?.artifactId ?? null;
    const recorded = terminalOwner.recordTerminal({ jobId: job.jobId, artifactId });
    const recordedArtifactId = recorded ? terminalOwner.readTerminal()?.artifactId ?? null : null;
    const convergentArtifact = applied && recordedArtifactId === applied.artifactId ? applied : null;
    setTerminalPointerRetained(resumable || !recorded);
    setSyncAsins(null);
    setTerminalSyncJob(job);
    setRefreshingProjectId(null);
    const currentArtifact = currentWebArtifactId();
    let disposition: SyncCompletionDisposition =
      !job.publication || job.publication.status === "not-required"
        ? "settled"
        : "convergence-blocked";
    if (convergentArtifact && currentArtifact === convergentArtifact.artifactId) {
      const url = new URL(window.location.href);
      if (url.searchParams.has("webArtifact")) {
        url.searchParams.delete("webArtifact");
        window.history.replaceState(window.history.state, "", url.toString());
      }
      setPublicationConvergenceNotice(null);
      disposition = "settled";
    } else if (convergentArtifact && terminalOwner.claimArtifactReload({ jobId: job.jobId, artifactId: convergentArtifact.artifactId })) {
      setPublicationConvergenceNotice(null);
      const url = new URL(window.location.href);
      url.searchParams.set("webArtifact", convergentArtifact.artifactId);
      window.location.replace(url.toString());
      return "navigation-started";
    } else {
      setPublicationConvergenceNotice(applied
        ? publicationArtifactNotice(currentArtifact, applied.artifactId)
        : null);
    }
    if (recorded) {
      syncSuppressedKeyRef.current = activeAsins.join(",");
      autoSyncStartedKeyRef.current = null;
    }
    return disposition;
  }, [activeAsins, market, resumedSyncScope.context?.projectId, terminalOwnerFor, autoSyncStartedKeyRef, setPublicationConvergenceNotice, setRefreshingProjectId, setSyncAsins, setTerminalPointerRetained, setTerminalSyncJob, syncSuppressedKeyRef]);

  return { terminalOwnerFor, dismissSyncJob, restartTerminalSync, handleTerminalSyncJob };
}
