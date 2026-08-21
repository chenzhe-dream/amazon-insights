import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";

import { AsinSyncFunnel } from "../../../app/asin-sync-funnel";
import { useResumedSyncScope } from "../../../app/lib/resumed-sync-scope";

const search = new URLSearchParams(window.location.search);
const asins = ["B07DYG1C9B", "B07VY9Q95Q", "B0BPXRVWYK"];

function Harness() {
  const [, setRevision] = useState(0);
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
  return createElement(AsinSyncFunnel, {
    asins,
    marketplace: "US",
    projectId: resumed.context?.projectId ?? null,
    runId: resumed.context?.runId ?? null,
    resumeJobId: search.get("syncJob"),
  });
}

createRoot(document.getElementById("root")!).render(createElement(Harness));
