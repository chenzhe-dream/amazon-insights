import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";

import { UrlResumableAsinSyncFunnel } from "../../../app/asin-sync-funnel";
import { useResumedSyncScope } from "../../../app/lib/resumed-sync-scope";
import { KeywordFetchStatusSection } from "../../../app/keyword-fetch-status";
import { TrafficFetchStatusSection } from "../../../app/traffic-fetch-status";

const asins = ["B07DYG1C9B", "B07VY9Q95Q", "B0BPXRVWYK"];

function Harness() {
  const search = new URLSearchParams(window.location.search);
  const [, setRevision] = useState(0);
  const tab = search.get("tab") ?? "overview";
  const [requested, setRequested] = useState(search.get("start") === "1" || (tab === "overview" && !search.get("syncJob")));
  (window as Window & { rerenderSyncFunnel?: () => void }).rerenderSyncFunnel = () => {
    setRevision(revision => revision + 1);
  };
  const resumed = useResumedSyncScope({
    runId: search.get("run"),
    fallbackContext: null,
  });
  const resumeStatus = (resumed as { status?: string }).status;
  if (resumed.resolving || resumeStatus === "resolving") {
    return createElement("span", { "data-sync-resume": "resolving" }, "resolving");
  }
  if (resumeStatus === "invalid") return createElement("span", { "data-sync-resume": "invalid" }, "invalid");
  const syncRequest = requested ? asins : null;
  const onSyncJobId = (jobId: string) => {
    const next = new URLSearchParams(window.location.search);
    next.set("syncJob", jobId);
    window.history.replaceState(null, "", `?${next}`);
    setRevision(revision => revision + 1);
  };
  const shared = {
    syncJobId: search.get("syncJob"),
    projectId: resumed.context?.projectId ?? null,
    runId: resumed.context?.runId ?? null,
    resumePending: resumed.resolving,
    resumeBlocked: resumeStatus === "invalid",
    onSyncJobId,
    onDismiss: () => {
      const next = new URLSearchParams(window.location.search);
      next.delete("syncJob");
      window.history.replaceState(null, "", `?${next}`);
      setRequested(false);
      setRevision(revision => revision + 1);
    },
  };
  if (tab === "keywords") {
    return createElement(KeywordFetchStatusSection as unknown as (props: Record<string, unknown>) => ReturnType<typeof createElement>, {
      products: asins.map(asin => ({ asin, brand: "Test" })), marketplace: "US", syncRequest,
      onRequestSync: () => setRequested(true), syncResume: shared,
    });
  }
  if (tab === "traffic") {
    return createElement(TrafficFetchStatusSection as unknown as (props: Record<string, unknown>) => ReturnType<typeof createElement>, {
      products: asins.map(asin => ({ asin, brand: "Test" })), marketplace: "US", syncRequest,
      onRequestSync: () => setRequested(true), syncResume: shared,
    });
  }
  return createElement(UrlResumableAsinSyncFunnel, {
    asins: syncRequest ?? asins,
    marketplace: "US",
    syncRequest,
    resume: shared,
    focusStageIds: tab === "library" ? ["catalog", "keywords"] : undefined,
  });
}

createRoot(document.getElementById("root")!).render(createElement(Harness));
