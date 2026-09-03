import assert from "node:assert/strict";
import test from "node:test";

import { diagnosticsForInvocation } from "../../scripts/run-asin-sync-job.mjs";

const currentAsins = ["B0SCOPE001", "B0SCOPE002"];

test("diagnosticsForInvocation keeps only the exact connector stage and requested ASINs", () => {
  const matchingProviderFailure = {
    connector: "sorftime",
    stage: "listing",
    asin: currentAsins[0],
    failureKind: "connection",
    causeCode: "CONNECTION_RESET",
  };
  const matchingSchemaFailure = {
    connector: "sorftime",
    stage: "listing",
    asin: currentAsins[1],
    failureKind: "schema",
    causeCode: "MCP_SCHEMA",
  };

  assert.deepEqual(diagnosticsForInvocation([
    matchingProviderFailure,
    { ...matchingProviderFailure, connector: "sellerSprite" },
    { ...matchingProviderFailure, stage: "reviews" },
    { ...matchingProviderFailure, asin: "B0HIST0001" },
    matchingSchemaFailure,
  ], {
    connector: "sorftime",
    stage: "listing",
    asins: currentAsins,
  }), [matchingProviderFailure, matchingSchemaFailure]);
});
