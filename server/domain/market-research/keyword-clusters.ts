/** Original members of one already-scoped, immutable keyword pool. */
export interface KeywordRecord {
  readonly id: string;
  readonly text: string;
  readonly searchVolume: number | null;
  readonly cpc: number | null;
  /** Fractional change: -1 = -100%, 0.2 = +20%; never a percentage or multiplier. */
  readonly yoyGrowth: number | null;
  /** Same fractional-change unit as yoyGrowth. */
  readonly recentGrowth: number | null;
}

export interface KeywordClusterMapping {
  readonly keywordId: string;
  readonly clusterId: string;
}

export interface KeywordWeightedMetric {
  readonly value: number | null;
  /** This metric's own denominator: known metric value and positive known volume. */
  readonly weightSum: number;
  readonly weightedMemberCount: number;
  /** Known values include members whose zero/unknown volume prevents weighting. */
  readonly knownValueCount: number;
  readonly unknownValueCount: number;
}

export interface KeywordPoolVolume {
  readonly memberIds: readonly string[];
  readonly memberCount: number;
  /** Null when any member's volume is unknown; zero is a known, empty/zero sum. */
  readonly totalSearchVolume: number | null;
  readonly knownSearchVolume: number;
  readonly knownSearchVolumeCount: number;
  readonly unknownSearchVolumeCount: number;
}

export interface KeywordClusterSummary extends KeywordPoolVolume {
  /** Null is reserved for the separately returned unassigned members. */
  readonly clusterId: string | null;
  /** 0–100 percent of the full input pool, including unassigned members. */
  readonly searchVolumeSharePercent: number | null;
  /** Full-pool volume; an unknown or zero denominator yields a null share. */
  readonly searchVolumeShareDenominator: number | null;
  readonly cpc: KeywordWeightedMetric;
  /** Values retain fractional-change units; no percentage conversion. */
  readonly yoyGrowth: KeywordWeightedMetric;
  readonly recentGrowth: KeywordWeightedMetric;
}

export interface AggregateKeywordClustersInput {
  readonly keywords: readonly KeywordRecord[];
  readonly mappings: readonly KeywordClusterMapping[];
}

export interface KeywordClusterAggregation {
  readonly pool: KeywordPoolVolume;
  readonly clusters: readonly KeywordClusterSummary[];
  readonly unassigned: KeywordClusterSummary;
}

type MetricField = "cpc" | "yoyGrowth" | "recentGrowth";
const compareIds = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function assertIdentity(value: string, field: string): void {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw new TypeError(`${field} must be a non-empty identity without surrounding whitespace`);
  }
}

function assertMetric(value: number | null, field: string, minimum: number): void {
  if (value === null) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new TypeError(`${field} must be null or a finite number within its safe numeric range (minimum ${minimum})`);
  }
}

function addVolume(sum: number, volume: number): number {
  // Check before addition: MAX_SAFE_INTEGER + 0.1 rounds back to MAX_SAFE_INTEGER.
  if (volume > Number.MAX_SAFE_INTEGER - sum) {
    throw new RangeError("Aggregated searchVolume exceeds the safe numeric range");
  }
  const next = sum + volume;
  if (!Number.isFinite(next) || next > Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Aggregated searchVolume exceeds the safe numeric range");
  }
  return next;
}

function volumeSummary(members: readonly KeywordRecord[]): KeywordPoolVolume {
  let knownSearchVolume = 0;
  let unknownSearchVolumeCount = 0;
  for (const member of members) {
    if (member.searchVolume === null) unknownSearchVolumeCount += 1;
    else knownSearchVolume = addVolume(knownSearchVolume, member.searchVolume);
  }
  return {
    memberIds: members.map(member => member.id),
    memberCount: members.length,
    totalSearchVolume: unknownSearchVolumeCount ? null : knownSearchVolume,
    knownSearchVolume,
    knownSearchVolumeCount: members.length - unknownSearchVolumeCount,
    unknownSearchVolumeCount,
  };
}

/** Neumaier summation keeps small terms when large signed terms later cancel. */
function compensatedSum(values: readonly number[]): number {
  let sum = 0;
  let correction = 0;
  for (const value of values) {
    const next = sum + value;
    correction += Math.abs(sum) >= Math.abs(value)
      ? (sum - next) + value
      : (value - next) + sum;
    sum = next;
  }
  return sum + correction;
}

function weightedMetric(members: readonly KeywordRecord[], field: MetricField): KeywordWeightedMetric {
  let knownValueCount = 0;
  let weightSum = 0;
  let maxWeight = 0;
  const weighted: Array<{ value: number; weight: number }> = [];
  for (const member of members) {
    const memberValue = member[field];
    if (memberValue === null) continue;
    knownValueCount += 1;
    if (member.searchVolume === null || member.searchVolume <= 0) continue;
    weightSum = addVolume(weightSum, member.searchVolume);
    maxWeight = Math.max(maxWeight, member.searchVolume);
    weighted.push({ value: memberValue, weight: member.searchVolume });
  }
  let value: number | null = null;
  if (weighted.length) {
    weightSum = compensatedSum(weighted.map(member => member.weight));
    assertMetric(weightSum, "Aggregated searchVolume", 0);
    // With validated values and total weight <= MAX_SAFE_INTEGER, unscaled
    // products/sums stay far below Number.MAX_VALUE. Divide once at the end:
    // do not subtract a huge previous mean or sum individually normalized -1s.
    // Scaling only tiny total weights upward prevents product underflow; the
    // same scale is applied to the numerator and this field's denominator.
    const scale = weightSum < 1 ? maxWeight : 1;
    const denominator = compensatedSum(weighted.map(member => member.weight / scale));
    const numerator = compensatedSum(weighted.map(member => member.value * (member.weight / scale)));
    value = numerator / denominator;
  }
  assertMetric(value, `Aggregated ${field}`, field === "cpc" ? 0 : -1);
  return {
    value,
    weightSum,
    weightedMemberCount: weighted.length,
    knownValueCount,
    unknownValueCount: members.length - knownValueCount,
  };
}

function clusterSummary(clusterId: string | null, members: readonly KeywordRecord[], pool: KeywordPoolVolume): KeywordClusterSummary {
  const volume = volumeSummary(members);
  return {
    clusterId,
    ...volume,
    searchVolumeSharePercent: pool.totalSearchVolume !== null && pool.totalSearchVolume > 0 && volume.totalSearchVolume !== null
      ? volume.totalSearchVolume / pool.totalSearchVolume * 100
      : null,
    searchVolumeShareDenominator: pool.totalSearchVolume,
    cpc: weightedMetric(members, "cpc"),
    yoyGrowth: weightedMetric(members, "yoyGrowth"),
    recentGrowth: weightedMetric(members, "recentGrowth"),
  };
}

/**
 * Recompute from original records after every mapping change. Never average prior
 * cluster means or infer semantic membership; each keyword ID may appear only once.
 * The caller owns marketplace/category/period/currency consistency for this pool.
 */
export function aggregateKeywordClusters(input: AggregateKeywordClustersInput): KeywordClusterAggregation {
  if (!Array.isArray(input?.keywords) || !Array.isArray(input?.mappings)) {
    throw new TypeError("keywords and mappings must be arrays");
  }
  const ids = new Set<string>();
  for (const member of input.keywords) {
    assertIdentity(member?.id, "keyword id");
    if (ids.has(member.id)) throw new TypeError("Duplicate keyword id");
    ids.add(member.id);
    if (typeof member.text !== "string" || !member.text.trim()) throw new TypeError("keyword text must be non-empty");
    assertMetric(member.searchVolume, "searchVolume", 0);
    assertMetric(member.cpc, "cpc", 0);
    assertMetric(member.yoyGrowth, "yoyGrowth", -1);
    assertMetric(member.recentGrowth, "recentGrowth", -1);
  }
  const assignments = new Map<string, string>();
  for (const mapping of input.mappings) {
    assertIdentity(mapping?.keywordId, "mapping keywordId");
    assertIdentity(mapping.clusterId, "mapping clusterId");
    if (!ids.has(mapping.keywordId)) throw new TypeError("Unknown keyword in mapping");
    if (assignments.has(mapping.keywordId)) throw new TypeError("Duplicate mapping for keyword id");
    assignments.set(mapping.keywordId, mapping.clusterId);
  }
  // Code-point order provides reproducible floating-point accumulation and output.
  const members = [...input.keywords].sort((a, b) => compareIds(a.id, b.id));
  const pool = volumeSummary(members);
  const groups = new Map<string, KeywordRecord[]>();
  const unassigned: KeywordRecord[] = [];
  for (const member of members) {
    const clusterId = assignments.get(member.id);
    if (clusterId === undefined) unassigned.push(member);
    else {
      const group = groups.get(clusterId) ?? [];
      group.push(member);
      groups.set(clusterId, group);
    }
  }
  return {
    pool,
    clusters: [...groups.entries()].sort(([a], [b]) => compareIds(a, b))
      .map(([clusterId, group]) => clusterSummary(clusterId, group, pool)),
    unassigned: clusterSummary(null, unassigned, pool),
  };
}
