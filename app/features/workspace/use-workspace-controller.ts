"use client";

import type { AuthenticatedWebSession } from "../../auth-session-gate";
import { useWorkspaceLocation } from "./workspace-location";
import { useWorkspaceInput } from "./workspace-input";
import { useVocRunState } from "./workspace-voc-run";
import { useSyncSessionState } from "./sync-session-state";
import { useProjectState } from "./project-state";
import { useFlyoutState } from "./workspace-flyout";
import { useRuntimeDataState } from "./workspace-runtime";
import { useRuntimeRefresh } from "./workspace-runtime";
import { useWorkspaceResume } from "./workspace-resume";
import { useTerminalSync } from "./terminal-sync";
import { useStageOutput } from "./stage-output";
import { useWorkspaceVocSources } from "./workspace-voc-sources";
import { useTrafficSnapshot } from "./traffic-snapshot";
import { useWorkspaceSourceModel } from "./workspace-source-model";
import { useSavedReportView } from "./workspace-voc-run";
import { useCatalogRefresh } from "./workspace-runtime";
import { useVocRunRestore } from "./workspace-voc-run";
import { useFlyoutPinnedPhase } from "./workspace-flyout";
import { useProjectLibraryRefresh } from "./project-library-refresh";
import { useFlyoutInteractions } from "./workspace-flyout";
import { useSyncStart } from "./sync-start";
import { createProjectApplication } from "./project-application";
import { useProjectHydration } from "./project-hydration";
import { createWorkspaceNavigation } from "./workspace-navigation-model";
import { createAnalysisWorkspace } from "./workspace-analysis-actions";
import { createAnalysisRun } from "./workspace-analysis-actions";
import { createVocReportActions } from "./workspace-voc-run";
import { createProjectSaveActions } from "./project-save-actions";
import { createWorkspaceUiActions } from "./workspace-ui-actions";

export function useWorkspaceController({ authSession }: { authSession: AuthenticatedWebSession }) {
  const {
    searchParams, router, appSearch, appLocationRef, asinsParam, projectParam, slugParam, workspacePath, tabHref,
    initialAsins, activeTab,
  } = useWorkspaceLocation();

  const {
    market, setMarket, inputs, setInputs, asinDraft, setAsinDraft, asinParse, replaceInputAsins, activeAsins, setActiveAsins,
    salesView, setSalesView, setMessage, message, showBuilderNotice,
  } = useWorkspaceInput({ initialAsins, slugParam, authSession });

  const { vocRun, setVocRun, selectedReportIds, setSelectedReportIds, restoringVocRun, vocRestoreController } = useVocRunState();

  const {
    syncAsins, setSyncAsins, syncRunContext, setSyncRunContext, terminalSyncJob, setTerminalSyncJob,
    publicationConvergenceNotice, setPublicationConvergenceNotice, stageOutputReceipt, setStageOutputReceipt,
    terminalPointerRetained, setTerminalPointerRetained, terminalRepairPending, setTerminalRepairPending,
    terminalRepairInFlight, terminalRepair, terminalRepairScope, analysisStartInFlight, workspaceKey, hydratedWorkspaceKey,
    setHydratedWorkspaceKey, syncSuppressedKey, autoSyncStartedKey, syncSessionJobIds, rememberSyncJob,
  } = useSyncSessionState({ slugParam, projectParam });

  const {
    currentProjectId, setCurrentProjectId, currentProjectName, setCurrentProjectName, savingKeywordCompare,
    setSavingKeywordCompare, savingTrafficPromo, setSavingTrafficPromo, savingChecklist, setSavingChecklist,
    refreshingProjectId, setRefreshingProjectId,
  } = useProjectState({ projectParam });

  const {
    flyoutGroupId, setFlyoutGroupId, flyoutPinned, setFlyoutPinned, flyoutTop, setFlyoutTop, flyoutCloseTimer, flyoutPanelRef,
    flyoutPinnedRef,
  } = useFlyoutState();

  const {
    catalogItems, setCatalogItems, runtimeAnalysisData, setRuntimeAnalysisData, runtimeAnalysisDataScope,
    setRuntimeAnalysisDataScope, runtimeAnalysisRequest, runtimeCommitGuard,
  } = useRuntimeDataState();

  const {
    syncJobId, baseSyncRunId, runtimeSessionKey, projectFavorites, runtimeScopeKey, refreshRuntimeAnalysisData,
    refreshRuntimeAfterSync,
  } = useRuntimeRefresh({
    searchParams, authSession, setVocRun, vocRestoreController, restoringVocRun, activeAsins, currentProjectId, market,
    runtimeCommitGuard, runtimeAnalysisRequest, setRuntimeAnalysisData, setRuntimeAnalysisDataScope, setCatalogItems,
    setMessage,
  });

  const {
    workspaces, setWorkspaces, workspaceLabel, setWorkspaceLabel, resumedSyncScope, workspaceReady, alexaVocPageScope,
    resumedProjectId,
  } = useWorkspaceResume({
    baseSyncRunId, syncRunContext, workspaceKey, hydratedWorkspaceKey, currentProjectId, refreshRuntimeAnalysisData,
    activeAsins, setMessage, runtimeScopeKey, authSession, runtimeAnalysisDataScope, runtimeAnalysisData,
  });

  const {
    terminalOwnerFor, dismissSyncJob, restartTerminalSync, handleTerminalSyncJob,
  } = useTerminalSync({
    terminalRepairScope, workspaceReady, authSession, resumedSyncScope, runtimeScopeKey, workspacePath, market,
    resumedProjectId, terminalPointerRetained, syncSuppressedKey, activeAsins, autoSyncStartedKey, setSyncAsins,
    setTerminalSyncJob, setRefreshingProjectId, terminalRepairInFlight, setTerminalRepairPending, terminalRepair, setMessage,
    rememberSyncJob, setTerminalPointerRetained, setSyncRunContext, restoringVocRun, setVocRun, setSelectedReportIds,
    setPublicationConvergenceNotice,
  });

  const {
    reviewRefreshFailed, stageOutputSnapshot, visibleTrafficStage, syncResume,
  } = useStageOutput({
    syncJobId, terminalSyncJob, baseSyncRunId, resumedSyncScope, authSession, market, activeAsins, workspacePath,
    resumedProjectId, setStageOutputReceipt, stageOutputReceipt, activeTab, workspaceReady, rememberSyncJob,
    setTerminalSyncJob, setTerminalPointerRetained, syncSessionJobIds, dismissSyncJob, handleTerminalSyncJob,
    restartTerminalSync, terminalRepairPending, terminalPointerRetained,
  });

  const { products, manualVoc, manualVocByAsin } = useWorkspaceVocSources({ activeAsins, catalogItems, alexaVocPageScope, authSession, market });

  const {
    trafficBindingKey, trafficSnapshotState, trafficSnapshotOwner, trafficData, trafficOrigin,
  } = useTrafficSnapshot({ authSession, market, activeAsins, activeTab, baseSyncRunId });

  const {
    stageOutputView, keywordAnalysisByAsin, keywordEnrichmentByKeyword, ratingByAsin, salesTrendByAsin, fbaFeeByAsin,
    listingContentByAsin, categoryTrendByNode, childSalesByAsin, priceStrategyByAsin, imageRemarksByAsin,
    imageRemarkOutcomesByAsin, reviewAnalysisByAsin, reviewGapReasonCode, fbaGapReasonCode, productLaunchSources,
    trafficOverviewByAsin, trafficMonthlyTrendByAsin, trafficMeta, mixedFamilies,
  } = useWorkspaceSourceModel({
    stageOutputSnapshot, visibleTrafficStage, runtimeAnalysisData, trafficData, activeAsins, market, manualVocByAsin,
    products,
  });

  const { savedReportView } = useSavedReportView({ vocRun, selectedReportIds });

  useCatalogRefresh({ setCatalogItems, workspaceKey });

  useVocRunRestore({ appSearch, authSession, restoringVocRun, vocRestoreController, setVocRun, runtimeSessionKey });

  useFlyoutPinnedPhase({ flyoutPinnedRef, flyoutPinned });

  useProjectLibraryRefresh({ setWorkspaces, currentProjectId });

  const {
    clearFlyoutCloseTimer, openFlyout, closeFlyout, toggleFlyout, scheduleCloseFlyout,
  } = useFlyoutInteractions({
    flyoutCloseTimer, setFlyoutTop, setFlyoutGroupId, setFlyoutPinned, flyoutGroupId, flyoutPinned, flyoutPinnedRef,
    flyoutPanelRef, flyoutTop,
  });

  const {
    startSyncIfNeeded,
  } = useSyncStart({
    syncJobId, terminalSyncJob, setTerminalPointerRetained, resumedSyncScope, workspaceReady, syncSuppressedKey,
    terminalOwnerFor, autoSyncStartedKey, syncAsins, catalogItems, setTerminalSyncJob, setSyncAsins, setMessage, asinsParam,
    slugParam, setActiveAsins, replaceInputAsins,
  });

  const {
    applyProject,
  } = createProjectApplication({
    currentProjectId, setMarket, setActiveAsins, replaceInputAsins, setCurrentProjectId, setCurrentProjectName,
    setWorkspaceLabel, restoringVocRun, setVocRun, setSelectedReportIds, setSyncAsins, setSyncRunContext, setTerminalSyncJob,
    setTerminalPointerRetained, setStageOutputReceipt, router, setMessage,
  });

  useProjectHydration({
    slugParam, projectParam, asinsParam, setCurrentProjectId, setCurrentProjectName, workspaceKey, setHydratedWorkspaceKey,
    setSyncAsins, setSyncRunContext, setTerminalSyncJob, setTerminalPointerRetained, setStageOutputReceipt,
    setRuntimeAnalysisData, runtimeAnalysisRequest, setMessage, setMarket, setActiveAsins, replaceInputAsins,
    setWorkspaceLabel, appLocationRef, router, refreshRuntimeAnalysisData, syncJobId, workspaceReady, activeAsins,
  });

  const { nav, activeFlyoutGroup, flyoutOpen, activeLeaf, pageTitle } = createWorkspaceNavigation({ flyoutGroupId, activeTab });

  const {
    persistAsins, ensureAnalysisWorkspace,
  } = createAnalysisWorkspace({ currentProjectId, slugParam, workspacePath, catalogItems, workspaceLabel, market });

  const {
    runAnalysis,
  } = createAnalysisRun({
    activeTab, asinParse, setMessage, inputs, analysisStartInFlight, restoringVocRun, setVocRun, setSelectedReportIds,
    setSyncRunContext, ensureAnalysisWorkspace, market, authSession, applyProject, replaceInputAsins, syncSuppressedKey,
    autoSyncStartedKey, setTerminalSyncJob, setTerminalPointerRetained, setSyncAsins, router,
  });

  const {
    cancelCurrentVocRun, retryCurrentVocStage, selectSavedReportVersion, downloadSavedAnalysisReports,
  } = createVocReportActions({ setVocRun, vocRun, setSelectedReportIds, setMessage, savedReportView });

  const {
    saveKeywordCompareProject, saveTrafficPromoProject, saveChecklistProject,
  } = createProjectSaveActions({
    activeAsins, setMessage, setSavingKeywordCompare, products, market, applyProject, inputs, setActiveAsins, setInputs,
    persistAsins, setSavingTrafficPromo, setSavingChecklist,
  });

  const {
    handleOverviewTabOnRequestSync, handleOverviewTabOnSyncDismiss, handleKeywordsTabOnRequestSync,
    handleKeywordsTabOnSyncDismiss, handleTrafficTabOnRequestSync, handleTrafficTabOnSyncDismiss,
    handleKeywordCompareLibraryTabOnRefreshKeywords, handleTrafficPromoLibraryTabOnRefreshKeywords,
    handleChecklistLibraryTabOnRefreshKeywords, handleProjectsLibraryTabOnProjectDeleted,
  } = createWorkspaceUiActions({
    activeAsins, setMessage, syncSuppressedKey, autoSyncStartedKey, startSyncIfNeeded, setSyncAsins, setSyncRunContext,
    applyProject, setRefreshingProjectId, setWorkspaces, currentProjectId, setCurrentProjectId, setCurrentProjectName,
    setWorkspaceLabel, setActiveAsins, replaceInputAsins, restoringVocRun, setVocRun, setSelectedReportIds,
    setTerminalSyncJob, setTerminalPointerRetained, setStageOutputReceipt, setRuntimeAnalysisData, runtimeAnalysisRequest,
  });

  return {
    flyoutOpen,
    publicationConvergenceNotice,
    nav,
    flyoutGroupId,
    activeTab,
    openFlyout,
    scheduleCloseFlyout,
    toggleFlyout,
    tabHref,
    closeFlyout,
    authSession,
    market,
    products,
    flyoutPanelRef,
    activeFlyoutGroup,
    flyoutTop,
    clearFlyoutCloseTimer,
    pageTitle,
    savingKeywordCompare,
    activeAsins,
    saveKeywordCompareProject,
    runAnalysis,
    savingTrafficPromo,
    inputs,
    saveTrafficPromoProject,
    savingChecklist,
    saveChecklistProject,
    savedReportView,
    downloadSavedAnalysisReports,
    activeLeaf,
    setMarket,
    setMessage,
    workspaceLabel,
    setWorkspaceLabel,
    asinDraft,
    asinParse,
    setAsinDraft,
    workspaces,
    currentProjectId,
    mixedFamilies,
    projectFavorites,
    currentProjectName,
    slugParam,
    showBuilderNotice,
    message,
    syncAsins,
    syncResume,
    refreshRuntimeAfterSync,
    stageOutputSnapshot,
    categoryTrendByNode,
    reviewGapReasonCode,
    reviewAnalysisByAsin,
    fbaGapReasonCode,
    fbaFeeByAsin,
    salesTrendByAsin,
    ratingByAsin,
    childSalesByAsin,
    priceStrategyByAsin,
    salesView,
    setSalesView,
    runtimeAnalysisData,
    runtimeAnalysisDataScope,
    runtimeScopeKey,
    listingContentByAsin,
    imageRemarksByAsin,
    imageRemarkOutcomesByAsin,
    alexaVocPageScope,
    manualVoc,
    reviewRefreshFailed,
    manualVocByAsin,
    vocRun,
    cancelCurrentVocRun,
    retryCurrentVocStage,
    selectSavedReportVersion,
    setInputs,
    keywordAnalysisByAsin,
    keywordEnrichmentByKeyword,
    productLaunchSources,
    runtimeSessionKey,
    baseSyncRunId,
    appSearch,
    workspaceReady,
    trafficSnapshotState,
    trafficBindingKey,
    trafficData,
    trafficSnapshotOwner,
    stageOutputView,
    trafficOrigin,
    trafficMeta,
    trafficOverviewByAsin,
    trafficMonthlyTrendByAsin,
    setRefreshingProjectId,
    setSyncAsins,
    refreshingProjectId,
    searchParams,
    applyProject,
    handleOverviewTabOnRequestSync,
    handleOverviewTabOnSyncDismiss,
    handleKeywordsTabOnRequestSync,
    handleKeywordsTabOnSyncDismiss,
    handleTrafficTabOnRequestSync,
    handleTrafficTabOnSyncDismiss,
    handleKeywordCompareLibraryTabOnRefreshKeywords,
    handleTrafficPromoLibraryTabOnRefreshKeywords,
    handleChecklistLibraryTabOnRefreshKeywords,
    handleProjectsLibraryTabOnProjectDeleted
  };
}

export type WorkspaceController = ReturnType<typeof useWorkspaceController>;
