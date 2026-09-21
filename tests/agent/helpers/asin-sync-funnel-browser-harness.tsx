import { createElement, Fragment, Profiler, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { AsinSyncProgressSection, hasResumableFailedStages, UrlResumableAsinSyncFunnel, type StageOutputSnapshot, type SyncCompletionDisposition, type SyncJob } from "../../../app/asin-sync-funnel";
import { useResumedSyncScope } from "../../../app/lib/resumed-sync-scope";
import { publicationArtifactNotice } from "../../../app/lib/publication-artifact-notice";
import { buildStageOutputView } from "../../../app/lib/stage-output-view";
import { createTerminalSyncOwner } from "../../../app/lib/sync-terminal-owner";
import { StageOutputGapCard } from "../../../app/stage-output-gap-card";
import { StageOutputGapNotice, stageOutputGapReasonCode } from "../../../app/stage-output-gap-notice";
import { CategoryNodeTrendSection } from "../../../app/category-node-trend-section";
import { KeywordFetchStatusSection } from "../../../app/keyword-fetch-status";
import { KeywordDemandSection } from "../../../app/keyword-demand-section";
import { ListingAplusSection } from "../../../app/listing-aplus-section";
import { TrafficFetchStatusSection } from "../../../app/traffic-fetch-status";
import { TrafficAnalysisConclusionSection } from "../../../app/page";
import { sifKeywordAnalysisData } from "../../../app/sif-keyword-analysis-data";
import { sifKeywordEnrichmentData } from "../../../app/sif-keyword-enrichment-data";
import { sorftimeReviewAnalysisData } from "../../../app/sorftime-review-analysis-data";
import { sorftimeRatingData } from "../../../app/sorftime-rating-data";
import { sorftimeSalesTrendData } from "../../../app/sorftime-sales-trend-data";
import { sorftimeFbaFeeData } from "../../../app/sorftime-fba-fee-data";
import { sorftimeListingContentData } from "../../../app/sorftime-listing-content-data";
import { sorftimeCategoryTrendData } from "../../../app/sorftime-category-trend-data";
import { sifListingTrafficMeta, sifListingTrafficOverview } from "../../../app/sif-listing-traffic-data";
import { sifMonthlyTrafficTrend } from "../../../app/sif-monthly-traffic-trend-data";

const asins = ["B07DYG1C9B", "B07VY9Q95Q", "B0BPXRVWYK"];
const authenticatedOrganizationId = "10000000-0000-4000-8000-000000000001";
const terminalEventsStorageKey = "asin-sync-funnel-browser-harness.sync-terminal-events";
const runtimeRefreshArtifactsStorageKey = "asin-sync-funnel-browser-harness.runtime-refresh-artifacts";
type HarnessWindow = Window & {
  rerenderSyncFunnel?: () => void;
  hydrateSyncWorkspace?: () => void;
  switchSyncFunnelTab?: (tab: "overview" | "keywords" | "traffic" | "library") => void;
  startNewSyncFunnel?: () => void;
  runOverviewAutoCheck?: () => void;
  logoutStageOutputs?: () => void;
  switchStageOutputJob?: (jobId: string) => void;
  syncTerminalEvents?: { completions: number; reloads: number };
  runtimeRefreshArtifacts?: string[];
  stageOutputEvents?: { updates: number; stages: string[] };
  syncFunnelCommits?: number;
};
const harnessWindow = window as HarnessWindow;
function terminalEvents(): { completions: number; reloads: number } {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(terminalEventsStorageKey) ?? "") as Partial<{ reloads: number }>;
    if (typeof saved.reloads === "number") return { completions: 0, reloads: saved.reloads };
  } catch {
    // The harness remains observable when browser storage is unavailable.
  }
  return { completions: 0, reloads: 0 };
}

function rememberTerminalEvents(events: { completions: number; reloads: number }) {
  try {
    window.sessionStorage.setItem(terminalEventsStorageKey, JSON.stringify({ reloads: events.reloads }));
  } catch {
    // Reload convergence itself must not depend on test instrumentation storage.
  }
}

harnessWindow.syncTerminalEvents ??= terminalEvents();
harnessWindow.runtimeRefreshArtifacts ??= (() => {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(runtimeRefreshArtifactsStorageKey) ?? "[]") as unknown;
    return Array.isArray(saved) && saved.every(value => typeof value === "string") ? saved : [];
  } catch {
    return [];
  }
})();
harnessWindow.stageOutputEvents ??= { updates: 0, stages: [] };
harnessWindow.syncFunnelCommits ??= 0;

function currentWebArtifactId(): string {
  return document.documentElement.dataset.webArtifactId ?? "legacy";
}

document.documentElement.dataset.webArtifactId = new URLSearchParams(window.location.search).get("webArtifact")
  ?? new URLSearchParams(window.location.search).get("artifact")
  ?? "legacy";

function Harness() {
  const search = new URLSearchParams(window.location.search);
  const [, setRevision] = useState(0);
  const [tab, setTab] = useState<"overview" | "keywords" | "traffic" | "library">(
    (search.get("tab") as "overview" | "keywords" | "traffic" | "library" | null) ?? "overview",
  );
  const [requested, setRequested] = useState(search.get("start") === "1");
  const [terminalJob, setTerminalJob] = useState<SyncJob | null>(null);
  const [publicationConvergenceNotice, setPublicationConvergenceNotice] = useState<string | null>(null);
  const [terminalPointerRetained, setTerminalPointerRetained] = useState(false);
  const [syncSessionJobIds, setSyncSessionJobIds] = useState<Set<string>>(() => new Set());
  const rememberSyncJob = useCallback((jobId: string) => setSyncSessionJobIds(current => {
    if (current.has(jobId)) return current;
    const next = new Set(current);
    next.add(jobId);
    return next;
  }), []);
  const [sessionActive, setSessionActive] = useState(true);
  const [stageOutputs, setStageOutputs] = useState<StageOutputSnapshot>({});
  const hydrationMarket = search.get("hydrationMarket") ?? "DE";
  const [workspace, setWorkspace] = useState(() => ({
    ready: search.get("hydrate") !== "async",
    asins: search.get("hydrate") === "async" ? [] : asins,
    marketplace: search.get("hydrate") === "async" ? "US" : "US",
  }));
  const resumed = useResumedSyncScope({
    runId: search.get("run"),
    fallbackContext: null,
  });
  const resumeStatus = (resumed as { status?: string }).status;
  const storage = search.get("storage") === "fail"
    ? { getItem: () => { throw new Error("storage unavailable"); }, setItem: () => { throw new Error("quota"); }, removeItem: () => { throw new Error("storage unavailable"); } }
    : window.sessionStorage;
  const terminalOwner = createTerminalSyncOwner({
    storage,
    pathname: window.location.pathname,
    organizationId: authenticatedOrganizationId,
    projectId: resumed.context?.projectId ?? null,
    marketplace: workspace.marketplace,
    asins: workspace.asins,
  });
  const startNewSyncFunnel = () => {
    terminalOwner.clearForExplicitStart();
    const next = new URLSearchParams(window.location.search);
    next.delete("syncJob");
    window.history.replaceState(null, "", `?${next}`);
    setTerminalPointerRetained(false);
    setTerminalJob(null);
    setRequested(true);
  };
  useEffect(() => {
    harnessWindow.rerenderSyncFunnel = () => setRevision(revision => revision + 1);
    harnessWindow.hydrateSyncWorkspace = () => {
      setWorkspace({ ready: true, asins, marketplace: hydrationMarket });
    };
    harnessWindow.switchSyncFunnelTab = nextTab => setTab(nextTab);
    harnessWindow.runOverviewAutoCheck = () => setRevision(revision => revision + 1);
    harnessWindow.logoutStageOutputs = () => setSessionActive(false);
    harnessWindow.switchStageOutputJob = (jobId: string) => {
      const next = new URLSearchParams(window.location.search);
      next.set("syncJob", jobId);
      window.history.replaceState(null, "", `?${next}`);
      setRevision(revision => revision + 1);
    };
    harnessWindow.startNewSyncFunnel = startNewSyncFunnel;
  });
  useEffect(() => {
    if (requested || search.get("manualStart") === "1" || tab !== "overview" || search.has("syncJob") || !workspace.ready || resumed.resolving || resumeStatus === "invalid" || terminalOwner.blocksAutomaticStart()) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- This browser harness models the page's post-hydration auto-start transition.
    setRequested(true);
  }, [requested, resumeStatus, resumed.resolving, tab, terminalOwner, workspace.ready]);
  if (resumed.resolving || resumeStatus === "resolving") {
    return createElement("span", { "data-sync-resume": "resolving" }, "resolving");
  }
  if (resumeStatus === "invalid") return createElement("span", { "data-sync-resume": "invalid" }, "invalid");
  const syncRequest = requested ? workspace.asins : null;
  const onSyncJobId = (jobId: string) => {
    rememberSyncJob(jobId);
    setTerminalJob(null);
    const next = new URLSearchParams(window.location.search);
    next.set("syncJob", jobId);
    window.history.replaceState(null, "", `?${next}`);
    setRevision(revision => revision + 1);
  };
  const shared = {
    organizationId: sessionActive ? authenticatedOrganizationId : null,
    stageOutputScopeKey: `${window.location.pathname}?${window.location.search}`,
    syncJobId: search.get("syncJob"),
    terminalJob,
    projectId: resumed.context?.projectId ?? null,
    runId: resumed.context?.runId ?? null,
    resumePending: resumed.resolving,
    resumeBlocked: resumeStatus === "invalid",
    workspaceReady: workspace.ready,
    knownSessionJobIds: syncSessionJobIds,
    onSyncJobObserved: rememberSyncJob,
    onSyncJobId,
    onDismiss: () => {
      if (terminalPointerRetained) return;
      const next = new URLSearchParams(window.location.search);
      next.delete("syncJob");
      window.history.replaceState(null, "", `?${next}`);
      setRequested(false);
      setTerminalJob(null);
      setRevision(revision => revision + 1);
    },
    onComplete: (job: SyncJob) => {
      const resumable = hasResumableFailedStages(job);
      const owner = createTerminalSyncOwner({
        storage,
        pathname: window.location.pathname,
        organizationId: authenticatedOrganizationId,
        projectId: job.scope?.projectId ?? resumed.context?.projectId ?? null,
        marketplace: job.marketplace ?? workspace.marketplace,
        asins: job.asins ?? workspace.asins,
      });
      const applied = job.publication?.status === "applied" ? job.publication : null;
      const artifactId = applied?.artifactId ?? null;
      const recorded = owner.recordTerminal({ jobId: job.jobId, artifactId });
      const recordedArtifactId = recorded ? owner.readTerminal()?.artifactId ?? null : null;
      const convergentArtifact = applied && recordedArtifactId === applied.artifactId ? applied : null;
      harnessWindow.syncTerminalEvents!.completions += 1;
      setTerminalJob(job);
      setTerminalPointerRetained(resumable || !recorded);
      const currentArtifact = currentWebArtifactId();
      let disposition: SyncCompletionDisposition = "convergence-blocked";
      if (convergentArtifact && currentArtifact === convergentArtifact.artifactId) {
        const url = new URL(window.location.href);
        if (url.searchParams.has("webArtifact")) {
          url.searchParams.delete("webArtifact");
          window.history.replaceState(window.history.state, "", url.toString());
        }
        setPublicationConvergenceNotice(null);
        disposition = "settled";
      } else if (convergentArtifact && owner.claimArtifactReload({ jobId: job.jobId, artifactId: convergentArtifact.artifactId })) {
        setPublicationConvergenceNotice(null);
        const url = new URL(window.location.href);
        url.searchParams.set("webArtifact", convergentArtifact.artifactId);
        harnessWindow.syncTerminalEvents!.reloads += 1;
        rememberTerminalEvents(harnessWindow.syncTerminalEvents!);
        window.location.replace(url.toString());
        return "navigation-started" as const;
      } else {
        setPublicationConvergenceNotice(applied
          ? publicationArtifactNotice(currentArtifact, applied.artifactId)
          : null);
      }
      if (recorded) {
        setRequested(false);
        setRevision(revision => revision + 1);
      }
      return disposition;
    },
    onTerminal: (job: SyncJob) => {
      const resumable = hasResumableFailedStages(job);
      const owner = createTerminalSyncOwner({
        storage,
        pathname: window.location.pathname,
        organizationId: authenticatedOrganizationId,
        projectId: job.scope?.projectId ?? resumed.context?.projectId ?? null,
        marketplace: job.marketplace ?? workspace.marketplace,
        asins: job.asins ?? workspace.asins,
      });
      const recorded = owner.recordTerminal({ jobId: job.jobId });
      setTerminalJob(job);
      setTerminalPointerRetained(resumable || !recorded);
      if (!recorded) return;
      setRequested(false);
      setRevision(revision => revision + 1);
    },
    allowDismiss: !terminalPointerRetained,
    onRestart: startNewSyncFunnel,
    canResumeFailedStages: search.get("primary") === "1",
    onStageOutput: (snapshot: StageOutputSnapshot) => {
      setStageOutputs(snapshot);
      harnessWindow.stageOutputEvents!.updates += 1;
      harnessWindow.stageOutputEvents!.stages = Object.keys(snapshot);
    },
  };
  const publicationNotice = publicationConvergenceNotice
    ? <span role="status">{publicationConvergenceNotice}</span>
    : null;
  if (tab === "keywords") {
    return <>{publicationNotice}<KeywordFetchStatusSection
      products={workspace.asins.map(asin => ({ asin, brand: "Test" }))}
      marketplace={workspace.marketplace}
      syncRequest={syncRequest}
      onRequestSync={() => setRequested(true)}
      syncResume={shared}
    /></>;
  }
  if (tab === "traffic") {
    return <>{publicationNotice}<TrafficFetchStatusSection
      products={workspace.asins.map(asin => ({ asin, brand: "Test" }))}
      marketplace={workspace.marketplace}
      syncRequest={syncRequest}
      onRequestSync={() => setRequested(true)}
      syncResume={shared}
    /></>;
  }
  if (search.get("wrapper") === "progress") {
    return <>{publicationNotice}<AsinSyncProgressSection
      asins={workspace.asins}
      marketplace={workspace.marketplace}
      syncRequest={syncRequest}
      syncResume={shared}
      onRequestSync={() => setRequested(true)}
      onSyncComplete={() => undefined}
      onSyncDismiss={() => {
        const next = new URLSearchParams(window.location.search);
        next.delete("syncJob");
        window.history.replaceState(null, "", `?${next}`);
        setRequested(false);
        setRevision(revision => revision + 1);
      }}
    /></>;
  }
  const funnelAsins = syncRequest ?? workspace.asins;
  const observeRuntimeRefresh = search.get("productionCompletion") === "1"
    ? () => {
        harnessWindow.runtimeRefreshArtifacts!.push(currentWebArtifactId());
        try {
          window.sessionStorage.setItem(runtimeRefreshArtifactsStorageKey, JSON.stringify(harnessWindow.runtimeRefreshArtifacts));
        } catch {
          // Test observability must not change completion behavior.
        }
      }
    : undefined;
  const funnel = <Profiler id="sync-funnel" onRender={() => { harnessWindow.syncFunnelCommits! += 1; }}>
    <UrlResumableAsinSyncFunnel
      asins={search.get("freshAsins") === "1" ? [...funnelAsins] : funnelAsins}
      marketplace={workspace.marketplace}
      syncRequest={syncRequest}
      resume={shared}
      focusStageIds={tab === "library" ? ["catalog", "keywords"] : undefined}
      onComplete={observeRuntimeRefresh}
    />
  </Profiler>;
  if (search.get("realKeyword") !== "1" && search.get("realStageConsumers") !== "1") return <>{publicationNotice}{funnel}</>;
  const view = buildStageOutputView(stageOutputs, {
    keywordAnalysisByAsin: sifKeywordAnalysisData,
    keywordEnrichmentByKeyword: sifKeywordEnrichmentData,
    reviewAnalysisByAsin: {
      ...sorftimeReviewAnalysisData,
      [asins[2]]: { status: "error" },
    },
    ratingByAsin: sorftimeRatingData,
    salesTrendByAsin: sorftimeSalesTrendData,
    fbaFeeByAsin: {
      ...sorftimeFbaFeeData,
      [asins[2]]: { status: "error" },
    },
    listingContentByAsin: sorftimeListingContentData,
    categoryTrendByNode: sorftimeCategoryTrendData,
    childSalesByAsin: {},
    priceStrategyByAsin: {},
    imageRemarksByAsin: {},
    imageRemarkOutcomesByAsin: {},
    trafficData: { overview: sifListingTrafficOverview, monthlyTrend: sifMonthlyTrafficTrend, meta: sifListingTrafficMeta },
  });
  const reviewGapReasonCode = stageOutputGapReasonCode(stageOutputs.reviews);
  const fbaGapReasonCode = stageOutputGapReasonCode(stageOutputs.fba);
  const product = { asin: workspace.asins[0], brand: "Task4", title: "Task4 product", image: "", subRankCategory: "Task4 category" };
  const idleResume = {
    syncJobId: null, terminalJob: null, projectId: null, runId: null,
    resumePending: false, resumeBlocked: false, workspaceReady: true,
  };
  return createElement(Fragment, null,
    publicationNotice,
    funnel,
    createElement(KeywordDemandSection, {
      products: [product],
      sources: { analysisByAsin: view.keywordAnalysisByAsin, enrichmentByKeyword: view.keywordEnrichmentByKeyword },
    }),
    search.get("realStageConsumers") === "1" ? createElement(Fragment, null,
      createElement(StageOutputGapCard, { snapshot: stageOutputs, stage: "keywords" }),
      reviewGapReasonCode ? createElement(StageOutputGapNotice, {
        label: "评论数据", asins: workspace.asins, records: view.reviewAnalysisByAsin, reasonCode: reviewGapReasonCode,
      }) : null,
      createElement(StageOutputGapCard, { snapshot: stageOutputs, stage: "sales_trend" }),
      fbaGapReasonCode ? createElement(StageOutputGapNotice, {
        label: "FBA费用", asins: workspace.asins, records: view.fbaFeeByAsin, reasonCode: fbaGapReasonCode,
      }) : null,
      createElement(StageOutputGapCard, { snapshot: stageOutputs, stage: "listing" }),
      createElement(ListingAplusSection, {
        products: [product], market: { label: "美国", domain: "amazon.com" }, colors: ["#123456"],
        listingByAsin: view.listingContentByAsin,
      }),
      createElement(CategoryNodeTrendSection, {
        products: [product], marketplace: "US", trendByNode: view.categoryTrendByNode,
      }),
      createElement(TrafficFetchStatusSection, {
        products: [product], marketplace: "US", syncRequest: null, syncResume: idleResume,
        onRequestSync: () => undefined, trafficData: view.trafficData, trafficOrigin: "dynamic",
      }),
      createElement(TrafficAnalysisConclusionSection as unknown as (props: Record<string, unknown>) => ReturnType<typeof createElement>, {
        products: [product], market: "US", trafficData: view.trafficData,
      }),
    ) : null,
  );
}

createRoot(document.getElementById("root")!).render(createElement(Harness));
