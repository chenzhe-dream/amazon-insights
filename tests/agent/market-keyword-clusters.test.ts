import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateKeywordClusters,
  type KeywordClusterMapping,
  type KeywordRecord,
} from "../../server/domain/market-research/keyword-clusters";

const keyword = (id: string, values: Partial<KeywordRecord> = {}): KeywordRecord => ({
  id, text: `keyword ${id}`, searchVolume: 100, cpc: null,
  yoyGrowth: null, recentGrowth: null, ...values,
});
const mapping = (keywordId: string, clusterId = "shelf"): KeywordClusterMapping => ({ keywordId, clusterId });
const near = (actual: number | null, expected: number) => {
  assert.notEqual(actual, null);
  assert.ok(Math.abs(actual! - expected) < 1e-12, `${actual} differs from ${expected}`);
};

test("CPC and each growth field use their own available positive-volume members", () => {
  const result = aggregateKeywordClusters({ keywords: [
    keyword("a", { searchVolume: 100, cpc: 1, yoyGrowth: 0.2 }),
    keyword("b", { searchVolume: 300, cpc: 3, recentGrowth: 0.4 }),
    keyword("c", { searchVolume: 500, yoyGrowth: -0.1, recentGrowth: 0 }),
    keyword("d", { searchVolume: 0, cpc: 0, yoyGrowth: -1, recentGrowth: 0.8 }),
  ], mappings: ["a", "b", "c", "d"].map(id => mapping(id)) });
  const cluster = result.clusters[0];
  assert.equal(cluster.totalSearchVolume, 900);
  assert.equal(cluster.knownSearchVolume, 900);
  assert.equal(cluster.knownSearchVolumeCount, 4);
  assert.equal(cluster.unknownSearchVolumeCount, 0);
  assert.equal(cluster.searchVolumeSharePercent, 100);
  assert.equal(cluster.searchVolumeShareDenominator, 900);
  assert.deepEqual(cluster.cpc, {
    value: 2.5, weightSum: 400, weightedMemberCount: 2,
    knownValueCount: 3, unknownValueCount: 1,
  });
  near(cluster.yoyGrowth.value, -0.05);
  assert.equal(cluster.yoyGrowth.weightSum, 600);
  assert.equal(cluster.yoyGrowth.weightedMemberCount, 2);
  assert.equal(cluster.yoyGrowth.knownValueCount, 3);
  assert.equal(cluster.yoyGrowth.unknownValueCount, 1);
  near(cluster.recentGrowth.value, 0.15);
  assert.equal(cluster.recentGrowth.weightSum, 800);
  assert.equal(cluster.recentGrowth.weightedMemberCount, 2);
  assert.equal(cluster.recentGrowth.knownValueCount, 3);
  assert.equal(cluster.recentGrowth.unknownValueCount, 1);
});

test("cluster shares retain the entire pool including unassigned keywords", () => {
  const result = aggregateKeywordClusters({ keywords: [
    keyword("a", { searchVolume: 100 }), keyword("b", { searchVolume: 300 }),
    keyword("c", { searchVolume: 600 }),
  ], mappings: [mapping("a", "small"), mapping("b", "large")] });
  assert.equal(result.pool.totalSearchVolume, 1000);
  assert.deepEqual(result.pool.memberIds, ["a", "b", "c"]);
  assert.deepEqual(result.clusters.map(c => [c.clusterId, c.searchVolumeSharePercent]), [["large", 30], ["small", 10]]);
  assert.deepEqual(result.unassigned.memberIds, ["c"]);
  assert.equal(result.unassigned.clusterId, null);
  assert.equal(result.unassigned.searchVolumeSharePercent, 60);
  assert.equal(result.unassigned.searchVolumeShareDenominator, 1000);
});

test("merging clusters recalculates from original members rather than averaging prior means", () => {
  const keywords = [
    keyword("a", { searchVolume: 100, cpc: 1, yoyGrowth: 1 }),
    keyword("b", { searchVolume: 900, cpc: 3, recentGrowth: -1 }),
    keyword("c", { searchVolume: 1000, cpc: 9, yoyGrowth: 0, recentGrowth: 1 }),
  ];
  const split = aggregateKeywordClusters({ keywords, mappings: [mapping("a", "x"), mapping("b", "y")] });
  assert.deepEqual(split.clusters.map(c => c.cpc.value), [1, 3]);
  const merged = aggregateKeywordClusters({ keywords, mappings: [mapping("a", "x"), mapping("b", "x")] });
  near(merged.clusters[0].cpc.value, 2.8);
  assert.equal(merged.clusters[0].yoyGrowth.value, 1);
  assert.equal(merged.clusters[0].yoyGrowth.weightSum, 100);
  assert.equal(merged.clusters[0].recentGrowth.value, -1);
  assert.equal(merged.clusters[0].recentGrowth.weightSum, 900);
  assert.equal(merged.clusters[0].searchVolumeSharePercent, 50);
  assert.deepEqual(merged.unassigned.memberIds, ["c"]);
});

test("input and mapping order do not change aggregates or mutate caller-owned input", () => {
  const keywords = Object.freeze([
    Object.freeze(keyword("z", { searchVolume: 0.3, cpc: 0.7 })),
    Object.freeze(keyword("a", { searchVolume: 0.2, cpc: 2.5 })),
    Object.freeze(keyword("A", { searchVolume: 0.1, cpc: 1 })),
    Object.freeze(keyword("b", { searchVolume: 0.4, cpc: 8 })),
  ]);
  const mappings = Object.freeze([
    Object.freeze(mapping("a", "a")), Object.freeze(mapping("A", "Z")),
    Object.freeze(mapping("z", "a")),
  ]);
  const result = aggregateKeywordClusters({ keywords, mappings });
  assert.deepEqual(aggregateKeywordClusters({ keywords: [...keywords].reverse(), mappings: [...mappings].reverse() }), result);
  assert.deepEqual(result.pool.memberIds, ["A", "a", "b", "z"]);
  assert.deepEqual(result.clusters.map(c => c.clusterId), ["Z", "a"]);
  assert.deepEqual(result.clusters[1].memberIds, ["a", "z"]);
  assert.deepEqual(keywords.map(k => k.id), ["z", "a", "A", "b"]);
});

test("unknown volume makes its group and pool total unknown without discarding known sums", () => {
  const result = aggregateKeywordClusters({ keywords: [
    keyword("a", { searchVolume: 100, cpc: 0, yoyGrowth: 0 }),
    keyword("b", { searchVolume: null, cpc: 8, yoyGrowth: 1, recentGrowth: 2 }),
    keyword("c", { searchVolume: 200, cpc: 4 }),
  ], mappings: [mapping("a"), mapping("b"), mapping("c", "other")] });
  assert.equal(result.pool.totalSearchVolume, null);
  assert.equal(result.pool.knownSearchVolume, 300);
  assert.equal(result.pool.unknownSearchVolumeCount, 1);
  const cluster = result.clusters.find(c => c.clusterId === "shelf")!;
  assert.equal(cluster.totalSearchVolume, null);
  assert.equal(cluster.knownSearchVolume, 100);
  assert.equal(cluster.searchVolumeSharePercent, null);
  assert.equal(cluster.searchVolumeShareDenominator, null);
  assert.deepEqual(cluster.cpc, { value: 0, weightSum: 100, weightedMemberCount: 1, knownValueCount: 2, unknownValueCount: 0 });
  assert.equal(cluster.yoyGrowth.value, 0);
  assert.equal(cluster.recentGrowth.value, null);
  assert.equal(cluster.recentGrowth.knownValueCount, 1);
  assert.equal(cluster.recentGrowth.weightedMemberCount, 0);
  assert.equal(result.clusters.find(c => c.clusterId === "other")!.totalSearchVolume, 200);
  assert.ok(result.clusters.every(c => c.searchVolumeSharePercent === null));
});

test("zero volume and unknown values remain different, with no fabricated weighted values", () => {
  const result = aggregateKeywordClusters({ keywords: [keyword("a", { searchVolume: 0, cpc: 0, yoyGrowth: -1 })], mappings: [] });
  assert.equal(result.pool.totalSearchVolume, 0);
  assert.equal(result.pool.knownSearchVolumeCount, 1);
  assert.equal(result.pool.unknownSearchVolumeCount, 0);
  assert.equal(result.unassigned.searchVolumeSharePercent, null);
  assert.equal(result.unassigned.searchVolumeShareDenominator, 0);
  assert.deepEqual(result.unassigned.cpc, { value: null, weightSum: 0, weightedMemberCount: 0, knownValueCount: 1, unknownValueCount: 0 });
  assert.deepEqual(result.unassigned.recentGrowth, { value: null, weightSum: 0, weightedMemberCount: 0, knownValueCount: 0, unknownValueCount: 1 });
});

test("an empty pool and an all-unknown pool have explicit, distinct counts", () => {
  const empty = aggregateKeywordClusters({ keywords: [], mappings: [] });
  assert.equal(empty.pool.memberCount, 0);
  assert.equal(empty.pool.totalSearchVolume, 0);
  assert.deepEqual(empty.clusters, []);
  assert.deepEqual(empty.unassigned.memberIds, []);
  assert.equal(empty.unassigned.searchVolumeSharePercent, null);
  const unknown = aggregateKeywordClusters({ keywords: [keyword("a", { searchVolume: null })], mappings: [] });
  assert.equal(unknown.pool.totalSearchVolume, null);
  assert.equal(unknown.pool.knownSearchVolume, 0);
  assert.equal(unknown.pool.knownSearchVolumeCount, 0);
  assert.equal(unknown.pool.unknownSearchVolumeCount, 1);
});

test("unmapped words stay unassigned even when their text is the same as a mapped member", () => {
  const result = aggregateKeywordClusters({ keywords: [keyword("a", { text: "shelf lamp" }), keyword("b", { text: "shelf lamp" })], mappings: [mapping("a")] });
  assert.deepEqual(result.clusters[0].memberIds, ["a"]);
  assert.deepEqual(result.unassigned.memberIds, ["b"]);
  assert.equal(result.unassigned.searchVolumeSharePercent, 50);
});

test("duplicate members and unknown, repeated or multiple assignments are rejected", () => {
  assert.throws(() => aggregateKeywordClusters({ keywords: [keyword("a"), keyword("a")], mappings: [] }), /duplicate keyword/i);
  assert.throws(() => aggregateKeywordClusters({ keywords: [keyword("a")], mappings: [mapping("missing")] }), /unknown keyword/i);
  assert.throws(() => aggregateKeywordClusters({ keywords: [keyword("a")], mappings: [mapping("a"), mapping("a")] }), /duplicate mapping/i);
  assert.throws(() => aggregateKeywordClusters({ keywords: [keyword("a")], mappings: [mapping("a", "one"), mapping("a", "two")] }), /duplicate mapping/i);
});

test("numeric fields reject invalid types, non-finite numbers, and out-of-domain values", () => {
  for (const field of ["searchVolume", "cpc", "yoyGrowth", "recentGrowth"] as const) {
    for (const value of [NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, "2", undefined]) {
      assert.throws(() => aggregateKeywordClusters({ keywords: [keyword("a", { [field]: value } as Partial<KeywordRecord>)], mappings: [] }), new RegExp(field));
    }
  }
  for (const field of ["searchVolume", "cpc"] as const) {
    assert.throws(() => aggregateKeywordClusters({ keywords: [keyword("a", { [field]: -0.01 })], mappings: [] }), new RegExp(field));
  }
  for (const field of ["yoyGrowth", "recentGrowth"] as const) {
    assert.throws(() => aggregateKeywordClusters({ keywords: [keyword("a", { [field]: -1.01 })], mappings: [] }), new RegExp(field));
  }
});

test("invalid identity and empty text cannot silently become an aggregate member or cluster", () => {
  for (const value of ["", " ", " a "]) {
    assert.throws(() => aggregateKeywordClusters({ keywords: [keyword(value)], mappings: [] }), /id/i);
    assert.throws(() => aggregateKeywordClusters({ keywords: [keyword("a")], mappings: [mapping("a", value)] }), /clusterId/i);
  }
  assert.throws(() => aggregateKeywordClusters({ keywords: [keyword("a", { text: "  " })], mappings: [] }), /text/i);
});

test("unsafe totals fail and safe high weighted values do not overflow an intermediate product", () => {
  assert.throws(() => aggregateKeywordClusters({ keywords: [keyword("a", { searchVolume: Number.MAX_SAFE_INTEGER }), keyword("b", { searchVolume: 1 })], mappings: [] }), /safe numeric range/i);
  assert.throws(() => aggregateKeywordClusters({ keywords: [keyword("a", { searchVolume: Number.MAX_SAFE_INTEGER }), keyword("b", { searchVolume: 0.1 })], mappings: [] }), /safe numeric range/i);
  const result = aggregateKeywordClusters({ keywords: [keyword("a", { searchVolume: 2, cpc: Number.MAX_SAFE_INTEGER })], mappings: [mapping("a")] });
  assert.equal(result.clusters[0].cpc.value, Number.MAX_SAFE_INTEGER);
});

test("valid -100% growth stays at its boundary after many-member aggregation", () => {
  const keywords = Array.from({ length: 9 }, (_, index) => keyword(`k${index}`, { searchVolume: 100, yoyGrowth: -1, recentGrowth: -1 }));
  const result = aggregateKeywordClusters({ keywords, mappings: keywords.map(k => mapping(k.id)) });
  assert.equal(result.clusters[0].yoyGrowth.value, -1);
  assert.equal(result.clusters[0].recentGrowth.value, -1);
  assert.equal(result.clusters[0].yoyGrowth.weightSum, 900);
});

for (const scenario of [
  { label: "half-unit value", firstWeight: 1, secondWeight: Number.MAX_SAFE_INTEGER - 1, secondValue: 0.5, expected: 1.5 },
  { label: "tenth-unit value", firstWeight: 1, secondWeight: Number.MAX_SAFE_INTEGER - 1, secondValue: 0.1, expected: 1.1 },
  { label: "tiny first weight", firstWeight: 1e-16, secondWeight: 1, secondValue: 0.1, expected: 1.000719925474099 },
]) {
  test(`extreme finite weights preserve small contributions: ${scenario.label}`, () => {
    const result = aggregateKeywordClusters({ keywords: [
      keyword("a", { searchVolume: scenario.firstWeight, cpc: Number.MAX_SAFE_INTEGER, yoyGrowth: Number.MAX_SAFE_INTEGER, recentGrowth: Number.MAX_SAFE_INTEGER }),
      keyword("b", { searchVolume: scenario.secondWeight, cpc: scenario.secondValue, yoyGrowth: scenario.secondValue, recentGrowth: scenario.secondValue }),
    ], mappings: [] });
    for (const field of ["cpc", "yoyGrowth", "recentGrowth"] as const) {
      assert.equal(result.unassigned[field].value, scenario.expected, field);
      assert.equal(result.unassigned[field].weightedMemberCount, 2);
      assert.equal(result.unassigned[field].knownValueCount, 2);
    }
  });
}

test("near-cancelling positive and negative growth retains a nonzero weighted residual", () => {
  const result = aggregateKeywordClusters({ keywords: [
    keyword("a", { searchVolume: 1, yoyGrowth: Number.MAX_SAFE_INTEGER, recentGrowth: Number.MAX_SAFE_INTEGER - 2 }),
    keyword("b", { searchVolume: Number.MAX_SAFE_INTEGER - 1, yoyGrowth: -1, recentGrowth: -1 }),
  ], mappings: [] });
  assert.equal(result.unassigned.yoyGrowth.value, 1 / Number.MAX_SAFE_INTEGER);
  assert.equal(result.unassigned.recentGrowth.value, -1 / Number.MAX_SAFE_INTEGER);
});

test("subnormal positive weights are scaled without losing known metric values", () => {
  const result = aggregateKeywordClusters({ keywords: [
    keyword("a", { searchVolume: Number.MIN_VALUE, cpc: 0.5, yoyGrowth: -1, recentGrowth: 0.5 }),
    keyword("b", { searchVolume: Number.MIN_VALUE, cpc: 0.25, yoyGrowth: -1, recentGrowth: -0.25 }),
  ], mappings: [] });
  assert.equal(result.unassigned.cpc.value, 0.375);
  assert.equal(result.unassigned.yoyGrowth.value, -1);
  assert.equal(result.unassigned.recentGrowth.value, 0.125);
  assert.equal(result.unassigned.cpc.weightSum, Number.MIN_VALUE * 2);
});

test("large finite products retain the common upper-bound value", () => {
  const result = aggregateKeywordClusters({ keywords: [
    keyword("a", { searchVolume: Number.MAX_SAFE_INTEGER - 1, cpc: Number.MAX_SAFE_INTEGER }),
    keyword("b", { searchVolume: 1, cpc: Number.MAX_SAFE_INTEGER }),
  ], mappings: [] });
  assert.equal(result.unassigned.cpc.value, Number.MAX_SAFE_INTEGER);
});
