import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";

import { AsinSyncFunnel } from "../../../app/asin-sync-funnel";

const search = new URLSearchParams(window.location.search);
const asins = ["B07DYG1C9B", "B07VY9Q95Q", "B0BPXRVWYK"];

function Harness() {
  const [, setRevision] = useState(0);
  (window as Window & { rerenderSyncFunnel?: () => void }).rerenderSyncFunnel = () => {
    setRevision(revision => revision + 1);
  };
  return createElement(AsinSyncFunnel, {
    asins,
    marketplace: "US",
    projectId: search.get("project"),
    runId: search.get("run"),
    resumeJobId: search.get("syncJob"),
  });
}

createRoot(document.getElementById("root")!).render(createElement(Harness));
