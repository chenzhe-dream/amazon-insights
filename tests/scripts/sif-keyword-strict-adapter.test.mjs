import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSifKeywordAnalysis } from "../../scripts/lib/sif-keyword-transform.mjs";

const asin = "B0D31VY644";
const marketplace = "US";
const fetchedAt = "2026-08-31";
const queryWindow = {
  time_type: "DAYS",
  time_value: "30",
  listingSearch: true,
};

function build(payload) {
  return buildSifKeywordAnalysis(asin, marketplace, payload, fetchedAt, queryWindow);
}

test("keeps a canonical nonempty keyword response ready", () => {
  const result = build({
    asin,
    marketplace,
    summary: { total_keywords_in_period: 1, top_keywords_analyzed: 1 },
    top_keywords: [{ keyword: "floor lamp", traffic_share: 0.42, search_volume: 1200 }],
  });

  assert.equal(result.status, "ready");
  assert.equal(result.keywords.length, 1);
  assert.equal(result.keywords[0].keyword, "floor lamp");
});

test("marks a strict-valid empty response as a valid empty result", () => {
  const result = build({ asin, marketplace, top_keywords: [] });

  assert.equal(result.status, "empty");
  assert.equal(result.terminalReason, "valid-empty");
  assert.deepEqual(result.keywords, []);
});

test("rejects a missing top_keywords field as schema-invalid", () => {
  const result = build({ asin, marketplace, data_notice: "not a keyword response" });

  assert.equal(result.status, "schema-error");
  assert.equal(result.terminalReason, "schema-invalid");
  assert.equal(result.errorCode, "SIF_KEYWORD_SCHEMA_INVALID");
  assert.deepEqual(result.keywords, []);
});

test("rejects a non-array top_keywords field as schema-invalid", () => {
  const result = build({ asin, marketplace, top_keywords: "floor lamp" });

  assert.equal(result.status, "schema-error");
  assert.equal(result.terminalReason, "schema-invalid");
});

test("rejects malformed keyword row field types as schema-invalid", () => {
  const result = build({
    asin,
    marketplace,
    top_keywords: [{ keyword: "floor lamp", search_volume: "1200" }],
  });

  assert.equal(result.status, "schema-error");
  assert.equal(result.terminalReason, "schema-invalid");
});

test("rejects an echoed ASIN mismatch as schema-invalid", () => {
  const result = build({ asin: "B000000000", marketplace, top_keywords: [] });

  assert.equal(result.status, "schema-error");
  assert.equal(result.terminalReason, "schema-invalid");
});

test("rejects an echoed marketplace mismatch as schema-invalid", () => {
  const result = build({ asin, marketplace: "UK", top_keywords: [] });

  assert.equal(result.status, "schema-error");
  assert.equal(result.terminalReason, "schema-invalid");
});

test("does not expose the raw response in runner-facing output", () => {
  const sentinel = "RAW_BODY_SENTINEL_DO_NOT_LEAK";
  const result = build({
    asin,
    marketplace,
    rawBody: sentinel,
    top_keywords: [{ keyword: "floor lamp", unexpected: sentinel }],
  });

  assert.equal(result.status, "ready");
  assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel));
});

test("recognizes the observed SIF no-data message without reporting zero total keywords", () => {
  const result = build({ message: "no data returned for this asin/period", data_notice: "Data updated daily" });
  assert.equal(result.status, "empty");
  assert.equal(result.totalKeywordsInPeriod, null);
  assert.deepEqual(result.keywords, []);
});

test("no-data text cannot hide conflicts, errors or malformed responses", () => {
  for (const extra of [{ isError: true }, { code: "DENIED" }, { error: "denied" },
    { top_keywords: "bad" }, { asin: "B000000000" }, { data_notice: {} }, { data: [] }]) {
    assert.equal(build({ message: "no data returned for this asin/period", ...extra }).status, "schema-error");
  }
  assert.equal(build({ message: "no data returned for this asin/period; retry" }).status, "schema-error");
});

test("SIF tool errors cannot become valid empty keyword responses", async () => {
  const { callSifTool } = await import('../../scripts/lib/sif-mcp-client.mjs');
  await assert.rejects(callSifTool('market_get_asin_keyword_signals', { asin, country: marketplace }, {
    env: { SIF_MCP_SECRET: 'fixture-secret', NODE_ENV: 'test' },
    fetchImpl: async () => new Response(JSON.stringify({ result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ message: 'no data returned for this asin/period' }) }] } })),
  }), error => error.kind === 'rpc');
});
