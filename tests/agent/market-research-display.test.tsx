import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MarketOverviewReport, MarketResearchJob } from "../../shared/market-research-contracts";
import { MarketOverviewResult, MarketResearchSection, canRetryMarketResearchJob, previousCompleteMonth } from "../../app/market-research-section";
import { createMarketResearchHistoryReader, createMarketResearchJob, listMarketResearchJobs } from "../../app/lib/market-research-browser";

const scope = { marketplace: "US", nodeQuery: "123:456", month: "2026-08", headTopN: 10, newProductMonths: 6 } as const;
const report: MarketOverviewReport = {
  schemaVersion: "market-overview/v1", scope, nodeId: "456", nodeIdPath: "123:456", categoryName: "<script>unsafe</script>",
  currency: "USD", collectedAt: "2026-09-12T03:00:00.000Z",
  metrics: { sampleProducts: 100, brands: null, sellers: 0, totalUnits: null, totalRevenue: 20000, avgPrice: 39.5, avgUnits: null, avgRatings: null, avgRating: null,
    productConcentrationRaw: 0.6, brandConcentrationRaw: 60, sellerConcentrationRaw: null, newCount: 4, newAvgPrice: null, newAvgUnits: 0 },
  evidence: [], issues: [], boundaries: ["样本数据不代表整个市场。"],
};
const job: MarketResearchJob = { id: "10000000-0000-4000-8000-000000000001", scope, status: "failed", attempts: 1,
  createdAt: report.collectedAt, updatedAt: report.collectedAt, report: null,
  error: { dataset: "research", code: "timeout", message: "上游暂时不可用", retryable: true } };

test("market report keeps missing values unknown and unconfirmed ratios raw", () => {
  const html = renderToStaticMarkup(<MarketOverviewResult report={report} />);
  assert.match(html, /未知/);
  assert.match(html, /0\.6/);
  assert.match(html, />60</);
  assert.match(html, /上游比例原值（单位待确认）/);
  assert.doesNotMatch(html, /%|机会分|高机会/);
  assert.match(html, /&lt;script&gt;unsafe&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /样本数据不代表整个市场/);
});

test("market overview can render without ASINs and does not start a job on rendering", () => {
  const html = renderToStaticMarkup(<MarketResearchSection sessionIdentity="session-one" />);
  assert.match(html, /类目节点/);
  assert.match(html, /筛选市场/);
  assert.match(html, /采集历史/);
  assert.doesNotMatch(html, /输入 3|自动开始/);
  for (const label of ["市场总览", "商品形态及价格带", "类目关键词洞察", "类目买家评论见解"]) assert.ok(html.includes(label));
});

test("default month uses the preceding complete calendar month across year boundaries", () => {
  assert.equal(previousCompleteMonth(new Date("2026-01-01T00:00:00Z")), "2025-12");
  assert.equal(previousCompleteMonth(new Date("2026-09-12T00:00:00Z")), "2026-08");
});

test("default month matches the backend UTC boundary during Shanghai's first morning of the month", () => {
  assert.equal(previousCompleteMonth(new Date("2026-09-01T00:30:00+08:00")), "2026-07");
  assert.equal(previousCompleteMonth(new Date("2026-09-01T00:00:00Z")), "2026-08");
});

test("only retryable failed jobs below the attempt limit offer retry", () => {
  assert.equal(canRetryMarketResearchJob(job), true);
  assert.equal(canRetryMarketResearchJob({ ...job, attempts: 3 }), false);
  assert.equal(canRetryMarketResearchJob({ ...job, error: { ...job.error!, retryable: false } }), false);
  assert.equal(canRetryMarketResearchJob({ ...job, status: "running", error: null }), false);
});

test("browser client uses authenticated same-origin API and an explicit idempotency key", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ path: string; init: RequestInit }> = [];
  globalThis.fetch = async (input, init) => { calls.push({ path: String(input), init: init ?? {} }); return Response.json({ job }); };
  try {
    const key = "20000000-0000-4000-8000-000000000001";
    await createMarketResearchJob(scope, key);
    assert.equal(calls[0].path, "/api/agent/v1/market-research/jobs");
    assert.equal(calls[0].init.credentials, "same-origin");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(new Headers(calls[0].init.headers).get("idempotency-key"), key);
    assert.deepEqual(JSON.parse(calls[0].init.body as string), scope);
  } finally { globalThis.fetch = originalFetch; }
});

test("browser client rejects malformed responses and responses after the session request is aborted", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ jobs: [{ ...job, scope: { ...scope, marketplace: "ZZ" } }] });
    await assert.rejects(listMarketResearchJobs(), /格式/);
    const controller = new AbortController();
    globalThis.fetch = async () => { controller.abort(); return Response.json({ jobs: [job] }); };
    await assert.rejects(listMarketResearchJobs(controller.signal), { name: "AbortError" });
  } finally { globalThis.fetch = originalFetch; }
});

test("slow history responses survive repeated three-second polling ticks and allow the next refresh", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const reader = createMarketResearchHistoryReader();
  const owner = new AbortController();
  let calls = 0;
  let latestRequest = 0;
  let displayed = "running";
  let finishResponse!: () => void;
  const pending = new Promise<void>(resolve => { finishResponse = resolve; });
  const refresh = () => reader.run(owner.signal, async () => {
    calls += 1;
    const requestId = ++latestRequest;
    await pending;
    if (requestId === latestRequest && !owner.signal.aborted) displayed = "succeeded";
  });
  const first = refresh();
  const interval = setInterval(() => void refresh(), 3000);
  t.mock.timers.tick(9000);
  assert.equal(calls, 1, "polling must not supersede an unfinished history response");
  finishResponse();
  await first;
  assert.equal(displayed, "succeeded", "the slow response must still update the displayed job");
  await refresh();
  assert.equal(calls, 2, "reading must resume after the previous response finishes");
  clearInterval(interval);
});

test("history reads resume after rejection", async () => {
  const reader = createMarketResearchHistoryReader();
  const signal = new AbortController().signal;
  await assert.rejects(reader.run(signal, async () => { throw new Error("slow upstream failed"); }), /slow upstream failed/);
  let refreshed = false;
  await reader.run(signal, async () => { refreshed = true; });
  assert.equal(refreshed, true);
});

test("aborted session reads do not block or release the new session read", async () => {
  const reader = createMarketResearchHistoryReader();
  const oldOwner = new AbortController();
  const nextOwner = new AbortController();
  let releaseOld!: () => void;
  let releaseNext!: () => void;
  const oldResponse = new Promise<void>(resolve => { releaseOld = resolve; });
  const nextResponse = new Promise<void>(resolve => { releaseNext = resolve; });
  let displayed = "empty";
  let calls = 0;
  const oldRead = reader.run(oldOwner.signal, async () => {
    calls += 1;
    await oldResponse;
    if (!oldOwner.signal.aborted) displayed = "old";
  });
  oldOwner.abort();
  const nextRead = reader.run(nextOwner.signal, async () => {
    calls += 1;
    await nextResponse;
    if (!nextOwner.signal.aborted) displayed = "next";
  });
  assert.equal(calls, 2, "the new session need not wait for an aborted transport");
  releaseOld();
  await oldRead;
  await reader.run(nextOwner.signal, async () => { calls += 1; });
  assert.equal(calls, 2, "the old completion must not unlock the new in-flight read");
  assert.equal(displayed, "empty");
  releaseNext();
  await nextRead;
  assert.equal(displayed, "next");
  await reader.run(oldOwner.signal, async () => { calls += 1; });
  assert.equal(calls, 2, "an aborted session cannot start another read");
});
