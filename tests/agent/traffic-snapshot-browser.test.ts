import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { createTrafficSnapshotOwner } from "../../app/lib/traffic-snapshot-browser";

const runId = "10000000-0000-4000-8000-000000000003";
const asins = ["B0C4XRN398"];
const nextRunId = "10000000-0000-4000-8000-000000000004";
const nextAsins = ["B07VY9Q95Q"];
const identity = { sessionIdentity: "session-a", organizationId: "org-a", logoutPending: false };

function dynamicPayload() {
  return {
    version: "1",
    state: "ready",
    marketplace: "US",
    asins,
    source: "sif",
    collectedAt: "2026-08-22T00:00:00.000Z",
    traffic: {
      competitors: [{
        asin: asins[0], brand: "Example", trafficRank: 1, trafficVolume: 1200,
        naturalVolume: 800, naturalShare: 66.7, advertisingVolume: 400, advertisingShare: 33.3,
        top1Share: 60, top3Share: 100, hhi: 5200, effectiveChildren: 2, childCount: 3,
        recommendationTraffic: 90, maxAdvertisingChannel: "SP(常规)", maxAdvertisingChannelShare: 70,
        effectiveAdvertisingChannels: 2, pullGrade: "中", naturalGrade: "中强", advertisingGrade: "中",
        recommendationGrade: "中", variantGrade: "中", health: "健康",
        monthlyTrend: [{ month: "2026-08", natural: 800, advertising: 400, total: 1200 }],
      }],
    },
  };
}

test("the current-run dynamic snapshot is preferred without a build or reload request", async () => {
  const requests: string[] = [];
  const states: string[] = [];
  const owner = createTrafficSnapshotOwner({
    ...identity, runId, marketplace: "US", asins,
    request: async (path) => {
      requests.push(path);
      return { ok: true, status: 200, json: async () => dynamicPayload() };
    },
    onState: (state) => states.push(state.kind),
  });
  await owner.refresh();
  assert.deepEqual(requests, [`/v1/runs/${runId}/traffic-snapshot`]);
  assert.deepEqual(states, ["dynamic"]);
  assert.equal(owner.current().kind, "dynamic");
});

test("a 404 retains a visibly labeled legacy fallback", async () => {
  const owner = createTrafficSnapshotOwner({
    ...identity, runId, marketplace: "US", asins,
    request: async () => ({ ok: false, status: 404, json: async () => ({ error: { code: "NOT_FOUND" } }) }),
  });
  await owner.refresh();
  assert.deepEqual(owner.current(), { kind: "legacy", label: "legacy" });
});

test("a later matching snapshot replaces the fallback without reload", async () => {
  let attempt = 0;
  const requests: string[] = [];
  const owner = createTrafficSnapshotOwner({
    ...identity, runId, marketplace: "US", asins,
    request: async (path) => {
      requests.push(path);
      attempt += 1;
      return attempt === 1
        ? { ok: false, status: 404, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => dynamicPayload() };
    },
  });
  await owner.refresh();
  await owner.refresh();
  assert.equal(owner.current().kind, "dynamic");
  assert.equal(requests.length, 2);
});

test("mismatched dynamic data is not adopted", async () => {
  const owner = createTrafficSnapshotOwner({
    ...identity, runId, marketplace: "US", asins,
    request: async () => ({ ok: true, status: 200, json: async () => ({ ...dynamicPayload(), asins: ["B07VY9Q95Q"] }) }),
  });
  await owner.refresh();
  assert.equal(owner.current().kind, "pending");
});

test("identity transition clears old dynamic data before the next read resolves", async () => {
  let phase: "first" | "mismatch" | "next" = "first";
  const requests: string[] = [];
  const owner = createTrafficSnapshotOwner({
    ...identity, runId, marketplace: "US", asins,
    request: async (path) => {
      requests.push(path);
      if (phase === "first") return { ok: true, status: 200, json: async () => dynamicPayload() };
      if (phase === "mismatch") return { ok: true, status: 200, json: async () => dynamicPayload() };
      return { ok: true, status: 200, json: async () => ({ ...dynamicPayload(), asins: nextAsins }) };
    },
  });
  await owner.refresh();
  assert.equal(owner.current().kind, "dynamic");

  phase = "mismatch";
  owner.rebind({ ...identity, runId: nextRunId, marketplace: "US", asins: nextAsins });
  assert.equal(owner.current().kind, "pending");
  await owner.refresh();
  assert.equal(owner.current().kind, "pending");

  phase = "next";
  await owner.refresh();
  assert.equal(owner.current().kind, "dynamic");
  assert.deepEqual(requests, [
    `/v1/runs/${runId}/traffic-snapshot`,
    `/v1/runs/${nextRunId}/traffic-snapshot`,
    `/v1/runs/${nextRunId}/traffic-snapshot`,
  ]);
});

test("session, organization, and logout transitions clear state and reject late responses", async () => {
  let resolve!: (value: { ok: boolean; status: number; json(): Promise<unknown> }) => void;
  let requests = 0;
  const owner = createTrafficSnapshotOwner({
    ...identity, runId, marketplace: "US", asins,
    request: () => { requests += 1; return new Promise(done => { resolve = done; }); },
  });
  const pending = owner.refresh();
  owner.rebind({ ...identity, sessionIdentity: "session-b", runId, marketplace: "US", asins });
  assert.equal(owner.current().kind, "pending");
  resolve({ ok: true, status: 200, json: async () => dynamicPayload() });
  await pending;
  assert.equal(owner.current().kind, "pending");

  owner.rebind({ ...identity, organizationId: "org-b", runId, marketplace: "US", asins });
  owner.rebind({ ...identity, organizationId: "org-b", logoutPending: true, runId, marketplace: "US", asins });
  await owner.refresh();
  assert.equal(requests, 1);
  assert.equal(owner.current().kind, "pending");
});

test("page traffic wiring binds authenticated identity and never falls back to global traffic rows", () => {
  const source = readFileSync(new URL("../../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /sessionIdentity: authSession\.sessionIdentity/);
  assert.match(source, /organizationId: authSession\.user\.organizationId/);
  assert.match(source, /logoutPending: authSession\.logoutPending/);
  assert.doesNotMatch(source, /overview:\s*sifListingTrafficOverview/);
  assert.match(source, /trafficDisplayFromSnapshot\(trafficSnapshotState\.snapshot, trustedTrafficDetailInput\)/);
});
