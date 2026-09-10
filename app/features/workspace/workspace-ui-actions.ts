"use client";

import { clearSyncJobFromSearch } from "../../lib/asin-sync-session";
import { type AnalysisProject } from "../projects/project-library-panel";
import { replaceAppUrl } from "../projects/workspace-navigation";
import type { useWorkspaceInput } from "./workspace-input";
import type { useSyncSessionState } from "./sync-session-state";
import type { useSyncStart } from "./sync-start";
import type { createProjectApplication } from "./project-application";
import type { useProjectState } from "./project-state";
import type { useWorkspaceResume } from "./workspace-resume";
import type { useVocRunState } from "./workspace-voc-run";
import type { useRuntimeDataState } from "./workspace-runtime";

type createWorkspaceUiActionsInputs = Pick<ReturnType<typeof useWorkspaceInput>, "activeAsins" | "setMessage" | "setActiveAsins" | "replaceInputAsins">
  & Pick<ReturnType<typeof useSyncSessionState>, "syncSuppressedKey" | "autoSyncStartedKey" | "setSyncAsins" | "setSyncRunContext" | "setTerminalSyncJob" | "setTerminalPointerRetained" | "setStageOutputReceipt">
  & Pick<ReturnType<typeof useSyncStart>, "startSyncIfNeeded">
  & Pick<ReturnType<typeof createProjectApplication>, "applyProject">
  & Pick<ReturnType<typeof useProjectState>, "setRefreshingProjectId" | "currentProjectId" | "setCurrentProjectId" | "setCurrentProjectName">
  & Pick<ReturnType<typeof useWorkspaceResume>, "setWorkspaces" | "setWorkspaceLabel">
  & Pick<ReturnType<typeof useVocRunState>, "restoringVocRun" | "setVocRun" | "setSelectedReportIds">
  & Pick<ReturnType<typeof useRuntimeDataState>, "setRuntimeAnalysisData" | "runtimeAnalysisRequest">;

export function createWorkspaceUiActions({
    activeAsins, setMessage, syncSuppressedKey: syncSuppressedKeyRef, autoSyncStartedKey: autoSyncStartedKeyRef,
    startSyncIfNeeded, setSyncAsins, setSyncRunContext, applyProject, setRefreshingProjectId, setWorkspaces, currentProjectId,
    setCurrentProjectId, setCurrentProjectName, setWorkspaceLabel, setActiveAsins, replaceInputAsins,
    restoringVocRun: restoringVocRunRef, setVocRun, setSelectedReportIds, setTerminalSyncJob, setTerminalPointerRetained,
    setStageOutputReceipt, setRuntimeAnalysisData, runtimeAnalysisRequest: runtimeAnalysisRequestRef,
  }: createWorkspaceUiActionsInputs) {
  const handleOverviewTabOnRequestSync = () => {
            if (activeAsins.length < 3) {
              setMessage("请至少输入 3 个竞品 ASIN");
              return;
            }
            syncSuppressedKeyRef.current = null;
            autoSyncStartedKeyRef.current = null;
            void startSyncIfNeeded(activeAsins, { force: true });
          };

  const handleOverviewTabOnSyncDismiss = () => {
            syncSuppressedKeyRef.current = activeAsins.join(",");
            setSyncAsins(null);
            setSyncRunContext(null);
            replaceAppUrl(clearSyncJobFromSearch(window.location.search), window.location.pathname);
          };

  const handleKeywordsTabOnRequestSync = () => {
            if (activeAsins.length < 3) {
              setMessage("请至少输入 3 个竞品 ASIN");
              return;
            }
            syncSuppressedKeyRef.current = null;
            autoSyncStartedKeyRef.current = null;
            void startSyncIfNeeded(activeAsins, { force: true });
          };

  const handleKeywordsTabOnSyncDismiss = () => {
            syncSuppressedKeyRef.current = activeAsins.join(",");
            setSyncAsins(null);
          };

  const handleTrafficTabOnRequestSync = () => {
            if (activeAsins.length < 3) {
              setMessage("请至少输入 3 个竞品 ASIN");
              return;
            }
            syncSuppressedKeyRef.current = null;
            autoSyncStartedKeyRef.current = null;
            void startSyncIfNeeded(activeAsins, { force: true });
          };

  const handleTrafficTabOnSyncDismiss = () => {
            syncSuppressedKeyRef.current = activeAsins.join(",");
            setSyncAsins(null);
          };

  const handleKeywordCompareLibraryTabOnRefreshKeywords = (project: AnalysisProject) => {
            applyProject(project, { announce: false });
            setRefreshingProjectId(project.id);
            syncSuppressedKeyRef.current = null;
            autoSyncStartedKeyRef.current = null;
            void startSyncIfNeeded(project.asins, { force: true }).then(started => {
              if (!started) setRefreshingProjectId(null);
            });
          };

  const handleTrafficPromoLibraryTabOnRefreshKeywords = (project: AnalysisProject) => {
            applyProject(project, { announce: false });
            setRefreshingProjectId(project.id);
            syncSuppressedKeyRef.current = null;
            autoSyncStartedKeyRef.current = null;
            void startSyncIfNeeded(project.asins, { force: true }).then(started => {
              if (!started) setRefreshingProjectId(null);
            });
          };

  const handleChecklistLibraryTabOnRefreshKeywords = (project: AnalysisProject) => {
            applyProject(project, { announce: false });
            setRefreshingProjectId(project.id);
            syncSuppressedKeyRef.current = null;
            autoSyncStartedKeyRef.current = null;
            void startSyncIfNeeded(project.asins, { force: true }).then(started => {
              if (!started) setRefreshingProjectId(null);
            });
          };

  const handleProjectsLibraryTabOnProjectDeleted = (id: string) => {
            setWorkspaces(previous => previous.filter(project => project.id !== id));
            if (id !== currentProjectId) return;
            setCurrentProjectId(null);
            setCurrentProjectName(null);
            setWorkspaceLabel("");
            setActiveAsins([]);
            replaceInputAsins([]);
            syncSuppressedKeyRef.current = activeAsins.join(",");
            autoSyncStartedKeyRef.current = null;
            restoringVocRunRef.current = null;
            setVocRun(null);
            setSelectedReportIds({});
            setSyncAsins(null);
            setSyncRunContext(null);
            setTerminalSyncJob(null);
            setTerminalPointerRetained(false);
            setStageOutputReceipt(null);
            setRuntimeAnalysisData(null);
            runtimeAnalysisRequestRef.current += 1;
            // Leave the deleted workspace entirely so in-flight run observers cannot
            // restore its pointers or recreate its project from the old ASIN input.
            window.location.replace("/?tab=projects&projectDeleted=1");
          };

  return {
    handleOverviewTabOnRequestSync, handleOverviewTabOnSyncDismiss, handleKeywordsTabOnRequestSync,
    handleKeywordsTabOnSyncDismiss, handleTrafficTabOnRequestSync, handleTrafficTabOnSyncDismiss,
    handleKeywordCompareLibraryTabOnRefreshKeywords, handleTrafficPromoLibraryTabOnRefreshKeywords,
    handleChecklistLibraryTabOnRefreshKeywords, handleProjectsLibraryTabOnProjectDeleted,
  };
}
