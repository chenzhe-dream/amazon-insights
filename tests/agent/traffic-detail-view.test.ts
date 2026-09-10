import assert from "node:assert/strict";
import test from "node:test";
import { sameTrafficDetailScope, mergeTrafficRecord, trafficStageFromReceipt, formatTrafficScore, formatTrafficPercent, trafficDetailMessage, trafficChildCountLabel, type TrafficDetailScope, type TrafficStageReceipt } from "../../app/lib/traffic-detail-view";
import { trafficDisplayFromSnapshot } from "../../app/sif-listing-traffic-data";
import { buildTrafficAnalysisConclusion } from "../../app/traffic-analysis-conclusion";
import { sifListingTrafficMeta } from "../../app/sif-listing-traffic-data";
import { buildStageOutputView } from '../../app/lib/stage-output-view';

test('same-batch collection atomically overrides summary and resists stale stage totals', () => {
  const asin = 'B01E6CX34C';
  const record = { totalScore: 900, naturalAd: [{ label: '自然流量', score: 600, ratio: 66.7 }, { label: '广告流量', score: 300, ratio: 33.3 }], adChannels: [{ label: 'SP(常规)', score: 300, ratio: 100 }], recommendationSources: [], children: [], updatedThrough: '2026-09-10' };
  const snapshot = { marketplace: 'US', asins: [asin], collectedAt: '2026-09-09T00:00:00.000Z', traffic: { competitors: [{ asin, trafficVolume: 100, naturalVolume: 50, naturalShare: 50, advertisingVolume: 50, advertisingShare: 50, childCount: 10, monthlyTrend: [{ month: '2026-08', natural: 1, advertising: 2, total: 3 }] }] }, listingCollection: { id: '10000000-0000-4000-8000-000000000001', schemaVersion: '1', source: 'sif', period: '近30天', collectedAt: '2026-09-10T00:00:00.000Z', marketplace: 'US', asins: [asin], records: { [asin]: record } } };
  const trafficData = trafficDisplayFromSnapshot(snapshot as never);
  assert.equal(trafficData.overview[asin]?.totalScore, 900);
  assert.equal(trafficData.overview[asin]?.childCount, 0);
  assert.equal(trafficData.monthlyTrend[asin].points[0].total, 3);
  for (const old of [{ total: 777, natural: 666, advertising: 111 }, { ...record, totalScore: 888, adChannels: [] }]) {
    const result = buildStageOutputView({ traffic: { data: { listingByAsin: { [asin]: old }, monthlyByAsin: {} } } } as never, { trafficData } as never);
    assert.equal(result.trafficData.overview[asin]?.totalScore, 900);
    assert.deepEqual(result.trafficData.overview[asin]?.adChannels, record.adChannels);
  }
});

const scope: TrafficDetailScope = {
  organizationId: "org", projectId: "project", runId: "run", jobId: "job",
  marketplace: "US", asin: "B0C4XRN398", evidenceId: "sha256:evidence",
};

test("traffic formatters preserve zero, round display values and reject invalid numbers", () => {
  for (const invalid of [undefined, null, -1, NaN, Infinity, -Infinity]) {
    assert.equal(formatTrafficScore(invalid), "—");
    assert.equal(formatTrafficPercent(invalid), "—");
  }
  assert.equal(formatTrafficScore(0), "0");
  assert.equal(formatTrafficScore(128266.49784446), "128,266");
  assert.equal(formatTrafficScore(141360.96935435), "141,361");
  assert.equal(formatTrafficPercent(0), "0.0%");
  assert.equal(formatTrafficPercent(100), "100.0%");
  assert.equal(formatTrafficPercent(100.001), "—");
  assert.equal(formatTrafficPercent(47.5717474844), "47.6%");
  assert.equal(formatTrafficPercent(58.5300664580), "58.5%");
});

test("traffic status text distinguishes missing, invalid and authoritative empty details", () => {
  const empty = mergeTrafficRecord({ children: [] }).overview!;
  const known = { ...empty, childCount: 11 };
  assert.equal(trafficDetailMessage(), "明细待补齐");
  assert.equal(trafficDetailMessage("missing"), "明细待补齐");
  assert.equal(trafficDetailMessage("empty"), "已返回，无符合条件的明细");
  assert.equal(trafficDetailMessage("invalid"), "数据格式异常，明细待补齐");
  assert.equal(trafficChildCountLabel(empty, "empty"), "0 个子体");
  assert.equal(trafficChildCountLabel(known, "complete"), "0 个子体");
  assert.equal(trafficChildCountLabel(known, "missing"), "已识别 11 个子体，明细待补齐");
  assert.equal(trafficChildCountLabel(known, "invalid"), "已识别 11 个子体，明细待补齐");
  assert.equal(trafficChildCountLabel(null), "子体数据待补齐");
  assert.equal(trafficChildCountLabel({ ...empty, childCount: 0 }), "子体数据待补齐");
});

test("missing natural/ad distribution is not graded as zero traffic", () => {
  const merged = mergeTrafficRecord({ totalScore: 100, adChannels: [], recommendationSources: [], children: [] });
  const conclusion = buildTrafficAnalysisConclusion([{ asin: scope.asin, brand: "fixture" }], {
    overview: { [scope.asin]: merged.overview }, detailAvailability: { [scope.asin]: merged.availability }, monthlyTrend: {}, meta: sifListingTrafficMeta,
  });
  assert.equal(conclusion.overview.length, 0);
});

test("traffic detail scope requires every non-empty trusted identity field", () => {
  assert.equal(sameTrafficDetailScope(scope, scope), true);
  assert.equal(sameTrafficDetailScope(scope, null), false);
  for (const key of Object.keys(scope) as Array<keyof TrafficDetailScope>) {
    assert.equal(sameTrafficDetailScope(scope, { ...scope, [key]: "different" }), false, key);
    assert.equal(sameTrafficDetailScope({ ...scope, [key]: "" }, scope), false, `${key} empty`);
  }
});

test("field states survive summary merges and reject malformed elements without hiding other fields", () => {
  const raw = { totalScore: 900, naturalAd: [{ label: "自然流量", score: 600, ratio: 66.7 }, { label: "广告流量", score: 300, ratio: 33.3 }],
    adChannels: [{ label: "SP(常规)", score: 300, ratio: 100 }], recommendationSources: [],
    children: [{ asin: "B000000001", label: "A", image: "", totalScore: 90, sharePct: 10, organic: 60, sp: 30, spRecommend: 0, sb: 0, sbv: 0 }], updatedThrough: "2026-08-01" };
  const full = mergeTrafficRecord(raw);
  const compact = mergeTrafficRecord({ total: 900 }, full.overview, full.availability);
  assert.deepEqual(compact.overview?.children, raw.children);
  assert.equal(compact.availability.children, "complete");
  const summaryFirst = mergeTrafficRecord({ total: 900, natural: 600 });
  assert.equal(summaryFirst.availability.children, "missing");
  assert.deepEqual(mergeTrafficRecord(raw, summaryFirst.overview, summaryFirst.availability), full);
  const zero = mergeTrafficRecord({ total: 0, natural: 0, advertising: 0 }, full.overview, full.availability);
  assert.deepEqual(zero.overview?.naturalAd.map(row => row.ratio), [0, 0]);
  for (const invalid of [null, -1, NaN, Infinity, "900"]) assert.equal(mergeTrafficRecord({ total: invalid }, full.overview).overview?.totalScore, null);
  assert.equal(mergeTrafficRecord({ natural: 5 }).overview?.totalScore, null);
  assert.equal(mergeTrafficRecord({ total: 900 }).availability.children, "missing");
  const malformed = mergeTrafficRecord({ children: [null], adChannels: [], updatedThrough: null }, full.overview, full.availability);
  assert.deepEqual(malformed.availability, { children: "invalid", adChannels: "empty", recommendationSources: "empty" });
  assert.equal(malformed.overview?.updatedThrough, null);
  assert.equal(malformed.overview?.totalScore, 900);
  for (const child of [{}, { ...raw.children[0], asin: "bad" }, { ...raw.children[0], sp: undefined }]) {
    assert.equal(mergeTrafficRecord({ children: [child] }).availability.children, "invalid");
  }
  assert.deepEqual(raw.children[0]?.sp, 30, "source is not mutated");
});

test("captured stage receipts cannot be relabeled across owner identity or task changes", () => {
  const receipt = { scopeKey: "session-a|org-a|US", snapshot: { traffic: { stage: "traffic", projectId: "p", runId: "r", jobId: "j", data: { listingByAsin: {} } } } } as unknown as TrafficStageReceipt;
  const expected = { scopeKey: receipt.scopeKey, projectId: "p", runId: "r", jobId: "j", enabled: true };
  assert.ok(trafficStageFromReceipt(receipt, expected).traffic);
  for (const scopeKey of ["session-b|org-a|US", "session-a|org-b|US", "session-a|org-a|UK"]) assert.deepEqual(trafficStageFromReceipt(receipt, { ...expected, scopeKey }), {});
  for (const key of ["projectId", "runId", "jobId"] as const) assert.deepEqual(trafficStageFromReceipt(receipt, { ...expected, [key]: "other" }), {});
  assert.deepEqual(trafficStageFromReceipt(receipt, { ...expected, enabled: false }), {});
  assert.deepEqual(trafficStageFromReceipt(null, expected), {});
});

test("snapshot keeps exact summary and child count without fabricating detail", () => {
  const snapshot = {
    version: "1", state: "ready", marketplace: "US", asins: [scope.asin], source: "sif",
    collectedAt: "2026-09-09T00:00:00.000Z",
    traffic: { competitors: [{
      asin: scope.asin, brand: "A", trafficRank: 1, trafficVolume: 1200, naturalVolume: 800, naturalShare: 66.7,
      advertisingVolume: 400, advertisingShare: 33.3, top1Share: 50, top3Share: 80, hhi: 4000,
      effectiveChildren: 3, childCount: 11, recommendationTraffic: 90, maxAdvertisingChannel: "SP(常规)",
      maxAdvertisingChannelShare: 70, effectiveAdvertisingChannels: 2, pullGrade: "中", naturalGrade: "中强",
      advertisingGrade: "中", recommendationGrade: "中", variantGrade: "中", health: "健康",
      monthlyTrend: [],
    }] },
  } as never;
  const missing = trafficDisplayFromSnapshot(snapshot);
  assert.equal(missing.overview[scope.asin]?.totalScore, 1200);
  assert.equal(missing.overview[scope.asin]?.childCount, 11);
  assert.deepEqual(missing.overview[scope.asin]?.adChannels, []);
  assert.deepEqual(missing.overview[scope.asin]?.recommendationSources, []);
  assert.deepEqual(missing.detailAvailability?.[scope.asin], {
    adChannels: "missing", recommendationSources: "missing", children: "missing",
  });

  const detail = { totalScore: 999, naturalAd: [], adChannels: [{ label: "SP(常规)", score: 123, ratio: 30 }], recommendationSources: [], children: [], updatedThrough: null };
  const scoped = trafficDisplayFromSnapshot(snapshot, {
    expectedScopeByAsin: { [scope.asin]: scope }, candidateByAsin: { [scope.asin]: { scope, overview: detail } },
  });
  assert.deepEqual(scoped.overview[scope.asin]?.adChannels, detail.adChannels);
  assert.equal(scoped.overview[scope.asin]?.totalScore, 1200);

  const rejected = trafficDisplayFromSnapshot(snapshot, {
    expectedScopeByAsin: { [scope.asin]: scope },
    candidateByAsin: { [scope.asin]: { scope: { ...scope, runId: "other" }, overview: detail } },
  });
  assert.deepEqual(rejected.overview[scope.asin]?.adChannels, []);
  assert.deepEqual(rejected.detailAvailability?.[scope.asin], {
    adChannels: "invalid", recommendationSources: "invalid", children: "invalid",
  });
});
