"use client";

import { type RuntimeAnalysisDataSnapshot, createRuntimeAnalysisScopeGuard, readAndCommitRuntimeAnalysisData } from "./lib/runtime-analysis-data";
import { type AuthenticatedWebSession, AuthIdentityControl, AuthSessionGate } from "./auth-session-gate";
import { useSearchParams, usePathname, useRouter } from "next/navigation";
import { useRef, useEffect, useState, useMemo, useCallback, useLayoutEffect, Fragment } from "react";
import { type TabId, tabFromParam } from "./lib/app-tabs";
import { parseBatchAsinInput } from "./lib/asin-batch-input";
import { type BuilderNotice, shouldShowBuilderNotice, isPrimaryAdministrator } from "./lib/primary-admin";
import { type VocRunObservation, baseSyncRunIdFromSearch, clearVocRunFromSearch, vocRunIdFromSearch, waitForVocRun, VocRunClientError, cancelVocRun, retryVocStage } from "./lib/voc-run-browser";
import { type SavedAnalysisReportSelection, buildSavedAnalysisReportView, readSavedAnalysisReport, serializeSavedAnalysisReportView } from "./lib/saved-analysis-reports";
import { type SyncJob, type SyncCompletionDisposition, hasResumableFailedStages, type StageOutputSnapshot, type SyncResumeBundle, AsinSyncProgressSection, UrlResumableAsinSyncFunnel } from "./features/sync/asin-sync-funnel";
import { type TrafficStageReceipt, trafficStageFromReceipt, formatTrafficScore, trafficChildCountLabel } from "./lib/traffic-detail-view";
import { createIncompleteSyncRepair } from "./lib/sync-incomplete-repair-browser";
import { localAgentFetch, localAgentErrorMessage } from "./lib/local-agent-browser";
import { type NavGroupId, navigationEntries, type NavGroup, isNavGroup, groupIdForTab } from "./features/shell/navigation";
import { refreshedCatalog } from "./competitor-data";
import { syncJobIdFromSearch, clearSyncJobFromSearch, searchWithSyncJobId } from "./lib/asin-sync-session";
import { useAnalysisProjectFavorites } from "./features/projects/use-analysis-project-favorites";
import { type AnalysisProject, ProjectLibraryPage } from "./features/projects/project-library-panel";
import { useResumedSyncScope } from "./lib/resumed-sync-scope";
import { useXydcOrderProgress } from "./lib/use-xydc-order-progress";
import { resolveAlexaVocPageScope } from "./lib/alexa-voc-page-scope";
import { createTerminalSyncOwner, browserSessionStorage } from "./lib/sync-terminal-owner";
import { publicationArtifactNotice } from "./lib/publication-artifact-notice";
import { useVocReviewOutput } from "./lib/use-voc-review-output";
import { useManualAlexaVoc } from "./features/voc/use-manual-alexa-voc";
import { type ManualAlexaVocNormalizedRecord } from "../shared/agent-contracts";
import { type TrafficSnapshotClientState, trafficSnapshotBindingKey, createTrafficSnapshotOwner } from "./lib/traffic-snapshot-browser";
import { trafficDisplayFromSnapshot, sifListingTrafficMeta, sifAdChannelGlossary, sifAdChannelGlossaryList } from "./sif-listing-traffic-data";
import { buildStageOutputView } from "./lib/stage-output-view";
import { sifKeywordAnalysisData } from "./sif-keyword-analysis-data";
import { sifKeywordEnrichmentData } from "./sif-keyword-enrichment-data";
import { sorftimeReviewAnalysisData, sorftimeReviewAnalysisMeta as sorftimeReviewDataMeta } from "./sorftime-review-analysis-data";
import { sorftimeRatingData } from "./sorftime-rating-data";
import { sorftimeSalesTrendData, sorftimeSalesTrendMeta } from "./sorftime-sales-trend-data";
import { sorftimeFbaFeeData, sorftimeFbaFeeMeta } from "./sorftime-fba-fee-data";
import { sorftimeListingContentData } from "./sorftime-listing-content-data";
import { sorftimeCategoryTrendData } from "./sorftime-category-trend-data";
import { sorftimeChildSales30d } from "./sorftime-child-sales-data";
import { sorftimePriceStrategies, sorftimePriceStrategyMeta } from "./sorftime-price-strategy-data";
import { listingImageRemarks } from "./listing-image-remarks";
import { scopedReviewRecords, reviewMissingMessage } from "./lib/voc-review-display";
import { stageOutputGapReasonCode, StageOutputGapNotice } from "./features/sync/stage-output-gap-notice";
import { type ProductLaunchRuntimeSources } from "./features/product-reports/product-launch-analysis";
import { buildKeywordDemandAnalysis } from "./features/keywords/keyword-demand-analysis";
import { workspaceHref, projectWorkspacePath } from "./lib/workspace-url";
import { readHistoricalSyncPointer } from "./features/projects/historical-sync-pointer";
import { inferAmazonMajorCategory } from "./amazon-major-categories";
import { NavThemeIcon, NavSubText } from "./features/shell/navigation-presentation";
import Link from "next/link";
import { HelpFeedbackDrawer } from "./help-feedback/help-feedback-drawer";
import { ConcurrencyAdminPanel } from "./concurrency-admin-panel";
import { BatchAsinInput } from "./features/sync/batch-asin-input";
import { WorkspaceHistoryStrip } from "./features/projects/workspace-history-strip";
import { AnalysisProjectFavoriteButton } from "./features/projects/analysis-project-favorite-button";
import { StageOutputGapCard } from "./features/sync/stage-output-gap-card";
import { CategoryNodeTrendSection } from "./category-node-trend-section";
import { resolveOverviewPrice, resolveOverviewRank } from "./lib/competitor-overview-fallback";
import { resolveRatingMetric, resolveFbaMetric, resolvePriceMetric } from "./lib/competitor-metric-resolution";
import { RatingCell } from "./components/amazon-star-rating";
import { XydcVariantSection } from "./xydc-variant-section";
import { LISTING_IMAGES_SOURCE_LABEL, ListingImagesSection } from "./features/listing/listing-images-section";
import { manualVocDisplayMeta, manualVocDimensions, manualVocSourceBadge } from "./features/voc/voc-display-schema";
import { VocDimensionLabel } from "./features/voc/voc-dimension-label";
import { AlexaVocImportPanel } from "./features/voc/alexa-voc-import-panel";
import { sorftimeReviewAnalysisMeta } from "./seller-sprite-review-analysis";
import { KeywordFetchStatusSection } from "./features/keywords/keyword-fetch-status";
import { KeywordDemandSection } from "./features/keywords/keyword-demand-section";
import { ProductLaunchRecommendationSection } from "./features/product-reports/product-launch-recommendation";
import { VocPositioningSection } from "./features/voc/voc-positioning-section";
import { VocEvidenceDefinition } from "./features/voc/voc-evidence-definition";
import { LaunchChecklistSection } from "./features/product-reports/launch-checklist-section";
import { TrafficDetailRecoveryControl } from "./features/traffic/traffic-detail-recovery";
import { TrafficFetchStatusSection } from "./features/traffic/traffic-fetch-status";
import { sifMonthlyTrafficMeta } from "./sif-monthly-traffic-trend-data";
import { buildTabHref, resolveActiveAsins, buildInputSlots, replaceAppUrl, parseAsinsParam, setProjectParam, sameAsinSet, PROJECT_REGISTRATION_FAILURE, savedReportStageLabels, MAX_ASIN_SLOTS, buildProjectLoadHref } from "./features/projects/workspace-navigation";
import { type MarketCode, type Product, placeholderProduct, markets, sellerSpriteOnlyFieldsUnavailable, variationTheme } from "./features/catalog/product-contracts";
import { SourceBadge } from "./components/source-badge";
import { ProductHeader } from "./components/product-header";
import { SalesTrendSparkline, ChildSalesBars, ComparisonChart } from "./features/charts/sales-charts";
import { colors } from "./features/charts/chart-format";
import { renderVocMatrixItem, ReviewAnalysisMatrixSection } from "./features/voc/review-analysis-matrix";
import { VocSevenDimensionInsightSection } from "./features/voc/voc-seven-dimension-insight";
import { VocRunStatusSummary } from "./features/voc/voc-run-status-summary";
import { TrafficDistributionBars, ChildTrafficStructurePanel } from "./features/traffic/traffic-distribution";
import { MonthlyTrafficStackChart } from "./features/traffic/monthly-traffic-stack-chart";
import { TrafficAnalysisConclusionSection } from "./features/traffic/traffic-analysis-conclusion-section";
import { BackToTopButton } from "./components/back-to-top-button";

function currentWebArtifactId(): string {
  return document.documentElement.dataset.webArtifactId ?? "legacy";
}

const ROOT_PATH_DIAGNOSTIC =
  "根路径不再混合展示全部底库。请输入一批同类 ASIN，或点下方工作区进入 /p/floor-lamps、/p/kick-scooters";

const RUNTIME_ANALYSIS_REFRESH_FAILED = "最新分析数据暂未刷新，页面已保留现有结果";

type RuntimeAnalysisRefreshResult =
  | Readonly<{ ok: true; snapshot: RuntimeAnalysisDataSnapshot }>
  | Readonly<{ ok: false; reason: "failed" | "superseded"; message: string }>;

export function AuthenticatedAmazonOpportunityApp({ authSession }: { authSession: AuthenticatedWebSession }) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const appSearch = searchParams.toString();
  const appLocationRef = useRef({ pathname, search: appSearch });
  useEffect(() => {
    appLocationRef.current = { pathname, search: appSearch };
  }, [appSearch, pathname]);
  const tabParam = searchParams.get("tab");
  const asinsParam = searchParams.get("asins");
  const projectParam = searchParams.get("project");
  const slugParam = pathname.match(/^\/p\/([a-z0-9]+(?:-[a-z0-9]+)*)$/)?.[1] ?? null;
  const workspacePath = slugParam ? `/p/${slugParam}` : "/";
  const tabHref = (tabId: TabId) => buildTabHref(tabId, searchParams, workspacePath);
  const initialAsins = resolveActiveAsins(slugParam ? null : asinsParam);
  const activeTab = tabFromParam(tabParam);
  const [market, setMarket] = useState<MarketCode>("US");
  const [inputs, setInputs] = useState(() => buildInputSlots(initialAsins));
  const [asinDraft, setAsinDraft] = useState(() => initialAsins.join("\n"));
  const asinParse = useMemo(() => parseBatchAsinInput(asinDraft), [asinDraft]);
  const replaceInputAsins = useCallback((asins: string[]) => {
    setInputs(buildInputSlots(asins));
    setAsinDraft(asins.join("\n"));
  }, []);
  const [activeAsins, setActiveAsins] = useState(initialAsins);
  const [salesView, setSalesView] = useState<"history" | "revenue" | "prices" | "ranks">("history");
  const [builderNotice, setBuilderNotice] = useState<BuilderNotice>(() =>
    slugParam
      ? { kind: "business", text: `正在打开工作区 /p/${slugParam}` }
      : { kind: "path-diagnostic", text: ROOT_PATH_DIAGNOSTIC },
  );
  const setMessage = useCallback((text: string) => {
    setBuilderNotice({ kind: "business", text });
  }, []);
  const message = builderNotice.text;
  const showBuilderNotice = shouldShowBuilderNotice(builderNotice, authSession.user);
  const [vocRun, setVocRun] = useState<VocRunObservation | null>(null);
  const [selectedReportIds, setSelectedReportIds] = useState<SavedAnalysisReportSelection>({});
  const restoringVocRun = useRef<string | null>(null);
  const vocRestoreController = useRef<AbortController | null>(null);
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
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(projectParam);
  const [currentProjectName, setCurrentProjectName] = useState<string | null>(null);
  const [savingKeywordCompare, setSavingKeywordCompare] = useState(false);
  const [savingTrafficPromo, setSavingTrafficPromo] = useState(false);
  const [savingChecklist, setSavingChecklist] = useState(false);
  const [refreshingProjectId, setRefreshingProjectId] = useState<string | null>(null);
  const [flyoutGroupId, setFlyoutGroupId] = useState<NavGroupId | null>(null);
  const [flyoutPinned, setFlyoutPinned] = useState(false);
  const [flyoutTop, setFlyoutTop] = useState(96);
  const flyoutCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flyoutPanelRef = useRef<HTMLElement | null>(null);
  const flyoutPinnedRef = useRef(false);
  const [catalogItems, setCatalogItems] = useState<Product[]>(() => refreshedCatalog as Product[]);
  const [runtimeAnalysisData, setRuntimeAnalysisData] = useState<RuntimeAnalysisDataSnapshot | null>(null);
  const [runtimeAnalysisDataScope, setRuntimeAnalysisDataScope] = useState<string | null>(null);
  const runtimeAnalysisRequest = useRef(0);
  const runtimeCommitGuard = useRef(createRuntimeAnalysisScopeGuard());
  const syncJobId = syncJobIdFromSearch(searchParams.toString());
  const baseSyncRunId = baseSyncRunIdFromSearch(searchParams.toString());
  const runtimeSessionKey = `${authSession.sessionIdentity}:${authSession.user.organizationId}`;
  const projectFavorites = useAnalysisProjectFavorites(authSession.logoutPending ? null : runtimeSessionKey);
  useLayoutEffect(() => {
    setVocRun(null);
    return () => {
      vocRestoreController.current?.abort();
      vocRestoreController.current = null;
      restoringVocRun.current = null;
    };
  }, [runtimeSessionKey, authSession.logoutPending]);
  const runtimeAsinKey = [...activeAsins].sort().join(",");
  const runtimeScopeKey = `${runtimeSessionKey}:${currentProjectId}:${market}:${runtimeAsinKey}:${syncJobId}:${baseSyncRunId}`;
  const runtimeScope = useRef<{ sessionKey: string; projectId: string | null; asins: string; enabled: boolean } | null>(null);
  useLayoutEffect(() => {
    const guard = runtimeCommitGuard.current;
    guard.activate(authSession.logoutPending ? null : runtimeScopeKey);
    runtimeScope.current = { sessionKey: runtimeSessionKey, projectId: currentProjectId, asins: runtimeAsinKey, enabled: !authSession.logoutPending };
    return () => { runtimeScope.current = null; guard.activate(null); };
  }, [runtimeSessionKey, runtimeScopeKey, currentProjectId, runtimeAsinKey, authSession.logoutPending]);
  const refreshRuntimeAnalysisData = useCallback(async (
    projectId: string,
    asins: readonly string[],
    signal?: AbortSignal,
    isCurrent?: () => boolean,
  ): Promise<RuntimeAnalysisRefreshResult> => {
    const request = ++runtimeAnalysisRequest.current;
    const captured = runtimeCommitGuard.current.capture();
    const sessionKey = runtimeScope.current?.sessionKey;
    const asinKey = [...asins].sort().join(",");
    try {
      const snapshot = await readAndCommitRuntimeAnalysisData(projectId, asins, {
        signal,
        isCurrent: () => runtimeCommitGuard.current.isCurrent(captured) && request === runtimeAnalysisRequest.current && (!isCurrent || isCurrent())
          && runtimeScope.current?.enabled === true && runtimeScope.current.sessionKey === sessionKey
          && runtimeScope.current.projectId === projectId && runtimeScope.current.asins === asinKey,
        commit: snapshot => { setRuntimeAnalysisData(snapshot); setRuntimeAnalysisDataScope(captured!.key); setCatalogItems(snapshot.catalog as Product[]); },
      });
      if (!snapshot) {
        return { ok: false, reason: "superseded", message: RUNTIME_ANALYSIS_REFRESH_FAILED };
      }
      return { ok: true, snapshot };
    } catch {
      return {
        ok: false,
        reason: request === runtimeAnalysisRequest.current ? "failed" : "superseded",
        message: RUNTIME_ANALYSIS_REFRESH_FAILED,
      };
    }
  }, []);
  const refreshRuntimeAfterSync = useCallback(async (successMessage: string): Promise<boolean> => {
    if (!currentProjectId) {
      setMessage(RUNTIME_ANALYSIS_REFRESH_FAILED);
      return false;
    }
    const result = await refreshRuntimeAnalysisData(currentProjectId, activeAsins);
    if (!result.ok) {
      if (result.reason === "failed") setMessage(result.message);
      return false;
    }
    setMessage(successMessage);
    return true;
  }, [activeAsins, currentProjectId, refreshRuntimeAnalysisData, setMessage]);
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
  useLayoutEffect(() => {
    const guard = terminalRepairScope.current;
    guard.activate(workspaceReady && !authSession.logoutPending && resumedSyncScope.canAdopt
      ? `${runtimeScopeKey}:${workspacePath}:${market}:${resumedProjectId}` : null);
    return () => guard.activate(null);
  }, [runtimeScopeKey, workspacePath, market, resumedProjectId, workspaceReady, authSession.logoutPending, resumedSyncScope.canAdopt]);
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
    syncSuppressedKey.current = activeAsins.join(",");
    autoSyncStartedKey.current = null;
    setSyncAsins(null);
    setTerminalSyncJob(null);
    setRefreshingProjectId(null);
    replaceAppUrl(clearSyncJobFromSearch(window.location.search), window.location.pathname);
  }, [activeAsins, terminalPointerRetained]);
  const restartTerminalSync = useCallback(async (parentJob: SyncJob) => {
    if (terminalRepairInFlight.current || !workspaceReady || !resumedSyncScope.canAdopt || !resumedProjectId || authSession.logoutPending) return;
    const captured = terminalRepairScope.current.capture();
    const isCurrent = () => terminalRepairScope.current.isCurrent(captured);
    terminalRepairInFlight.current = true;
    setTerminalRepairPending(true);
    try {
      const result = await terminalRepair.current({ asins: activeAsins, marketplace: market, projectId: resumedProjectId, parentJobId: parentJob.jobId }, isCurrent);
      if (!result || !isCurrent()) return;
      if ("noWork" in result) {
        setMessage(result.message);
        return;
      }
      terminalOwnerFor(activeAsins).clearForExplicitStart();
      syncSuppressedKey.current = null;
      autoSyncStartedKey.current = activeAsins.join(",");
      rememberSyncJob(result.jobId);
      setTerminalSyncJob(null);
      setTerminalPointerRetained(false);
      setSyncAsins(null);
      setSyncRunContext(result.scope);
      restoringVocRun.current = null;
      setVocRun(null);
      setSelectedReportIds({});
      const params = clearVocRunFromSearch(new URLSearchParams(searchWithSyncJobId(window.location.search, result.jobId)));
      params.set("run", result.scope.runId);
      replaceAppUrl(params, window.location.pathname);
      setMessage("补抓未完成数据已启动");
    } catch (error) {
      if (isCurrent()) setMessage(error instanceof Error ? error.message : "补抓启动失败");
    } finally {
      terminalRepairInFlight.current = false;
      setTerminalRepairPending(false);
    }
  }, [activeAsins, authSession.logoutPending, market, rememberSyncJob, resumedProjectId, resumedSyncScope.canAdopt, setMessage, terminalOwnerFor, workspaceReady]);
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
      syncSuppressedKey.current = activeAsins.join(",");
      autoSyncStartedKey.current = null;
    }
    return disposition;
  }, [activeAsins, market, resumedSyncScope.context?.projectId, terminalOwnerFor]);
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
  // A fresh token prevents A -> B -> A from reviving the first A's pending response.
  const stageOutputOwnerToken = useMemo(() => ({ scopeKey: stageOutputScopeKey }), [stageOutputScopeKey]);
  const onScopedStageOutput = useCallback((snapshot: StageOutputSnapshot, reason?: "owner-disposed") => {
    // Tab disposal is not a new data result. Explicit retry updates (including {}) still apply.
    if (reason === "owner-disposed") return;
    setStageOutputReceipt({ scopeKey: stageOutputOwnerToken.scopeKey, ownerToken: stageOutputOwnerToken, snapshot });
  }, [stageOutputOwnerToken]);
  const currentStageReceipt = stageOutputReceipt?.ownerToken === stageOutputOwnerToken ? stageOutputReceipt : null;
  const reviewScope = useMemo(() => !authSession.logoutPending && resumedProjectId && stageOutputRunId && stageOutputJobId ? {
    organizationId: authSession.user.organizationId, projectId: resumedProjectId,
    runId: stageOutputRunId, jobId: stageOutputJobId, marketplace: market, asins: activeAsins,
  } : null, [authSession.logoutPending, authSession.user.organizationId, resumedProjectId, stageOutputRunId, stageOutputJobId, market, activeAsins]);
  // VOC has no funnel. Only read here while that tab owns the review view.
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
  }), [authSession.logoutPending, authSession.sessionIdentity, authSession.user.organizationId, onScopedStageOutput, dismissSyncJob, handleTerminalSyncJob, rememberSyncJob, restartTerminalSync, terminalRepairPending, resumedProjectId, resumedSyncScope.canAdopt, resumedSyncScope.context, resumedSyncScope.resolving, stageOutputScopeKey, syncJobId, syncSessionJobIds, terminalPointerRetained, terminalSyncJob, workspaceReady]);

  const products = useMemo(
    () => activeAsins.map(asin => catalogItems.find(p => p.asin === asin) ?? placeholderProduct(asin)),
    [activeAsins, catalogItems]
  );
  const manualVoc = useManualAlexaVoc({
    projectId: alexaVocPageScope.manualListProjectId,
    sessionIdentity: authSession.sessionIdentity,
    organizationId: authSession.user.organizationId,
    marketplace: market,
    asins: activeAsins,
    enabled: !authSession.logoutPending,
  });
  const manualVocByAsin = useMemo<Readonly<Record<string, ManualAlexaVocNormalizedRecord | undefined>>>(
    () => Object.fromEntries(activeAsins.map(asin => [asin, manualVoc.effectiveVocByAsin[asin]?.normalizedRecord])),
    [activeAsins, manualVoc.effectiveVocByAsin],
  );
  const [trafficSnapshotReceipt, setTrafficSnapshotReceipt] = useState<{ key: string; state: TrafficSnapshotClientState } | null>(null);
  const trafficBindingKey = trafficSnapshotBindingKey({
    sessionIdentity: authSession.sessionIdentity, organizationId: authSession.user.organizationId,
    logoutPending: authSession.logoutPending, marketplace: market, asins: activeAsins,
    runId: activeTab === "traffic" ? baseSyncRunId : null,
  });
  const trafficSnapshotState = useMemo<TrafficSnapshotClientState>(() => !authSession.logoutPending && trafficSnapshotReceipt?.key === trafficBindingKey
    ? trafficSnapshotReceipt.state : { kind: "pending" }, [authSession.logoutPending, trafficBindingKey, trafficSnapshotReceipt]);
  const trafficSnapshotOwner = useRef<ReturnType<typeof createTrafficSnapshotOwner> | null>(null);
  const asinScopeKey = activeAsins.join(",");
  useLayoutEffect(() => {
    const owner = trafficSnapshotOwner.current ??= createTrafficSnapshotOwner({
      sessionIdentity: authSession.sessionIdentity,
      organizationId: authSession.user.organizationId,
      logoutPending: authSession.logoutPending,
      runId: null,
      marketplace: market,
      asins: activeAsins,
      request: (path) => localAgentFetch(path),
      onState: (state, key) => setTrafficSnapshotReceipt({ state, key }),
    });
    if (activeTab !== "traffic" || !baseSyncRunId || activeAsins.length === 0) {
      owner.rebind({ sessionIdentity: authSession.sessionIdentity, organizationId: authSession.user.organizationId, logoutPending: authSession.logoutPending, runId: null, marketplace: market, asins: activeAsins });
      return;
    }
    owner.rebind({ sessionIdentity: authSession.sessionIdentity, organizationId: authSession.user.organizationId, logoutPending: authSession.logoutPending, runId: baseSyncRunId, marketplace: market, asins: activeAsins });
    void owner.refresh().catch(() => undefined);
    const timer = window.setInterval(() => void owner.refresh().catch(() => undefined), 5_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [activeAsins, activeTab, asinScopeKey, authSession.logoutPending, authSession.sessionIdentity, authSession.user.organizationId, baseSyncRunId, market]);
  // Stage output is independently authorized, not proof for hydrating a snapshot cache.
  const trafficData = useMemo(
    () => trafficSnapshotState.kind === "dynamic" ? trafficDisplayFromSnapshot(trafficSnapshotState.snapshot) : undefined,
    [trafficSnapshotState],
  );
  const trafficOrigin = trafficSnapshotState.kind === "dynamic"
    ? "dynamic" as const
    : trafficSnapshotState.kind === "legacy" ? "legacy" as const : "pending" as const;
  const stageOutputView = useMemo(
    () => buildStageOutputView({ ...stageOutputSnapshot, traffic: visibleTrafficStage.traffic }, {
      keywordAnalysisByAsin: runtimeAnalysisData
        ? runtimeAnalysisData.keywords.analysisByAsin as typeof sifKeywordAnalysisData
        : sifKeywordAnalysisData,
      keywordEnrichmentByKeyword: runtimeAnalysisData
        ? runtimeAnalysisData.keywords.enrichmentByKeyword as typeof sifKeywordEnrichmentData
        : sifKeywordEnrichmentData,
      // Global generated review files carry no project/run/job ownership.
      reviewAnalysisByAsin: {} as typeof sorftimeReviewAnalysisData,
      ratingByAsin: runtimeAnalysisData
        ? runtimeAnalysisData.reviews.ratingByAsin as typeof sorftimeRatingData
        : sorftimeRatingData,
      salesTrendByAsin: runtimeAnalysisData
        ? runtimeAnalysisData.salesTrend.trendByAsin as typeof sorftimeSalesTrendData
        : sorftimeSalesTrendData,
      fbaFeeByAsin: runtimeAnalysisData
        ? runtimeAnalysisData.fba.feeByAsin as typeof sorftimeFbaFeeData
        : sorftimeFbaFeeData,
      listingContentByAsin: runtimeAnalysisData
        ? runtimeAnalysisData.listing.contentByAsin as typeof sorftimeListingContentData
        : sorftimeListingContentData,
      categoryTrendByNode: runtimeAnalysisData
        ? runtimeAnalysisData.category.trendByNode as typeof sorftimeCategoryTrendData
        : sorftimeCategoryTrendData,
      childSalesByAsin: runtimeAnalysisData
        ? runtimeAnalysisData.childSales.rowsByAsin as typeof sorftimeChildSales30d
        : sorftimeChildSales30d,
      priceStrategyByAsin: runtimeAnalysisData
        ? runtimeAnalysisData.priceStrategy.strategyByAsin as typeof sorftimePriceStrategies
        : sorftimePriceStrategies,
      imageRemarksByAsin: runtimeAnalysisData
        ? runtimeAnalysisData.imageRemarks.remarksByAsin as typeof listingImageRemarks
        : listingImageRemarks,
      imageRemarkOutcomesByAsin: runtimeAnalysisData
        ? runtimeAnalysisData.imageRemarks.outcomesByAsin
        : {},
      trafficData: trafficData ?? {
        overview: {},
        monthlyTrend: {},
        meta: sifListingTrafficMeta,
      },
    }),
    [runtimeAnalysisData, stageOutputSnapshot, visibleTrafficStage.traffic, trafficData],
  );
  const {
    keywordAnalysisByAsin, keywordEnrichmentByKeyword, ratingByAsin,
    salesTrendByAsin, fbaFeeByAsin, listingContentByAsin, categoryTrendByNode,
    childSalesByAsin, priceStrategyByAsin, imageRemarksByAsin, imageRemarkOutcomesByAsin,
  } = stageOutputView;
  const reviewAnalysisByAsin = useMemo(() => scopedReviewRecords(stageOutputView.reviewAnalysisByAsin, activeAsins, market), [stageOutputView.reviewAnalysisByAsin, activeAsins, market]);
  const reviewGapReasonCode = stageOutputGapReasonCode(stageOutputSnapshot.reviews);
  const fbaGapReasonCode = stageOutputGapReasonCode(stageOutputSnapshot.fba);
  const productLaunchSources = useMemo<ProductLaunchRuntimeSources>(() => ({
    manualVocByAsin,
    keywordDemand: buildKeywordDemandAnalysis(
      products.map(product => ({
        asin: product.asin,
        brand: product.brand,
        title: product.title,
        subRankCategory: product.subRankCategory,
        image: product.image,
        price: product.price,
      })),
      {
        analysisByAsin: keywordAnalysisByAsin,
        enrichmentByKeyword: keywordEnrichmentByKeyword,
      },
    ),
  }), [keywordAnalysisByAsin, keywordEnrichmentByKeyword, manualVocByAsin, products]);
  const trafficOverviewByAsin = stageOutputView.trafficData.overview;
  const trafficMonthlyTrendByAsin = stageOutputView.trafficData.monthlyTrend;
  const trafficMeta = stageOutputView.trafficData.meta;
  const mixedFamilies = useMemo(() => {
    const families = new Set(
      products.map(item => item.productFamily).filter((item): item is NonNullable<Product["productFamily"]> => Boolean(item) && item !== "generic"),
    );
    return families.size > 1;
  }, [products]);
  const savedReportView = useMemo(
    () => vocRun?.runId
      ? buildSavedAnalysisReportView(vocRun.runId, vocRun.reports, selectedReportIds)
      : null,
    [selectedReportIds, vocRun],
  );

  const refreshCatalog = useCallback(async () => {
    try {
      const response = await fetch("/api/catalog");
      if (!response.ok) return;
      const payload = (await response.json()) as { items?: Product[] };
      if (Array.isArray(payload.items) && payload.items.length) {
        setCatalogItems(payload.items);
      }
    } catch {
      // 保留打包快照
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled && !workspaceKey) void refreshCatalog();
    });
    return () => {
      cancelled = true;
    };
  }, [refreshCatalog, workspaceKey]);

  useEffect(() => {
    const runId = vocRunIdFromSearch(appSearch);
    if (authSession.logoutPending || !runId || restoringVocRun.current === runId) return;
    restoringVocRun.current = runId;
    const controller = new AbortController();
    vocRestoreController.current = controller;
    void waitForVocRun(runId, { signal: controller.signal, onObservation: (observation) => {
      if (!controller.signal.aborted) setVocRun(observation);
    } })
      .catch((error) => { if (!controller.signal.aborted) setVocRun({
        kind: "failed",
        runId,
        stage: null,
        report: null,
        reports: [],
        message: error instanceof Error ? error.message : "Unable to restore VOC run",
      }); });
    return () => {
      controller.abort();
      if (restoringVocRun.current === runId) restoringVocRun.current = null;
    };
  }, [appSearch, runtimeSessionKey, authSession.logoutPending]);

  useEffect(() => {
    flyoutPinnedRef.current = flyoutPinned;
  }, [flyoutPinned]);

  useEffect(() => {
    localAgentFetch("/v1/local-data/projects?kind=analysis")
      .then(res => res.json())
      .then(payload => setWorkspaces(Array.isArray(payload.projects) ? payload.projects : []))
      .catch(() => setWorkspaces([]));
  }, [currentProjectId]);

  const clearFlyoutCloseTimer = () => {
    if (flyoutCloseTimer.current) {
      clearTimeout(flyoutCloseTimer.current);
      flyoutCloseTimer.current = null;
    }
  };

  const alignFlyoutToTrigger = (trigger: HTMLElement) => {
    const rail = trigger.closest(".nav-rail") ?? trigger;
    const top = trigger.getBoundingClientRect().top - rail.getBoundingClientRect().top;
    setFlyoutTop(Math.max(8, top));
  };

  const openFlyout = (id: NavGroupId, trigger?: HTMLElement | null) => {
    if (trigger) alignFlyoutToTrigger(trigger);
    clearFlyoutCloseTimer();
    setFlyoutGroupId(id);
  };

  const closeFlyout = () => {
    clearFlyoutCloseTimer();
    setFlyoutPinned(false);
    setFlyoutGroupId(null);
  };

  const toggleFlyout = (id: NavGroupId, trigger?: HTMLElement | null) => {
    if (trigger) alignFlyoutToTrigger(trigger);
    clearFlyoutCloseTimer();
    if (flyoutGroupId === id && flyoutPinned) {
      closeFlyout();
      return;
    }
    setFlyoutPinned(true);
    setFlyoutGroupId(id);
  };

  const scheduleCloseFlyout = () => {
    if (flyoutPinnedRef.current) return;
    clearFlyoutCloseTimer();
    flyoutCloseTimer.current = setTimeout(() => {
      if (flyoutPinnedRef.current) return;
      setFlyoutGroupId(null);
      flyoutCloseTimer.current = null;
    }, 240);
  };

  useEffect(() => () => clearFlyoutCloseTimer(), []);

  useLayoutEffect(() => {
    if (!flyoutGroupId || !flyoutPanelRef.current) return;
    const panel = flyoutPanelRef.current;
    const rail = panel.closest(".nav-rail");
    if (!rail) return;
    const height = panel.offsetHeight;
    const railHeight = rail.getBoundingClientRect().height;
    const margin = 8;
    const maxTop = Math.max(margin, railHeight - height - margin);
    setFlyoutTop(current => Math.min(Math.max(current, margin), maxTop));
  }, [flyoutGroupId, flyoutTop]);

  useEffect(() => {
    if (!flyoutGroupId) return;
    const onPointerDown = (event: PointerEvent) => {
      const path = event.composedPath();
      const inside = path.some(
        node =>
          node instanceof Element &&
          node.closest(".nav-rail, .sidebar-flyout, .voc-tertiary-open"),
      );
      if (inside) return;
      closeFlyout();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeFlyout();
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [flyoutGroupId]);

  const startSyncIfNeeded = useCallback(async (values: string[], { force = false } = {}) => {
    const key = values.join(",");
    if (values.length < 3) return false;
    if (syncJobId) {
      if (!force || !["completed", "completed-with-gaps", "failed"].includes(terminalSyncJob?.status ?? "")) return false;
      replaceAppUrl(clearSyncJobFromSearch(window.location.search), window.location.pathname);
      setTerminalPointerRetained(false);
    }
    if (!resumedSyncScope.canStart) return false;
    if (!workspaceReady) return false;
    if (!force && syncSuppressedKey.current === key) return false;
    const terminalOwner = terminalOwnerFor(values);
    if (!force && terminalOwner.blocksAutomaticStart()) {
      syncSuppressedKey.current = key;
      return false;
    }
    if (!force && autoSyncStartedKey.current === key && syncAsins) return false;

    if (!force) {
      const pendingCatalog = values.filter(v => !catalogItems.some(p => p.asin === v)).length;
      let needsMcpSync = pendingCatalog > 0;
      try {
        const response = await localAgentFetch(`/v1/local-data/sync-asins?asins=${encodeURIComponent(key)}`);
        if (response.ok) {
          const payload = await response.json();
          needsMcpSync = Boolean(payload.needsSync);
        }
      } catch {
        needsMcpSync = pendingCatalog > 0;
      }
      if (!needsMcpSync) return false;
    }

    if (force) {
      terminalOwner.clearForExplicitStart();
      setTerminalSyncJob(null);
    }
    autoSyncStartedKey.current = key;
    syncSuppressedKey.current = null;
    setSyncAsins(values);
    setMessage(`已加入 ${values.length} 个竞品，后台正在全自动拉取数据（含 VOC）…`);
    return true;
  }, [syncAsins, catalogItems, setMessage, syncJobId, resumedSyncScope.canStart, terminalOwnerFor, terminalSyncJob?.status, workspaceReady]);

  useEffect(() => {
    const parsed = parseAsinsParam(asinsParam);
    if (slugParam) return;
    if (!parsed) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setActiveAsins(current => (current.join(",") === parsed.join(",") ? current : parsed));
      replaceInputAsins(parsed);
    });
    return () => {
      cancelled = true;
    };
  }, [asinsParam, replaceInputAsins, slugParam]);

  const applyProject = (
    project: AnalysisProject,
    options?: { announce?: boolean; normalizeInput?: boolean; replace?: boolean },
  ) => {
    const changingWorkspace = project.id !== currentProjectId;
    const nextMarket = (project.marketplace in markets ? project.marketplace : "US") as MarketCode;
    setMarket(nextMarket);
    setActiveAsins(project.asins);
    if (options?.normalizeInput !== false) replaceInputAsins(project.asins);
    setCurrentProjectId(project.id);
    setCurrentProjectName(project.name);
    if (project.name && project.categoryLabel && project.name !== project.categoryLabel && !project.name.startsWith(`${project.categoryLabel} ·`)) {
      setWorkspaceLabel(project.name);
    } else {
      setWorkspaceLabel("");
    }
    let params = new URLSearchParams(window.location.search);
    params.delete("asins");
    params.delete("project");
    if (changingWorkspace) {
      params.delete("run");
      params = clearVocRunFromSearch(params);
      params.delete("syncJob");
      restoringVocRun.current = null;
      setVocRun(null);
      setSelectedReportIds({});
      setSyncAsins(null);
      setSyncRunContext(null);
      setTerminalSyncJob(null);
      setTerminalPointerRetained(false);
      setStageOutputReceipt(null);
    }
    if (!project.slug) {
      params.set("asins", project.asins.join(","));
      params.set("project", project.id);
    }
    const href = workspaceHref(project.slug, params);
    const current = `${window.location.pathname}${window.location.search}`;
    if (current !== href) {
      if (options?.replace) router.replace(href);
      else router.push(href);
    }
    if (options?.announce !== false) {
      setMessage(`已加载项目「${project.name}」· ${project.asins.length} 个 ASIN · ${project.slug ? `/p/${project.slug}` : ""}`);
    }
  };

  useEffect(() => {
    const key = slugParam || projectParam;
    if (!key) {
      if (!parseAsinsParam(asinsParam)) {
        let cancelled = false;
        queueMicrotask(() => {
          if (cancelled) return;
          setCurrentProjectId(null);
          setCurrentProjectName(null);
        });
        return () => {
          cancelled = true;
        };
      }
      return;
    }
    let cancelled = false;
    if (workspaceKey) {
      setHydratedWorkspaceKey(null);
      setSyncAsins(null);
      setSyncRunContext(null);
      setTerminalSyncJob(null);
      setTerminalPointerRetained(false);
      setStageOutputReceipt(null);
    }
    setRuntimeAnalysisData(null);
    runtimeAnalysisRequest.current += 1;
    localAgentFetch(`/v1/local-data/projects/${encodeURIComponent(key)}`)
      .then(res => res.json())
      .then(payload => {
        if (cancelled) return;
        if (!payload.project) {
          setMessage(`找不到工作区 /p/${key}，请从项目收藏打开或重新分析`);
          return;
        }
        const project = payload.project as AnalysisProject;
        const nextMarket = (project.marketplace in markets ? project.marketplace : "US") as MarketCode;
        setMarket(nextMarket);
        setActiveAsins(project.asins);
        replaceInputAsins(project.asins);
        setCurrentProjectId(project.id);
        setCurrentProjectName(project.name);
        if (project.name && project.categoryLabel && project.name !== project.categoryLabel && !project.name.startsWith(`${project.categoryLabel} ·`)) {
          setWorkspaceLabel(project.name);
        } else {
          setWorkspaceLabel("");
        }
        void readHistoricalSyncPointer(project).then(pointer => {
          if (cancelled) return;
          const currentLocation = appLocationRef.current;
          const params = new URLSearchParams(currentLocation.search);
          params.delete("asins");
          params.delete("project");
          if (pointer) {
            params.set("run", pointer.runId);
            params.set("syncJob", pointer.jobId);
            setSyncRunContext({ projectId: pointer.projectId, runId: pointer.runId });
          } else {
            setSyncRunContext(null);
          }
          const href = workspaceHref(project.slug, params);
          const current = `${currentLocation.pathname}${currentLocation.search ? `?${currentLocation.search}` : ""}`;
          if (current !== href) router.replace(href);
          if (workspaceKey) setHydratedWorkspaceKey(workspaceKey);
        });
      })
      .catch(() => {
        if (!cancelled) {
          setCurrentProjectName(null);
          if (workspaceKey) setHydratedWorkspaceKey(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [slugParam, projectParam, router, asinsParam, refreshRuntimeAnalysisData, replaceInputAsins, setMessage, workspaceKey]);

  useEffect(() => {
    if (!syncJobId || !workspaceReady || activeAsins.length === 0) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setMessage(`基础/MCP同步已启动，${activeAsins.length}个VOC待手工录入`);
    });
    return () => {
      cancelled = true;
    };
  }, [activeAsins.length, setMessage, syncJobId, workspaceReady]);

  const nav = navigationEntries;
  const activeFlyoutGroup = flyoutGroupId
    ? nav.find((entry): entry is NavGroup => isNavGroup(entry) && entry.id === flyoutGroupId) ?? null
    : null;
  const flyoutOpen = Boolean(activeFlyoutGroup);
  const activeLeaf = (() => {
    for (const entry of nav) {
      if (isNavGroup(entry)) {
        const child = entry.children.find(item => item.id === activeTab);
        if (child) return { parent: entry.label, ...child };
      } else if (entry.id === activeTab) {
        return { parent: null as string | null, ...entry };
      }
    }
    return { parent: null as string | null, id: "overview" as TabId, label: "竞品概览", sub: "" };
  })();
  const pageTitle = activeLeaf.parent ? `${activeLeaf.parent} · ${activeLeaf.label}` : activeLeaf.label;
  const persistAsins = (values: string[], projectId: string | null = currentProjectId) => {
    const params = new URLSearchParams(window.location.search);
    if (slugParam) {
      params.delete("asins");
      params.delete("project");
      replaceAppUrl(params, workspacePath);
      return;
    }
    params.set("asins", values.join(","));
    setProjectParam(params, projectId);
    replaceAppUrl(params, "/");
  };

  const ensureAnalysisWorkspace = async (asins: string[]) => {
    const pool = asins
      .map(asin => catalogItems.find(item => item.asin === asin))
      .filter((item): item is Product => Boolean(item));
    const categoryHint =
      pool.find(item => item.subRankCategory && item.subRankCategory !== "等待同步")?.subRankCategory ?? "竞品分析";
    const alias = workspaceLabel.trim();

    if (currentProjectId) {
      try {
        const response = await localAgentFetch(`/v1/local-data/projects/${encodeURIComponent(currentProjectId)}`);
        const existing = ((await response.json()) as { project?: AnalysisProject }).project;
        if (
          response.ok &&
          existing &&
          (existing.marketplace || "US") === market &&
          sameAsinSet(existing.asins, asins)
        ) return existing;
      } catch {
        // 精确复用失败后走 list/create；绝不修改旧项目。
      }
    }

    try {
      const listed = await localAgentFetch("/v1/local-data/projects?kind=analysis").then(res => res.json());
      const same = (listed.projects as AnalysisProject[] | undefined)?.find(
        project => sameAsinSet(project.asins, asins) && (project.marketplace || "US") === market,
      );
      if (same) return same;

      const response = await localAgentFetch("/v1/local-data/projects", {
        method: "POST",
        body: JSON.stringify({
          kind: "analysis",
          name: alias || `${categoryHint} · ${market}`,
          alias: alias || undefined,
          categoryLabel: categoryHint,
          majorCategory: inferAmazonMajorCategory(pool),
          marketplace: market,
          asins,
        }),
      });
      if (!response.ok) return null;
      return (await response.json()).project as AnalysisProject;
    } catch {
      return null;
    }
  };

  const runAnalysis = async () => {
    let values: string[];
    if (activeTab === "overview") {
      if (!asinParse.canSubmit) return setMessage("请修正 ASIN 输入后再开始分析");
      values = [...asinParse.asins];
    } else {
      values = inputs.map(v => v.trim().toUpperCase()).filter(Boolean);
      if (values.length < 3) return setMessage("请至少输入 3 个竞品 ASIN");
      const invalid = values.find(v => !/^[A-Z0-9]{10}$/.test(v));
      if (invalid) return setMessage(`${invalid} 格式不正确，ASIN 应为 10 位字母或数字`);
      if (new Set(values).size !== values.length) return setMessage("请勿重复输入相同 ASIN");
    }
    if (analysisStartInFlight.current) return;
    analysisStartInFlight.current = true;
    try {
      const cleanParams = clearVocRunFromSearch(clearSyncJobFromSearch(window.location.search));
      cleanParams.delete("run");
      replaceAppUrl(cleanParams, window.location.pathname);
      restoringVocRun.current = null;
      setVocRun(null);
      setSelectedReportIds({});
      setSyncRunContext(null);
      const project = await ensureAnalysisWorkspace(values);
      if (!project?.id) throw new Error(PROJECT_REGISTRATION_FAILURE);
      let registrationResponse: Response;
      let registrationPayload: {
        project?: {
          id?: unknown;
          organizationId?: unknown;
          marketplace?: unknown;
          asins?: unknown;
        };
        error?: unknown;
      };
      try {
        registrationResponse = await localAgentFetch("/v1/projects", {
          method: "POST",
          headers: {
            "Idempotency-Key": `project-register:${project.id}`,
          },
          body: JSON.stringify({
            id: project.id,
            name: project.name,
            marketplace: market,
            asins: values,
          }),
        });
        registrationPayload = await registrationResponse.json() as typeof registrationPayload;
      } catch {
        throw new Error(PROJECT_REGISTRATION_FAILURE);
      }
      const registeredProject = registrationPayload.project;
      if (
        !registrationResponse.ok ||
        registeredProject?.id !== project.id ||
        registeredProject.organizationId !== authSession.user.organizationId ||
        registeredProject.marketplace !== market ||
        !Array.isArray(registeredProject.asins) ||
        !sameAsinSet(registeredProject.asins, values)
      ) {
        throw new Error(PROJECT_REGISTRATION_FAILURE);
      }
      const ownershipParams = new URLSearchParams(cleanParams);
      ownershipParams.delete("asins");
      ownershipParams.delete("project");
      replaceAppUrl(ownershipParams, projectWorkspacePath(project.slug));
      applyProject(
        { ...project, marketplace: market, asins: [...values] },
        { announce: false, normalizeInput: false, replace: true },
      );
      const response = await localAgentFetch("/v1/local-data/sync-asins", {
        method: "POST",
        body: JSON.stringify({
          asins: values,
          marketplace: "US",
          projectId: registeredProject.id,
        }),
      });
      const payload = await response.json() as {
        jobId?: unknown;
        scope?: { projectId?: unknown; runId?: unknown };
        error?: unknown;
      };
      if (
        !response.ok ||
        typeof payload.jobId !== "string" ||
        !payload.jobId ||
        payload.scope?.projectId !== registeredProject.id ||
        typeof payload.scope.runId !== "string" ||
        !payload.scope.runId
      ) {
        throw new Error(localAgentErrorMessage(payload, "启动同步失败"));
      }

      replaceInputAsins(values);
      syncSuppressedKey.current = null;
      autoSyncStartedKey.current = values.join(",");
      const finalParams = new URLSearchParams(searchWithSyncJobId(cleanParams, payload.jobId));
      finalParams.set("run", payload.scope.runId);
      finalParams.delete("asins");
      finalParams.delete("project");
      if (!project?.slug) {
        finalParams.set("asins", values.join(","));
      }
      const finalHref = workspaceHref(project?.slug, finalParams);
      replaceAppUrl(finalParams, projectWorkspacePath(project?.slug));
      setTerminalSyncJob(null);
      setTerminalPointerRetained(false);
      setSyncAsins(null);
      router.replace(finalHref);
      setSyncRunContext({
        projectId: registeredProject.id,
        runId: payload.scope.runId,
      });
      setMessage(`基础/MCP同步已启动，${values.length}个VOC待手工录入`);
      return;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "启动同步失败");
    } finally {
      analysisStartInFlight.current = false;
    }
  };

  const continueVocRun = async (observation: VocRunObservation) => {
    setVocRun(observation);
    if (observation.kind === "active" && observation.runId) {
      setVocRun(await waitForVocRun(observation.runId, { onObservation: setVocRun }));
    }
  };

  const setVocActionFailure = (runId: string, error: unknown) => {
    setVocRun((current) => ({
      kind: error instanceof TypeError ? "offline" : error instanceof VocRunClientError ? error.kind : "failed",
      runId,
      stage: current?.stage ?? null,
      report: current?.report ?? null,
      reports: current?.reports ?? [],
      message: error instanceof TypeError
        ? "Agent Service is offline. Run: npm run agent:dev"
        : error instanceof Error ? error.message : "VOC run action failed",
    }));
  };

  const cancelCurrentVocRun = async () => {
    const runId = vocRun?.runId;
    if (!runId) return;
    try {
      await continueVocRun(await cancelVocRun(runId));
    } catch (error) {
      setVocActionFailure(runId, error);
    }
  };

  const retryCurrentVocStage = async () => {
    const runId = vocRun?.runId;
    if (!runId) return;
    try {
      await continueVocRun(await retryVocStage(runId));
    } catch (error) {
      setVocActionFailure(runId, error);
    }
  };

  const selectSavedReportVersion = async (
    stage: keyof typeof savedReportStageLabels,
    reportId: string,
  ) => {
    const runId = vocRun?.runId;
    if (!runId) return;
    try {
      const report = await readSavedAnalysisReport(reportId);
      if (report.runId !== runId || report.stage !== stage) {
        throw new Error("Saved report does not belong to this run and stage");
      }
      setVocRun((current) => current
        ? {
            ...current,
            reports: current.reports.map((candidate) => candidate.id === report.id ? report : candidate),
            report: stage === "voc-positioning" ? report : current.report,
          }
        : current);
      setSelectedReportIds((current) => ({ ...current, [stage]: report.id }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "读取已保存报告失败");
    }
  };

  const downloadSavedAnalysisReports = () => {
    if (!savedReportView) {
      setMessage("当前运行没有可导出的已保存报告");
      return;
    }
    const url = URL.createObjectURL(new Blob(
      [serializeSavedAnalysisReportView(savedReportView)],
      { type: "application/json" },
    ));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `analysis-run-${savedReportView.runId}-reports.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const saveKeywordCompareProject = async () => {
    if (activeAsins.length < 3) {
      setMessage("请至少保留 3 个竞品 ASIN 后再保存到流量词对比");
      return;
    }
    setSavingKeywordCompare(true);
    try {
      const categoryHint =
        products.find(item => item.subRankCategory && item.subRankCategory !== "等待同步")?.subRankCategory ??
        "竞品关键词";
      const stamp = new Date().toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "keyword-compare",
          name: `${categoryHint} · 流量词对比 · ${stamp}`,
          majorCategory: inferAmazonMajorCategory(products),
          categoryLabel: categoryHint,
          marketplace: market,
          asins: activeAsins,
          note: `来自竞品关键词分析 · ${activeAsins.length} 个 ASIN`,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "保存失败");
      const project = payload.project as AnalysisProject;
      applyProject(project, { announce: false });
      setMessage(`已保存到收藏夹「流量词对比」：${project.name}`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存到流量词对比失败");
    } finally {
      setSavingKeywordCompare(false);
    }
  };

  const saveTrafficPromoProject = async () => {
    const values = inputs.map(v => v.trim().toUpperCase()).filter(Boolean);
    if (values.length < 3) {
      setMessage("请至少保留 3 个竞品 ASIN 后再保存到推广能力分析");
      return;
    }
    const invalid = values.find(v => !/^[A-Z0-9]{10}$/.test(v));
    if (invalid) {
      setMessage(`${invalid} 格式不正确，ASIN 应为 10 位字母或数字`);
      return;
    }
    if (new Set(values).size !== values.length) {
      setMessage("请勿重复输入相同 ASIN");
      return;
    }
    setActiveAsins(values);
    setInputs(buildInputSlots(values));
    persistAsins(values);
    setSavingTrafficPromo(true);
    try {
      const categoryHint =
        products.find(item => item.subRankCategory && item.subRankCategory !== "等待同步")?.subRankCategory ??
        "竞品流量";
      const stamp = new Date().toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "traffic-promo",
          name: `${categoryHint} · 推广能力分析 · ${stamp}`,
          majorCategory: inferAmazonMajorCategory(products),
          categoryLabel: categoryHint,
          marketplace: market,
          asins: values,
          note: `来自竞品流量分析 · ${values.length} 个 ASIN`,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "保存失败");
      const project = payload.project as AnalysisProject;
      applyProject(project, { announce: false });
      setMessage(`已保存到收藏夹「竞品推广能力分析」：${project.name}`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存到推广能力分析失败");
    } finally {
      setSavingTrafficPromo(false);
    }
  };

  const saveChecklistProject = async () => {
    if (activeAsins.length < 3) {
      setMessage("请至少保留 3 个竞品 ASIN 后再保存到项目确认清单");
      return;
    }
    setSavingChecklist(true);
    try {
      const categoryHint =
        products.find(item => item.subRankCategory && item.subRankCategory !== "等待同步")?.subRankCategory ??
        "立项确认";
      const stamp = new Date().toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "checklist",
          name: `${categoryHint} · 立项确认清单 · ${stamp}`,
          majorCategory: inferAmazonMajorCategory(products),
          categoryLabel: categoryHint,
          marketplace: market,
          asins: activeAsins,
          note: `来自立项前确认清单 · ${activeAsins.length} 个 ASIN`,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "保存失败");
      const project = payload.project as AnalysisProject;
      applyProject(project, { announce: false });
      setMessage(`已保存到收藏夹「项目确认清单」：${project.name}`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存到项目确认清单失败");
    } finally {
      setSavingChecklist(false);
    }
  };

  return <main className={`app-shell${flyoutOpen ? " flyout-open" : ""}`}>
    {publicationConvergenceNotice ? <div role="status">{publicationConvergenceNotice}</div> : null}
    <div className="nav-rail">
    <aside className="sidebar">
      <div className="brand-mark">
        <span className="brand-icon" aria-hidden="true">
          <svg viewBox="0 0 48 48" width={38} height={38} fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="brandTile" x1="8" y1="6" x2="40" y2="42" gradientUnits="userSpaceOnUse">
                <stop stopColor="#2B3648"/>
                <stop offset="1" stopColor="#1A2332"/>
              </linearGradient>
              <linearGradient id="brandAccent" x1="14" y1="30" x2="36" y2="14" gradientUnits="userSpaceOnUse">
                <stop stopColor="#FFB84D"/>
                <stop offset="1" stopColor="#FF9900"/>
              </linearGradient>
            </defs>
            <g>
              <rect x="4" y="4" width="40" height="40" rx="12" fill="url(#brandTile)"/>
              {/* opportunity rising bars */}
              <path d="M12.5 31.5V27.2M17 31.5V23.5M21.5 31.5V20.2" stroke="#8FA0B5" strokeWidth="2.2" strokeLinecap="round"/>
              <path d="M12.5 26.2C16.8 26.2 19.2 20.8 23.8 18.6C27.6 16.8 30.2 14.2 33.8 12.4" stroke="url(#brandAccent)" strokeWidth="2.4" strokeLinecap="round"/>
              <path d="M29.6 12.2h4.8v4.8" stroke="url(#brandAccent)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
              {/* insight lens */}
              <circle cx="28.2" cy="27.8" r="6.4" stroke="#fff" strokeWidth="2.1"/>
              <path d="M32.8 32.4 36.6 36.2" stroke="#FF9900" strokeWidth="2.3" strokeLinecap="round"/>
              <circle cx="28.2" cy="27.8" r="2.1" fill="#FF9900"/>
            </g>
          </svg>
        </span>
        <div className="brand-copy">
          <strong>
            <span className="brand-amazon-logo">
              <img src="/amazon-logo.svg" alt="Amazon" width={88} height={27} />
            </span>
            产品机会洞察
          </strong>
        </div>
      </div>
      <nav>
        {nav.map(entry => (
          <Fragment key={entry.id}>
            {isNavGroup(entry) ? (
              <button
                type="button"
                data-dim={entry.id}
                aria-expanded={flyoutGroupId === entry.id}
                aria-controls="sidebar-flyout"
                className={`nav-item nav-group-trigger${entry.children.some(child => child.id === activeTab) || flyoutGroupId === entry.id ? " active" : ""}`}
                onMouseEnter={event => openFlyout(entry.id, event.currentTarget)}
                onMouseLeave={scheduleCloseFlyout}
                onFocus={event => openFlyout(entry.id, event.currentTarget)}
                onClick={event => toggleFlyout(entry.id, event.currentTarget)}
                onBlur={event => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    scheduleCloseFlyout();
                  }
                }}
              >
                <NavThemeIcon dim={entry.id} />
                <span className="nav-item-copy">
                  <b>{entry.label}</b>
                  <NavSubText text={entry.sub} />
                </span>
                <span className="nav-chevron" aria-hidden="true" />
              </button>
            ) : (
              <Link
                href={tabHref(entry.id)}
                data-dim={entry.id}
                className={activeTab === entry.id ? "nav-item active" : "nav-item"}
                onClick={closeFlyout}
              >
                <NavThemeIcon dim={entry.id} />
                <span className="nav-item-copy">
                  <b>{entry.label}</b>
                  <NavSubText text={entry.sub} />
                </span>
              </Link>
            )}
          </Fragment>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <HelpFeedbackDrawer user={authSession.user} />
        <div className="sync-status"><i/>数据源状态正常</div>
        <p>{markets[market].label} · 当前对比<br/><b>{products.length} 个 ASIN</b></p>
      </div>
    </aside>

    <aside
      id="sidebar-flyout"
      ref={flyoutPanelRef}
      className={`sidebar-flyout${flyoutOpen ? " open" : ""}`}
      aria-hidden={!flyoutOpen}
      aria-label={activeFlyoutGroup ? `${activeFlyoutGroup.label} 三级页面` : "三级导航"}
      style={{ top: flyoutTop }}
      onMouseEnter={clearFlyoutCloseTimer}
      onMouseLeave={scheduleCloseFlyout}
    >
      {activeFlyoutGroup ? (
        <div className="sidebar-flyout-list">
          {activeFlyoutGroup.children.map(child => (
            <Link
              key={child.id}
              href={tabHref(child.id)}
              data-dim={child.id}
              className={activeTab === child.id ? "sidebar-flyout-item active" : "sidebar-flyout-item"}
              onClick={closeFlyout}
            >
              <NavThemeIcon dim={child.id} />
              <span className="nav-item-copy">
                <b>{child.label}</b>
                <NavSubText text={child.sub} />
              </span>
            </Link>
          ))}
        </div>
      ) : null}
    </aside>
    </div>

    <section className="workspace">
      <header className="topbar">
        <div>
          <p className="eyebrow">{products[0]?.subRankCategory && products[0].subRankCategory !== "等待同步" ? products[0].subRankCategory : "竞品分析"} · Amazon {markets[market].short}</p>
          <h1>{pageTitle}</h1>
        </div>
        <div className="top-actions">
          <AuthIdentityControl session={authSession} />
          {activeTab === "keywords" ? (
            <>
              <button
                type="button"
                className="ghost-btn"
                disabled={savingKeywordCompare || activeAsins.length < 3}
                onClick={() => void saveKeywordCompareProject()}
              >
                {savingKeywordCompare ? "保存中…" : "保存到流量词对比"}
              </button>
              <button type="button" className="primary-btn" onClick={() => void runAnalysis()}>
                抓取关键词数据
              </button>
            </>
          ) : activeTab === "traffic" ? (
            <>
              <button
                type="button"
                className="ghost-btn"
                disabled={savingTrafficPromo || inputs.filter(Boolean).length < 3}
                onClick={() => void saveTrafficPromoProject()}
              >
                {savingTrafficPromo ? "保存中…" : "保存到推广能力分析"}
              </button>
              <button type="button" className="primary-btn" onClick={() => void runAnalysis()}>
                抓取流量数据
              </button>
            </>
          ) : activeTab === "checklist" ? (
            <>
              <button
                type="button"
                className="ghost-btn"
                disabled={savingChecklist || activeAsins.length < 3}
                onClick={() => void saveChecklistProject()}
              >
                {savingChecklist ? "保存中…" : "保存到项目确认清单"}
              </button>
              <Link className="primary-btn" href={tabHref("overview")}>管理竞品 ASIN</Link>
            </>
          ) : (
            <>
              <button
                type="button"
                className="ghost-btn"
                disabled={!savedReportView}
                onClick={downloadSavedAnalysisReports}
              >
                导出对比报告
              </button>
              <Link className="primary-btn" href={tabHref("overview")}>管理竞品 ASIN</Link>
            </>
          )}
        </div>
      </header>
      <ConcurrencyAdminPanel user={authSession.user} />
      <div className="comparison-context"><span>目标市场 <b>{markets[market].label} {markets[market].short}</b></span><span>竞品数量 <b>{products.length} / 10</b></span><span>对比模式 <b>多 ASIN 同屏</b></span><SourceBadge>卖家精灵更新 2026-08-03</SourceBadge></div>

      {activeLeaf.parent ? (
        <div className="voc-tertiary-bar" data-nav-dim={activeTab} aria-label={`${activeLeaf.parent} 当前位置`}>
          <div className="voc-tertiary-crumb">
            <button
              type="button"
              className="voc-tertiary-open"
              onMouseEnter={() => {
                const groupId = groupIdForTab(activeTab);
                if (groupId) {
                  const trigger = document.querySelector<HTMLElement>(`.nav-group-trigger[data-dim="${groupId}"]`);
                  openFlyout(groupId, trigger);
                }
              }}
              onClick={() => {
                const groupId = groupIdForTab(activeTab);
                if (groupId) {
                  const trigger = document.querySelector<HTMLElement>(`.nav-group-trigger[data-dim="${groupId}"]`);
                  toggleFlyout(groupId, trigger);
                }
              }}
            >
              {activeLeaf.parent}
            </button>
            <i>/</i>
            <b>{activeLeaf.label}</b>
          </div>
        </div>
      ) : null}


      {activeTab === "overview" && <div className="page-content compare-page">
        <section className="card asin-builder">
          <div className="section-head"><div><h3>设置对标竞品</h3><p>工作区按「类目 + 站点」分开：美国落地灯是 /p/floor-lamps-us，英国站会是 /p/floor-lamps-uk。同一站点再开一批细分（如儿童三轮 vs 成人滑板车）会再生成新地址。输入 3–10 个 ASIN 后点「开始全自动分析」。</p></div><span className="required-note">3–10 个</span></div>
          <div className="asin-builder-body">
            <div className="builder-meta-row">
            <label className="market-inline">目标市场<select value={market} onChange={e=>{const next=e.target.value as MarketCode;setMarket(next);setMessage(`已切换至 ${markets[next].label}，ASIN 链接与数据口径将同步更新`);}}>{Object.entries(markets).map(([code,item])=><option key={code} value={code}>{item.option}</option>)}</select></label>
            <label className="workspace-alias-field">
              细分名称
              <input
                value={workspaceLabel}
                onChange={e => setWorkspaceLabel(e.target.value)}
                placeholder="可选：儿童三轮 / 置物架灯 / Kids 3-Wheel"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            </div>
            <BatchAsinInput raw={asinDraft} result={asinParse} onRawChange={setAsinDraft} />
            {workspaces.length > 0 ? (
              <WorkspaceHistoryStrip
                workspaces={workspaces}
                currentProjectId={currentProjectId}
                buildHref={workspace => projectWorkspacePath(workspace.slug)}
              />
            ) : null}
            {mixedFamilies ? (
              <p className="mixed-family-note">
                当前表里混了不同品类。请分别打开对应工作区，不要把滑板车和落地灯放在同一页对比。
              </p>
            ) : null}
          </div>
          <div className="builder-actions">
            <AnalysisProjectFavoriteButton projectId={currentProjectId} favorites={projectFavorites} />
            <Link className="ghost-btn" href={tabHref("projects")}>收藏与历史</Link>
            {currentProjectName ? (
              <span className="builder-project-chip">
                当前工作区：{currentProjectName}
                {slugParam ? ` · /p/${slugParam}` : ""}
              </span>
            ) : null}
            {showBuilderNotice ? (
              <span
                className={
                  message.includes("请") || message.includes("不正确") || message.includes("重复")
                    ? "builder-message error"
                    : "builder-message"
                }
              >
                {message}
              </span>
            ) : null}
            <button className="primary-btn" onClick={runAnalysis}>开始全自动分析</button>
          </div>
        </section>

        {activeAsins.length > 0 || syncAsins ? (
        <AsinSyncProgressSection
          asins={activeAsins}
          marketplace={market}
          syncRequest={syncAsins}
          syncResume={syncResume}
          onRequestSync={() => {
            if (activeAsins.length < 3) {
              setMessage("请至少输入 3 个竞品 ASIN");
              return;
            }
            syncSuppressedKey.current = null;
            autoSyncStartedKey.current = null;
            void startSyncIfNeeded(activeAsins, { force: true });
          }}
          onSyncComplete={async () => {
            await refreshRuntimeAfterSync("MCP 同步完成，最新分析数据已刷新");
          }}
          onSyncDismiss={() => {
            syncSuppressedKey.current = activeAsins.join(",");
            setSyncAsins(null);
            setSyncRunContext(null);
            replaceAppUrl(clearSyncJobFromSearch(window.location.search), window.location.pathname);
          }}
        />
        ) : null}

        <StageOutputGapCard snapshot={stageOutputSnapshot} stage="category" />
        <CategoryNodeTrendSection
          marketplace={market}
          products={products.map(p => ({ asin: p.asin, brand: p.brand, subRankCategory: p.subRankCategory }))}
          trendByNode={categoryTrendByNode}
        />

        {reviewGapReasonCode ? (
          <StageOutputGapNotice
            label="评论数据"
            asins={activeAsins}
            records={reviewAnalysisByAsin}
            reasonCode={reviewGapReasonCode}
          />
        ) : null}
        <StageOutputGapCard snapshot={stageOutputSnapshot} stage="sales_trend" />
        <StageOutputGapCard snapshot={stageOutputSnapshot} stage="child_sales" />
        <StageOutputGapCard snapshot={stageOutputSnapshot} stage="price_strategy" />
        {fbaGapReasonCode ? (
          <StageOutputGapNotice
            label="FBA费用"
            asins={activeAsins}
            records={fbaFeeByAsin}
            reasonCode={fbaGapReasonCode}
          />
        ) : null}
        <section className="card compare-table-card"><div className="section-head"><div><h3>竞品参数总览</h3><p>{slugParam ? `当前工作区 /p/${slugParam} · 仅展示本批对标 ASIN` : "同一工作区内的竞品对齐查看；不同品类请用各自的 /p/ 地址"}；点击 ASIN 可打开对应站点前台</p></div><SourceBadge>MCP 综合</SourceBadge></div><div className="matrix-wrap"><table className="compare-matrix"><thead><tr><th>指标</th>{products.map((p,i)=><th key={p.asin}><ProductHeader product={p} index={i} market={market}/></th>)}</tr></thead><tbody>
          <tr><th>当前售价</th>{products.map(p=>{const overview=resolveOverviewPrice(p.price, salesTrendByAsin[p.asin]);return <td key={p.asin}><strong>{overview.value===null?"—":`$${overview.value}`}</strong></td>})}</tr>
          <tr><th>30天销量<small className="insight-source">Sorftime · 悬停趋势图</small></th>{products.map((p,i)=><td key={p.asin}><SalesTrendSparkline asin={p.asin} sales30d={p.sales} color={colors[i]} trendByAsin={salesTrendByAsin}/></td>)}</tr>
          <tr><th>评分 / 评论<small className="insight-source">Sorftime MCP</small></th>{products.map(p=>{const metric=resolveRatingMetric(ratingByAsin[p.asin],p);return <td key={p.asin}>{metric.value?<>{metric.value.rating===null?<span>— / {metric.value.reviewCount?.toLocaleString() ?? "—"}</span>:<RatingCell rating={metric.value.rating} reviews={metric.value.reviewCount}/>} {metric.label?<small className="no-data-text">{metric.label}</small>:null}</>:<span className="no-data-text">{metric.label}</span>}</td>})}</tr>
          <tr><th>Best Seller Rank</th>{products.map(p=>{const overview=resolveOverviewRank(p.rank, p.subRank, salesTrendByAsin[p.asin]);return <td key={p.asin}>{overview.value===null?"—":overview.source==="sellerSprite"?<div className="rank-lines"><b>#{overview.value.toLocaleString()} in {p.rankCategory}</b>{p.subRank===null?null:<small>#{p.subRank} in {p.subRankCategory}</small>}</div>:<div className="rank-lines"><b>#{overview.value.toLocaleString()}</b><small>类目：卖家精灵未返回</small></div>}</td>})}</tr>
          <tr><th>购物车卖家</th>{products.map(p=><td key={p.asin}>{sellerSpriteOnlyFieldsUnavailable(p)?"SellerSprite 暂不可用":p.buyBoxSeller}</td>)}</tr>
          <tr><th>配送方式</th>{products.map(p=><td key={p.asin}>{sellerSpriteOnlyFieldsUnavailable(p)?"SellerSprite 暂不可用":p.fulfillment}</td>)}</tr>
          <tr><th>产品包装</th>{products.map(p=><td key={p.asin}><b>{p.packageSize}</b><small>{p.packageWeight}</small></td>)}</tr>
          <tr><th>FBA 费用</th>{products.map(p=>{const record=fbaFeeByAsin[p.asin];const metric=resolveFbaMetric(record);return <td key={p.asin}>{metric.value!=null?<div className="fba-fee-cell"><strong>${metric.value.toFixed(2)}</strong>{record?.packageSize?<small title={record.note??undefined}>{record.packageSize}{record.packageWeight?` · ${record.packageWeight}`:""}</small>:null}<small className="insight-source">{record?.source === "keepa" ? "Keepa · 配送费" : "Sorftime · FBA 费用估算"}</small></div>:<span className="no-data-text">{metric.label ?? sorftimeFbaFeeMeta.emptyMessage}</span>}</td>})}</tr>
          <tr><th>产品规格<small className="insight-source">Features &amp; Specs</small></th>{products.map(p=><td key={p.asin}><div className="spec-lines">{p.specifications.map(spec=><div key={spec}>{spec}</div>)}</div></td>)}</tr>
          <tr><th>上架时间</th>{products.map(p=><td key={p.asin}>{p.launch}</td>)}</tr><tr><th>变体主题</th>{products.map(p=><td key={p.asin}>{variationTheme(p)}</td>)}</tr><tr><th>变体数量</th>{products.map(p=><td key={p.asin}>{p.variants}</td>)}</tr>
          <tr><th>近30天子体销量<small className="insight-source">Sorftime MCP</small></th>{products.map(p=>{const items=[...((childSalesByAsin[p.asin] as typeof sorftimeChildSales30d[string] | undefined)??[])].sort((a,b)=>b.sales-a.sales||a.variant.localeCompare(b.variant)).slice(0,5);return <td key={p.asin}><ChildSalesBars items={items}/></td>})}</tr>
          <tr><th>价格策略分析<small className="insight-source">Sorftime MCP</small></th>{products.map(p=>{const strategy=priceStrategyByAsin[p.asin] as typeof sorftimePriceStrategies[string] | undefined;const metric=resolvePriceMetric(strategy,p.price);return <td key={p.asin}>{strategy&&metric.source==="sorftime"?<div className="price-strategy-cell"><p><b>定价锚点</b>{strategy.anchor}</p><p><b>促销手法</b>{strategy.promotion}</p><p><b>折扣心理</b>{strategy.psychology}</p><small>{strategy.evidence}</small></div>:<span className="no-data-text">{metric.label ?? sorftimePriceStrategyMeta.emptyMessage}</span>}</td>})}</tr>
          <tr><th>主要卖点<small className="insight-source">Amazon Bullet Point 总结</small></th>{products.map(p=><td key={p.asin} className="selling-points-cell"><ul>{p.sellingPoints.map((point,index)=><li key={`${p.asin}-bp-${index}`}>{point}</li>)}</ul></td>)}</tr>
        </tbody></table></div></section>

        <section className="card compare-chart-card sales-combined-card">
          <div className="section-head">
            <div>
              <h3>竞品历史数据追踪</h3>
              <p>
                {salesView === "history"
                  ? "月销量 · 同一坐标系查看增速、体量与拐点"
                  : salesView === "revenue"
                    ? "月销售额 · Sorftime SalesAmount · USD"
                    : salesView === "prices"
                      ? "历史价格 · 月均价 · USD"
                      : "大类 BSR · 越靠上表现越优"}
                {sorftimeSalesTrendMeta.updatedAt ? ` · 同步至 ${sorftimeSalesTrendMeta.updatedAt}` : ""}
              </p>
            </div>
            <div className="chart-head-actions">
              <div className="chart-view-switch" role="group" aria-label="切换历史数据指标">
                <button className={salesView === "history" ? "selected" : ""} aria-pressed={salesView === "history"} onClick={() => setSalesView("history")}>
                  月销量
                </button>
                <button className={salesView === "revenue" ? "selected" : ""} aria-pressed={salesView === "revenue"} onClick={() => setSalesView("revenue")}>
                  月销售额
                </button>
                <button className={salesView === "prices" ? "selected" : ""} aria-pressed={salesView === "prices"} onClick={() => setSalesView("prices")}>
                  历史价格
                </button>
                <button className={salesView === "ranks" ? "selected" : ""} aria-pressed={salesView === "ranks"} onClick={() => setSalesView("ranks")}>
                  大类 BSR
                </button>
              </div>
              <SourceBadge>Sorftime MCP</SourceBadge>
            </div>
          </div>
          <div className="chart-legend">
            {products.map((p, i) => (
              <span key={p.asin}>
                <i style={{ background: colors[i] }} />
                {p.brand}
              </span>
            ))}
          </div>
          <ComparisonChart key={salesView} products={products} metric={salesView} inverse={salesView === "ranks"} trendByAsin={salesTrendByAsin} />
        </section>

        <XydcVariantSection
          products={products.map(product => ({
            asin: product.asin,
            brand: product.brand,
            title: product.title,
            image: product.image,
          }))}
          families={runtimeAnalysisData?.variants.families ?? []}
          orderFamilies={runtimeAnalysisData?.variantOrders.families ?? []}
          progress={runtimeAnalysisDataScope === runtimeScopeKey ? runtimeAnalysisData?.xydcOrderProgress ?? null : null}
          market={markets[market]}
        />
      </div>}

      {activeTab === "overview-images" && (
        <div className="page-content compare-page">
          <StageOutputGapCard snapshot={stageOutputSnapshot} stage="listing" />
          <StageOutputGapCard snapshot={stageOutputSnapshot} stage="image_remarks" />
          <section className="card page-intro">
            <div>
              <span className="status-chip">Listing 图册</span>
              <h2>纵向 ASIN、横向图片 1–9，同屏横向比较各竞品主图与辅图策略</h2>
              <p>布局对齐 Excel 竞品图册表：每行一个 ASIN，每列同一顺位素材；第 1 列为主图，其余为辅图；每张图下方灰色卡片为视觉结构摘要。</p>
            </div>
            <SourceBadge>{LISTING_IMAGES_SOURCE_LABEL}</SourceBadge>
          </section>
          <ListingImagesSection
            products={products.map(p => ({ asin: p.asin, brand: p.brand, image: p.image }))}
            market={markets[market]}
            colors={colors}
            listingByAsin={listingContentByAsin}
            resolveImageRemark={(asin, slotIndex) => {
              const slots = imageRemarksByAsin[asin];
              return Array.isArray(slots) ? slots[slotIndex] as never ?? null : null;
            }}
            resolveImageOutcome={(asin, slotIndex) => {
              const slots = imageRemarkOutcomesByAsin[asin];
              const candidate = Array.isArray(slots) ? slots[slotIndex] : null;
              return candidate && typeof candidate === "object" && !Array.isArray(candidate)
                ? candidate as never
                : null;
            }}
          />
        </div>
      )}

      {activeTab === "voc" && <div className="page-content compare-page">
        <section className="card page-intro"><div><span className="status-chip">多竞品 VOC 对比</span><h2>七个相同维度同屏对齐，直接比较顾客关注与购买决策差异</h2><p>入口：Alexa for Shopping 对话框 · 中文七问一次性提交 · 输出完整报告 · 数据源为 Customer Review（经 Alexa 整理）。</p></div><SourceBadge>{products.length} 个 ASIN 同屏</SourceBadge></section>
        <section className="card voc-dimension-format-card">
          <div className="section-head"><div><h3>VOC 核心主题 · 七维格式</h3><p>矩阵左列展示格式说明，各 ASIN 列按同一结构对齐</p></div><SourceBadge>{manualVocDisplayMeta.source}</SourceBadge></div>
          <table className="voc-dimension-format-table">
            <thead><tr><th>维度</th><th>格式说明</th></tr></thead>
            <tbody>
              {manualVocDimensions.map(d => (
                <tr key={d.key}>
                  <th>
                    <VocDimensionLabel label={d.label} description={d.description} />
                  </th>
                  <td>{d.formatHint}</td>
                </tr>
              ))}
              <tr className="voc-dimension-format-note-row">
                <th>备注</th>
                <td>Alexa for Shopping 聊天框提问，提问格式为：这个产品的顾客关注点是什么、好评点是什么、差评点是什么、未被满足的需求是什么、使用人群是谁、使用场景是什么、核心购买动机是什么。</td>
              </tr>
            </tbody>
          </table>
        </section>
        <AlexaVocImportPanel
          key={`${authSession.sessionIdentity}:${authSession.user.organizationId}`}
          projectId={alexaVocPageScope.authoritativeImportScope?.projectId ?? null}
          runId={alexaVocPageScope.authoritativeImportScope?.runId ?? null}
          products={products.map(p => ({ asin: p.asin, brand: p.brand, title: p.title }))}
          effectiveVocByAsin={manualVoc.effectiveVocByAsin}
          statusByAsin={manualVoc.statusByAsin}
          onImported={manualVoc.onImported}
          pollingEnabled={alexaVocPageScope.canPoll}
          disabled={market !== "US" || !alexaVocPageScope.authoritativeImportScope}
        />
        <section className="card voc-matrix-card">
          <div className="section-head">
            <div><h3>VOC 核心主题</h3><p>{manualVocDisplayMeta.scope}</p></div>
            <SourceBadge>Authenticated API</SourceBadge>
            {Object.values(manualVoc.statusByAsin).some(status => status === "source-error" || status === "protocol-conflict")
              ? <button type="button" className="ghost-btn" onClick={() => void manualVoc.refresh()}>重试读取 VOC</button>
              : null}
          </div>
          <div className="matrix-wrap">
            <table className="compare-matrix voc-matrix">
              <thead>
                <tr>
                  <th>VOC 维度</th>
                  {products.map((product, index) => {
                    const badge = manualVocSourceBadge(manualVoc.effectiveVocByAsin[product.asin] ?? null);
                    const status = manualVoc.statusByAsin[product.asin];
                    return <th key={product.asin}>
                      <ProductHeader product={product} index={index} market={market} />
                      {badge ? <small className="voc-status verified">{badge}</small> : null}
                      {status === "source-error" ? <small className="voc-status limited">读取失败 · 已保留页面版本</small> : null}
                      {status === "protocol-conflict" ? <small className="voc-status limited">revision 冲突 · 已保留页面版本</small> : null}
                    </th>;
                  })}
                </tr>
              </thead>
              <tbody>
                {manualVocDimensions.map(dimension => <tr key={dimension.key}>
                  <th>
                    <VocDimensionLabel label={dimension.label} description={dimension.description} />
                    <small className={dimension.verified ? "voc-status verified" : "voc-status limited"}>{dimension.formatHint}</small>
                  </th>
                  {products.map(product => {
                    const overlayRecord = manualVoc.effectiveVocByAsin[product.asin] ?? null;
                    const record = overlayRecord?.normalizedRecord;
                    const status = manualVoc.statusByAsin[product.asin];
                    const fallback = status === "loading"
                      ? "正在读取当前组织的 Manual Alexa VOC…"
                      : status === "source-error"
                        ? "运行时 VOC 暂不可用，请重试。"
                        : status === "protocol-conflict"
                          ? "服务器返回冲突 revision；已保留较新页面版本。"
                          : market === "US"
                            ? "该 ASIN 尚未录入 Manual Alexa VOC。"
                            : "Manual Alexa VOC 当前仅支持美国站。";
                    const items = record?.[dimension.key] ?? [fallback];
                    const isTableRow = Boolean(record) && (dimension.key === "audiences" || dimension.key === "scenarios" || dimension.key === "motives");
                    const cellClass = record ? "bullet-cell voc-alexa-cell" : "bullet-cell voc-limited-cell";
                    return <td key={product.asin} className={cellClass}>
                      <ul className={isTableRow ? "voc-table-list" : undefined}>
                        {items.map((item, index) => <li key={`${product.asin}-${dimension.key}-${index}`} className={item.includes("｜") && index === 0 ? "voc-table-head" : undefined}>{renderVocMatrixItem(item, dimension.key)}</li>)}
                      </ul>
                    </td>;
                  })}
                </tr>)}
              </tbody>
            </table>
          </div>
          <p className="voc-source-footnote">入口：{manualVocDisplayMeta.source} · 提问：中文七问 · 输出：完整报告 · 权威源：PostgreSQL（认证 API 即时读取）</p>
        </section>
        {reviewGapReasonCode ? (
          <StageOutputGapNotice
            label="评论数据"
            asins={activeAsins}
            records={reviewAnalysisByAsin}
            reasonCode={reviewGapReasonCode}
          />
        ) : null}
        {reviewRefreshFailed ? <p role="status">本次评论结果读取失败；如有本项目已验证结果，将继续保留显示。重新进入 VOC 页可重试读取。</p> : null}
        <ReviewAnalysisMatrixSection
          title="智能评论分析"
          description="Sorftime MCP · 按实际返回的 Customers Say 主题及评论样本展示 · 六维同屏对齐 · 格式：【分类】+ 提及占比；各 ASIN 的样本数和采集时间见表头。"
          badge="Sorftime MCP"
          data={reviewAnalysisByAsin}
          missingMessages={Object.fromEntries(activeAsins.map(asin => [asin, reviewMissingMessage(stageOutputSnapshot.reviews, asin)]))}
          dataMeta={{ ...sorftimeReviewDataMeta, updatedAt: stageOutputSnapshot.reviews && "updatedAt" in stageOutputSnapshot.reviews ? stageOutputSnapshot.reviews.updatedAt : "当前项目结果尚未读取" }}
          configMeta={sorftimeReviewAnalysisMeta}
          pendingSteps={
            <>
              服务端 Sorftime 连接器尚未配置或数据尚未同步。请联系管理员配置连接器后运行{" "}
              <code>{sorftimeReviewAnalysisMeta.syncCommand}</code>。
            </>
          }
          products={products}
          market={market}
        />
        <VocSevenDimensionInsightSection products={products} manualVocByAsin={manualVocByAsin} reviewAnalysisData={reviewAnalysisByAsin} />
        <section className="card launch-block" data-voc-run={vocRun?.runId ?? undefined}>
            <VocRunStatusSummary observation={vocRun} />
            {vocRun?.kind === "active" ? (
              <button type="button" className="ghost-btn" onClick={() => void cancelCurrentVocRun()}>取消运行</button>
            ) : null}
            {vocRun?.kind === "failed" ? (
              <button type="button" className="ghost-btn" onClick={() => void retryCurrentVocStage()}>重试 VOC 阶段</button>
            ) : null}
            {vocRun?.kind === "waiting-input" ? <p>需要补齐可信 VOC 数据后再重试；不会自动采集外部数据。</p> : null}
            {savedReportView ? (
              <div data-saved-analysis-reports={savedReportView.runId}>
                {savedReportView.stages.map((slot) => (
                  <article key={slot.stage} data-report-stage={slot.stage}>
                    <strong>{savedReportStageLabels[slot.stage]} · {slot.stage}</strong>
                    {slot.history.length ? (
                      <label>
                        已保存报告版本
                        <select
                          value={slot.selected?.id ?? ""}
                          onChange={(event) => void selectSavedReportVersion(slot.stage, event.target.value)}
                        >
                          {slot.history.map((report) => (
                            <option key={report.id} value={report.id}>
                              v{report.version} · {report.status}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : (
                      <p>暂无已保存报告</p>
                    )}
                    {slot.selected ? (
                      <>
                        <p>
                          Report {slot.selected.id} · v{slot.selected.version} · {slot.selected.status}
                        </p>
                        <p>
                          Skill {slot.selected.skill.id}@{slot.selected.skill.version}
                        </p>
                        <details>
                          <summary>查看已保存结果</summary>
                          <pre>{JSON.stringify(slot.selected.result, null, 2)}</pre>
                        </details>
                      </>
                    ) : null}
                  </article>
                ))}
              </div>
            ) : null}
          </section>
      </div>}

      {activeTab === "keywords" && <div className="page-content compare-page">
        <section className="card asin-builder">
          <div className="section-head">
            <div>
              <h3>本页独立设置竞品 ASIN</h3>
              <p>无需先去竞品概览；在此录入 3–10 个 ASIN，抓取关键词后即可保存到收藏夹「流量词对比」</p>
            </div>
            <span className="required-note">3–10 个</span>
          </div>
          <div className="asin-builder-body">
            <label className="market-inline">
              目标市场
              <select
                value={market}
                onChange={e => {
                  const next = e.target.value as MarketCode;
                  setMarket(next);
                  setMessage(`已切换至 ${markets[next].label}，关键词数据口径将同步更新`);
                }}
              >
                {Object.entries(markets).map(([code, item]) => (
                  <option key={code} value={code}>
                    {item.option}
                  </option>
                ))}
              </select>
            </label>
            <div className="asin-inputs">
              {Array.from({ length: MAX_ASIN_SLOTS }).map((_, i) => (
                <label key={i} className="asin-slot">
                  <span>
                    {i + 1}
                    {i < 3 && <b>*</b>}
                  </span>
                  <input
                    value={inputs[i]}
                    name={`asin-slot-${i}`}
                    placeholder="10位ASIN"
                    maxLength={10}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    data-lpignore="true"
                    data-1p-ignore="true"
                    onChange={e => setInputs(prev => prev.map((v, j) => (j === i ? e.target.value.toUpperCase() : v)))}
                  />
                  {i >= 3 && inputs[i] ? (
                    <button
                      type="button"
                      onClick={() => setInputs(prev => prev.map((v, j) => (j === i ? "" : v)))}
                      aria-label={`清空竞品${i + 1}`}
                    >
                      ×
                    </button>
                  ) : null}
                </label>
              ))}
            </div>
          </div>
          <div className="builder-actions">
            <Link className="ghost-btn" href={tabHref("keyword-compare")}>
              ★ 流量词对比
            </Link>
            {currentProjectName ? (
              <span className="builder-project-chip">
                当前工作区：{currentProjectName}
                {slugParam ? ` · /p/${slugParam}` : ""}
              </span>
            ) : null}
            {showBuilderNotice ? (
              <span
                className={
                  message.includes("请") || message.includes("不正确") || message.includes("重复") || message.includes("失败")
                    ? "builder-message error"
                    : "builder-message"
                }
              >
                {message}
              </span>
            ) : null}
            <button type="button" className="ghost-btn" disabled={savingKeywordCompare || activeAsins.length < 3} onClick={() => void saveKeywordCompareProject()}>
              {savingKeywordCompare ? "保存中…" : "保存到流量词对比"}
            </button>
            <button type="button" className="primary-btn" onClick={() => void runAnalysis()}>
              抓取关键词数据
            </button>
          </div>
        </section>

        <StageOutputGapCard snapshot={stageOutputSnapshot} stage="keywords" />
        <KeywordFetchStatusSection
          products={products.map(p => ({ asin: p.asin, brand: p.brand, image: p.image }))}
          marketplace={market}
          syncRequest={syncAsins}
          syncResume={syncResume}
          keywordAnalysisByAsin={keywordAnalysisByAsin}
          keywordEnrichmentByKeyword={keywordEnrichmentByKeyword}
          onRequestSync={() => {
            if (activeAsins.length < 3) {
              setMessage("请至少输入 3 个竞品 ASIN");
              return;
            }
            syncSuppressedKey.current = null;
            autoSyncStartedKey.current = null;
            void startSyncIfNeeded(activeAsins, { force: true });
          }}
          onSyncComplete={async () => {
            await refreshRuntimeAfterSync("关键词相关数据已就绪，可继续分析或保存到流量词对比");
          }}
          onSyncDismiss={() => {
            syncSuppressedKey.current = activeAsins.join(",");
            setSyncAsins(null);
          }}
        />

        <KeywordDemandSection
          mode="analysis"
          products={products.map(p => ({ asin: p.asin, brand: p.brand, title: p.title, subRankCategory: p.subRankCategory, image: p.image, price: p.price }))}
          sources={{ analysisByAsin: keywordAnalysisByAsin, enrichmentByKeyword: keywordEnrichmentByKeyword }}
        />
      </div>}

      {activeTab === "keyword-insight" && <div className="page-content compare-page">
        <StageOutputGapCard snapshot={stageOutputSnapshot} stage="keywords" />
        <KeywordDemandSection
          mode="insight"
          products={products.map(p => ({ asin: p.asin, brand: p.brand, title: p.title, subRankCategory: p.subRankCategory, image: p.image, price: p.price }))}
          sources={{ analysisByAsin: keywordAnalysisByAsin, enrichmentByKeyword: keywordEnrichmentByKeyword }}
        />
      </div>}

      {activeTab === "launch" && <div className="page-content compare-page">
        <ProductLaunchRecommendationSection products={products} sources={productLaunchSources} />
      </div>}

      {activeTab === "voc-positioning" && <div className="page-content compare-page">
        <VocPositioningSection products={products} sources={productLaunchSources} />
      </div>}

      {activeTab === "definition" && <div className="page-content compare-page">
        <VocEvidenceDefinition
          key={`${runtimeSessionKey}:${currentProjectId}:${baseSyncRunId}:${market}:${activeAsins.join(",")}`}
          projectId={currentProjectId} baseSyncRunId={baseSyncRunId}
          sessionKey={runtimeSessionKey} organizationId={authSession.user.organizationId}
          marketplace={market} asins={activeAsins} products={products} sources={productLaunchSources}
          initialRunId={vocRunIdFromSearch(appSearch)} initialHistoryRunId={new URLSearchParams(appSearch).get("vocHistory")} initialSelectedAsins={new URLSearchParams(appSearch).get("vocAsins")?.split(",")} refreshToken={JSON.stringify(manualVocByAsin)}
          enabled={!authSession.logoutPending && workspaceReady}
          onRunStarted={(runId, selectedAsins, previousRunId) => {
            const params = new URLSearchParams(window.location.search);
            params.set("vocRun", runId);
            if (previousRunId) params.set("vocHistory", previousRunId);
            params.set("vocAsins", selectedAsins.join(","));
            replaceAppUrl(params);
          }}
        />
      </div>}

      {activeTab === "checklist" && <div className="page-content compare-page">
        <LaunchChecklistSection
          sources={productLaunchSources}
          products={products.map(p => ({
            asin: p.asin,
            brand: p.brand,
            title: p.title,
            price: p.price,
            sales: p.sales,
            rating: p.rating,
            reviews: p.reviews,
            launch: p.launch,
            subRankCategory: p.subRankCategory,
            rankCategory: p.rankCategory,
          }))}
          onSaveToLibrary={() => void saveChecklistProject()}
          savingToLibrary={savingChecklist}
          canSaveToLibrary={activeAsins.length >= 3}
          libraryHref={tabHref("checklist-library")}
          libraryMessage={
            message.includes("项目确认清单") || message.includes("立项确认清单") ? message : null
          }
        />
      </div>}

      {activeTab === "traffic" && <div className="page-content compare-page">
        <section className="card asin-builder">
          <div className="section-head">
            <div>
              <h3>本页独立设置竞品 ASIN</h3>
              <p>无需先去竞品概览；在此录入 3–10 个 ASIN，抓取流量后即可保存到收藏夹「竞品推广能力分析」</p>
            </div>
            <span className="required-note">3–10 个</span>
          </div>
          <div className="asin-builder-body">
            <label className="market-inline">
              目标市场
              <select
                value={market}
                onChange={e => {
                  const next = e.target.value as MarketCode;
                  setMarket(next);
                  setMessage(`已切换至 ${markets[next].label}，流量数据口径将同步更新`);
                }}
              >
                {Object.entries(markets).map(([code, item]) => (
                  <option key={code} value={code}>
                    {item.option}
                  </option>
                ))}
              </select>
            </label>
            <div className="asin-inputs">
              {Array.from({ length: MAX_ASIN_SLOTS }).map((_, i) => (
                <label key={i} className="asin-slot">
                  <span>
                    {i + 1}
                    {i < 3 && <b>*</b>}
                  </span>
                  <input
                    value={inputs[i]}
                    name={`asin-slot-${i}`}
                    placeholder="10位ASIN"
                    maxLength={10}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    data-lpignore="true"
                    data-1p-ignore="true"
                    onChange={e => setInputs(prev => prev.map((v, j) => (j === i ? e.target.value.toUpperCase() : v)))}
                  />
                  {i >= 3 && inputs[i] ? (
                    <button
                      type="button"
                      onClick={() => setInputs(prev => prev.map((v, j) => (j === i ? "" : v)))}
                      aria-label={`清空竞品${i + 1}`}
                    >
                      ×
                    </button>
                  ) : null}
                </label>
              ))}
            </div>
          </div>
          <div className="builder-actions">
            <Link className="ghost-btn" href={tabHref("traffic-promo")}>
              ★ 推广能力分析
            </Link>
            {currentProjectName ? (
              <span className="builder-project-chip">
                当前工作区：{currentProjectName}
                {slugParam ? ` · /p/${slugParam}` : ""}
              </span>
            ) : null}
            {showBuilderNotice ? (
              <span
                className={
                  message.includes("请") || message.includes("不正确") || message.includes("重复") || message.includes("失败")
                    ? "builder-message error"
                    : "builder-message"
                }
              >
                {message}
              </span>
            ) : null}
            <button type="button" className="ghost-btn" disabled={savingTrafficPromo || inputs.filter(Boolean).length < 3} onClick={() => void saveTrafficPromoProject()}>
              {savingTrafficPromo ? "保存中…" : "保存到推广能力分析"}
            </button>
            <button type="button" className="primary-btn" onClick={() => void runAnalysis()}>
              抓取流量数据
            </button>
          </div>
        </section>

        <StageOutputGapCard snapshot={stageOutputSnapshot} stage="traffic" />
        {authSession.user.role === 'admin' && !authSession.logoutPending && baseSyncRunId && trafficSnapshotState.kind === 'dynamic' && <TrafficDetailRecoveryControl key={trafficBindingKey} runId={baseSyncRunId} recovered={Boolean(trafficData?.authoritativeListingAsins?.length)} onRecovered={async () => trafficSnapshotOwner.current?.refresh()} />}
        <TrafficFetchStatusSection
          products={products.map(p => ({ asin: p.asin, brand: p.brand, image: p.image }))}
          marketplace={market}
          trafficData={stageOutputView.trafficData}
          trafficOrigin={stageOutputSnapshot.traffic?.stageStatus === "done" ? "dynamic" : trafficOrigin}
          syncRequest={syncAsins}
          syncResume={syncResume}
          onRequestSync={() => {
            if (activeAsins.length < 3) {
              setMessage("请至少输入 3 个竞品 ASIN");
              return;
            }
            syncSuppressedKey.current = null;
            autoSyncStartedKey.current = null;
            void startSyncIfNeeded(activeAsins, { force: true });
          }}
          onSyncComplete={async () => {
            await refreshRuntimeAfterSync("流量相关数据已就绪，可继续分析或保存到推广能力分析");
          }}
          onSyncDismiss={() => {
            syncSuppressedKey.current = activeAsins.join(",");
            setSyncAsins(null);
          }}
        />

        <section className="card page-intro"><div><span className="status-chip">竞品流量分析</span><h2>同屏比较流量结构、月趋势，并输出推广能力结论</h2><p>数据来自 SIF「查流量结构」· {trafficMeta.period} · 更新至 {trafficMeta.updatedThrough}，统一 Listing 口径。</p></div>
          <SourceBadge>SIF MCP</SourceBadge>
        </section>

        <section className="card listing-traffic-distribution">
          <div className="section-head">
            <div>
              <h3>父 ASIN 流量结构</h3>
              <p>Listing 聚合 · 自然 / 广告占比 · 广告渠道 · 推荐专栏来源</p>
            </div>
            <SourceBadge>SIF MCP</SourceBadge>
          </div>
          <div className="traffic-distribution-scroll">
            <div className="traffic-distribution-grid">
              <div className="traffic-distribution-head">
                <span>竞品</span>
                <span>Listing自然 / 广告流量分布</span>
                <span title="悬停各渠道标签可查看 SIF 字段释义">广告流量分布</span>
                <span>推荐专栏流量分布</span>
              </div>
              {products.map((p, i) => {
                const data = trafficOverviewByAsin[p.asin];
                return (
                  <div className="traffic-distribution-row" key={p.asin}>
                    <div className="traffic-product-cell">
                      <ProductHeader product={p} index={i} market={market} />
                      {data && <small>总分 {formatTrafficScore(data.totalScore)} · 更新至 {data.updatedThrough ?? "未提供"}</small>}
                    </div>
                    <div className="traffic-metric-cell"><TrafficDistributionBars items={data?.naturalAd ?? []} palette={["#55BB6A", "#FFB03B"]} /></div>
                    <div className="traffic-metric-cell"><TrafficDistributionBars state={stageOutputView.trafficData.detailAvailability?.[p.asin]?.adChannels} items={data?.adChannels ?? []} glossary={sifAdChannelGlossary} palette={["#538CEE", "#FFB03B", "#F15C5C", "#55BB6A"]} /></div>
                    <div className="traffic-metric-cell"><TrafficDistributionBars state={stageOutputView.trafficData.detailAvailability?.[p.asin]?.recommendationSources} items={data?.recommendationSources ?? []} maxItems={6} palette={["#538CEE", "#55BB6A", "#FFB03B", "#F15C5C"]} /></div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="traffic-channel-glossary">
            {sifAdChannelGlossaryList.map(item => (
              <span key={item.label} title={`${item.en} · ${item.meaning}`}>
                <b>{item.label}</b>
                <em>{item.en}</em>
                <small>{item.meaning}</small>
              </span>
            ))}
          </div>
          <p className="traffic-data-note">口径对齐 SIF 查流量结构 · Listing 聚合视图 · 近30天流量分 · 广告渠道释义来自 SIF MCP wholeName 与查流量结构文档。</p>
        </section>

        <section className="card child-traffic-distribution">
          <div className="section-head">
            <div>
              <h3>子体流量结构</h3>
              <p>默认展示流量 TOP3 子体 · 其余折叠 · 条长按总分缩放</p>
            </div>
            <SourceBadge>SIF MCP</SourceBadge>
          </div>
          <div className="child-traffic-compare-grid">
            {products.map((p, i) => {
              const data = trafficOverviewByAsin[p.asin];
              return (
                <div className="child-traffic-card" key={p.asin}>
                  <div className="child-traffic-card-head">
                    <ProductHeader product={p} index={i} market={market} />
                    <small>{trafficChildCountLabel(data, stageOutputView.trafficData.detailAvailability?.[p.asin]?.children)} · 总分 {formatTrafficScore(data?.totalScore)}</small>
                  </div>
                  <ChildTrafficStructurePanel variants={data?.children ?? []} state={stageOutputView.trafficData.detailAvailability?.[p.asin]?.children} />
                </div>
              );
            })}
          </div>
        </section>

        <section className="card compare-chart-card monthly-traffic-card">
          <div className="section-head">
            <div>
              <h3>月流量趋势对比</h3>
              <p>按品牌分组 · 近6个月自然 / 广告堆叠柱 · 更新至 {trafficMeta.updatedThrough}</p>
            </div>
            <SourceBadge>SIF MCP</SourceBadge>
          </div>
          <div className="monthly-traffic-legends">
            <div className="chart-legend">
              <span><i style={{ background: sifMonthlyTrafficMeta.naturalColor }} />自然流量</span>
              <span><i style={{ background: sifMonthlyTrafficMeta.adColor }} />广告流量</span>
            </div>
            <div className="chart-legend">
              {products.map((p, i) => <span key={p.asin}><i style={{ background: colors[i] }} />{p.brand}</span>)}
            </div>
          </div>
          <MonthlyTrafficStackChart products={products} monthlyTrendByAsin={trafficMonthlyTrendByAsin} />
          <p className="traffic-data-note">{sifMonthlyTrafficMeta.note}</p>
        </section>

        <TrafficAnalysisConclusionSection products={products} market={market} trafficData={stageOutputView.trafficData} />
      </div>}

      {activeTab === "keyword-compare" && <div className="page-content compare-page">
        {syncAsins || syncResume.syncJobId || syncResume.terminalJob ? (
          <UrlResumableAsinSyncFunnel
            asins={activeAsins}
            marketplace={market}
            syncRequest={syncAsins}
            resume={syncResume}
            focusStageIds={["catalog", "keywords"]}
            onComplete={async () => {
              await refreshRuntimeAfterSync("关键词相关数据已刷新");
              setRefreshingProjectId(null);
              setSyncAsins(null);
            }}
            onDismiss={() => {
              setRefreshingProjectId(null);
              setSyncAsins(null);
            }}
          />
        ) : null}
        <ProjectLibraryPage
          kind="keyword-compare"
          title="流量词对比"
          description="收藏从「竞品关键词分析」保存的流量词对比项目。打开后可刷新词数据，或编辑追加新的 ASIN。"
          saveLabel="保存为流量词对比项目"
          loadLabel="打开对比"
          emptyHint="还没有流量词对比项目。请先到「关键词调研 · 竞品关键词分析」点击「保存到流量词对比」。"
          market={market}
          draftAsins={inputs}
          currentProjectId={currentProjectId}
          suggestedMajorCategory={inferAmazonMajorCategory(products)}
          suggestedCategoryLabel={products.find(item => item.subRankCategory && item.subRankCategory !== "等待同步")?.subRankCategory ?? null}
          openInNewTab
          refreshingId={refreshingProjectId}
          buildLoadHref={project => buildProjectLoadHref(project, searchParams, "keywords")}
          onLoadProject={project => {
            applyProject(project);
            setMessage(`已打开流量词对比「${project.name}」· ${project.asins.length} 个 ASIN`);
          }}
          onProjectSaved={project => {
            applyProject(project, { announce: false });
            setMessage(`已更新流量词对比「${project.name}」· ${project.asins.length} 个 ASIN`);
          }}
          onRefreshKeywords={project => {
            applyProject(project, { announce: false });
            setRefreshingProjectId(project.id);
            syncSuppressedKey.current = null;
            autoSyncStartedKey.current = null;
            void startSyncIfNeeded(project.asins, { force: true }).then(started => {
              if (!started) setRefreshingProjectId(null);
            });
          }}
        />
      </div>}

      {activeTab === "traffic-promo" && <div className="page-content compare-page">
        {syncAsins || syncResume.syncJobId || syncResume.terminalJob ? (
          <UrlResumableAsinSyncFunnel
            asins={activeAsins}
            marketplace={market}
            syncRequest={syncAsins}
            resume={syncResume}
            focusStageIds={["catalog", "traffic"]}
            onComplete={async () => {
              await refreshRuntimeAfterSync("流量相关数据已刷新");
              setRefreshingProjectId(null);
              setSyncAsins(null);
            }}
            onDismiss={() => {
              setRefreshingProjectId(null);
              setSyncAsins(null);
            }}
          />
        ) : null}
        <ProjectLibraryPage
          kind="traffic-promo"
          title="竞品推广能力分析"
          description="收藏从「竞品流量分析」保存的推广能力分析项目。打开后进入流量结构与推广结论页。"
          saveLabel="保存为推广能力分析项目"
          loadLabel="打开分析"
          emptyHint="还没有推广能力分析项目。请先到「竞品流量分析」点击「保存到推广能力分析」。"
          market={market}
          draftAsins={inputs}
          currentProjectId={currentProjectId}
          suggestedMajorCategory={inferAmazonMajorCategory(products)}
          suggestedCategoryLabel={products.find(item => item.subRankCategory && item.subRankCategory !== "等待同步")?.subRankCategory ?? null}
          openInNewTab
          refreshingId={refreshingProjectId}
          buildLoadHref={project => buildProjectLoadHref(project, searchParams, "traffic")}
          onLoadProject={project => {
            applyProject(project);
            setMessage(`已打开推广能力分析「${project.name}」· ${project.asins.length} 个 ASIN`);
          }}
          onProjectSaved={project => {
            applyProject(project, { announce: false });
            setMessage(`已更新推广能力分析「${project.name}」· ${project.asins.length} 个 ASIN`);
          }}
          onRefreshKeywords={project => {
            applyProject(project, { announce: false });
            setRefreshingProjectId(project.id);
            syncSuppressedKey.current = null;
            autoSyncStartedKey.current = null;
            void startSyncIfNeeded(project.asins, { force: true }).then(started => {
              if (!started) setRefreshingProjectId(null);
            });
          }}
        />
      </div>}

      {activeTab === "checklist-library" && <div className="page-content compare-page">
        {syncAsins || syncResume.syncJobId || syncResume.terminalJob ? (
          <UrlResumableAsinSyncFunnel
            asins={activeAsins}
            marketplace={market}
            syncRequest={syncAsins}
            resume={syncResume}
            focusStageIds={["catalog", "reviews", "alexa_voc"]}
            onComplete={async () => {
              await refreshRuntimeAfterSync("竞品与 VOC 相关数据已刷新");
              setRefreshingProjectId(null);
              setSyncAsins(null);
            }}
            onDismiss={() => {
              setRefreshingProjectId(null);
              setSyncAsins(null);
            }}
          />
        ) : null}
        <ProjectLibraryPage
          kind="checklist"
          title="项目确认清单"
          description="收藏从「立项前确认清单」保存的项目。打开后进入清单页，可刷新竞品与 VOC 数据，或编辑追加新 ASIN。"
          saveLabel="保存为项目确认清单"
          loadLabel="打开清单"
          emptyHint="还没有项目确认清单。请先到「立项前确认清单」点击「保存到项目确认清单」。"
          market={market}
          draftAsins={inputs}
          currentProjectId={currentProjectId}
          suggestedMajorCategory={inferAmazonMajorCategory(products)}
          suggestedCategoryLabel={products.find(item => item.subRankCategory && item.subRankCategory !== "等待同步")?.subRankCategory ?? null}
          openInNewTab
          refreshingId={refreshingProjectId}
          buildLoadHref={project => buildProjectLoadHref(project, searchParams, "checklist")}
          onLoadProject={project => {
            applyProject(project);
            setMessage(`已打开立项确认清单「${project.name}」· ${project.asins.length} 个 ASIN`);
          }}
          onProjectSaved={project => {
            applyProject(project, { announce: false });
            setMessage(`已更新项目确认清单「${project.name}」· ${project.asins.length} 个 ASIN`);
          }}
          onRefreshKeywords={project => {
            applyProject(project, { announce: false });
            setRefreshingProjectId(project.id);
            syncSuppressedKey.current = null;
            autoSyncStartedKey.current = null;
            void startSyncIfNeeded(project.asins, { force: true }).then(started => {
              if (!started) setRefreshingProjectId(null);
            });
          }}
        />
      </div>}

      {activeTab === "projects" && <div className="page-content compare-page">
        <ProjectLibraryPage
          kind="analysis"
          key={runtimeSessionKey}
          favorites={projectFavorites}
          canDeleteProjects={authSession.user.role === "admin" && !authSession.logoutPending}
          onProjectDeleted={id => {
            setWorkspaces(previous => previous.filter(project => project.id !== id));
            if (id !== currentProjectId) return;
            setCurrentProjectId(null);
            setCurrentProjectName(null);
            setWorkspaceLabel("");
            setActiveAsins([]);
            replaceInputAsins([]);
            syncSuppressedKey.current = activeAsins.join(",");
            autoSyncStartedKey.current = null;
            restoringVocRun.current = null;
            setVocRun(null);
            setSelectedReportIds({});
            setSyncAsins(null);
            setSyncRunContext(null);
            setTerminalSyncJob(null);
            setTerminalPointerRetained(false);
            setStageOutputReceipt(null);
            setRuntimeAnalysisData(null);
            runtimeAnalysisRequest.current += 1;
            // Leave the deleted workspace entirely so in-flight run observers cannot
            // restore its pointers or recreate its project from the old ASIN input.
            window.location.replace("/?tab=projects&projectDeleted=1");
          }}
          market={market}
          draftAsins={inputs}
          currentProjectId={currentProjectId}
          suggestedMajorCategory={inferAmazonMajorCategory(products)}
          suggestedCategoryLabel={products.find(item => item.subRankCategory && item.subRankCategory !== "等待同步")?.subRankCategory ?? null}
          buildLoadHref={project => buildProjectLoadHref(project, searchParams)}
          onLoadProject={project => {
            applyProject(project);
            setMessage(`已加载项目「${project.name}」· ${project.asins.length} 个 ASIN`);
          }}
          onProjectSaved={project => {
            applyProject(project, { announce: false, replace: true });
          }}
        />
      </div>}
    </section>
    <div className="floating-action-stack">
      <BackToTopButton />
    </div>
  </main>;
}

export default function Home() {
  return (
    <AuthSessionGate>
      {(authSession) => <AuthenticatedAmazonOpportunityApp authSession={authSession} />}
    </AuthSessionGate>
  );
}
