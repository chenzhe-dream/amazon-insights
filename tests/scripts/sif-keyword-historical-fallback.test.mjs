import assert from "node:assert/strict";
import { test } from "node:test";

import { collectSifKeywordWithPreviousMonth } from "../../scripts/lib/sif-keyword-historical-fallback.mjs";
import { matchesKeywordQueryWindow, previousCompleteMonthWindow } from "../../scripts/lib/sif-keyword-sync-config.mjs";

const asin = "B0C6FP6LMY";
const current = { asin, marketplace: "UK", top_keywords: [] };
const historical = { asin, marketplace: "UK", top_keywords: [{ keyword: "steel tip darts", search_volume: 120 }] };

test("previous complete UTC month rolls back over January", () => {
  assert.deepEqual(previousCompleteMonthWindow(new Date("2027-01-01T00:00:00Z")), {
    time_type: "month", time_value: "2026-12-01", listingSearch: true,
  });
});

test("explicit UK fallback queries only current 30 days then previous complete month", async () => {
  const calls = [];
  const record = await collectSifKeywordWithPreviousMonth({ asin, marketplace: "UK", fetchedAt: "2026-10-21",
    now: new Date("2026-10-21T00:00:00Z"), enabled: true,
    call: async (_name, args) => { calls.push(args); return calls.length === 1 ? current : historical; },
  });
  assert.deepEqual(calls.map(({ time_type, time_value, listingSearch }) => ({ time_type, time_value, listingSearch })), [
    { time_type: "lately", time_value: "30", listingSearch: true },
    { time_type: "month", time_value: "2026-09-01", listingSearch: true },
  ]);
  assert.equal(record.status, "ready");
  assert.equal(record.keywords[0].keyword, "steel tip darts");
  assert.deepEqual(record.queryWindow, calls[1] && { time_type: "month", time_value: "2026-09-01", listingSearch: true });
  assert.equal(record.currentEmpty?.terminalReason, "valid-empty");
  assert.equal(record.currentEmpty?.queryWindow.time_type, "lately");
  assert.equal(matchesKeywordQueryWindow(record, { enabled: true, now: new Date("2026-10-21T00:00:00Z") }), true);
  assert.equal(matchesKeywordQueryWindow(record, { enabled: false, now: new Date("2026-10-21T00:00:00Z") }), false);
  assert.equal(matchesKeywordQueryWindow(record, { enabled: true, now: new Date("2026-11-01T00:00:00Z") }), false);
  assert.equal(matchesKeywordQueryWindow(record, { enabled: true, now: new Date("2026-10-21T00:00:00Z"), marketplace: "DE" }), false);
});

test("disabled fallback and verified historical empty preserve current empty observation", async () => {
  for (const enabled of [false, true]) {
    const calls = [];
    const record = await collectSifKeywordWithPreviousMonth({ asin, marketplace: "UK", fetchedAt: "2026-10-21",
      now: new Date("2026-10-21T00:00:00Z"), enabled,
      call: async (_name, args) => { calls.push(args); return current; },
    });
    assert.equal(calls.length, enabled ? 2 : 1);
    assert.equal(record.status, "empty");
    assert.deepEqual(record.queryWindow, { time_type: "lately", time_value: "30", listingSearch: true });
    assert.deepEqual(record.keywords, []);
    if (enabled) assert.deepEqual(record.historicalEmpty?.queryWindow, { time_type: "month", time_value: "2026-09-01", listingSearch: true });
  }
});

test("transport and schema failures never trigger historical query", async () => {
  for (const first of [new Error("quota"), { asin, marketplace: "DE", top_keywords: [] }, { asin, marketplace: "UK", top_keywords: "bad" }]) {
    let count = 0;
    const run = collectSifKeywordWithPreviousMonth({ asin, marketplace: "UK", fetchedAt: "2026-10-21",
      now: new Date("2026-10-21T00:00:00Z"), enabled: true,
      call: async () => { count++; if (first instanceof Error) throw first; return first; },
    });
    if (first instanceof Error) await assert.rejects(run, /quota/);
    else assert.equal((await run).status, "schema-error");
    assert.equal(count, 1);
  }
});
