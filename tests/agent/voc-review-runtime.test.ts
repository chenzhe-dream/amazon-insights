import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createVocReviewReader } from "../../app/lib/voc-review-reader";
import { buildVocDevelopmentSummary, hasVocDevelopmentData } from "../../app/features/voc/voc-development-summary";

const scope = { organizationId: "org", projectId: "10000000-0000-4000-8000-000000000002", runId: "10000000-0000-4000-8000-000000000003", jobId: "job", marketplace: "US", asins: ["B0F43M9KWW"] };
const record = { asin: scope.asins[0], marketplace: "US", status: "ready" as const, sampledReviews: 33, fetchedAt: "2026-09-10T00:00:00Z", blocks: [{ key: "positives" as const, label: "好评", rows: [{ label: "brightness", sharePct: 80, count: 8 }] }] };
function canonical(value: any): any { return Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value; }
function output() {
  const data = { analysisByAsin: { [record.asin]: record }, ratingByAsin: {} };
  return { projectId: scope.projectId, runId: scope.runId, jobId: scope.jobId, stage: "reviews", stageStatus: "done", jobVersion: 12, outputVersion: 12, updatedAt: record.fetchedAt, data, contentHash: createHash("sha256").update(JSON.stringify(canonical({ stage: "reviews", data }))).digest("hex") };
}
function job() { return { jobId: scope.jobId, jobVersion: 12, marketplace: "US", asins: scope.asins, scope: { projectId: scope.projectId, runId: scope.runId }, stages: [{ id: "reviews", status: "done" }] }; }
test("direct VOC reads persisted review output without mounting the sync funnel", async () => {
  const seen: any[] = [];
  const reader = createVocReviewReader(scope, async path => Response.json(path.endsWith("/output") ? output() : job()), snapshot => seen.push(snapshot));
  await reader.refresh();
  assert.equal(seen.at(-1).reviews.data.analysisByAsin[record.asin].sampledReviews, 33);
});
test("disposed reader cannot publish delayed response after project switch/logout", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const seen: any[] = [];
  const reader = createVocReviewReader(scope, async path => { if (path.endsWith("/output")) await pending; return Response.json(path.endsWith("/output") ? output() : job()); }, s => seen.push(s));
  const request = reader.refresh();
  await new Promise(resolve => setImmediate(resolve));
  reader.dispose(); release(); await request;
  assert.equal(seen.length, 0);
});
test("disposed reader cannot publish delayed failure into a replacement scope", async () => {
  let reject!: (error: Error) => void;
  const pending = new Promise<Response>((_, fail) => { reject = fail; });
  const seen: unknown[] = [];
  const reader = createVocReviewReader(scope, async () => pending, snapshot => seen.push(snapshot));
  const request = reader.refresh(); reader.dispose(); reject(new Error("late failure")); await request;
  assert.deepEqual(seen, []);
});
for (const mismatch of [{ marketplace: "UK" }, { asins: ["B0OTHER000"] }, { scope: { projectId: "other", runId: scope.runId } }, { scope: { projectId: scope.projectId, runId: "other" } }]) {
  test(`rejects mismatched job ${JSON.stringify(mismatch)}`, async () => {
    const seen: any[] = [];
    const reader = createVocReviewReader(scope, async () => Response.json({ ...job(), ...mismatch }), s => seen.push(s));
    await reader.refresh(); assert.equal(seen.length, 0);
  });
}
test("seven dimension summary consumes the same runtime review records as matrix", () => {
  const products = [{ asin: record.asin, brand: "Govee", productFamily: "lighting" as const }];
  const records = { [record.asin]: record };
  assert.equal(hasVocDevelopmentData(products, {}, records), true);
  assert.ok(buildVocDevelopmentSummary(products, {}, records).some(d => d.themes.length));
  assert.equal(hasVocDevelopmentData(products, {}, {}), false);
});
test("terminal result is GET-only and never re-fetches the same completed episode", async () => {
  const paths: string[] = [];
  const reader = createVocReviewReader(scope, async (path, init) => { assert.equal(init?.method ?? "GET", "GET"); paths.push(path); return Response.json(path.endsWith("/output") ? output() : job()); }, () => {});
  for (let i = 0; i < 6; i++) await reader.refresh();
  assert.equal(paths.length, 2);
  assert.equal(reader.isSettled(), true);
});
test("missing output stops after three tries without fabricating ready data", async () => {
  let outputs = 0;
  const seen: any[] = [];
  const reader = createVocReviewReader(scope, async path => { if (!path.endsWith("/output")) return Response.json(job()); outputs++; return new Response(null, { status: 404 }); }, s => seen.push(s));
  for (let i = 0; i < 7; i++) await reader.refresh();
  assert.equal(outputs, 3);
  assert.equal(seen.at(-1).reviews.stageStatus, "missing-output");
});
test("terminal job with missing review stage is also bounded", async () => {
  let reads = 0;
  const reader = createVocReviewReader(scope, async () => { reads++; return Response.json({ ...job(), status: "completed", stages: [] }); }, () => {});
  for (let i = 0; i < 7; i++) await reader.refresh();
  assert.equal(reads, 3); assert.equal(reader.isSettled(), true);
});
test("partial review projection preserves successful siblings and exposes its current gap", async () => {
  const partial = { ...output(), stageStatus: "partial", gap: { state: "partial", reasonCode: "UPSTREAM_EMPTY", items: [{ asin: "B0CZRBL776", causeCode: "UPSTREAM_EMPTY" }] } };
  partial.contentHash = createHash("sha256").update(JSON.stringify(canonical({ stage: "reviews", data: partial.data, gap: partial.gap }))).digest("hex");
  const seen: any[] = [];
  const reader = createVocReviewReader(scope, async path => Response.json(path.endsWith("/output") ? partial : { ...job(), stages: [{ id: "reviews", status: "partial" }] }), s => seen.push(s));
  await reader.refresh();
  assert.equal(seen.at(-1).reviews.data.analysisByAsin[record.asin].sampledReviews, 33);
  assert.equal(seen.at(-1).reviews.gap.reasonCode, "UPSTREAM_EMPTY");
});
