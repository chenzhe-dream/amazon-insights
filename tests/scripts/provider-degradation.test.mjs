import assert from "node:assert/strict";
import test from "node:test";

import {
  createProviderDegradationTracker,
  providerDegradedDiagnostic,
} from "../../scripts/lib/provider-diagnostics.mjs";
import {
  diagnosticStatusesByAsin,
  providerDispatchPlan,
} from "../../scripts/run-asin-sync-job.mjs";

const firstAsin = "B0TEST0001";
const secondAsin = "B0TEST0002";
const connectorStages = [
  { connector: "sif", firstStage: "keywords", nextStage: "traffic" },
  { connector: "sorftime", firstStage: "reviews", nextStage: "sales_trend" },
  // SellerSprite has one production stage, so its independent second ASIN is its later dispatch.
  { connector: "sellerSprite", firstStage: "catalog", nextStage: "catalog" },
];
const providerWideFailures = [
  { label: "dns", failureKind: "dns", causeCode: "DNS_NOT_FOUND" },
  { label: "tls", failureKind: "tls", causeCode: "TLS_CERTIFICATE" },
  { label: "proxy", failureKind: "proxy", causeCode: "PROXY_CONNECT" },
  { label: "connection", failureKind: "connection", causeCode: "CONNECTION_REFUSED" },
  { label: "timeout", failureKind: "timeout", causeCode: "CONNECT_TIMEOUT" },
  { label: "http", failureKind: "http", causeCode: "HTTP_5XX" },
  { label: "rpc", failureKind: "rpc", causeCode: "MCP_RPC" },
  // Auth/quota arrive through the existing safe HTTP contract, not new diagnostic kinds.
  { label: "auth", failureKind: "http", causeCode: "HTTP_4XX" },
  { label: "quota", failureKind: "http", causeCode: "HTTP_5XX" },
];

test("local request admission failure does not disable later provider stages", () => {
  const tracker = createProviderDegradationTracker({ threshold: 1 });
  tracker.record({ connector: "sorftime", stage: "sales_trend", asin: firstAsin,
    failureKind: "governor", causeCode: "RESOURCE_GOVERNOR" });
  assert.equal(tracker.isDegraded("sorftime"), false);
  assert.deepEqual(tracker.snapshot(), []);
});

test("structured provider diagnostics map transport and timeout failures without upstream-empty", () => {
  assert.deepEqual(diagnosticStatusesByAsin([firstAsin, secondAsin], [
    {
      connector: "sif",
      stage: "keywords",
      asin: firstAsin,
      failureKind: "dns",
      causeCode: "DNS_NOT_FOUND",
    },
    {
      connector: "sif",
      stage: "keywords",
      asin: secondAsin,
      failureKind: "timeout",
      causeCode: "CONNECT_TIMEOUT",
    },
  ]), {
    [firstAsin]: "connector-failed",
    [secondAsin]: "timeout",
  });
});

test("first connector failure degrades only that connector and emits bounded skip diagnostics", () => {
  const tracker = createProviderDegradationTracker({ threshold: 1 });
  tracker.record({
    connector: "sif",
    stage: "keywords",
    asin: firstAsin,
    failureKind: "dns",
    causeCode: "DNS_NOT_FOUND",
  });

  assert.equal(tracker.isDegraded("sif"), true);
  assert.equal(tracker.isDegraded("sorftime"), false);
  assert.equal(tracker.isDegraded("sellerSprite"), false);
  assert.deepEqual(tracker.skipDiagnostics("sif", "traffic", [firstAsin, secondAsin]), [
    providerDegradedDiagnostic({ connector: "sif", stage: "traffic", asin: firstAsin }),
    providerDegradedDiagnostic({ connector: "sif", stage: "traffic", asin: secondAsin }),
  ]);
  assert.deepEqual(tracker.snapshot(), [{
    connector: "sif",
    failureKind: "dns",
    causeCode: "DNS_NOT_FOUND",
  }]);
});

test("a degraded connector may run only an explicitly local scoped-evidence fallback", () => {
  assert.deepEqual(providerDispatchPlan({
    connectorDegraded: true,
    allowScopedEvidenceFallback: false,
    env: { SORFTIME_ASINS: firstAsin },
  }), {
    skip: true,
    env: { SORFTIME_ASINS: firstAsin },
  });
  assert.deepEqual(providerDispatchPlan({
    connectorDegraded: true,
    allowScopedEvidenceFallback: true,
    env: { SORFTIME_ASINS: firstAsin },
  }), {
    skip: false,
    env: {
      SORFTIME_ASINS: firstAsin,
      SORFTIME_SCOPED_EVIDENCE_ONLY: "1",
    },
  });
});

test("one ASIN schema failure stays local while provider-wide failures still open the connector breaker", () => {
  const tracker = createProviderDegradationTracker({ threshold: 1 });
  tracker.record({
    connector: "sorftime",
    stage: "reviews",
    asin: firstAsin,
    failureKind: "schema",
    causeCode: "MCP_SCHEMA",
  });

  assert.equal(tracker.isDegraded("sorftime"), false);
  assert.deepEqual(tracker.skipDiagnostics("sorftime", "sales_trend", [secondAsin]), []);
  assert.deepEqual(tracker.snapshot(), []);

  tracker.record({
    connector: "sorftime",
    stage: "sales_trend",
    asin: secondAsin,
    failureKind: "connection",
    causeCode: "CONNECTION_RESET",
  });

  assert.equal(tracker.isDegraded("sorftime"), true);
  assert.deepEqual(tracker.snapshot(), [{
    connector: "sorftime",
    failureKind: "connection",
    causeCode: "CONNECTION_RESET",
  }]);
});

test("the same schema-local breaker policy applies to SellerSprite", () => {
  const tracker = createProviderDegradationTracker({ threshold: 1 });
  tracker.record({
    connector: "sellerSprite",
    stage: "catalog",
    asin: firstAsin,
    failureKind: "schema",
    causeCode: "MCP_SCHEMA",
  });

  assert.equal(tracker.isDegraded("sellerSprite"), false);
  assert.deepEqual(tracker.skipDiagnostics("sellerSprite", "listing", [secondAsin]), []);
});

for (const { connector, firstStage, nextStage } of connectorStages) {
  test(`${connector} keeps MCP_SCHEMA local to the failed ASIN and stage`, () => {
    const tracker = createProviderDegradationTracker({ threshold: 1 });
    tracker.record({
      connector,
      stage: firstStage,
      asin: firstAsin,
      failureKind: "schema",
      causeCode: "MCP_SCHEMA",
    });

    assert.equal(tracker.isDegraded(connector), false);
    assert.deepEqual(tracker.snapshot(), []);
    assert.deepEqual(tracker.skipDiagnostics(connector, nextStage, [secondAsin]), []);
  });
}

for (const { connector, firstStage, nextStage } of connectorStages) {
  for (const { label, failureKind, causeCode } of providerWideFailures) {
    test(`${connector} ${label} failure skips later dispatch with the fixed safe reason`, () => {
      const tracker = createProviderDegradationTracker({ threshold: 1 });
      tracker.record({ connector, stage: firstStage, asin: firstAsin, failureKind, causeCode });

      assert.equal(tracker.isDegraded(connector), true);
      assert.deepEqual(tracker.skipDiagnostics(connector, nextStage, [secondAsin]), [
        providerDegradedDiagnostic({ connector, stage: nextStage, asin: secondAsin }),
      ]);
      assert.deepEqual(tracker.snapshot(), [{ connector, failureKind, causeCode }]);
    });
  }
}
