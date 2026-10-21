import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { KeywordFetchStatusSection } from "../../app/keyword-fetch-status";

const asin = "B0C6FP6LMY";
const base = { asin, marketplace: "UK", fetchedAt: "2026-10-21", status: "empty", totalKeywordsInPeriod: 0,
  topKeywordsAnalyzed: 0, keywords: [], queryWindow: { time_type: "lately", time_value: "30", listingSearch: true } };
function render(record?: Record<string, unknown>) {
  return renderToStaticMarkup(createElement(KeywordFetchStatusSection, {
    products: [{ asin, brand: "Fixture" }], marketplace: "UK", syncRequest: null, syncResume: {} as never,
    onRequestSync: () => {}, keywordAnalysisByAsin: record ? { [asin]: record } as never : {} as never,
    keywordEnrichmentByKeyword: {} as never,
  }));
}

test("absent keyword record is uncollected, not verified empty", () => {
  const html = render();
  assert.match(html, /待拉取/);
  assert.doesNotMatch(html, /已核实无词/);
});

test("only a present valid-empty keyword record gets verified-empty wording", () => {
  assert.match(render({ ...base, terminalReason: "valid-empty" }), /已核实无词/);
  for (const record of [{ ...base }, { ...base, status: "error" },
    { ...base, terminalReason: "valid-empty", historicalAttempt: { outcome: "schema-error" } }]) {
    const html = render(record);
    assert.match(html, /待拉取/);
    assert.doesNotMatch(html, /已核实无词/);
  }
});

test("historical ready period retains its label", () => {
  const html = render({ ...base, status: "ready", keywords: [{ keyword: "steel tip darts" }],
    queryWindow: { time_type: "month", time_value: "2026-09-01", listingSearch: true } });
  assert.match(html, /历史词已就绪/);
});
