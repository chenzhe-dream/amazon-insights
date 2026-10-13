import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { collectMarketKeywordPage, collectMarketKeywordTrend } from "../../server/services/market-keyword-collector";
import { ConnectorError, type ConnectorRequest, type ConnectorResult, type RemoteMcpConnector } from "../../server/connectors/connector-contract";

// Synthetic fixtures reproduce the recorded Sorftime doc/data shapes only.
// Counts and keywords here are invented; these are not upstream observations.
const now = new Date("2026-09-12T12:00:00.000Z");
const scope = { organizationId: "synthetic-org", researchId: "11111111-1111-4111-8111-111111111111", marketplace: "US" as const, nodeIdPath: "228013:495224:3736561:1063294", fromMonth: "2026-08", toMonth: "2026-08", currency: "USD" as const };
const row = (keyword = "synthetic lamp") => ({ keyword, weekly_search_volume: 40, weekly_search_rank: 5, monthly_search_volume: 160, recommended_cpc_bid: "1.25", seasonality: "Peak season of search volume: 11月" });
const page = (rows: unknown[] = [row()]) => ({ doc: { keyword: "The extended keyword text.", recommended_cpc_bid: "Recommended CPC bid (string, in USD)." }, data: rows });
const trend = () => ({ doc: { keyword: "The queried keyword text." }, data: {
  keyword: "synthetic lamp",
  search_volume_trend: ["2025-08 search volume 100", "2026-07 search volume 150", "2026-08 search volume 180"],
  search_rank_trend: ["2026-08 search rank 5"],
  recommended_bid_trend: ["2026-08 CPC recommended bid 1.25"],
} });
function mock(payload: unknown, override?: (request: ConnectorRequest) => Promise<ConnectorResult>) {
  const calls: ConnectorRequest[] = [];
  const connector: RemoteMcpConnector = {
    id: "sorftime",
    async execute(request) {
      calls.push(request);
      return override ? override(request) : { data: payload as ConnectorResult["data"], source: { connectorId: "sorftime", operation: request.operation, fetchedAt: "2026-09-12T06:00:00.000Z", attemptCount: 1 } };
    },
    async probe() { throw new Error("probe must not run"); },
  };
  return { connector, calls };
}
const pageInput = (connector: RemoteMcpConnector, extra = {}) => ({ connector, scope, jobId: "synthetic-job", seed: "synthetic seed", page: 1, ...extra });
const trendInput = (connector: RemoteMcpConnector, extra = {}) => ({ connector, scope, jobId: "synthetic-job", keyword: "synthetic lamp", ...extra });

test("page sends one governed request and keeps returned member distinct from seed", async () => {
  const upstream = mock(page());
  const result = await collectMarketKeywordPage(pageInput(upstream.connector), now);
  assert.equal(result.status, "ready");
  assert.equal(result.seed, "synthetic seed");
  assert.equal(result.members[0].keyword, "synthetic lamp");
  assert.deepEqual(result.members[0].monthlySearchVolume, { value: 160, reason: null });
  assert.deepEqual(result.members[0].recommendedCpcUsd, { value: 1.25, reason: null });
  assert.equal(result.members[0].seasonality.value, "Peak season of search volume: 11月");
  assert.equal(result.evidence.observationPeriod.kind, "unknown");
  assert.equal(result.evidence.responseIdentity.keyword.status, "unverified");
  assert.equal(result.evidence.responseIdentity.marketplace.status, "unverified");
  assert.deepEqual(upstream.calls.map(call => ({ operation: call.operation, input: call.input, governorScope: call.governorScope })), [{ operation: "keyword_extends", input: { keyword: "synthetic seed", keyword_support_site: "US", page: 1 }, governorScope: { organizationId: scope.organizationId, jobId: "synthetic-job" } }]);
  assert.ok(upstream.calls[0].signal instanceof AbortSignal);
});

test("page limit is 20, full page is only a next candidate, stable IDs survive seed/page changes", async () => {
  const payload = page(Array.from({ length: 20 }, (_, index) => row(`synthetic ${index}`)));
  const first = await collectMarketKeywordPage(pageInput(mock(payload).connector), now);
  const next = await collectMarketKeywordPage(pageInput(mock(payload).connector, { seed: "other seed", page: 2 }), now);
  assert.equal(first.status, "ready");
  assert.notEqual(next.status, "failed");
  if (next.status === "failed") return;
  assert.equal(first.members.length, 20);
  assert.equal(first.members[0].id, next.members[0].id);
  assert.deepEqual(first.pagination, { pageLimit: 20, nextPageCandidate: 2, hasMore: "unknown", totalCount: null });
  assert.equal(first.evidence.coverage.expectedCount, null);
  const overflow = await collectMarketKeywordPage(pageInput(mock(page([...payload.data, row("overflow")])).connector), now);
  assert.equal(overflow.status, "failed");
});

test("page missing fields are partial, blank CPC is missing, genuine zero remains zero", async () => {
  const result = await collectMarketKeywordPage(pageInput(mock(page([{ keyword: "zero", weekly_search_volume: 0, monthly_search_volume: 0, recommended_cpc_bid: "", seasonality: "" }])).connector), now);
  assert.equal(result.status, "partial");
  assert.deepEqual(result.members[0].monthlySearchVolume, { value: 0, reason: null });
  assert.deepEqual(result.members[0].recommendedCpcUsd, { value: null, reason: "missing" });
  assert.deepEqual(result.members[0].weeklySearchRank, { value: null, reason: "missing" });
});

test("page successful empty data is empty, not ready", async () => {
  const result = await collectMarketKeywordPage(pageInput(mock(page([])).connector), now);
  assert.equal(result.status, "empty");
  assert.equal(result.evidence.coverage.receivedCount, 0);
});

test("invalid numeric fields fail with bounded raw diagnostics instead of valid evidence", async () => {
  for (const value of [-1, 1.5, "100", Number.MAX_SAFE_INTEGER + 1]) {
    const payload = page([{ ...row(), monthly_search_volume: value }]);
    const result = await collectMarketKeywordPage(pageInput(mock(payload).connector), now);
    assert.equal(result.status, "failed");
    if (result.status !== "failed") continue;
    assert.equal(result.failure.code, "malformed-response");
    assert.deepEqual(result.rawPayload, payload);
    assert.equal("evidence" in result, false);
    assert.ok(result.issues.some(issue => issue.code === "invalid"));
  }
  for (const value of ["1.2 USD", "1e3", "-1", "NaN", 1.2]) {
    const result = await collectMarketKeywordPage(pageInput(mock(page([{ ...row(), recommended_cpc_bid: value }])).connector), now);
    assert.equal(result.status, "failed");
  }
});

test("duplicate or invalid page member identity fails without hiding rows", async () => {
  for (const rows of [[row(), row()], [row("")], [null]]) {
    const result = await collectMarketKeywordPage(pageInput(mock(page(rows)).connector), now);
    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.deepEqual(result.rawPayload, page(rows));
  }
});

test("all declared envelope and row scope/identity echoes reject conflicts", async () => {
  const conflicts = [
    { ...page(), site: "GB" }, { ...page(), page: 2 }, { ...page(), keyword: "different seed" },
    { ...page(), node_id: "999" }, { ...page(), month: "202607" }, { ...page(), currency: "EUR" },
    page([{ ...row(), site: "GB" }]), page([{ ...row(), month: "2026-07" }]),
  ];
  for (const payload of conflicts) {
    const result = await collectMarketKeywordPage(pageInput(mock(payload).connector), now);
    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.equal(result.failure.code, "identity-conflict");
      assert.deepEqual(result.rawPayload, payload);
    }
  }
});

test("page matching echoes verify only actually echoed fields", async () => {
  const payload = { ...page(), site: "US", page: 1, keyword: "synthetic seed", node_id: "1063294", month: "202608", currency: "USD" };
  const result = await collectMarketKeywordPage(pageInput(mock(payload).connector), now);
  assert.notEqual(result.status, "failed");
  if (result.status === "failed") return;
  assert.equal(result.evidence.responseIdentity.keyword.status, "verified");
  assert.equal(result.evidence.responseIdentity.page.status, "verified");
  assert.equal(result.evidence.responseIdentity.month.status, "unverified");
  assert.equal(result.evidence.responseIdentity.asin.status, "unverified");
});

test("trend parses exact source strings, derives selected complete month and explicit growth baseline", async () => {
  const upstream = mock(trend());
  const result = await collectMarketKeywordTrend(trendInput(upstream.connector), now);
  assert.equal(result.status, "partial"); // CPC currency is not stated by the trend source.
  const month = result.months[0];
  assert.equal(month.month, "2026-08");
  assert.equal(month.searchVolume.value, 180);
  assert.equal(month.yoyGrowth.value, 0.8);
  assert.equal(month.yoyGrowth.baselineMonth, "2025-08");
  assert.equal(month.yoyGrowth.baselineValue, 100);
  assert.ok(Math.abs(month.recentGrowth.value! - 0.2) < 1e-12);
  assert.equal(month.recentGrowth.baselineMonth, "2026-07");
  assert.equal(month.recentGrowth.formulaVersion, "calendar-month-growth/v1");
  assert.equal(result.cpcCurrency, null);
  assert.equal(result.evidence.units.recommendedBid.status, "unknown");
  assert.equal(result.evidence.responseIdentity.keyword.status, "verified");
  assert.deepEqual(result.evidence.observationPeriod, { kind: "calendar-months", fromMonth: "2025-08", toMonth: "2026-08" });
  assert.deepEqual(upstream.calls[0].input, { keyword: "synthetic lamp", keyword_support_site: "US", type: 2 });
  assert.equal(upstream.calls.length, 1);
});

test("trend missing/zero baseline is explicit and true zero current yields minus one", async () => {
  for (const [baseline, expectedReason] of [[undefined, "missing-baseline"], [0, "zero-baseline"]] as const) {
    const payload = trend();
    payload.data.search_volume_trend = ["2026-08 search volume 0", ...(baseline === undefined ? [] : [`2026-07 search volume ${baseline}`])];
    const result = await collectMarketKeywordTrend(trendInput(mock(payload).connector), now);
    assert.notEqual(result.status, "failed");
    if (result.status === "failed") continue;
    assert.equal(result.months[0].searchVolume.value, 0);
    assert.equal(result.months[0].recentGrowth.value, null);
    assert.equal(result.months[0].recentGrowth.reason, expectedReason);
    assert.equal(result.months[0].yoyGrowth.reason, "missing-baseline");
  }
  const payload = trend(); payload.data.search_volume_trend[2] = "2026-08 search volume 0";
  const zero = await collectMarketKeywordTrend(trendInput(mock(payload).connector), now);
  if (zero.status === "failed") return assert.fail();
  assert.equal(zero.months[0].recentGrowth.value, -1);
});

test("trend requested month gaps stay missing instead of borrowing latest source month", async () => {
  const payload = trend(); payload.data.search_volume_trend.pop();
  const result = await collectMarketKeywordTrend(trendInput(mock(payload).connector, { scope: { ...scope, fromMonth: "2026-07" } }), now);
  assert.equal(result.status, "partial");
  assert.deepEqual(result.months.map(month => month.searchVolume.value), [150, null]);
  assert.equal(result.months[1].yoyGrowth.reason, "missing-current");
});

test("identical duplicate month is explicit; conflicting duplicate invalidates only its metric month", async () => {
  const payload = trend(); payload.data.recommended_bid_trend.push("2026-08 CPC recommended bid 1.25");
  const same = await collectMarketKeywordTrend(trendInput(mock(payload).connector), now);
  assert.equal(same.status, "partial");
  assert.equal(same.series.recommendedBid.length, 1);
  assert.ok(same.issues.some(issue => issue.code === "duplicate-month"));
  payload.data.recommended_bid_trend.push("2026-08 CPC recommended bid 2.25");
  const different = await collectMarketKeywordTrend(trendInput(mock(payload).connector), now);
  assert.equal(different.status, "partial");
  assert.ok(different.issues.some(issue => issue.code === "conflicting-month"));
  assert.deepEqual(different.evidence.payload, payload);
  assert.equal(different.months[0].recommendedBid.value, null);
  assert.equal(different.months[0].searchVolume.value, 180);
});

test("trend rejects malformed month, wrong label, negative/fractional/unsafe counts and trailing text", async () => {
  for (const invalid of ["2026-13 search volume 1", "2026-08 search volume -1", "2026-08 search volume 1.5", "2026-08 search volume 9007199254740992", "2026-08 search rank 1", "2026-08 search volume 1 junk", "2026-8 search volume 1", "2026-08 search volume 1e3"]) {
    const payload = trend(); payload.data.search_volume_trend.push(invalid);
    const result = await collectMarketKeywordTrend(trendInput(mock(payload).connector), now);
    assert.equal(result.status, "failed", invalid);
    if (result.status === "failed") assert.deepEqual(result.rawPayload, payload);
  }
});

test("source count text must be integer before Number rounding", async () => {
  for (const field of ["search_volume_trend", "search_rank_trend"] as const) {
    const label = field === "search_volume_trend" ? "search volume" : "search rank";
    for (const token of ["1.00000000000000001", "9007199254740990.5", "1.0"]) {
      const payload = trend();
      payload.data[field] = [`2026-08 ${label} ${token}`];
      const result = await collectMarketKeywordTrend(trendInput(mock(payload).connector), now);
      assert.equal(result.status, "failed", `${field}: ${token}`);
      if (result.status !== "failed") continue;
      assert.equal(result.failure.code, "malformed-response");
      assert.deepEqual(result.rawPayload, payload);
      assert.ok(result.issues.some(issue => issue.code === "invalid" && JSON.stringify(issue.path) === JSON.stringify(["data", field, 0])));
      assert.equal("evidence" in result, false);
    }
  }
});

test("page decimal text rejects positive underflow and out-of-range values without inventing zero", async () => {
  for (const token of [`0.${"0".repeat(400)}1`, "9007199254740991.1"]) {
    const payload = page([{ ...row(), recommended_cpc_bid: token }]);
    const result = await collectMarketKeywordPage(pageInput(mock(payload).connector), now);
    assert.equal(result.status, "failed");
    if (result.status !== "failed") continue;
    assert.equal(result.failure.code, "malformed-response");
    assert.deepEqual(result.rawPayload, payload);
    assert.ok(result.issues.some(issue => issue.code === "invalid" && JSON.stringify(issue.path) === JSON.stringify(["data", 0, "recommended_cpc_bid"])));
    assert.equal("evidence" in result, false);
  }
});

test("trend decimal text rejects positive underflow and out-of-range values without inventing zero", async () => {
  for (const token of [`0.${"0".repeat(400)}1`, "9007199254740991.1"]) {
    const payload = trend();
    payload.data.recommended_bid_trend = [`2026-08 CPC recommended bid ${token}`];
    const result = await collectMarketKeywordTrend(trendInput(mock(payload).connector), now);
    assert.equal(result.status, "failed");
    if (result.status !== "failed") continue;
    assert.equal(result.failure.code, "malformed-response");
    assert.deepEqual(result.rawPayload, payload);
    assert.ok(result.issues.some(issue => issue.code === "invalid" && JSON.stringify(issue.path) === JSON.stringify(["data", "recommended_bid_trend", 0])));
    assert.equal("evidence" in result, false);
  }
});

test("numeric text keeps genuine zero, representable positive decimals and maximum safe counts", async () => {
  for (const token of ["0", "0.000", "1.25", `0.${"0".repeat(309)}1`, String(Number.MAX_SAFE_INTEGER)]) {
    const pageResult = await collectMarketKeywordPage(pageInput(mock(page([{ ...row(), recommended_cpc_bid: token }])).connector), now);
    assert.equal(pageResult.status, "ready");
    assert.equal(pageResult.members[0].recommendedCpcUsd.value, Number(token));
    const payload = trend();
    payload.data.recommended_bid_trend = [`2026-08 CPC recommended bid ${token}`];
    payload.data.search_volume_trend = [`2026-08 search volume ${Number.MAX_SAFE_INTEGER}`];
    const trendResult = await collectMarketKeywordTrend(trendInput(mock(payload).connector), now);
    assert.equal(trendResult.status, "partial");
    assert.equal(trendResult.months[0].recommendedBid.value, Number(token));
    assert.equal(trendResult.months[0].searchVolume.value, Number.MAX_SAFE_INTEGER);
  }
});

test("current and future trend observations cannot enter complete month series or observation range", async () => {
  const payload = trend(); payload.data.search_volume_trend.push("2026-09 search volume 999", "2027-01 search volume 999");
  const result = await collectMarketKeywordTrend(trendInput(mock(payload).connector), now);
  assert.equal(result.status, "partial");
  assert.equal(result.series.searchVolume.find(point => point.month === "2026-09")?.measurement.reason, "incomplete-month");
  assert.equal(result.observedCompleteMonths.includes("2026-09"), false);
  assert.equal(result.evidence.observationPeriod.kind === "calendar-months" && result.evidence.observationPeriod.toMonth, "2026-08");
});

test("missing trend series and empty series have empty status when selected volume is unavailable", async () => {
  for (const data of [{ keyword: "synthetic lamp" }, { keyword: "synthetic lamp", search_volume_trend: [], search_rank_trend: [], recommended_bid_trend: [] }]) {
    const result = await collectMarketKeywordTrend(trendInput(mock({ data }).connector), now);
    assert.equal(result.status, "empty");
    assert.equal(result.months[0].searchVolume.value, null);
    assert.equal(result.evidence.observationPeriod.kind, "unknown");
  }
});

test("trend query keyword must echo and all known data identity aliases are checked", async () => {
  for (const changes of [{ keyword: "wrong" }, { keyword: null }, { site: "GB" }, { node_id_path: "1:2" }, { month: "2025-08" }, { currency: "EUR" }]) {
    const result = await collectMarketKeywordTrend(trendInput(mock({ ...trend(), data: { ...trend().data, ...changes } }).connector), now);
    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.equal(result.failure.code, "identity-conflict");
  }
});

test("invalid request, provider and incomplete research month never execute", async () => {
  for (const extra of [{ page: 0 }, { page: 1.5 }, { seed: " " }, { timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: 60001 }, { jobId: " " }, { scope: { ...scope, toMonth: "2026-09" } }, { scope: { ...scope, fromMonth: "2026-13" } }]) {
    const upstream = mock(page());
    const result = await collectMarketKeywordPage(pageInput(upstream.connector, extra), now);
    assert.equal(result.status, "failed"); assert.equal(upstream.calls.length, 0);
  }
  const wrong = mock(page()); wrong.connector = { ...wrong.connector, id: "sellerSprite" };
  const result = await collectMarketKeywordPage(pageInput(wrong.connector), now);
  assert.equal(result.status, "failed"); assert.equal(wrong.calls.length, 0);
});

test("pre-cancellation skips execute and in-flight cancellation propagates to connector", async () => {
  const before = new AbortController(); before.abort();
  const never = mock(page());
  const cancelled = await collectMarketKeywordPage(pageInput(never.connector, { signal: before.signal }), now);
  assert.equal(cancelled.status, "failed"); assert.equal(never.calls.length, 0);
  const during = new AbortController();
  const upstream = mock(null, async () => new Promise(() => {}));
  const pending = collectMarketKeywordPage(pageInput(upstream.connector, { signal: during.signal }), now);
  during.abort();
  const result = await pending;
  assert.equal(result.status === "failed" && result.failure.code, "cancelled");
  assert.equal(upstream.calls[0].signal?.aborted, true);
});

test("bounded deadline returns timeout even if connector ignores cancellation", async () => {
  const upstream = mock(null, async () => new Promise(() => {}));
  const result = await collectMarketKeywordTrend(trendInput(upstream.connector, { timeoutMs: 10 }), now);
  assert.equal(result.status === "failed" && result.failure.code, "timeout");
  assert.equal(upstream.calls.length, 1);
  assert.equal(upstream.calls[0].signal?.aborted, true);
});

test("a synchronous connector cannot publish success after blocking beyond its monotonic deadline", async () => {
  for (const kind of ["page", "trend"] as const) {
    let calls = 0;
    let observed: AbortSignal | undefined;
    const connector: RemoteMcpConnector = { ...mock(null).connector,
      execute(request) {
        calls++;
        observed = request.signal;
        const until = performance.now() + 20;
        while (performance.now() < until) { /* Deliberately prevent timers from running. */ }
        return Promise.resolve({ data: kind === "page" ? page() : trend(), source: { connectorId: "sorftime", operation: request.operation, fetchedAt: now.toISOString(), attemptCount: 1 } });
      },
    };
    const result = kind === "page"
      ? await collectMarketKeywordPage(pageInput(connector, { timeoutMs: 5 }), now)
      : await collectMarketKeywordTrend(trendInput(connector, { timeoutMs: 5 }), now);
    assert.equal(result.status, "failed", kind);
    if (result.status !== "failed") continue;
    assert.equal(result.failure.code, "timeout");
    assert.equal(result.failure.retryable, true);
    assert.equal("evidence" in result, false);
    assert.equal(calls, 1);
    assert.equal(observed?.aborted, true);
  }
});

test("a connector cancelling synchronously before returning cannot publish success", async () => {
  const controller = new AbortController();
  const connector: RemoteMcpConnector = { ...mock(null).connector,
    execute(request) {
      controller.abort();
      return Promise.resolve({ data: page(), source: { connectorId: "sorftime", operation: request.operation, fetchedAt: now.toISOString(), attemptCount: 1 } });
    },
  };
  const result = await collectMarketKeywordPage(pageInput(connector, { signal: controller.signal }), now);
  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.equal(result.failure.code, "cancelled");
});

for (const kind of ["page", "trend"] as const) {
  for (const expected of ["timeout", "cancelled"] as const) {
    test(`${kind} rejection rechecks ${expected} before classifying the connector error`, async () => {
      const controller = new AbortController();
      let calls = 0;
      let observed: AbortSignal | undefined;
      const connector: RemoteMcpConnector = { ...mock(null).connector,
        execute(request) {
          calls++;
          observed = request.signal;
          if (expected === "timeout") {
            const until = performance.now() + 20;
            while (performance.now() < until) { /* Delay timer delivery before rejection. */ }
          } else controller.abort();
          return Promise.reject(new ConnectorError("sorftime", "authentication", false));
        },
      };
      const extra = { signal: controller.signal, timeoutMs: expected === "timeout" ? 5 : 1_000 };
      const result = kind === "page"
        ? await collectMarketKeywordPage(pageInput(connector, extra), now)
        : await collectMarketKeywordTrend(trendInput(connector, extra), now);
      assert.equal(result.status, "failed");
      if (result.status !== "failed") return;
      assert.equal(result.failure.code, expected);
      assert.equal(result.failure.retryable, expected === "timeout");
      assert.equal("evidence" in result, false);
      assert.equal(calls, 1);
      assert.equal(observed?.aborted, true);
    });
  }
}

test("connector abort rejection cannot replace the caller cancellation/deadline reason", async () => {
  for (const mode of ["cancelled", "timeout"] as const) {
    const controller = new AbortController();
    const connector: RemoteMcpConnector = { ...mock(null).connector,
      execute: request => new Promise((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => reject(new Error("opaque abort error")), { once: true });
      }),
    };
    const pending = collectMarketKeywordPage(pageInput(connector, { signal: controller.signal, timeoutMs: 10 }), now);
    if (mode === "cancelled") controller.abort();
    const result = await pending;
    assert.equal(result.status === "failed" && result.failure.code, mode);
  }
});

test("known failures remain safely classified and unknown messages never leak", async () => {
  for (const error of [new ConnectorError("sorftime", "rate-limit", true), new Error("secret upstream credential")]) {
    const upstream = mock(null, async () => { throw error; });
    const result = await collectMarketKeywordPage(pageInput(upstream.connector), now);
    assert.equal(result.status, "failed");
    assert.equal(JSON.stringify(result).includes("secret"), false);
    if (result.status === "failed") assert.equal(result.failure.code, error instanceof ConnectorError ? "rate-limit" : "upstream-temporary");
  }
});

test("response metadata is required and mismatched source cannot be turned into valid evidence", async () => {
  for (const source of [null, { connectorId: "sellerSprite", operation: "keyword_extends", fetchedAt: "2026-09-12T06:00:00.000Z", attemptCount: 1 }, { connectorId: "sorftime", operation: "wrong", fetchedAt: "2026-09-12T06:00:00.000Z", attemptCount: 1 }, { connectorId: "sorftime", operation: "keyword_extends", fetchedAt: "2026-10-01T00:00:00.000Z", attemptCount: 1 }]) {
    const payload = page();
    const upstream = mock(payload, async () => ({ data: payload, source }) as ConnectorResult);
    const result = await collectMarketKeywordPage(pageInput(upstream.connector), now);
    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.deepEqual(result.rawPayload, payload);
  }
});

test("payload guard rejects getters/nonfinite data without invoking getters", async () => {
  let reads = 0;
  const unsafe = { doc: {} };
  Object.defineProperty(unsafe, "data", { enumerable: true, get() { reads++; return [row()]; } });
  for (const payload of [unsafe, page([{ ...row(), weekly_search_volume: NaN }])]) {
    const result = await collectMarketKeywordPage(pageInput(mock(payload).connector), now);
    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.equal(result.rawPayload, null);
  }
  assert.equal(reads, 0);
});

test("raw JSON that exceeds the evidence envelope depth is malformed, not an identity conflict", async () => {
  let diagnostic: unknown = null;
  for (let index = 0; index < 23; index++) diagnostic = { nested: diagnostic };
  const payload = { ...page(), diagnostic };
  const result = await collectMarketKeywordPage(pageInput(mock(payload).connector), now);
  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.failure.code, "malformed-response");
    assert.deepEqual(result.rawPayload, payload);
  }
});

test("evidence hashes actual canonical payload and remains detached/frozen", async () => {
  const payload = page();
  const result = await collectMarketKeywordPage(pageInput(mock(payload).connector), now);
  if (result.status === "failed") return assert.fail();
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)])) : value;
  assert.equal(result.evidence.payloadHash, createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex"));
  payload.data[0] = row("mutated");
  assert.equal((result.evidence.payload as { data: { keyword: string }[] }).data[0].keyword, "synthetic lamp");
  assert.ok(Object.isFrozen(result.evidence.payload));
});
