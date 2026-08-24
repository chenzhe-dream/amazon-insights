import assert from "node:assert/strict";
import test from "node:test";

import {
  createProviderDegradationTracker,
  providerDegradedDiagnostic,
} from "../../scripts/lib/provider-diagnostics.mjs";
import { diagnosticStatusesByAsin } from "../../scripts/run-asin-sync-job.mjs";

const firstAsin = "B0TEST0001";
const secondAsin = "B0TEST0002";

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
