import assert from "node:assert/strict";
import test from "node:test";
import { sameTrafficDetailScope, type TrafficDetailScope } from "../../app/lib/traffic-detail-view";
import { trafficDisplayFromSnapshot } from "../../app/sif-listing-traffic-data";

const scope: TrafficDetailScope = {
  organizationId: "org", projectId: "project", runId: "run", jobId: "job",
  marketplace: "US", asin: "B0C4XRN398", evidenceId: "sha256:evidence",
};

test("traffic detail scope requires every non-empty trusted identity field", () => {
  assert.equal(sameTrafficDetailScope(scope, scope), true);
  assert.equal(sameTrafficDetailScope(scope, null), false);
  for (const key of Object.keys(scope) as Array<keyof TrafficDetailScope>) {
    assert.equal(sameTrafficDetailScope(scope, { ...scope, [key]: "different" }), false, key);
    assert.equal(sameTrafficDetailScope({ ...scope, [key]: "" }, scope), false, `${key} empty`);
  }
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
  assert.equal(missing.detailAvailability?.[scope.asin], "missing");

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
  assert.equal(rejected.detailAvailability?.[scope.asin], "invalid-scope");
});
