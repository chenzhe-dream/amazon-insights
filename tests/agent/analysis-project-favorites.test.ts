import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildAgentApp } from "../../server/app";
import type { AuthenticationService, AuthenticatedPrincipal } from "../../server/auth/authentication-service";
import { createAnalysisProjectFavoriteStore } from "../../server/services/analysis-project-favorite-store";
import { createAgentServiceClient } from "../../app/lib/agent-service-client";
import { proxyAgentRequest, PUT, DELETE } from "../../app/api/agent/[...path]/route";

const projectId = "10000000-0000-4000-8000-000000000001";
const org = "10000000-0000-4000-8000-000000000002";
const otherOrg = "10000000-0000-4000-8000-000000000003";
const actor = "10000000-0000-4000-8000-000000000004";
const token = "B".repeat(43);
const origin = "http://127.0.0.1:31900";
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "explicit-favorites-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "projects"));
  const bytes = JSON.stringify({ id: projectId, kind: "analysis", name: "History", updatedAt: "original" });
  writeFileSync(join(root, "projects", `${projectId}.json`), bytes);
  const store = createAnalysisProjectFavoriteStore({ dataRoot: root });
  return { root, bytes, store };
}

test("history is initially unstarred; reads create nothing and preserve project bytes", t => {
  const { root, store, bytes } = fixture(t);
  assert.deepEqual(store.list(org), []);
  assert.deepEqual(readdirSync(root), ["projects"]);
  assert.equal(readFileSync(join(root, "projects", `${projectId}.json`), "utf8"), bytes);
});

test("explicit favorites survive new instances, share within team, isolate organizations and remove only markers", t => {
  const { root, store, bytes } = fixture(t);
  store.set(org, actor, projectId, true);
  store.set(org, actor, projectId, true);
  assert.deepEqual(createAnalysisProjectFavoriteStore({ dataRoot: root }).list(org), [projectId]);
  assert.deepEqual(store.list(otherOrg), []);
  store.set(otherOrg, actor, projectId, true);
  store.set(org, actor, projectId, false);
  store.set(org, actor, projectId, false);
  assert.deepEqual(store.list(org), []);
  assert.deepEqual(store.list(otherOrg), [projectId]);
  assert.equal(readFileSync(join(root, "projects", `${projectId}.json`), "utf8"), bytes);
});

test("reject invalid IDs, missing/non-analysis projects without creating storage", t => {
  const { root, store } = fixture(t);
  assert.throws(() => store.set(org, actor, "../escape", true));
  assert.throws(() => store.list("../escape"));
  assert.throws(() => store.set(org, actor, actor, true), /not found/i);
  writeFileSync(join(root, "projects", `${projectId}.json`), JSON.stringify({ id: projectId, kind: "traffic-promo" }));
  assert.throws(() => store.set(org, actor, projectId, true), /analysis/i);
  assert.deepEqual(readdirSync(root), ["projects"]);
});

test("corrupt favorite records fail visibly instead of silently clearing favorites", t => {
  const { root, store } = fixture(t);
  store.set(org, actor, projectId, true);
  writeFileSync(join(root, "analysis-project-favorites", org, `${projectId}.json`), "{broken");
  assert.throws(() => store.list(org));
});

function appFor(t: test.TestContext, root: string, organizationId = org, role: "admin" | "member" = "member") {
  const principal: AuthenticatedPrincipal = { kind: "user", userId: actor, organizationId,
    email: "member@example.com", role, sessionId: projectId };
  const app = buildAgentApp({
    env: { AGENT_SERVICE_PROXY_TOKEN: "test-proxy", AGENT_SERVICE_HOST: "127.0.0.1",
      AGENT_SERVICE_TRUSTED_ORIGINS: origin, AGENT_DATA_ROOT: root, AGENT_VOC_LOCAL_FAKE: "1" },
    authConfig: { mode: "authenticated", cookie: { name: "__Host-agent_session", secure: true, maxAgeSeconds: 28800 },
      sessionTtlMs: 28800000, loginLimiter: { windowMs: 900000, maxFailures: 5, maxEntries: 10000 } },
    authService: { authenticate: async (value: string | null) => value === token ? principal : null } as unknown as AuthenticationService,
  });
  t.after(() => app.close());
  return app;
}
const headers = { origin, "x-agent-proxy-token": "test-proxy", cookie: `__Host-agent_session=${token}` };

test("authenticated routes persist using configured data root; members/admins share only their organization", async t => {
  const { root, bytes } = fixture(t);
  const app = appFor(t, root);
  const url = `/v1/local-data/projects/${projectId}/favorite`;
  assert.equal((await app.inject({ method: "PUT", url, headers })).statusCode, 200);
  const admin = appFor(t, root, org, "admin");
  assert.deepEqual((await admin.inject({ method: "GET", url: "/v1/local-data/project-favorites", headers })).json(), { projectIds: [projectId] });
  const other = appFor(t, root, otherOrg);
  assert.deepEqual((await other.inject({ method: "GET", url: "/v1/local-data/project-favorites", headers })).json(), { projectIds: [] });
  assert.equal((await app.inject({ method: "DELETE", url, headers })).statusCode, 200);
  assert.deepEqual((await app.inject({ method: "GET", url: "/v1/local-data/project-favorites", headers })).json(), { projectIds: [] });
  assert.equal(readFileSync(join(root, "projects", `${projectId}.json`), "utf8"), bytes);
});

test("routes reject anonymous requests, spoofed scope, invalid project IDs and missing projects", async t => {
  const { root } = fixture(t);
  const app = appFor(t, root);
  const url = `/v1/local-data/projects/${projectId}/favorite`;
  for (const [method, path] of [["GET", "/v1/local-data/project-favorites"], ["PUT", url], ["DELETE", url]] as const) {
    const response = await app.inject({ method, url: path, headers: { origin, "x-agent-proxy-token": "test-proxy" } });
    assert.equal(response.statusCode, 401, response.body);
  }
  assert.equal((await app.inject({ method: "PUT", url, headers, payload: { organizationId: otherOrg } })).statusCode, 400);
  assert.equal((await app.inject({ method: "GET", url: `/v1/local-data/project-favorites?organizationId=${otherOrg}`, headers })).statusCode, 400);
  assert.equal((await app.inject({ method: "PUT", url: "/v1/local-data/projects/invalid/favorite", headers })).statusCode, 400);
  assert.equal((await app.inject({ method: "PUT", url: `/v1/local-data/projects/${actor}/favorite`, headers })).statusCode, 404);
  assert.deepEqual(readdirSync(root), ["projects"]);
});

test("anonymous-loopback mode does not authorize favorites", async t => {
  const { root } = fixture(t);
  const app = buildAgentApp({ env: { AGENT_SERVICE_PROXY_TOKEN: "test-proxy", AGENT_SERVICE_HOST: "127.0.0.1",
    AGENT_SERVICE_TRUSTED_ORIGINS: origin, AGENT_DATA_ROOT: root, AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK: "1", AGENT_VOC_LOCAL_FAKE: "1" } });
  t.after(() => app.close());
  for (const [method, url] of [["GET", "/v1/local-data/project-favorites"], ["PUT", `/v1/local-data/projects/${projectId}/favorite`], ["DELETE", `/v1/local-data/projects/${projectId}/favorite`]] as const) {
    assert.equal((await app.inject({ method, url, headers: { origin, "x-agent-proxy-token": "test-proxy" } })).statusCode, 401);
  }
  assert.deepEqual(readdirSync(root), ["projects"]);
});

test("favorite routes pass the actual web proxy allowlist and forward authenticated cookies", async t => {
  const { root } = fixture(t);
  const app = appFor(t, root);
  const client = createAgentServiceClient({ env: { AGENT_SERVICE_INTERNAL_URL: "http://127.0.0.1:31901", AGENT_SERVICE_PROXY_TOKEN: "test-proxy" },
    fetchImplementation: async (input, init) => {
      const forwarded = new Headers(init?.headers);
      assert.equal(forwarded.get("cookie"), headers.cookie);
      const response = await app.inject({ method: init?.method as "GET" | "PUT" | "DELETE", url: new URL(String(input)).pathname,
        headers: { ...Object.fromEntries(forwarded), origin }, payload: init?.body as string | undefined });
      return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } });
    } });
  for (const [method, handler, path] of [["PUT", PUT, ["v1", "local-data", "projects", projectId, "favorite"]],
    ["GET", proxyAgentRequest, ["v1", "local-data", "project-favorites"]], ["DELETE", DELETE, ["v1", "local-data", "projects", projectId, "favorite"]]] as const) {
    const response = await handler(new Request(`http://localhost/api/agent/${path.join("/")}`, { method, headers: { cookie: headers.cookie } }),
      { params: Promise.resolve({ path: [...path] }) }, client);
    assert.equal(response.status, 200, await response.text());
  }
  for (const [method, handler] of [["PUT", PUT], ["DELETE", DELETE]] as const) {
    const response = await handler(new Request(`http://localhost/api/agent/v1/local-data/projects/${projectId}/favorite`, {
      method, headers: { cookie: headers.cookie, "content-type": "application/json" }, body: JSON.stringify({ organizationId: otherOrg }),
    }), { params: Promise.resolve({ path: ["v1", "local-data", "projects", projectId, "favorite"] }) }, client);
    assert.equal(response.status, 400, "the Web proxy must reject spoofed scope instead of dropping its body");
  }
});

test("storage failures use safe public messages and leave previous data untouched", async t => {
  const { root, store, bytes } = fixture(t);
  store.set(org, actor, projectId, true);
  writeFileSync(join(root, "analysis-project-favorites", org, `${projectId}.json`), "{broken");
  const app = appFor(t, root);
  const response = await app.inject({ method: "GET", url: "/v1/local-data/project-favorites", headers });
  assert.equal(response.statusCode, 500);
  assert.ok(!response.body.includes(root));
  assert.match(response.body, /收藏服务暂时不可用/);
  assert.equal(readFileSync(join(root, "projects", `${projectId}.json`), "utf8"), bytes);
});
