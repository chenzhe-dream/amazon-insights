import { z } from "zod";
import { MarketAnalysisScopeSchema } from "../../../shared/market-analysis-contracts";
import {
  KEYWORD_SCORING_RULE_VERSION,
  type KeywordDemandScoreReport,
  type KeywordClusterScore,
  type KeywordMetricRank,
  type KeywordRankField,
  type KeywordScoreComponent,
  type KeywordQuadrant,
  type KeywordExactFraction,
} from "../../../shared/market-keyword-scoring-contracts";
import { aggregateKeywordClusters } from "./keyword-clusters";

const compareIds = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const identity = z.string().min(1).max(240).refine(s => s.trim() === s, "Identity must not have surrounding whitespace");
const ids = z.array(identity).max(2_000);
const evidenceSchema = z.object({
  scope: MarketAnalysisScopeSchema,
  snapshotId: identity,
  sourceVersion: identity,
  recordIds: ids.min(1),
  metric: identity,
  unit: z.enum(["count", "fraction", "ratio", "USD", "label"]),
  method: identity,
  methodVersion: identity,
}).strict();
const metricSchema = z.object({
  value: z.number().finite().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nullable(),
  evidence: evidenceSchema.nullable(),
  missingReason: identity.nullable(),
}).strict();
const w5Schema = z.object({
  diagnosis: z.enum(["structural_declining", "structural_declining_seasonal_dip"]).nullable(),
  evidence: evidenceSchema.nullable(),
  missingReason: identity.nullable(),
}).strict();
const inputSchema = z.object({
  scope: MarketAnalysisScopeSchema,
  snapshotId: identity,
  sourceVersion: identity,
  mappingVersion: identity,
  ruleVersion: z.literal(KEYWORD_SCORING_RULE_VERSION),
  abaShareKind: z.enum(["top3-click-share", "top3-conversion-share"]),
  keywords: z.array(z.object({
    id: identity, text: z.string().trim().min(1).max(1_000),
    searchVolume: metricSchema, cpc: metricSchema, yoyGrowth: metricSchema, recentGrowth: metricSchema,
  }).strict()).max(2_000),
  mappings: z.array(z.object({ keywordId: identity, clusterId: identity }).strict()).max(2_000),
  clusterMetrics: z.array(z.object({
    clusterId: identity, memberIds: ids.min(1),
    threeMonthGrowth: metricSchema, supplyDemandRatio: metricSchema, abaTop3Share: metricSchema,
    spr: metricSchema, suggestedBid: metricSchema, averagePrice: metricSchema, w5: w5Schema,
  }).strict()).max(2_000),
  comparisonClusterIds: ids,
  excludedClusters: z.array(z.object({ clusterId: identity, reason: identity }).strict()).max(2_000),
  requireCompleteInputs: z.boolean().optional(),
}).strict();

type ParsedInput = z.infer<typeof inputSchema>;
type Metric = z.infer<typeof metricSchema>;
type Evidence = z.infer<typeof evidenceSchema>;
type MetricSpec = readonly [metric: string, unit: Evidence["unit"], method: string, minimum: number, integer?: boolean, maximum?: number];
const specs = {
  searchVolume: ["monthly-searches", "count", "calendar-month-total", 0, true],
  cpc: ["actual-cpc", "USD", "source-cpc", 0],
  yoyGrowth: ["yoy-growth", "fraction", "year-over-year-change", -1],
  recentGrowth: ["monthly-growth", "fraction", "month-over-month-change", -1],
  threeMonthGrowth: ["three-month-growth", "fraction", "three-month-change", -1],
  supplyDemandRatio: ["demand-over-supply", "ratio", "source-demand-over-supply", 0],
  spr: ["spr", "count", "source-front-page-units", 0, true],
  suggestedBid: ["suggested-bid", "USD", "source-suggested-bid", 0],
  averagePrice: ["average-selling-price", "USD", "mapped-product-mean", 0],
} as const satisfies Record<string, MetricSpec>;

function unique(values: readonly string[], context: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`Duplicate ${context}`);
}

function validateEvidence(evidence: Evidence, input: ParsedInput, metric: string, unit: Evidence["unit"], method: string): void {
  if (JSON.stringify(evidence.scope) !== JSON.stringify(input.scope)) throw new TypeError("Metric evidence scope differs from scoring scope");
  if (evidence.snapshotId !== input.snapshotId || evidence.sourceVersion !== input.sourceVersion) throw new TypeError("Metric evidence snapshot/source version differs from scoring input");
  if (evidence.metric !== metric || evidence.unit !== unit || evidence.method !== method) throw new TypeError(`Metric evidence does not establish ${metric} with unit ${unit} and method ${method}`);
  unique(evidence.recordIds, "evidence record ID");
  evidence.recordIds.sort(compareIds);
}

function validateMetric(metric: Metric, input: ParsedInput, spec: MetricSpec): void {
  const [kind, unit, method, minimum, integer = false, maximum = Number.MAX_SAFE_INTEGER] = spec;
  if (metric.value === null) {
    if (metric.missingReason === null) throw new TypeError(`${kind}: missing value requires a reason`);
  } else {
    if (metric.evidence === null || metric.missingReason !== null) throw new TypeError(`${kind}: known value requires evidence without a missing reason`);
    if (metric.value < minimum || metric.value > maximum || (integer && !Number.isSafeInteger(metric.value))) throw new TypeError(`${kind}: value is outside its valid numeric range`);
  }
  if (metric.evidence !== null) validateEvidence(metric.evidence, input, kind, unit, method);
}

function validateInput(value: unknown): ParsedInput {
  // Zod's strict nested schemas detach the accepted values; callers cannot inject prior
  // cluster volumes, scores or arbitrary extra metrics through the public entry point.
  const input = inputSchema.parse(value);
  if (input.scope.fromMonth !== input.scope.toMonth || input.scope.toMonth >= new Date().toISOString().slice(0, 7)) throw new TypeError("Keyword scoring requires one completed calendar month");
  unique(input.clusterMetrics.map(c => c.clusterId), "cluster metric ID");
  unique(input.comparisonClusterIds, "comparison cluster ID");
  unique(input.excludedClusters.map(c => c.clusterId), "excluded cluster ID");
  for (const member of input.keywords) {
    for (const field of ["searchVolume", "cpc", "yoyGrowth", "recentGrowth"] as const) validateMetric(member[field], input, specs[field]);
  }
  for (const cluster of input.clusterMetrics) {
    unique(cluster.memberIds, "cluster member ID");
    cluster.memberIds.sort(compareIds);
    for (const field of ["threeMonthGrowth", "supplyDemandRatio", "spr", "suggestedBid", "averagePrice"] as const) validateMetric(cluster[field], input, specs[field]);
    validateMetric(cluster.abaTop3Share, input, [input.abaShareKind, "fraction", "source-top3-share", 0, false, 1]);
    if (cluster.w5.diagnosis === null ? cluster.w5.missingReason === null : cluster.w5.evidence === null || cluster.w5.missingReason !== null) throw new TypeError("W5 requires either a sourced diagnosis or an explicit missing reason");
    if (cluster.w5.evidence) validateEvidence(cluster.w5.evidence, input, "w5-diagnosis", "label", "evidence-backed-diagnosis");
  }
  input.keywords.sort((a, b) => compareIds(a.id, b.id));
  input.mappings.sort((a, b) => compareIds(a.keywordId, b.keywordId));
  input.clusterMetrics.sort((a, b) => compareIds(a.clusterId, b.clusterId));
  input.comparisonClusterIds.sort(compareIds);
  input.excludedClusters.sort((a, b) => compareIds(a.clusterId, b.clusterId));
  return input;
}

type Ratio = { n: bigint; d: bigint };
function ratio(n: bigint, d = BigInt(1)): Ratio {
  let a = n < BigInt(0) ? -n : n, b = d;
  while (b) { const next = a % b; a = b; b = next; }
  return { n: n / a, d: d / a };
}
function add(a: Ratio, b: Ratio): Ratio { return ratio(a.n * b.d + b.n * a.d, a.d * b.d); }
function scale(a: Ratio, n: bigint, d = BigInt(1)): Ratio { return ratio(a.n * n, a.d * d); }
function compare(a: Ratio, b: Ratio): number {
  const difference = a.n * b.d - b.n * a.d;
  return difference < BigInt(0) ? -1 : difference > BigInt(0) ? 1 : 0;
}
/** Number.toString is a unique round-trippable decimal identity, not a display rounding policy. */
function decimal(value: number): Ratio {
  const [mantissa, exponent = "0"] = value.toString().split("e");
  const places = mantissa.split(".")[1]?.length ?? 0;
  const power = Number(exponent) - places;
  const numerator = BigInt(mantissa.replace(".", ""));
  return power >= 0 ? ratio(numerator * BigInt(10) ** BigInt(power)) : ratio(numerator, BigInt(10) ** BigInt(-power));
}
function exact(value: Ratio | null): KeywordExactFraction | null {
  return value === null ? null : { numerator: value.n.toString(), denominator: value.d.toString() };
}
/** Round the exact fraction once to nearest-even binary64 for display, including subnormals. */
function display(value: Ratio | null): number | null {
  if (value === null) return null;
  if (value.n === BigInt(0)) return 0;
  const magnitude = value.n < BigInt(0) ? -value.n : value.n;
  let exponent = magnitude.toString(2).length - value.d.toString(2).length;
  if (exponent >= 0 ? magnitude < (value.d << BigInt(exponent)) : (magnitude << BigInt(-exponent)) < value.d) exponent--;
  const unit = Math.max(exponent - 52, -1074);
  const numerator = unit < 0 ? magnitude << BigInt(-unit) : magnitude;
  const denominator = unit < 0 ? value.d : value.d << BigInt(unit);
  let rounded = numerator / denominator;
  const twiceRemainder = BigInt(2) * (numerator % denominator);
  if (twiceRemainder > denominator || (twiceRemainder === denominator && rounded % BigInt(2) !== BigInt(0))) rounded++;
  return (value.n < BigInt(0) ? -1 : 1) * Number(rounded) * 2 ** unit;
}
function atLeast(value: Ratio | null, threshold: number): boolean {
  return value !== null && compare(value, ratio(BigInt(threshold))) >= 0;
}

function growth(yoy: Ratio | null, threeMonth: Ratio | null): { view: KeywordClusterScore["growth"]; exact: Ratio | null } {
  const missingFields: Array<"yoyGrowth" | "threeMonthGrowth"> = [];
  if (yoy === null) missingFields.push("yoyGrowth");
  if (threeMonth === null) missingFields.push("threeMonthGrowth");
  const value = yoy !== null && threeMonth !== null ? add(scale(yoy, BigInt(3), BigInt(5)), scale(threeMonth, BigInt(2), BigInt(5))) : yoy ?? threeMonth;
  return { exact: value, view: {
    value: display(value), exactValue: exact(value),
    unit: "fraction",
    basis: yoy !== null ? threeMonth !== null ? "yoy-and-three-month" : "yoy-only" : threeMonth !== null ? "three-month-only" : "missing",
    missingFields,
  } };
}

type RankRow = { clusterId: string; values: Record<KeywordRankField, Ratio | null> };
type PreparedRank = { view: KeywordMetricRank; exact: Ratio | null };
/** One exact sort/tie walk per field; membership order remains the canonical
 * input order used by archived reports, independent of numeric sort order. */
function prepareRanks(rows: readonly RankRow[], field: KeywordRankField, direction: "higher" | "lower"): ReadonlyMap<string, PreparedRank> {
  const valid = rows.filter(row => row.values[field] !== null);
  const comparisonClusterIds = Object.freeze(valid.map(row => row.clusterId));
  const missingClusterIds = Object.freeze(rows.filter(row => row.values[field] === null).map(row => row.clusterId));
  const sorted = [...valid].sort((a, b) => compare(a.values[field]!, b.values[field]!));
  const allEqual = sorted.length > 0 && compare(sorted[0].values[field]!, sorted[sorted.length - 1].values[field]!) === 0;
  const common = { method: "mid-rank" as const, direction, comparisonClusterIds, missingClusterIds,
    singleSample: sorted.length === 1, allEqual, discriminating: sorted.length > 1 && !allEqual };
  const result = new Map<string, PreparedRank>();
  for (let start = 0; start < sorted.length;) {
    let end = start + 1;
    while (end < sorted.length && compare(sorted[start].values[field]!, sorted[end].values[field]!) === 0) end++;
    const below = direction === "higher" ? start : sorted.length - end;
    const value = ratio(BigInt(2 * below + end - start) * BigInt(100), BigInt(2 * sorted.length));
    for (let index = start; index < end; index++) result.set(sorted[index].clusterId, {
      exact: value, view: { valuePercent: display(value), exactValuePercent: exact(value), ...common, reason: null },
    });
    start = end;
  }
  for (const row of rows) if (row.values[field] === null) result.set(row.clusterId, {
    exact: null, view: { valuePercent: null, exactValuePercent: null, ...common, reason: sorted.length ? "missing-target" : "empty-pool" },
  });
  return result;
}

function quadrant(s1: Ratio | null, s3: Ratio | null): KeywordQuadrant | null {
  if (s1 === null || s3 === null) return null;
  return atLeast(s1, 50) ? atLeast(s3, 50) ? "main-battlefield" : "red-ocean" : atLeast(s3, 50) ? "opportunity-gap" : "defer-zone";
}

function demandClass(share: Ratio | null, s1: Ratio | null, s2: Ratio | null, s3: Ratio | null): KeywordClusterScore["demandClass"] {
  if (atLeast(share, 10) || atLeast(s1, 75)) return "mainstream";
  if (share === null || s1 === null) return null;
  if (atLeast(s2, 60) || atLeast(s3, 60)) return "niche";
  return s2 !== null && s3 !== null ? "observation" : null;
}

/** Pure scoped rule calculation. This is the only public entry point, including any future CLI. */
export function scoreKeywordDemandClusters(value: unknown): KeywordDemandScoreReport {
  const input = validateInput(value);
  const aggregation = aggregateKeywordClusters({
    keywords: input.keywords.map(k => ({ id: k.id, text: k.text, searchVolume: k.searchVolume.value, cpc: k.cpc.value, yoyGrowth: k.yoyGrowth.value, recentGrowth: k.recentGrowth.value })),
    mappings: input.mappings,
  });
  const aggregateById = new Map(aggregation.clusters.map(c => [c.clusterId!, c]));
  const metricsById = new Map(input.clusterMetrics.map(c => [c.clusterId, c]));
  if (metricsById.size !== aggregateById.size) throw new TypeError("Cluster metrics must cover exactly the current mapped clusters");
  for (const [id, metrics] of metricsById) {
    const aggregate = aggregateById.get(id);
    if (!aggregate || JSON.stringify(aggregate.memberIds) !== JSON.stringify(metrics.memberIds)) throw new TypeError("Cluster metric members differ from the current original-member mapping");
  }
  const comparison = new Set(input.comparisonClusterIds);
  const excluded = new Set(input.excludedClusters.map(c => c.clusterId));
  if ([...comparison, ...excluded].some(id => !aggregateById.has(id)) || [...comparison].some(id => excluded.has(id)) || comparison.size + excluded.size !== aggregateById.size) throw new TypeError("Comparison and explicitly excluded IDs must partition the current clusters");
  const memberById = new Map(input.keywords.map(member => [member.id, member]));
  const maybeDecimal = (value: number | null) => value === null ? null : decimal(value);
  const rows = input.comparisonClusterIds.map(clusterId => {
    const aggregate = aggregateById.get(clusterId)!;
    const metrics = metricsById.get(clusterId)!;
    if (input.requireCompleteInputs && [aggregate.totalSearchVolume, aggregate.yoyGrowth.value, metrics.threeMonthGrowth.value, metrics.supplyDemandRatio.value, metrics.abaTop3Share.value, metrics.spr.value, metrics.suggestedBid.value, metrics.averagePrice.value].some(value => value === null)) throw new TypeError("Complete scoring inputs are required in strict mode");
    // Derive once for every member of the fixed comparison set. Both ranking targets
    // and the comparison pool consume this exact value, including single-source growth.
    // Preserve T3's original-member/field-specific denominator, but retain exact
    // decimal arithmetic for ranking rather than re-reading its rounded display mean.
    let weightedYoy = ratio(BigInt(0)), yoyWeight = BigInt(0);
    for (const id of aggregate.memberIds) {
      const member = memberById.get(id)!;
      if (member.searchVolume.value !== null && member.searchVolume.value > 0 && member.yoyGrowth.value !== null) {
        const weight = BigInt(member.searchVolume.value);
        weightedYoy = add(weightedYoy, scale(decimal(member.yoyGrowth.value), weight));
        yoyWeight += weight;
      }
    }
    const derivedGrowth = growth(yoyWeight > BigInt(0) ? scale(weightedYoy, BigInt(1), yoyWeight) : null, maybeDecimal(metrics.threeMonthGrowth.value));
    return {
      clusterId, aggregate, metrics, growth: derivedGrowth.view,
      values: { searchVolume: maybeDecimal(aggregate.totalSearchVolume), growth: derivedGrowth.exact, supplyDemandRatio: maybeDecimal(metrics.supplyDemandRatio.value), abaTop3Share: maybeDecimal(metrics.abaTop3Share.value), spr: maybeDecimal(metrics.spr.value), suggestedBid: maybeDecimal(metrics.suggestedBid.value), averagePrice: maybeDecimal(metrics.averagePrice.value) },
    };
  });
  const mixedGrowthBasis = new Set(rows.map(r => r.growth.basis).filter(b => b !== "missing")).size > 1;
  const rankFields = ["searchVolume", "growth", "supplyDemandRatio", "abaTop3Share", "spr", "suggestedBid", "averagePrice"] as const;
  const fieldRanks = Object.fromEntries(rankFields.map(field => [field, prepareRanks(rows, field, ["abaTop3Share", "spr", "suggestedBid"].includes(field) ? "lower" : "higher")])) as Record<KeywordRankField, ReadonlyMap<string, PreparedRank>>;
  const clusters: KeywordClusterScore[] = rows.map(row => {
    const ranked = Object.fromEntries(rankFields.map(field => [field, fieldRanks[field].get(row.clusterId)!])) as Record<KeywordRankField, PreparedRank>;
    const ranks = Object.fromEntries(Object.entries(ranked).map(([field, value]) => [field, value.view])) as Record<KeywordRankField, KeywordMetricRank>;
    const p = (field: KeywordRankField) => ranked[field].exact;
    const sdr = p("supplyDemandRatio"), aba = p("abaTop3Share"), spr = p("spr"), bid = p("suggestedBid");
    const rationalScores = { S1: p("searchVolume"), S2: p("growth"), S3: sdr !== null && aba !== null ? add(scale(sdr, BigInt(3), BigInt(5)), scale(aba, BigInt(2), BigInt(5))) : null, S4: spr !== null && bid !== null ? scale(add(spr, bid), BigInt(1), BigInt(2)) : null, S5: p("averagePrice") };
    const scores = Object.fromEntries(Object.entries(rationalScores).map(([field, value]) => [field, display(value)])) as Record<KeywordScoreComponent, number | null>;
    const exactScores = Object.fromEntries(Object.entries(rationalScores).map(([field, value]) => [field, exact(value)])) as Record<KeywordScoreComponent, KeywordExactFraction | null>;
    const missingComponents = (Object.keys(rationalScores) as KeywordScoreComponent[]).filter(field => rationalScores[field] === null);
    // Count-derived mid-rank fractions and every subsequent weight remain exact.
    // Numeric display conversion never feeds rankings, quadrants or thresholds.
    const weights = { S1: BigInt(28), S2: BigInt(22), S3: BigInt(20), S4: BigInt(18), S5: BigInt(12) };
    const rationalPvs = missingComponents.length ? null : (Object.keys(weights) as KeywordScoreComponent[]).reduce((sum, field) => add(sum, scale(rationalScores[field]!, weights[field], BigInt(100))), ratio(BigInt(0)));
    const pvs = display(rationalPvs);
    const q = quadrant(rationalScores.S1, rationalScores.S3);
    const tierReasons: string[] = [];
    let tier: KeywordClusterScore["keywordValidationTier"] = null;
    if (row.metrics.w5.diagnosis !== null) {
      tier = "P4";
      tierReasons.push(row.metrics.w5.diagnosis);
    } else if (rationalPvs !== null) {
      let tierNumber = atLeast(rationalPvs, 70) ? 1 : atLeast(rationalPvs, 55) ? 2 : atLeast(rationalPvs, 40) ? 3 : 4;
      if (q === "red-ocean") { tierNumber = Math.max(tierNumber, 2); tierReasons.push("red-ocean-cap-P2"); }
      if (q === "defer-zone") { tierNumber = Math.max(tierNumber, 3); tierReasons.push("defer-zone-cap-P3"); }
      tier = (["P1", "P2", "P3", "P4"] as const)[tierNumber - 1];
    }
    const limitations: string[] = [];
    if (row.growth.basis === "yoy-only" || row.growth.basis === "three-month-only") limitations.push("growth-source-incomplete");
    if (mixedGrowthBasis) limitations.push("mixed-growth-basis-in-comparison-pool");
    if (row.aggregate.yoyGrowth.unknownValueCount > 0) limitations.push("partial-member-yoy-coverage");
    if (Object.values(ranks).some(r => r.valuePercent !== null && !r.discriminating)) limitations.push("non-discriminating-metric-pool");
    const share = row.aggregate.totalSearchVolume !== null && row.aggregate.searchVolumeShareDenominator !== null && row.aggregate.searchVolumeShareDenominator > 0
      ? ratio(BigInt(100) * BigInt(row.aggregate.totalSearchVolume), BigInt(row.aggregate.searchVolumeShareDenominator)) : null;
    return {
      clusterId: row.clusterId, memberIds: row.aggregate.memberIds, growth: row.growth, ranks, scores, exactScores, scoreUnit: "percent", pvs, exactPvs: exact(rationalPvs),
      status: pvs === null ? "pending" : "computed", missingComponents, quadrant: q,
      demandClass: demandClass(share, rationalScores.S1, rationalScores.S2, rationalScores.S3),
      keywordValidationTier: tier, tierReasons,
      searchVolumeSharePercent: row.aggregate.searchVolumeSharePercent,
      searchVolumeShareDenominator: row.aggregate.searchVolumeShareDenominator,
      limitations,
    };
  });
  return {
    schemaVersion: "keyword-demand-score/v1", precisionPolicy: "canonical-decimal-input/exact-rational-comparison", input, aggregation, clusters,
    interpretation: "Historical heuristic validation ranking; not probability, profit or VOC priority",
    priceScoreMeaning: "Relative selling-price position; not margin",
  };
}
