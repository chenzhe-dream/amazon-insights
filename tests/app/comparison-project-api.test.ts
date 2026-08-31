import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createComparisonFavoriteRoute } from "../../app/api/comparison-favorites/[projectId]/route";
import { createComparisonProjectRoute } from "../../app/api/comparison-projects/[projectId]/route";
import { createComparisonProjectsRoute } from "../../app/api/comparison-projects/route";
import { createProjectFavoriteStore } from "../../scripts/lib/project-favorite-store.mjs";

const ORIGIN = "http://127.0.0.1:31900";
const COOKIE = "__Host-agent_session=EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE";
const ORGANIZATION_A = "93000000-0000-4000-8000-000000000001";
const ORGANIZATION_B = "93000000-0000-4000-8000-000000000002";
const USER_A = "93000000-0000-4000-8000-000000000003";
const PROJECT_A = "93000000-0000-4000-8000-000000000004";
const PROJECT_B = "93000000-0000-4000-8000-000000000005";
const LEGACY_OWNED = "93000000-0000-4000-8000-000000000006";
const LEGACY_FOREIGN = "93000000-0000-4000-8000-000000000007";
const KEY = "comparison.browser:0001";
const ASINS = ["B0AAAA0001", "B0BBBB0002", "B0CCCC0003"];
const now = "2026-08-31T09:00:00.000Z";

const user = {
  id: USER_A,
  organizationId: ORGANIZATION_A,
  email: "member@example.com",
  displayName: "Member",
  role: "member" as const,
  status: "active" as const,
  createdAt: now,
  updatedAt: now,
};
const project = {
  id: PROJECT_A,
  organizationId: ORGANIZATION_A,
  name: "Standing Desk Comparison",
  marketplace: "US" as const,
  asins: ASINS,
  createdBy: USER_A,
  currentRunId: null,
  createdAt: now,
  updatedAt: now,
};

type AgentCall = Readonly<{
  method: string;
  path: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  requestId?: string;
}>;
type AgentResult = Readonly<{ status: number; headers: Headers; body: unknown }>;

function result(status: number, body: unknown): AgentResult {
  return { status, headers: new Headers({ "content-type": "application/json" }), body };
}

function sessionResult() {
  return result(200, { authenticated: true, user, sessionIdentity: "S".repeat(43) });
}

function request(path: string, init: RequestInit = {}) {
  return new Request(`${ORIGIN}${path}`, {
    ...init,
    headers: { origin: ORIGIN, cookie: COOKIE, ...init.headers },
  });
}

test("favorite store writes only the organization-partitioned reference schema", () => {
  const directory = mkdtempSync(join(tmpdir(), "comparison-favorites-"));
  const store = createProjectFavoriteStore({ directory });
  try {
    const favorite = {
      organizationId: ORGANIZATION_A,
      agentProjectId: PROJECT_A,
      kind: "keyword-compare" as const,
      slug: "standing-desk-comparison",
      labels: ["Standing desk", "Priority"],
      asins: ASINS,
      marketplace: "US",
      runId: PROJECT_B,
    };
    store.write(favorite);
    const file = join(directory, ORGANIZATION_A, `${PROJECT_A}.json`);
    const persisted = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(Object.keys(persisted), [
      "organizationId",
      "agentProjectId",
      "kind",
      "slug",
      "labels",
    ]);
    assert.deepEqual(persisted, {
      organizationId: ORGANIZATION_A,
      agentProjectId: PROJECT_A,
      kind: "keyword-compare",
      slug: "standing-desk-comparison",
      labels: ["Standing desk", "Priority"],
    });
    assert.deepEqual(store.list(ORGANIZATION_A), [persisted]);
    assert.deepEqual(store.list(ORGANIZATION_B), []);
    assert.equal(readdirSync(join(directory, ORGANIZATION_A)).length, 1);
    assert.throws(() => store.list("../foreign"), /organization/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("comparison create forwards the client key byte-for-byte and verifies Agent echo before favorite write", async () => {
  const calls: AgentCall[] = [];
  const favorites: unknown[] = [];
  const client = async (call: AgentCall) => {
    calls.push(call);
    if (call.path === "/v1/auth/session") return sessionResult();
    return result(201, { project });
  };
  const route = createComparisonProjectsRoute({
    client,
    favorites: {
      list: () => [],
      write: (favorite) => favorites.push(favorite),
      remove: () => false,
      read: () => null,
    },
  });
  const payload = {
    name: project.name,
    marketplace: "US",
    asins: ASINS,
    kind: "keyword-compare",
    labels: ["Favorite"],
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await route.POST(request("/api/comparison-projects", {
      method: "POST",
      headers: { "Idempotency-Key": KEY },
      body: JSON.stringify(payload),
    }));
    assert.equal(response.status, 201);
    assert.equal((await response.json()).project.id, PROJECT_A);
  }
  const creates = calls.filter((call) => call.path === "/v1/projects");
  assert.equal(creates.length, 2);
  assert.deepEqual(creates.map((call) => new Headers(call.headers).get("idempotency-key")), [KEY, KEY]);
  assert.deepEqual(creates.map((call) => JSON.parse(String(call.body))), [
    { name: project.name, marketplace: "US", asins: ASINS },
    { name: project.name, marketplace: "US", asins: ASINS },
  ]);
  assert.deepEqual(favorites, [
    {
      organizationId: ORGANIZATION_A,
      agentProjectId: PROJECT_A,
      kind: "keyword-compare",
      slug: "standing-desk-comparison-93000000",
      labels: ["Favorite"],
    },
    {
      organizationId: ORGANIZATION_A,
      agentProjectId: PROJECT_A,
      kind: "keyword-compare",
      slug: "standing-desk-comparison-93000000",
      labels: ["Favorite"],
    },
  ]);

  for (const invalidKey of [undefined, "short", "comparison key invalid", "é".repeat(16)]) {
    const before = calls.length;
    const headers = invalidKey ? { "Idempotency-Key": invalidKey } : undefined;
    const response = await route.POST(request("/api/comparison-projects", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    }));
    assert.equal(response.status, 400);
    assert.equal(calls.length, before);
  }
});

test("bad Agent echo never creates a favorite and favorite failure leaves the Agent project retryable", async () => {
  let writes = 0;
  const badEchoRoute = createComparisonProjectsRoute({
    client: async (call) => call.path === "/v1/auth/session"
      ? sessionResult()
      : result(201, { project: { ...project, organizationId: ORGANIZATION_B } }),
    favorites: {
      list: () => [], read: () => null, remove: () => false,
      write: () => { writes += 1; },
    },
  });
  const body = JSON.stringify({
    name: project.name,
    marketplace: "US",
    asins: ASINS,
    kind: "analysis",
    labels: [],
  });
  const badEcho = await badEchoRoute.POST(request("/api/comparison-projects", {
    method: "POST", headers: { "Idempotency-Key": KEY }, body,
  }));
  assert.equal(badEcho.status, 502);
  assert.equal(writes, 0);

  const calls: AgentCall[] = [];
  const failedFavoriteRoute = createComparisonProjectsRoute({
    client: async (call) => {
      calls.push(call);
      return call.path === "/v1/auth/session" ? sessionResult() : result(201, { project });
    },
    favorites: {
      list: () => [], read: () => null, remove: () => false,
      write: () => { throw new Error("disk full"); },
    },
  });
  const failedFavorite = await failedFavoriteRoute.POST(request("/api/comparison-projects", {
    method: "POST", headers: { "Idempotency-Key": KEY }, body,
  }));
  assert.equal(failedFavorite.status, 503);
  assert.deepEqual(await failedFavorite.json(), {
    project,
    favorite: { saved: false, retryable: true },
  });
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [
    "GET /v1/auth/session",
    "POST /v1/projects",
  ]);
});

test("list and delete expose only own favorites and owner-gated legacy metadata without binding", async () => {
  const calls: AgentCall[] = [];
  const ownFavorite = {
    organizationId: ORGANIZATION_A,
    agentProjectId: PROJECT_A,
    kind: "analysis" as const,
    slug: "active-project",
    labels: ["Active"],
  };
  const ownedLegacy = { ...ownFavorite, agentProjectId: LEGACY_OWNED, slug: "owned-legacy" };
  const foreignLegacy = { ...ownFavorite, agentProjectId: LEGACY_FOREIGN, slug: "foreign-legacy" };
  const removed: Array<[string, string]> = [];
  const favorites = {
    list: (organizationId: string) => organizationId === ORGANIZATION_A
      ? [ownFavorite, ownedLegacy, foreignLegacy]
      : [],
    read: (organizationId: string, id: string) =>
      organizationId === ORGANIZATION_A && id === PROJECT_A ? ownFavorite : null,
    write: () => undefined,
    remove: (organizationId: string, id: string) => {
      removed.push([organizationId, id]);
      return organizationId === ORGANIZATION_A && id === PROJECT_A;
    },
  };
  const client = async (call: AgentCall) => {
    calls.push(call);
    if (call.path === "/v1/auth/session") return sessionResult();
    if (call.path === "/v1/projects") return result(200, { projects: [project] });
    if (call.path === `/v1/legacy-projects/${LEGACY_OWNED}/eligibility`) {
      return result(200, {
        legacyProjectId: LEGACY_OWNED,
        ownerOrganizationId: ORGANIZATION_A,
        readOnly: true,
        importAllowed: true,
      });
    }
    return result(404, { error: { code: "NOT_FOUND", message: "Not found", requestId: "agent" } });
  };
  const collection = createComparisonProjectsRoute({ client, favorites });
  const listed = await collection.GET(request("/api/comparison-projects"));
  assert.equal(listed.status, 200);
  assert.deepEqual(await listed.json(), {
    projects: [project],
    favorites: [ownFavorite],
    legacyProjects: [{
      ...ownedLegacy,
      readOnly: true,
      importAllowed: true,
    }],
  });
  assert.equal(calls.some((call) => call.method === "POST" && /legacy/i.test(call.path)), false);

  const favoriteRoute = createComparisonFavoriteRoute({ client, favorites });
  const deleted = await favoriteRoute.DELETE(
    request(`/api/comparison-favorites/${PROJECT_A}`, { method: "DELETE" }),
    { params: Promise.resolve({ projectId: PROJECT_A }) },
  );
  assert.equal(deleted.status, 200);
  assert.deepEqual(removed, [[ORGANIZATION_A, PROJECT_A]]);
  const missing = await favoriteRoute.DELETE(
    request(`/api/comparison-favorites/${PROJECT_B}`, { method: "DELETE" }),
    { params: Promise.resolve({ projectId: PROJECT_B }) },
  );
  assert.equal(missing.status, 404);
});

test("detail route proxies principal Agent reads and metadata patches", async () => {
  const calls: AgentCall[] = [];
  const client = async (call: AgentCall) => {
    calls.push(call);
    if (call.path === "/v1/auth/session") return sessionResult();
    return result(200, { project: { ...project, name: call.method === "PATCH" ? "Renamed" : project.name } });
  };
  const route = createComparisonProjectRoute({
    client,
    favorites: { list: () => [], read: () => null, write: () => undefined, remove: () => false },
  });
  const context = { params: Promise.resolve({ projectId: PROJECT_A }) };
  assert.equal((await route.GET(request(`/api/comparison-projects/${PROJECT_A}`), context)).status, 200);
  const renamed = await route.PATCH(request(`/api/comparison-projects/${PROJECT_A}`, {
    method: "PATCH", body: JSON.stringify({ name: "Renamed" }),
  }), context);
  assert.equal(renamed.status, 200);
  assert.deepEqual(calls.slice(-2).map((call) => `${call.method} ${call.path}`), [
    "GET /v1/auth/session",
    `PATCH /v1/projects/${PROJECT_A}`,
  ]);
  assert.equal(calls.at(-1)?.body, JSON.stringify({ name: "Renamed" }));
});
