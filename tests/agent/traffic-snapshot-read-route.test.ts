import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentApp } from "../../server/app";
import type { AuthenticatedPrincipal } from "../../server/auth/authentication-service";
import type { AgentAuthenticationConfig } from "../../server/config";
import type { LocalDataBridgeDeps } from "../../server/routes/local-data";

const origin = "http://127.0.0.1:31900";
const proxyToken = "route-test-token";
const sessionToken = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const organizationId = "10000000-0000-4000-8000-000000000001";
const foreignOrganizationId = "10000000-0000-4000-8000-000000000002";
const runId = "10000000-0000-4000-8000-000000000003";
const missingRunId = "10000000-0000-4000-8000-000000000004";
const asin = "B0C4XRN398";

const authConfig: AgentAuthenticationConfig = {
  mode: "authenticated",
  cookie: { name: "__Host-agent_session", secure: true, maxAgeSeconds: 28_800 },
  sessionTtlMs: 28_800_000,
  loginLimiter: { windowMs: 900_000, maxFailures: 5, maxEntries: 10_000 },
};

class FakeAuthService {
  constructor(private readonly principal: AuthenticatedPrincipal) {}
  async authenticate(token: string | null) {
    return token === sessionToken ? this.principal : null;
  }
}

function principal(): AuthenticatedPrincipal {
  return { kind: "user", userId: "10000000-0000-4000-8000-000000000005", organizationId, email: "member@example.com", role: "member", sessionId: "10000000-0000-4000-8000-000000000006" };
}

function headers() {
  return { origin, "x-agent-proxy-token": proxyToken, cookie: `__Host-agent_session=${sessionToken}` };
}

function trafficSnapshot() {
  return {
    marketplace: "US" as const,
    asins: [asin],
    source: "sif" as const,
    collectedAt: "2026-08-22T00:00:00.000Z",
    traffic: {
      competitors: [{
        asin, brand: "Example", trafficRank: 1, trafficVolume: 1200,
        naturalVolume: 800, naturalShare: 66.7, advertisingVolume: 400, advertisingShare: 33.3,
        top1Share: 60, top3Share: 100, hhi: 5200, effectiveChildren: 2, childCount: 3,
        recommendationTraffic: 90, maxAdvertisingChannel: "SP(常规)", maxAdvertisingChannelShare: 70,
        effectiveAdvertisingChannels: 2, pullGrade: "中" as const, naturalGrade: "中强" as const,
        advertisingGrade: "中" as const, recommendationGrade: "中" as const, variantGrade: "中" as const,
        health: "健康" as const, monthlyTrend: [{ month: "2026-08", natural: 800, advertising: 400, total: 1200 }],
      }],
    },
  };
}

function deps(read: LocalDataBridgeDeps["readTrafficSnapshot"]): LocalDataBridgeDeps {
  return {
    async fetchProjects() { return []; }, async fetchProject() { return null; },
    async createAnalysisProject() { throw new Error("unused"); }, async updateAnalysisProject() { return null; },
    async deleteAnalysisProject() { return false; }, async normalizeAsins() { return null; },
    async fetchAsinDataStatus() { return []; }, async startAsinSyncJob() { throw new Error("unused"); },
    async readJob() { return null; }, readTrafficSnapshot: read,
  };
}

function appWith(read: LocalDataBridgeDeps["readTrafficSnapshot"]) {
  return buildAgentApp({
    env: { AGENT_SERVICE_PROXY_TOKEN: proxyToken, AGENT_SERVICE_TRUSTED_ORIGINS: origin, AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK: undefined },
    authConfig,
    authService: new FakeAuthService(principal()) as never,
    localDataBridgeDeps: deps(read),
  });
}

test("same-organization traffic reads return only normalized view data", async (t) => {
  const app = appWith(async (request) => request.organizationId === organizationId && request.runId === runId ? trafficSnapshot() : null);
  t.after(() => app.close());
  const response = await app.inject({ method: "GET", url: `/v1/runs/${runId}/traffic-snapshot`, headers: headers() });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.version, "1");
  assert.equal(body.state, "ready");
  assert.deepEqual(body.asins, [asin]);
  assert.equal("snapshotId" in body, false);
  assert.equal("contentHash" in body, false);
  assert.equal("payload" in body, false);
  assert.equal("runId" in body, false);
});

test("foreign and missing traffic snapshots are existence-indistinguishable", async (t) => {
  const app = appWith(async (request) => request.organizationId === foreignOrganizationId ? trafficSnapshot() : null);
  t.after(() => app.close());
  const [foreign, missing] = await Promise.all([
    app.inject({ method: "GET", url: `/v1/runs/${runId}/traffic-snapshot`, headers: headers() }),
    app.inject({ method: "GET", url: `/v1/runs/${missingRunId}/traffic-snapshot`, headers: headers() }),
  ]);
  assert.equal(foreign.statusCode, 404);
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(
    { code: foreign.json().error.code, message: foreign.json().error.message },
    { code: missing.json().error.code, message: missing.json().error.message },
  );
});

test("a run without a snapshot returns the explicit pending/not-found contract", async (t) => {
  const app = appWith(async () => null);
  t.after(() => app.close());
  const response = await app.inject({ method: "GET", url: `/v1/runs/${runId}/traffic-snapshot`, headers: headers() });
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json().error.code, "NOT_FOUND");
  assert.equal(response.json().error.message, "Traffic snapshot is pending");
});
