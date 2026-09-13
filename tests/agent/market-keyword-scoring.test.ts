import test from "node:test";
import assert from "node:assert/strict";
import { scoreKeywordDemandClusters } from "../../server/domain/market-research/keyword-scoring";
import { KEYWORD_SCORING_RULE_VERSION, type KeywordDemandScoringInput, type KeywordScoringMetric } from "../../shared/market-keyword-scoring-contracts";

const scope = { organizationId: "org-a", researchId: "11111111-1111-4111-8111-111111111111", marketplace: "US" as const, nodeIdPath: "12:34", fromMonth: "2026-08", toMonth: "2026-08", currency: "USD" as const };
const methods = {
  searchVolume: ["monthly-searches", "count", "calendar-month-total"],
  cpc: ["actual-cpc", "USD", "source-cpc"],
  yoyGrowth: ["yoy-growth", "fraction", "year-over-year-change"],
  recentGrowth: ["monthly-growth", "fraction", "month-over-month-change"],
  threeMonthGrowth: ["three-month-growth", "fraction", "three-month-change"],
  supplyDemandRatio: ["demand-over-supply", "ratio", "source-demand-over-supply"],
  abaTop3Share: ["top3-click-share", "fraction", "source-top3-share"],
  spr: ["spr", "count", "source-front-page-units"],
  suggestedBid: ["suggested-bid", "USD", "source-suggested-bid"],
  averagePrice: ["average-selling-price", "USD", "mapped-product-mean"],
} as const;
type Field = keyof typeof methods;
type Spec = Partial<Record<Field, number | null>>;
function metric(field: Field, value: number | null, recordId: string): KeywordScoringMetric {
  const [kind, unit, method] = methods[field];
  return { value, evidence: value === null ? null : { scope: { ...scope }, snapshotId: "snapshot-aug", sourceVersion: "source/v1", recordIds: [recordId], metric: kind, unit, method, methodVersion: "method/v1" }, missingReason: value === null ? "Source metric unavailable" : null };
}
function fixture(specs: Spec[] = [{}]): KeywordDemandScoringInput {
  const defaults: Record<Field, number | null> = { searchVolume: 100, cpc: 2, yoyGrowth: 0.1, recentGrowth: 0.9, threeMonthGrowth: 0.1, supplyDemandRatio: 1, abaTop3Share: 0.5, spr: 100, suggestedBid: 2, averagePrice: 30 };
  const values = specs.map(s => ({ ...defaults, ...s }));
  const ids = values.map((_, i) => `c${i.toString().padStart(4, "0")}`);
  return {
    scope: { ...scope }, snapshotId: "snapshot-aug", sourceVersion: "source/v1", mappingVersion: "mapping/v1", ruleVersion: KEYWORD_SCORING_RULE_VERSION, abaShareKind: "top3-click-share",
    keywords: values.map((s, i) => ({ id: ids[i], text: `keyword ${i}`, searchVolume: metric("searchVolume", s.searchVolume, ids[i]), cpc: metric("cpc", s.cpc, ids[i]), yoyGrowth: metric("yoyGrowth", s.yoyGrowth, ids[i]), recentGrowth: metric("recentGrowth", s.recentGrowth, ids[i]) })),
    mappings: ids.map(id => ({ keywordId: id, clusterId: id })),
    clusterMetrics: values.map((s, i) => ({ clusterId: ids[i], memberIds: [ids[i]], threeMonthGrowth: metric("threeMonthGrowth", s.threeMonthGrowth, ids[i]), supplyDemandRatio: metric("supplyDemandRatio", s.supplyDemandRatio, ids[i]), abaTop3Share: metric("abaTop3Share", s.abaTop3Share, ids[i]), spr: metric("spr", s.spr, ids[i]), suggestedBid: metric("suggestedBid", s.suggestedBid, ids[i]), averagePrice: metric("averagePrice", s.averagePrice, ids[i]), w5: { diagnosis: null, evidence: null, missingReason: "No verified W5 diagnosis" } })),
    comparisonClusterIds: ids, excludedClusters: [],
  };
}
function first(input: KeywordDemandScoringInput) { return scoreKeywordDemandClusters(input).clusters[0]; }
function near(actual: number | null, expected: number) { assert.ok(actual !== null && Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`); }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }
// Fixture construction uses counts of below/equal members, not production ranking functions.
function rankValues(percent: number, count = 10): number[] {
  const mid = percent * count / 100;
  const equal = Number.isInteger(mid) ? 2 : 1;
  const below = Math.round(mid - equal / 2);
  assert.ok(below >= 0 && below + equal <= count);
  return [below + 1, ...Array.from({ length: below }, (_, i) => i + 1), ...Array(equal - 1).fill(below + 1), ...Array.from({ length: count - below - equal }, (_, i) => below + 2 + i)];
}
function scoreFixture(scores: [number, number, number, number, number], count = 10): KeywordDemandScoringInput {
  const values = scores.map(s => rankValues(s, count));
  return fixture(Array.from({ length: count }, (_, i) => ({ searchVolume: values[0][i] * 100, yoyGrowth: values[1][i] / count, threeMonthGrowth: values[1][i] / count, supplyDemandRatio: values[2][i], abaTop3Share: 1 - values[2][i] / (count + 1), spr: count + 1 - values[3][i], suggestedBid: count + 1 - values[3][i], averagePrice: values[4][i] })));
}

test("01 ties retain independent hand-calculated mid-ranks 12.5/50/87.5", () => {
  const report = scoreKeywordDemandClusters(fixture([10, 20, 20, 30].map(searchVolume => ({ searchVolume }))));
  assert.deepEqual(report.clusters.map(c => c.scores.S1), [12.5, 50, 50, 87.5]);
  assert.equal(report.clusters[0].ranks.searchVolume.method, "mid-rank");
});
test("02 singleton and all-equal known samples score 50 with no discriminatory power", () => {
  for (const input of [fixture(), fixture([{}, {}, {}])]) {
    const score = first(input);
    near(score.pvs, 50);
    assert.equal(score.ranks.searchVolume.allEqual, true);
    assert.equal(score.ranks.searchVolume.discriminating, false);
    assert.equal(score.ranks.searchVolume.singleSample, input.keywords.length === 1);
  }
});
test("03 empty valid field pool yields null; empty comparison selection produces no ranked clusters", () => {
  const score = first(fixture([{ yoyGrowth: null, threeMonthGrowth: null }]));
  assert.equal(score.ranks.growth.valuePercent, null);
  assert.equal(score.ranks.growth.reason, "empty-pool");
  const input = fixture();
  assert.deepEqual(scoreKeywordDemandClusters({ ...input, comparisonClusterIds: [], excludedClusters: [{ clusterId: "c0000", reason: "Generic category word" }] }).clusters, []);
});
for (const [label, single, expectedBasis] of [["04 yoy-only", { yoyGrowth: 0.2, threeMonthGrowth: null }, "yoy-only"], ["05 three-month-only", { yoyGrowth: null, threeMonthGrowth: 0.2 }, "three-month-only"], ["06 negative yoy-only", { yoyGrowth: -0.2, threeMonthGrowth: null }, "yoy-only"]] as const) {
  test(`${label}: target and pool share the same growth derivation, giving 50`, () => {
    const negative = single.yoyGrowth === -0.2;
    const score = first(fixture([single, { yoyGrowth: negative ? -0.1 : 0.1, threeMonthGrowth: negative ? -0.1 : 0.1 }, { yoyGrowth: negative ? -0.3 : 0.3, threeMonthGrowth: negative ? -0.3 : 0.3 }]));
    assert.equal(score.scores.S2, 50);
    assert.equal(score.growth.basis, expectedBasis);
    assert.equal(score.status, "computed");
    assert.ok(score.limitations.includes("growth-source-incomplete"));
  });
}
test("07 missing growth is excluded rather than neutral-filled; remaining ranks are 25/75", () => {
  const scores = scoreKeywordDemandClusters(fixture([{ yoyGrowth: null, threeMonthGrowth: null }, { yoyGrowth: -0.2, threeMonthGrowth: -0.2 }, { yoyGrowth: 0.2, threeMonthGrowth: 0.2 }])).clusters;
  assert.deepEqual(scores.map(c => c.scores.S2), [null, 25, 75]);
  assert.equal(scores[0].pvs, null);
  assert.deepEqual(scores[1].ranks.growth.missingClusterIds, ["c0000"]);
});
test("08 zero is observed growth, not missing", () => {
  const score = first(fixture([{ yoyGrowth: 0, threeMonthGrowth: null }, { yoyGrowth: -0.2, threeMonthGrowth: -0.2 }, { yoyGrowth: 0.2, threeMonthGrowth: 0.2 }]));
  assert.equal(score.growth.value, 0);
  assert.equal(score.scores.S2, 50);
});
test("09 signed growth preserves the historic 0.6/0.4 blend and fractional unit", () => {
  const score = first(fixture([{ yoyGrowth: 0.2, threeMonthGrowth: -0.1 }]));
  near(score.growth.value, 0.08);
  assert.equal(score.growth.unit, "fraction");
  assert.equal(score.growth.basis, "yoy-and-three-month");
});
test("10 unknown volume does not become median volume or change the known pool sum", () => {
  const report = scoreKeywordDemandClusters(fixture([{ searchVolume: null }, { searchVolume: 100 }, { searchVolume: 300 }]));
  assert.equal(report.aggregation.pool.knownSearchVolume, 400);
  assert.equal(report.aggregation.pool.totalSearchVolume, null);
  assert.deepEqual(report.clusters.map(c => c.scores.S1), [null, 25, 75]);
  assert.ok(report.clusters.every(c => c.searchVolumeSharePercent === null));
  assert.equal(report.clusters[0].pvs, null);
});
test("11 known zero pool has no share denominator but retains equal observed scale rank", () => {
  const report = scoreKeywordDemandClusters(fixture([{ searchVolume: 0 }, { searchVolume: 0 }]));
  assert.equal(report.aggregation.pool.totalSearchVolume, 0);
  assert.equal(report.clusters[0].searchVolumeSharePercent, null);
  assert.equal(report.clusters[0].scores.S1, 50);
});
test("12 missing SDR keeps ABA rank 250/3 but S3 and PVS pending", () => {
  const score = first(fixture([{ supplyDemandRatio: null, abaTop3Share: 0.2 }, { supplyDemandRatio: 1, abaTop3Share: 0.5 }, { supplyDemandRatio: 3, abaTop3Share: 0.8 }]));
  near(score.ranks.abaTop3Share.valuePercent, 250 / 3);
  assert.equal(score.scores.S3, null);
  assert.equal(score.pvs, null);
  assert.equal(score.quadrant, null);
});
test("13 missing suggested bid retains inverse SPR rank but cannot use actual CPC", () => {
  const score = first(fixture([{ spr: 100, suggestedBid: null, cpc: 1 }, { spr: 200, suggestedBid: 1 }, { spr: 300, suggestedBid: 3 }]));
  near(score.ranks.spr.valuePercent, 250 / 3);
  assert.equal(score.scores.S4, null);
  assert.equal(score.pvs, null);
});
test("14 unknown average price stays pending; price means relative price, not margin", () => {
  const report = scoreKeywordDemandClusters(fixture([{ averagePrice: null }, { averagePrice: 20 }, { averagePrice: 40 }]));
  assert.deepEqual(report.clusters.map(c => c.scores.S5), [null, 25, 75]);
  assert.equal(report.clusters[0].pvs, null);
  assert.equal(report.priceScoreMeaning, "Relative selling-price position; not margin");
});
test("15 independent component vector [80,60,70,50,90] gives PVS 69.4 and P2", () => {
  const score = first(scoreFixture([80, 60, 70, 50, 90]));
  assert.deepEqual(score.scores, { S1: 80, S2: 60, S3: 70, S4: 50, S5: 90 });
  near(score.pvs, 69.4);
  assert.equal(score.quadrant, "main-battlefield");
  assert.equal(score.keywordValidationTier, "P2");
});
test("16 a missing key component never renormalizes the other weights", () => {
  const input = scoreFixture([80, 60, 70, 50, 90]);
  const modified = { ...input, clusterMetrics: input.clusterMetrics.map((m, i) => i ? m : { ...m, suggestedBid: metric("suggestedBid", null, m.clusterId) }) };
  const score = first(modified);
  assert.equal(score.pvs, null);
  assert.equal(score.status, "pending");
  assert.deepEqual(score.missingComponents, ["S4"]);
  assert.equal(score.keywordValidationTier, null);
});
test("17 raw boundary values decide tiers before display rounding", () => {
  for (const [value, tier] of [[40, "P3"], [55, "P2"], [70, "P1"]] as const) {
    // Keep S1/S3 high to avoid quadrant caps while independently fixing the total.
    const input = scoreFixture([value, value, value, value, value]);
    const score = first(input);
    near(score.pvs, value);
    assert.equal(score.keywordValidationTier, tier);
  }
  const almost = first(scoreFixture([69.95, 70.05, 70, 70, 70], 1000));
  near(almost.pvs, 69.997);
  assert.equal(almost.pvs?.toFixed(1), "70.0");
  assert.equal(almost.keywordValidationTier, "P2");
});
test("18 high-scoring defer quadrant [45,95,45,95,95] is capped at P3", () => {
  const score = first(scoreFixture([45, 95, 45, 95, 95]));
  near(score.pvs, 71);
  assert.equal(score.quadrant, "defer-zone");
  assert.equal(score.keywordValidationTier, "P3");
});
test("19 red-ocean caps P1 at P2; caps never promote an existing P4", () => {
  const score = first(scoreFixture([95, 95, 45, 95, 95]));
  near(score.pvs, 85);
  assert.equal(score.keywordValidationTier, "P2");
  assert.equal(first(scoreFixture([55, 5, 5, 5, 5])).keywordValidationTier, "P4");
  assert.equal(first(scoreFixture([5, 5, 5, 5, 5])).keywordValidationTier, "P4");
});
test("20 sourced W5 decline is conservative P4 independently of pending PVS", () => {
  for (const diagnosis of ["structural_declining", "structural_declining_seasonal_dip"] as const) {
    const input = fixture([{ suggestedBid: null }]);
    const source = metric("averagePrice", 1, "diagnosis-record").evidence!;
    const modified = { ...input, clusterMetrics: input.clusterMetrics.map(m => ({ ...m, w5: { diagnosis, evidence: { ...source, metric: "w5-diagnosis", unit: "label" as const, method: "evidence-backed-diagnosis" }, missingReason: null } })) };
    const score = first(modified);
    assert.equal(score.keywordValidationTier, "P4");
    assert.equal(score.pvs, null);
    assert.equal(score.status, "pending");
    assert.ok(score.tierReasons.includes(diagnosis));
    assert.throws(() => first({ ...modified, clusterMetrics: modified.clusterMetrics.map(m => ({ ...m, w5: { ...m.w5, evidence: null } })) }));
  }
});
test("21 default missing inputs remain pending; strict uses the same validator plus completeness", () => {
  const input = fixture([{ searchVolume: null, yoyGrowth: null, threeMonthGrowth: null, supplyDemandRatio: null, abaTop3Share: null, spr: null, suggestedBid: null, averagePrice: null }]);
  assert.deepEqual(first(input).scores, { S1: null, S2: null, S3: null, S4: null, S5: null });
  assert.throws(() => first({ ...input, requireCompleteInputs: true }), /complete/i);
  assert.throws(() => first({ ...fixture([{ threeMonthGrowth: null }]), requireCompleteInputs: true }), /complete/i);
  assert.equal(first({ ...fixture(), requireCompleteInputs: true }).status, "computed");
});
test("22 both modes reject illegal numbers/types/ranges; legal zero and -1 survive", () => {
  for (const value of [NaN, Infinity, "3", true, -1, Number.MAX_SAFE_INTEGER + 1, 1.5]) {
    for (const requireCompleteInputs of [false, true]) {
      const input = fixture();
      const bad = { ...input, requireCompleteInputs, keywords: input.keywords.map(k => ({ ...k, searchVolume: { ...k.searchVolume, value } })) };
      assert.throws(() => scoreKeywordDemandClusters(bad));
    }
  }
  for (const [field, value] of [["abaTop3Share", 1.2], ["threeMonthGrowth", -1.01], ["spr", 1.5], ["suggestedBid", -1]] as const) assert.throws(() => first(fixture([{ [field]: value }])));
  assert.equal(first(fixture([{ yoyGrowth: -1, threeMonthGrowth: -1 }])).growth.value, -1);
});
test("23 deterministic reordering detaches inputs; duplicate IDs and mappings are rejected", () => {
  const input = fixture([{ searchVolume: 200 }, { searchVolume: 100 }]);
  const before = clone(input);
  const reordered = { ...input, keywords: [...input.keywords].reverse(), mappings: [...input.mappings].reverse(), clusterMetrics: [...input.clusterMetrics].reverse(), comparisonClusterIds: [...input.comparisonClusterIds].reverse() };
  assert.deepEqual(scoreKeywordDemandClusters(input), scoreKeywordDemandClusters(reordered));
  assert.deepEqual(input, before);
  assert.throws(() => first({ ...input, comparisonClusterIds: ["c0000", "c0000"] }));
  assert.throws(() => first({ ...input, comparisonClusterIds: ["unknown"] }));
  assert.throws(() => first({ ...input, mappings: [...input.mappings, input.mappings[0]] }));
  assert.throws(() => first({ ...input, keywords: [...input.keywords, input.keywords[0]] }));
});
test("24 merge reaggregates original members and keeps unassigned volume in the share", () => {
  const base = fixture([{ searchVolume: 100, cpc: 1 }, { searchVolume: 900, cpc: 3 }, { searchVolume: 1000 }]);
  const input = { ...base, mappings: [{ keywordId: "c0000", clusterId: "merged" }, { keywordId: "c0001", clusterId: "merged" }], clusterMetrics: [{ ...base.clusterMetrics[0], clusterId: "merged", memberIds: ["c0000", "c0001"], suggestedBid: metric("suggestedBid", null, "merged") }], comparisonClusterIds: ["merged"] };
  const report = scoreKeywordDemandClusters(input);
  near(report.aggregation.clusters[0].cpc.value, 2.8);
  assert.equal(report.clusters[0].searchVolumeSharePercent, 50);
  assert.equal(report.clusters[0].searchVolumeShareDenominator, 2000);
  assert.equal(report.clusters[0].scores.S4, null);
  assert.throws(() => scoreKeywordDemandClusters({ ...input, clusterMetrics: [{ ...input.clusterMetrics[0], memberIds: ["c0000"] }] }), /member/i);
  assert.throws(() => scoreKeywordDemandClusters({ ...input, clusterMetrics: [{ ...input.clusterMetrics[0], monthlySearches: 99999 }] }));
});
test("scope, month, snapshot, versions, metric units and semantic methods are mandatory", () => {
  const base = fixture();
  for (const patch of [{ scope: { ...scope, toMonth: "2026-07" } }, { scope: { ...scope, fromMonth: "2026-07" } }, { snapshotId: "" }, { mappingVersion: "" }, { ruleVersion: "legacy" }]) assert.throws(() => scoreKeywordDemandClusters({ ...base, ...patch }));
  const evidence = base.clusterMetrics[0].threeMonthGrowth.evidence!;
  for (const patch of [{ scope: { ...scope, fromMonth: "2026-07", toMonth: "2026-07" } }, { scope: { ...scope, currency: "EUR" } }, { scope: { ...scope, organizationId: "other-org" } }, { snapshotId: "other" }, { sourceVersion: "" }, { method: "month-over-month-change" }, { unit: "count" }, { recordIds: [] }]) {
    assert.throws(() => scoreKeywordDemandClusters({ ...base, clusterMetrics: [{ ...base.clusterMetrics[0], threeMonthGrowth: { ...base.clusterMetrics[0].threeMonthGrowth, evidence: { ...evidence, ...patch } } }] }));
  }
  assert.throws(() => scoreKeywordDemandClusters({ ...base, clusterMetrics: [{ ...base.clusterMetrics[0], abaTop3Share: { ...base.clusterMetrics[0].abaTop3Share, evidence: { ...evidence, metric: "top3-conversion-share" } } }] }));
});
test("monthly change is never treated as three-month growth; unknown evidence never supplies numbers", () => {
  const input = fixture([{ yoyGrowth: null, threeMonthGrowth: null, recentGrowth: 0.9 }]);
  assert.equal(first(input).growth.value, null);
  const base = fixture();
  assert.throws(() => first({ ...base, keywords: base.keywords.map(k => ({ ...k, searchVolume: { value: 100, evidence: null, missingReason: null } })) }));
  assert.throws(() => first({ ...base, keywords: base.keywords.map(k => ({ ...k, searchVolume: { value: null, evidence: null, missingReason: null } })) }));
});
test("partial conditions remain unknown instead of defaulting to observation", () => {
  assert.equal(first(fixture([{ searchVolume: null }])).demandClass, null);
  const mainstream = first(fixture([{ supplyDemandRatio: null }]));
  assert.equal(mainstream.demandClass, "mainstream");
  assert.equal(mainstream.quadrant, null);
  assert.equal(mainstream.keywordValidationTier, null);
});
test("excluded clusters require reasons and remain in the full-volume denominator", () => {
  const base = fixture([{ searchVolume: 100 }, { searchVolume: 900 }]);
  const input = { ...base, comparisonClusterIds: ["c0000"], excludedClusters: [{ clusterId: "c0001", reason: "Brand-specific query" }] };
  const report = scoreKeywordDemandClusters(input);
  assert.equal(report.clusters.length, 1);
  assert.equal(report.clusters[0].searchVolumeSharePercent, 10);
  assert.equal(report.clusters[0].scores.S1, 50);
  assert.throws(() => first({ ...input, excludedClusters: [] }));
});

test("P2-1 equal decimal growth stays tied across single/blended bases, including extreme inputs", () => {
  for (const value of [0.11, Number.MAX_SAFE_INTEGER, Number.MIN_VALUE, -1]) {
    const report = scoreKeywordDemandClusters(fixture([{ yoyGrowth: value, threeMonthGrowth: null }, { yoyGrowth: value, threeMonthGrowth: value }]));
    assert.deepEqual(report.clusters.map(c => c.scores.S2), [50, 50]);
    assert.deepEqual(report.clusters.map(c => c.growth.value), [value, value]);
    assert.deepEqual(report.clusters.map(c => c.pvs), [50, 50]);
  }
});
test("P2-1 different component values with exact weighted growth 0.11 tie with the single value", () => {
  // 3/5*0.1 + 2/5*0.125 = 0.06 + 0.05 = 0.11 exactly.
  const report = scoreKeywordDemandClusters(fixture([{ yoyGrowth: 0.11, threeMonthGrowth: null }, { yoyGrowth: 0.1, threeMonthGrowth: 0.125 }]));
  assert.deepEqual(report.clusters.map(c => c.scores.S2), [50, 50]);
  assert.deepEqual(report.clusters.map(c => c.growth.value), [0.11, 0.11]);
  assert.deepEqual(report.clusters.map(c => c.growth.exactValue), [{ numerator: "11", denominator: "100" }, { numerator: "11", denominator: "100" }]);
  assert.equal(report.precisionPolicy, "canonical-decimal-input/exact-rational-comparison");
});
test("P2-1 adjacent genuinely distinct decimal values are not merged with an epsilon", () => {
  for (const [lower, upper] of [[0.11, 0.11000000000000001], [-0.11000000000000001, -0.11], [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER]]) {
    const report = scoreKeywordDemandClusters(fixture([{ yoyGrowth: lower, threeMonthGrowth: null }, { yoyGrowth: upper, threeMonthGrowth: null }]));
    assert.deepEqual(report.clusters.map(c => c.scores.S2), [25, 75]);
  }
});
test("P2-1 exact member weighting prevents T3 numeric-display rounding from splitting a mathematical tie", () => {
  const base = fixture([{ searchVolume: 3, yoyGrowth: 0.1, threeMonthGrowth: null }, { searchVolume: 2, yoyGrowth: 0.125 }, { searchVolume: 100, yoyGrowth: 0.11, threeMonthGrowth: null }]);
  const input = { ...base, mappings: [{ keywordId: "c0000", clusterId: "merged" }, { keywordId: "c0001", clusterId: "merged" }, { keywordId: "c0002", clusterId: "single" }], clusterMetrics: [{ ...base.clusterMetrics[0], clusterId: "merged", memberIds: ["c0000", "c0001"] }, { ...base.clusterMetrics[2], clusterId: "single", memberIds: ["c0002"] }], comparisonClusterIds: ["merged", "single"] };
  // (3*0.1 + 2*0.125)/5 = 0.11, independent of binary intermediary arithmetic.
  assert.deepEqual(scoreKeywordDemandClusters(input).clusters.map(c => c.scores.S2), [50, 50]);
});
test("positive rational growth below the smallest displayable double still ranks above exact zero", () => {
  const report = scoreKeywordDemandClusters(fixture([{ yoyGrowth: 0, threeMonthGrowth: 0 }, { yoyGrowth: 0, threeMonthGrowth: Number.MIN_VALUE }]));
  assert.deepEqual(report.clusters.map(c => c.scores.S2), [25, 75]);
  assert.deepEqual(report.clusters.map(c => c.growth.value), [0, 0]);
  assert.equal(report.clusters[1].growth.exactValue?.numerator, "1");
  assert.notEqual(report.clusters[1].growth.exactValue, null);
  assert.doesNotThrow(() => JSON.stringify(report));
});

function rankNumeratorFixture(js: [number, number, number, number, number]): KeywordDemandScoringInput {
  const values = js.map(j => {
    const equal = j % 2 ? 1 : 2, below = (j - equal) / 2;
    return [below + 1, ...Array.from({ length: below }, (_, i) => i + 1), ...Array(equal - 1).fill(below + 1), ...Array.from({ length: 6 - below - equal }, (_, i) => below + 2 + i)];
  });
  return fixture(Array.from({ length: 6 }, (_, i) => ({ searchVolume: values[0][i] * 100, yoyGrowth: values[1][i], threeMonthGrowth: null, supplyDemandRatio: values[2][i], abaTop3Share: 1 - values[2][i] / 7, spr: 7 - values[3][i], suggestedBid: 7 - values[3][i], averagePrice: values[4][i] })));
}
test("P2-2 exact rational mid-rank thresholds 40/55/70 survive denominators containing thirds", () => {
  // Every j denotes (below*2 + equal), with rank denominator 2N=12.
  // Independent integer numerators: 480/12=40, 660/12=55, 840/12=70.
  for (const [js, expected, tier] of [
    [[6, 1, 7, 1, 11], 40, "P3"], [[6, 1, 7, 11, 11], 55, "P2"], [[9, 11, 8, 3, 11], 70, "P1"],
  ] as const) {
    const score = first(rankNumeratorFixture([...js]));
    assert.equal(score.pvs, expected);
    assert.equal(score.quadrant, "main-battlefield");
    assert.equal(score.keywordValidationTier, tier);
    assert.deepEqual(score.exactPvs, { numerator: String(expected), denominator: "1" });
  }
});


function goldenInputs(){
 const mixed=fixture([{searchVolume:0,yoyGrowth:-1,threeMonthGrowth:null,supplyDemandRatio:null,abaTop3Share:0,spr:0,suggestedBid:0,averagePrice:0},{searchVolume:10,yoyGrowth:-.25,threeMonthGrowth:.25,abaTop3Share:1},{searchVolume:10,yoyGrowth:null,threeMonthGrowth:null,suggestedBid:null},{searchVolume:null,yoyGrowth:.2,threeMonthGrowth:.2,spr:null},{searchVolume:30,yoyGrowth:0,threeMonthGrowth:0}]);
 const extreme=fixture([{searchVolume:2**51,yoyGrowth:.1,threeMonthGrowth:.3},{searchVolume:1,yoyGrowth:-1,threeMonthGrowth:0},{searchVolume:2**51,yoyGrowth:.2,threeMonthGrowth:.11}]);
 const merged=fixture([{searchVolume:10,yoyGrowth:-1},{searchVolume:30,yoyGrowth:.2},{searchVolume:60,yoyGrowth:.9}]);
 const mergedInput={...merged,mappings:merged.mappings.map((m,i)=>i===1?{keywordId:'c0001',clusterId:'c0000'}:m),clusterMetrics:[{...merged.clusterMetrics[0],memberIds:['c0000','c0001']},merged.clusterMetrics[2]],comparisonClusterIds:['c0000','c0002']};
 return [fixture([]),fixture(),fixture([{}, {}, {}]),mixed,extreme,mergedInput];
}
import {createHash} from 'node:crypto';
test('rank optimization preserves pre-change full serialized score identities for varied source cases',()=>{
 const expected=['1c41626f14753aa29fa155e3cd66dd7da005995c74383ffaa92a28bd3eaa6c55','dcfbfbfb267cf4ccba043c619c09b4bbb5d85bb6b36341845e8e1398093f48a6','17f80592a6da3ce94b55a0436fdeed34afa22dd6c7d71df0048a605aa4a3f062','6d2c4b9b18168404a1494d1e60f8f0e13f36fb04d3a61d7553a59fd1032da05b','042beefb23b2368a4da688dd5d5a73a08a9d4ea94f164caf1ac3916f6ba7bef8','02f70e8a71a62ed33c27162e675c16ddc82bfc593a77961ddb819015ee89789e'];
 assert.deepEqual(goldenInputs().map(input=>createHash('sha256').update(JSON.stringify(scoreKeywordDemandClusters(input))).digest('hex')),expected);
});
test('maximum-cardinality ranks retain only one immutable membership pair per field',()=>{
 const report=scoreKeywordDemandClusters(fixture(Array.from({length:2000},(_,i)=>({yoyGrowth:i%3===0?null:(i%7-3)/10,threeMonthGrowth:i%3===0?null:(i%7-3)/10}))));
 const memberships=new Set<readonly string[]>();
 for(const cluster of report.clusters)for(const rank of Object.values(cluster.ranks)){memberships.add(rank.comparisonClusterIds);memberships.add(rank.missingClusterIds);}
 assert.ok(memberships.size<=14,`Expected field-shared membership arrays; got ${memberships.size}`);
 for(const ids of memberships)assert.ok(Object.isFrozen(ids));
});
