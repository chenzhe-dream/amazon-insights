import assert from "node:assert/strict";
import { test } from "node:test";

import { PROJECTABLE_SYNC_STAGE_IDS, projectStageOutput } from "../../scripts/lib/sync-stage-output.mjs";

test("partial projections retain ready data and an exact bounded gap", () => {
  const asin = "B0TEST0091";
  const projected = projectStageOutput("reviews", [asin], {
    stageStatus: "partial",
    gapReasonCode: "MCP_SCHEMA",
    readExport: (_file, name) => name === "sorftimeReviewAnalysisData"
      ? { [asin]: { status: "ready", themes: [] } }
      : { [asin]: { status: "ready", rating: 4.5 } },
    updatedAt: "2026-09-02T00:00:00.000Z",
  });

  assert.deepEqual(projected.data, {
    analysisByAsin: { [asin]: { status: "ready", themes: [] } },
    ratingByAsin: { [asin]: { status: "ready", rating: 4.5 } },
  });
  assert.deepEqual(projected.gap, { state: "partial", reasonCode: "MCP_SCHEMA" });
  assert.match(projected.contentHash, /^[a-f0-9]{64}$/);
});

test("partial projections retain only ready ASIN data and bounded per-ASIN diagnostic items", () => {
  const projected = projectStageOutput("reviews", ["B0TEST0094", "B0TEST0093", "B0TEST0092"], {
    stageStatus: "partial",
    dataAsins: ["B0TEST0092"],
    gapItems: [
      { asin: "B0TEST0093", causeCode: "MCP_SCHEMA", operation: "product_reviews", boundary: "tool-content", shape: { topLevelType: "object", data: { presence: "present", type: "array" } }, rawBody: "must not persist" },
      { asin: "B0TEST0093", causeCode: "MCP_SCHEMA", operation: "product_reviews", boundary: "tool-content" },
    ],
    readExport: (_file, name) => name === "sorftimeReviewAnalysisData"
      ? { B0TEST0092: { status: "ready" }, B0TEST0093: { status: "stale" }, B0TEST0094: { status: "stale" } }
      : { B0TEST0092: { status: "ready" }, B0TEST0093: { status: "stale" }, B0TEST0094: { status: "stale" } },
  });

  assert.deepEqual(Object.keys(projected.data.analysisByAsin), ["B0TEST0092"]);
  assert.deepEqual(projected.gap.items, [
    { asin: "B0TEST0093", causeCode: "MCP_SCHEMA", operation: "product_reviews", boundary: "tool-content",
      shape: {
        topLevelType: "object", data: { presence: "present", type: "array" },
        details: { presence: "unknown", type: "unknown" }, items: { presence: "unknown", type: "unknown" },
      },
    },
    { asin: "B0TEST0094", causeCode: "UPSTREAM_EMPTY" },
  ]);
  assert.doesNotMatch(JSON.stringify(projected.gap), /rawBody|must not persist/);
});

test("the projectable stage set includes child sales, price strategy, and image remarks", () => {
  assert.deepEqual(PROJECTABLE_SYNC_STAGE_IDS, [
    "keywords", "reviews", "sales_trend", "fba", "listing", "category", "traffic",
    "child_sales", "price_strategy", "image_remarks",
  ]);
});

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
    sorftimeChildSales30d: { [requested]: [{ asin: requested, sales: 10 }], B0OTHER003: [] },
    sorftimePriceStrategies: { [requested]: { anchor: "ready" }, B0OTHER003: { anchor: "other" } },
    listingImageRemarks: { [requested]: [{ remark: "ready" }], B0OTHER003: [{ remark: "other" }] },
    listingImageRemarksMeta: { imageOutcomesByAsin: { [requested]: [{ status: "ready" }], B0OTHER003: [{ status: "timeout" }] } },
  };
  const expectedKeys = {
    keywords: ["analysisByAsin", "enrichmentByKeyword"],
    reviews: ["analysisByAsin", "ratingByAsin"],
    sales_trend: ["trendByAsin"],
    fba: ["feeByAsin"],
    listing: ["contentByAsin"],
    category: ["trendByNode"],
    traffic: ["listingByAsin", "monthlyByAsin"],
    child_sales: ["rowsByAsin"],
    price_strategy: ["strategyByAsin"],
    image_remarks: ["remarksByAsin", "outcomesByAsin"],
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

test("traffic projection reads the real nested SIF overview shape without copying raw fields", () => {
  const asin = "B0TEST0008";
  const draft = projectStageOutput("traffic", [asin], {
    readExport: (_file, name) => name === "sifListingTrafficRawByAsin"
      ? {
        [asin]: {
          fetchedAt: "2026-09-03T09:00:00.000Z",
          overview: {
            total: 128266.49784446,
            overview: {
              nf: { score: 61017.2, ratio: 0.47571747 },
              ad: { score: 67249.3, ratio: 0.52428253 },
            },
            ad: {
              sp: { name: "provider SP", score: 30000.4, ratio: 0.45 },
              recommend: { name: "provider recommend", score: 20000.5, ratio: 0.3 },
              sb: { name: "provider SB", score: 10000.6, ratio: 0.15 },
              sbv: { name: "provider SBV", score: 7248.4, ratio: 0.1 },
              unknown: { name: "must not persist", score: 999999, ratio: 1 },
            },
            recommend: {
              seventh: { name: "Seventh", score: 10, ratio: 0.02 },
              third: { name: "Third", score: 30, ratio: 0.03 },
              belowThreshold: { name: "Below threshold", score: 999, ratio: 0.009 },
              first: { name: "First", score: 50, ratio: 0.05 },
              sixth: { name: "Sixth", score: 15, ratio: 0.02 },
              fourth: { name: "Fourth", score: 25, ratio: 0.025 },
              second: { name: "Second", score: 40, ratio: 0.04 },
              fifth: { name: "Fifth", score: 20, ratio: 0.02 },
              zeroScore: { name: "Zero", score: 0, ratio: 0.5 },
            },
            data_notice: "Data updated through 2026-09-02 (refreshes daily)",
          },
          structure: { chars: {
            dims: [
              { img: "https://example.invalid/one.jpg", features: ["Black", "Large"], sumScore: 141360.96935435, ratio: 47.571747577185825 / 100, val: "variant B0CHILD001" },
              null,
              { features: [], sumScore: 20.4, ratio: 0.2, val: "B0CHILD002" },
            ],
            nfs: [{ score: 100.4 }, { score: 9999 }, { score: 200.4 }],
            sps: [{ score: 10.4 }, { score: 9999 }, { score: 20.4 }],
            recs: [{ score: 11.4 }, { score: 9999 }, { score: 21.4 }],
            sbs: [{ score: 12.4 }, { score: 9999 }, { score: 22.4 }],
            sbvs: [{ score: 13.4 }, { score: 9999 }, { score: 23.4 }],
            unknownProviderVector: [{ score: 999999 }],
          } },
          providerBody: { shouldNotPersist: true },
        },
      }
      : { [asin]: { dates: ["2026-08"], nf: [{ score: 3 }], ad: [{ score: 2 }] } },
  });
  assert.deepEqual(draft.data.listingByAsin[asin], {
    fetchedAt: "2026-09-03T09:00:00.000Z",
    totalScore: 128266,
    naturalAd: [
      { label: "自然流量", score: 61017, ratio: 47.6 },
      { label: "广告流量", score: 67249, ratio: 52.4 },
    ],
    adChannels: [
      { label: "SP(常规)", score: 30000, ratio: 45 },
      { label: "SP(推荐)", score: 20001, ratio: 30 },
      { label: "SB(常规)", score: 10001, ratio: 15 },
      { label: "SBV", score: 7248, ratio: 10 },
    ],
    recommendationSources: [
      { label: "First", score: 50, ratio: 5 },
      { label: "Second", score: 40, ratio: 4 },
      { label: "Third", score: 30, ratio: 3 },
      { label: "Fourth", score: 25, ratio: 2.5 },
      { label: "Fifth", score: 20, ratio: 2 },
      { label: "Sixth", score: 15, ratio: 2 },
    ],
    children: [
      { asin: "B0CHILD001", label: "Black / Large", image: "https://example.invalid/one.jpg", totalScore: 141361, sharePct: 47.6, organic: 100, sp: 10, spRecommend: 11, sb: 12, sbv: 13 },
      { asin: "B0CHILD002", label: "默认", image: "", totalScore: 20, sharePct: 20, organic: 200, sp: 20, spRecommend: 21, sb: 22, sbv: 23 },
    ],
    updatedThrough: "2026-09-02",
  });
  assert.deepEqual(draft.data.monthlyByAsin[asin].points, [
    { month: "2026-08", natural: 3, advertising: 2, total: 5 },
  ]);
  assert.doesNotMatch(JSON.stringify(draft.data), /shouldNotPersist/);
  assert.doesNotMatch(JSON.stringify(draft.data), /must not persist|unknownProviderVector/);
  assert.equal(Math.round(128266.49784446), 128266);
  assert.equal(Math.round(141360.96935435), 141361);
  assert.equal(Math.round(0.47571747 * 1000) / 10, 47.6);
  assert.equal(Math.round(47.571747577185825 * 10) / 10, 47.6);
});

test("traffic projection omits unavailable detail arrays but preserves authoritative empty arrays", () => {
  const missing = projectStageOutput("traffic", ["B0TEST0010"], {
    readExport: (_file, name) => name === "sifListingTrafficRawByAsin"
      ? { B0TEST0010: { overview: { total: 7, overview: { nf: { score: 5 }, ad: { score: 2 } } } } }
      : {},
  });
  assert.deepEqual(missing.data.listingByAsin.B0TEST0010, {
    totalScore: 7,
    naturalAd: [
      { label: "自然流量", score: 5, ratio: 0 },
      { label: "广告流量", score: 2, ratio: 0 },
    ],
    updatedThrough: null,
  });

  const empty = projectStageOutput("traffic", ["B0TEST0011"], {
    readExport: (_file, name) => name === "sifListingTrafficRawByAsin"
      ? { B0TEST0011: { overview: { total: 0, overview: {}, ad: {}, recommend: {} }, structure: { chars: { dims: [] } } } }
      : {},
  });
  assert.deepEqual(empty.data.listingByAsin.B0TEST0011, {
    totalScore: 0,
    naturalAd: [
      { label: "自然流量", score: 0, ratio: 0 },
      { label: "广告流量", score: 0, ratio: 0 },
    ],
    adChannels: [], recommendationSources: [], children: [], updatedThrough: null,
  });
});

test("traffic projection ignores malformed structure instead of inventing child detail", () => {
  for (const structure of [undefined, null, [], { chars: null }, { chars: { dims: "not-an-array" } }]) {
    const draft = projectStageOutput("traffic", ["B0TEST0012"], {
      readExport: (_file, name) => name === "sifListingTrafficRawByAsin"
        ? { B0TEST0012: { overview: { overview: {} }, structure } }
        : {},
    });
    assert.equal(Object.hasOwn(draft.data.listingByAsin.B0TEST0012, "children"), false);
  }
});

test("traffic projection rejects object-shaped children without an ASIN and retains source indices without mutation", () => {
  const asin = "B0TEST0013";
  const raw = {
    overview: { overview: {} },
    structure: { chars: {
      dims: [{}, { val: null }, { val: "variant B0VALID001", features: ["Valid"] }],
      nfs: [{ score: 901 }, { score: 902 }, { score: 103 }],
      sps: [{ score: 911 }, { score: 912 }, { score: 113 }],
      recs: [{ score: 921 }, { score: 922 }, { score: 123 }],
      sbs: [{ score: 931 }, { score: 932 }, { score: 133 }],
      sbvs: [{ score: 941 }, { score: 942 }, { score: 143 }],
    } },
  };
  const original = structuredClone(raw);
  const draft = projectStageOutput("traffic", [asin], {
    readExport: (_file, name) => name === "sifListingTrafficRawByAsin" ? { [asin]: raw } : {},
  });

  assert.deepEqual(draft.data.listingByAsin[asin].children, [{
    asin: "B0VALID001", label: "Valid", image: "", totalScore: 0, sharePct: 0,
    organic: 103, sp: 113, spRecommend: 123, sb: 133, sbv: 143,
  }]);
  assert.deepEqual(raw, original);
});

test("traffic accepts only the explicitly whitelisted legacy normalized overview fallback", () => {
  const asin = "B0TEST0009";
  const draft = projectStageOutput("traffic", [asin], {
    readExport: (_file, name) => name === "sifListingTrafficRawByAsin"
      ? { [asin]: { overview: { total: { score: 7 }, nf: { score: 5 }, ad: { score: 2 } } } }
      : { [asin]: { dates: [] } },
  });
  assert.deepEqual(draft.data.listingByAsin[asin], { total: 7, natural: 5, advertising: 2 });
});
