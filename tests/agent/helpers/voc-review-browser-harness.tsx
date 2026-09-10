import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { useVocReviewOutput } from "../../../app/lib/use-voc-review-output";
import { scopedReviewRecords, reviewEmptyMessage, reviewEvidenceText } from "../../../app/lib/voc-review-display";
import { buildVocDevelopmentSummary } from "../../../app/features/voc/voc-development-summary";
import type { SellerSpriteReviewAnalysisRecord } from "../../../app/seller-sprite-review-analysis";

function Harness() {
  const [project, setProject] = useState("10000000-0000-4000-8000-000000000002");
  const [loggedIn, setLoggedIn] = useState(true);
  const [tab, setTab] = useState(new URLSearchParams(location.search).get("tab") ?? "voc");
  const scope = useMemo(() => loggedIn ? { organizationId: "org", projectId: project, runId: "10000000-0000-4000-8000-000000000003", jobId: "job", marketplace: "US", asins: ["B0F43M9KWW"] } : null, [project, loggedIn]);
  const { snapshot: output, refreshFailed } = useVocReviewOutput(`${project}:${loggedIn}`, scope, tab === "voc");
  const records = output.reviews && "data" in output.reviews ? (output.reviews.data as { analysisByAsin: Record<string, SellerSpriteReviewAnalysisRecord> }).analysisByAsin : {};
  const visible = scopedReviewRecords(records, ["B0F43M9KWW"], "US");
  const record = visible.B0F43M9KWW;
  const summary = buildVocDevelopmentSummary([{ asin: "B0F43M9KWW", brand: "Govee", productFamily: "lighting" }], {}, visible);
  return <main>
    <button onClick={() => setTab("voc")}>VOC</button><button onClick={() => setTab("overview")}>Overview</button>
    <button onClick={() => setProject(project.endsWith("2") ? "10000000-0000-4000-8000-000000000004" : "10000000-0000-4000-8000-000000000002")}>Switch</button>
    <button onClick={() => setLoggedIn(false)}>Logout</button>
    {tab === "voc" && <section><p id="read-failure">{refreshFailed ? "refresh failed" : ""}</p><p id="evidence">{reviewEvidenceText(record)}</p><p>{reviewEmptyMessage(record)}</p><div id="matrix">{record?.blocks.flatMap(b => b.rows.map(r => r.label)).join(",")}</div><div id="summary">{summary.flatMap(d => d.themes.map(t => t.label)).join(",")}</div></section>}
  </main>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
