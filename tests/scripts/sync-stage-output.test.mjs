import assert from "node:assert/strict";
import { test } from "node:test";

import { projectStageOutput } from "../../scripts/lib/sync-stage-output.mjs";

test("projectStageOutput hashes only the fixed sales projection", () => {
  const draft = projectStageOutput("sales_trend", ["B0TEST0001"], {
    readExport: (_file, name) => name === "sorftimeSalesTrendData"
      ? {
        B0TEST0001: { status: "ready", volume: [] },
        B0OTHER001: { status: "ready" },
      }
      : {},
    now: () => "2026-08-25T09:00:00.000Z",
  });

  assert.deepEqual(Object.keys(draft.data.trendByAsin), ["B0TEST0001"]);
  assert.match(draft.contentHash, /^[a-f0-9]{64}$/);
});

test("projectStageOutput uses canonical object keys and a fixed terminal gap", () => {
  const options = {
    now: () => "2026-08-25T09:00:00.000Z",
    readExport: () => ({
      B0TEST0002: { nested: { z: 1, a: 2 }, status: "ready" },
      B0OTHER002: { status: "ready" },
    }),
  };
  const first = projectStageOutput("sales_trend", ["B0TEST0002"], options);
  const second = projectStageOutput("sales_trend", ["B0TEST0002"], {
    ...options,
    readExport: () => ({
      B0OTHER002: { status: "ready" },
      B0TEST0002: { status: "ready", nested: { a: 2, z: 1 } },
    }),
  });

  assert.equal(first.contentHash, second.contentHash);
  assert.deepEqual(Object.keys(first.data.trendByAsin), ["B0TEST0002"]);
});

test("projectStageOutput emits only the fixed schema branches for every done stage", () => {
  const requested = "B0TEST0003";
  const exports = {
    sifKeywordAnalysisData: {
      [requested]: { keywords: [{ keyword: "alpha" }], status: "ready" },
      B0OTHER003: { keywords: [{ keyword: "beta" }], status: "ready" },
    },
    sifKeywordEnrichmentData: { alpha: { status: "ready" }, beta: { status: "ready" } },
    sorftimeReviewAnalysisData: { [requested]: { status: "ready" }, B0OTHER003: { status: "ready" } },
    sorftimeRatingData: { [requested]: { status: "ready" }, B0OTHER003: { status: "ready" } },
    sorftimeSalesTrendData: { [requested]: { status: "ready" }, B0OTHER003: { status: "ready" } },
    sorftimeFbaFeeData: { [requested]: { status: "ready" }, B0OTHER003: { status: "ready" } },
    sorftimeListingContentData: { [requested]: { status: "ready" }, B0OTHER003: { status: "ready" } },
    sorftimeCategoryTrendData: {
      nodeB: { nodeId: "nodeB", asins: ["B0OTHER003", requested], status: "ready" },
    },
    sifListingTrafficRawByAsin: { [requested]: { overview: {}, providerBody: { secret: "must-not-project" } }, B0OTHER003: { overview: {} } },
    sifMonthlyTrafficRawByAsin: { [requested]: { dates: [] }, B0OTHER003: { dates: [] } },
  };
  const expectedKeys = {
    keywords: ["analysisByAsin", "enrichmentByKeyword"],
    reviews: ["analysisByAsin", "ratingByAsin"],
    sales_trend: ["trendByAsin"],
    fba: ["feeByAsin"],
    listing: ["contentByAsin"],
    category: ["trendByNode"],
    traffic: ["listingByAsin", "monthlyByAsin"],
  };
  for (const [stage, keys] of Object.entries(expectedKeys)) {
    const draft = projectStageOutput(stage, [requested], {
      readExport: (_file, name) => exports[name],
      updatedAt: "2026-08-25T09:00:00.000Z",
    });
    assert.deepEqual(Object.keys(draft.data), keys);
    assert.doesNotMatch(JSON.stringify(draft.data), /B0OTHER003/);
    if (stage === "category") assert.deepEqual(Object.keys(draft.data.trendByNode), ["nodeB"]);
    else assert.match(JSON.stringify(draft.data), new RegExp(requested));
    if (stage === "traffic") assert.doesNotMatch(JSON.stringify(draft.data), /must-not-project/);
  }
});

test("category hash is independent of node and object insertion order", () => {
  const requested = "B0TEST0004";
  const first = projectStageOutput("category", [requested], {
    readExport: () => ({ nodeB: { z: 1, nodeId: "nodeB", asins: [requested] }, nodeA: { nodeId: "nodeA", a: 2, asins: [requested] } }),
  });
  const second = projectStageOutput("category", [requested], {
    readExport: () => ({ nodeA: { asins: [requested], a: 2, nodeId: "nodeA" }, nodeB: { asins: [requested], nodeId: "nodeB", z: 1 } }),
  });
  assert.equal(first.contentHash, second.contentHash);
  assert.deepEqual(Object.keys(first.data), ["trendByNode"]);
});
