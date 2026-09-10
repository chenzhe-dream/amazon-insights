"use client";

import { type RuntimeAnalysisDataSnapshot, createRuntimeAnalysisScopeGuard, readAndCommitRuntimeAnalysisData } from "../../lib/runtime-analysis-data";
import { type AuthenticatedWebSession } from "../../auth-session-gate";
import { useSearchParams, usePathname, useRouter } from "next/navigation";
import { useRef, useEffect, useState, useMemo, useCallback, useLayoutEffect } from "react";
import { type TabId, tabFromParam } from "../../lib/app-tabs";
import { parseBatchAsinInput } from "../../lib/asin-batch-input";
import { type BuilderNotice, shouldShowBuilderNotice, isPrimaryAdministrator } from "../../lib/primary-admin";
import { type VocRunObservation, baseSyncRunIdFromSearch, clearVocRunFromSearch, vocRunIdFromSearch, waitForVocRun, VocRunClientError, cancelVocRun, retryVocStage } from "../../lib/voc-run-browser";
import { type SavedAnalysisReportSelection, buildSavedAnalysisReportView, readSavedAnalysisReport, serializeSavedAnalysisReportView } from "../../lib/saved-analysis-reports";
import { type SyncJob, type SyncCompletionDisposition, hasResumableFailedStages, type StageOutputSnapshot, type SyncResumeBundle } from "../sync/asin-sync-funnel";
import { type TrafficStageReceipt, trafficStageFromReceipt } from "../../lib/traffic-detail-view";
import { createIncompleteSyncRepair } from "../../lib/sync-incomplete-repair-browser";
import { localAgentFetch, localAgentErrorMessage } from "../../lib/local-agent-browser";
import { type NavGroupId, navigationEntries, type NavGroup, isNavGroup } from "../shell/navigation";
import { refreshedCatalog } from "../../competitor-data";
import { syncJobIdFromSearch, clearSyncJobFromSearch, searchWithSyncJobId } from "../../lib/asin-sync-session";
import { useAnalysisProjectFavorites } from "../projects/use-analysis-project-favorites";
import { type AnalysisProject } from "../projects/project-library-panel";
import { useResumedSyncScope } from "../../lib/resumed-sync-scope";
import { useXydcOrderProgress } from "../../lib/use-xydc-order-progress";
import { resolveAlexaVocPageScope } from "../../lib/alexa-voc-page-scope";
import { createTerminalSyncOwner, browserSessionStorage } from "../../lib/sync-terminal-owner";
import { publicationArtifactNotice } from "../../lib/publication-artifact-notice";
import { useVocReviewOutput } from "../../lib/use-voc-review-output";
import { useManualAlexaVoc } from "../voc/use-manual-alexa-voc";
import { type ManualAlexaVocNormalizedRecord } from "../../../shared/agent-contracts";
import { type TrafficSnapshotClientState, trafficSnapshotBindingKey, createTrafficSnapshotOwner } from "../../lib/traffic-snapshot-browser";
import { trafficDisplayFromSnapshot, sifListingTrafficMeta } from "../../sif-listing-traffic-data";
import { buildStageOutputView } from "../../lib/stage-output-view";
import { sifKeywordAnalysisData } from "../../sif-keyword-analysis-data";
import { sifKeywordEnrichmentData } from "../../sif-keyword-enrichment-data";
import { sorftimeReviewAnalysisData } from "../../sorftime-review-analysis-data";
import { sorftimeRatingData } from "../../sorftime-rating-data";
import { sorftimeSalesTrendData } from "../../sorftime-sales-trend-data";
import { sorftimeFbaFeeData } from "../../sorftime-fba-fee-data";
import { sorftimeListingContentData } from "../../sorftime-listing-content-data";
import { sorftimeCategoryTrendData } from "../../sorftime-category-trend-data";
import { sorftimeChildSales30d } from "../../sorftime-child-sales-data";
import { sorftimePriceStrategies } from "../../sorftime-price-strategy-data";
import { listingImageRemarks } from "../../listing-image-remarks";
import { scopedReviewRecords } from "../../lib/voc-review-display";
import { stageOutputGapReasonCode } from "../sync/stage-output-gap-notice";
import { type ProductLaunchRuntimeSources } from "../product-reports/product-launch-analysis";
import { buildKeywordDemandAnalysis } from "../keywords/keyword-demand-analysis";
import { workspaceHref, projectWorkspacePath } from "../../lib/workspace-url";
import { readHistoricalSyncPointer } from "../projects/historical-sync-pointer";
import { inferAmazonMajorCategory } from "../../amazon-major-categories";
import { buildTabHref, resolveActiveAsins, buildInputSlots, replaceAppUrl, parseAsinsParam, setProjectParam, sameAsinSet, PROJECT_REGISTRATION_FAILURE, savedReportStageLabels } from "../projects/workspace-navigation";
import { type MarketCode, type Product, placeholderProduct, markets } from "../catalog/product-contracts";

function currentWebArtifactId(): string {
  return document.documentElement.dataset.webArtifactId ?? "legacy";
}

const ROOT_PATH_DIAGNOSTIC =
  "根路径不再混合展示全部底库。请输入一批同类 ASIN，或点下方工作区进入 /p/floor-lamps、/p/kick-scooters";

const RUNTIME_ANALYSIS_REFRESH_FAILED = "最新分析数据暂未刷新，页面已保留现有结果";

type RuntimeAnalysisRefreshResult =
  | Readonly<{ ok: true; snapshot: RuntimeAnalysisDataSnapshot }>
  | Readonly<{ ok: false; reason: "failed" | "superseded"; message: string }>;

export function useWorkspaceController({ authSession }: { authSession: AuthenticatedWebSession }) {
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

  const handleOverviewTabOnRequestSync = () => {
            if (activeAsins.length < 3) {
              setMessage("请至少输入 3 个竞品 ASIN");
              return;
            }
            syncSuppressedKey.current = null;
            autoSyncStartedKey.current = null;
            void startSyncIfNeeded(activeAsins, { force: true });
          };

  const handleOverviewTabOnSyncDismiss = () => {
            syncSuppressedKey.current = activeAsins.join(",");
            setSyncAsins(null);
            setSyncRunContext(null);
            replaceAppUrl(clearSyncJobFromSearch(window.location.search), window.location.pathname);
          };

  const handleKeywordsTabOnRequestSync = () => {
            if (activeAsins.length < 3) {
              setMessage("请至少输入 3 个竞品 ASIN");
              return;
            }
            syncSuppressedKey.current = null;
            autoSyncStartedKey.current = null;
            void startSyncIfNeeded(activeAsins, { force: true });
          };

  const handleKeywordsTabOnSyncDismiss = () => {
            syncSuppressedKey.current = activeAsins.join(",");
            setSyncAsins(null);
          };

  const handleTrafficTabOnRequestSync = () => {
            if (activeAsins.length < 3) {
              setMessage("请至少输入 3 个竞品 ASIN");
              return;
            }
            syncSuppressedKey.current = null;
            autoSyncStartedKey.current = null;
            void startSyncIfNeeded(activeAsins, { force: true });
          };

  const handleTrafficTabOnSyncDismiss = () => {
            syncSuppressedKey.current = activeAsins.join(",");
            setSyncAsins(null);
          };

  const handleKeywordCompareLibraryTabOnRefreshKeywords = (project: AnalysisProject) => {
            applyProject(project, { announce: false });
            setRefreshingProjectId(project.id);
            syncSuppressedKey.current = null;
            autoSyncStartedKey.current = null;
            void startSyncIfNeeded(project.asins, { force: true }).then(started => {
              if (!started) setRefreshingProjectId(null);
            });
          };

  const handleTrafficPromoLibraryTabOnRefreshKeywords = (project: AnalysisProject) => {
            applyProject(project, { announce: false });
            setRefreshingProjectId(project.id);
            syncSuppressedKey.current = null;
            autoSyncStartedKey.current = null;
            void startSyncIfNeeded(project.asins, { force: true }).then(started => {
              if (!started) setRefreshingProjectId(null);
            });
          };

  const handleChecklistLibraryTabOnRefreshKeywords = (project: AnalysisProject) => {
            applyProject(project, { announce: false });
            setRefreshingProjectId(project.id);
            syncSuppressedKey.current = null;
            autoSyncStartedKey.current = null;
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
          };

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
