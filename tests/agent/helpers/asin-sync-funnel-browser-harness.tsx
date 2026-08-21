import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";

import { UrlResumableAsinSyncFunnel } from "../../../app/asin-sync-funnel";
import { useResumedSyncScope } from "../../../app/lib/resumed-sync-scope";
import { KeywordFetchStatusSection } from "../../../app/keyword-fetch-status";
import { TrafficFetchStatusSection } from "../../../app/traffic-fetch-status";

const asins = ["B07DYG1C9B", "B07VY9Q95Q", "B0BPXRVWYK"];
type HarnessWindow = Window & {
  rerenderSyncFunnel?: () => void;
  hydrateSyncWorkspace?: () => void;
  syncTerminalEvents?: { completions: number; reloads: number };
};

function Harness() {
  const search = new URLSearchParams(window.location.search);
  const [, setRevision] = useState(0);
  const tab = search.get("tab") ?? "overview";
  const [requested, setRequested] = useState(search.get("start") === "1" || (tab === "overview" && !search.get("syncJob")));
  const [terminalJobId, setTerminalJobId] = useState<string | null>(null);
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
  if (!harnessWindow.syncTerminalEvents) {
    harnessWindow.syncTerminalEvents = { completions: 0, reloads: 0 };
  }
  const resumed = useResumedSyncScope({
    runId: search.get("run"),
    fallbackContext: null,
  });
  const resumeStatus = (resumed as { status?: string }).status;
  if (resumed.resolving || resumeStatus === "resolving") {
    return createElement("span", { "data-sync-resume": "resolving" }, "resolving");
  }
  if (resumeStatus === "invalid") return createElement("span", { "data-sync-resume": "invalid" }, "invalid");
  const syncRequest = requested ? workspace.asins : null;
  const onSyncJobId = (jobId: string) => {
    setTerminalJobId(null);
    const next = new URLSearchParams(window.location.search);
    next.set("syncJob", jobId);
    window.history.replaceState(null, "", `?${next}`);
    setRevision(revision => revision + 1);
  };
  const shared = {
    syncJobId: search.get("syncJob"),
    terminalJobId,
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
      setTerminalJobId(null);
      setRevision(revision => revision + 1);
    },
    onComplete: (jobId: string) => {
      harnessWindow.syncTerminalEvents!.completions += 1;
      setTerminalJobId(jobId);
      const next = new URLSearchParams(window.location.search);
      next.delete("syncJob");
      window.history.replaceState(null, "", `?${next}`);
      setRequested(false);
      setRevision(revision => revision + 1);
    },
    onReload: () => {
      harnessWindow.syncTerminalEvents!.reloads += 1;
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
