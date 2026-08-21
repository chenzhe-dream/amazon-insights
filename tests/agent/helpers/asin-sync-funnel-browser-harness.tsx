import { createElement, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { UrlResumableAsinSyncFunnel, type SyncJob } from "../../../app/asin-sync-funnel";
import { useResumedSyncScope } from "../../../app/lib/resumed-sync-scope";
import { createTerminalSyncOwner } from "../../../app/lib/sync-terminal-owner";
import { KeywordFetchStatusSection } from "../../../app/keyword-fetch-status";
import { TrafficFetchStatusSection } from "../../../app/traffic-fetch-status";

const asins = ["B07DYG1C9B", "B07VY9Q95Q", "B0BPXRVWYK"];
type HarnessWindow = Window & {
  rerenderSyncFunnel?: () => void;
  hydrateSyncWorkspace?: () => void;
  switchSyncFunnelTab?: (tab: "overview" | "keywords" | "traffic" | "library") => void;
  startNewSyncFunnel?: () => void;
  runOverviewAutoCheck?: () => void;
  syncTerminalEvents?: { completions: number; reloads: number };
};

function Harness() {
  const search = new URLSearchParams(window.location.search);
  const [, setRevision] = useState(0);
  const [tab, setTab] = useState<"overview" | "keywords" | "traffic" | "library">(
    (search.get("tab") as "overview" | "keywords" | "traffic" | "library" | null) ?? "overview",
  );
  const [requested, setRequested] = useState(search.get("start") === "1");
  const [terminalJob, setTerminalJob] = useState<SyncJob | null>(null);
  const scheduledReloadJobId = useRef<string | null>(null);
  const hydrationMarket = search.get("hydrationMarket") ?? "DE";
  const [workspace, setWorkspace] = useState(() => ({
    ready: search.get("hydrate") !== "async",
    asins: search.get("hydrate") === "async" ? [] : asins,
    marketplace: search.get("hydrate") === "async" ? "US" : "US",
  }));
  const harnessWindow = window as HarnessWindow;
  harnessWindow.rerenderSyncFunnel = () => {
    setRevision(revision => revision + 1);
  };
  harnessWindow.hydrateSyncWorkspace = () => {
    setWorkspace({ ready: true, asins, marketplace: hydrationMarket });
  };
  harnessWindow.switchSyncFunnelTab = nextTab => {
    setTab(nextTab);
  };
  harnessWindow.runOverviewAutoCheck = () => {
    setRevision(revision => revision + 1);
  };
  if (!harnessWindow.syncTerminalEvents) {
    harnessWindow.syncTerminalEvents = { completions: 0, reloads: 0 };
  }
  const resumed = useResumedSyncScope({
    runId: search.get("run"),
    fallbackContext: null,
  });
  const resumeStatus = (resumed as { status?: string }).status;
  const terminalOwner = createTerminalSyncOwner({
    storage: window.sessionStorage,
    pathname: window.location.pathname,
    projectId: resumed.context?.projectId ?? null,
    marketplace: workspace.marketplace,
    asins: workspace.asins,
  });
  harnessWindow.startNewSyncFunnel = () => {
    terminalOwner.clearForExplicitStart();
    setTerminalJob(null);
    setRequested(true);
  };
  useEffect(() => {
    if (requested || tab !== "overview" || search.has("syncJob") || !workspace.ready || resumed.resolving || resumeStatus === "invalid" || terminalOwner.blocksAutomaticStart()) return;
    setRequested(true);
  }, [requested, resumeStatus, resumed.resolving, tab, terminalOwner, workspace.ready]);
  if (resumed.resolving || resumeStatus === "resolving") {
    return createElement("span", { "data-sync-resume": "resolving" }, "resolving");
  }
  if (resumeStatus === "invalid") return createElement("span", { "data-sync-resume": "invalid" }, "invalid");
  const syncRequest = requested ? workspace.asins : null;
  const onSyncJobId = (jobId: string) => {
    setTerminalJob(null);
    const next = new URLSearchParams(window.location.search);
    next.set("syncJob", jobId);
    window.history.replaceState(null, "", `?${next}`);
    setRevision(revision => revision + 1);
  };
  const shared = {
    syncJobId: search.get("syncJob"),
    terminalJob,
    projectId: resumed.context?.projectId ?? null,
    runId: resumed.context?.runId ?? null,
    resumePending: resumed.resolving,
    resumeBlocked: resumeStatus === "invalid",
    workspaceReady: workspace.ready,
    onSyncJobId,
    onDismiss: () => {
      const next = new URLSearchParams(window.location.search);
      next.delete("syncJob");
      window.history.replaceState(null, "", `?${next}`);
      setRequested(false);
      setTerminalJob(null);
      setRevision(revision => revision + 1);
    },
    onComplete: (job: SyncJob) => {
      createTerminalSyncOwner({
        storage: window.sessionStorage,
        pathname: window.location.pathname,
        projectId: job.scope?.projectId ?? resumed.context?.projectId ?? null,
        marketplace: job.marketplace ?? workspace.marketplace,
        asins: job.asins ?? workspace.asins,
      }).recordTerminal({ jobId: job.jobId });
      harnessWindow.syncTerminalEvents!.completions += 1;
      setTerminalJob(job);
      const next = new URLSearchParams(window.location.search);
      next.delete("syncJob");
      window.history.replaceState(null, "", `?${next}`);
      setRequested(false);
      setRevision(revision => revision + 1);
      if (job.needsReload && scheduledReloadJobId.current !== job.jobId) {
        scheduledReloadJobId.current = job.jobId;
        window.setTimeout(() => {
          harnessWindow.syncTerminalEvents!.reloads += 1;
        }, 10);
      }
    },
  };
  if (tab === "keywords") {
    return createElement(KeywordFetchStatusSection as unknown as (props: Record<string, unknown>) => ReturnType<typeof createElement>, {
      products: workspace.asins.map(asin => ({ asin, brand: "Test" })), marketplace: workspace.marketplace, syncRequest,
      onRequestSync: () => setRequested(true), syncResume: shared,
    });
  }
  if (tab === "traffic") {
    return createElement(TrafficFetchStatusSection as unknown as (props: Record<string, unknown>) => ReturnType<typeof createElement>, {
      products: workspace.asins.map(asin => ({ asin, brand: "Test" })), marketplace: workspace.marketplace, syncRequest,
      onRequestSync: () => setRequested(true), syncResume: shared,
    });
  }
  return createElement(UrlResumableAsinSyncFunnel, {
    asins: syncRequest ?? workspace.asins,
    marketplace: workspace.marketplace,
    syncRequest,
    resume: shared,
    focusStageIds: tab === "library" ? ["catalog", "keywords"] : undefined,
  });
}

createRoot(document.getElementById("root")!).render(createElement(Harness));
