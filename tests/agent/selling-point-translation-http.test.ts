import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { registerSellingTranslationRoutes } from "../../server/routes/selling-point-translations";
import { SellingPointTranslationService } from "../../server/services/selling-point-translation";
import { proxyAgentRequest } from "../../app/api/agent/[...path]/route";
import { createAgentServiceClient } from "../../app/lib/agent-service-client";

const projectId = "10000000-0000-4000-8000-000000000001";
const asin = "B000000001";
const path = `/v1/projects/${projectId}/selling-point-translations/${asin}`;

test("translation requires a session, uses server organization, and rejects client source overrides", async t => {
  const root = mkdtempSync(join(tmpdir(), "selling-http-"));
  t.after(() => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  let requestedVersion: string | undefined;
  let releaseTranslation!: () => void;
  const translationGate = new Promise<void>(resolveGate => { releaseTranslation = resolveGate; });
  const service = new SellingPointTranslationService({ root, modelIdentity: "test",
    resolveSource: async (org, project, item, versionId) => {
      requestedVersion = versionId;
      assert.equal(org, "org");
      assert.equal(project, projectId);
      assert.equal(item, asin);
      return { organizationId: org, projectId: project, runId: "run", asin: item, original: ["Timer 2 hours"], sourceComplete: true };
    }, translate: async () => { await translationGate; return ["定时 2 小时"]; } });
  const app = Fastify();
  t.after(() => app.close());
  let signedIn = false;
  app.decorateRequest("authPrincipal", null);
  app.addHook("preHandler", async request => {
    if (signedIn) request.authPrincipal = { kind: "user", organizationId: "org", userId: "u", sessionId: "s", email: "u@test.example", role: "member" };
  });
  registerSellingTranslationRoutes(app, service);
  assert.equal((await app.inject(path)).statusCode, 401);
  signedIn = true;
  assert.equal((await app.inject({ method: "POST", url: path, payload: { original: ["injected"], organizationId: "other" } })).statusCode, 400);
  assert.equal((await app.inject(path + "?organizationId=other")).statusCode, 400);
  assert.equal((await app.inject(path)).json().state, "missing");
  assert.equal((await app.inject(path + "?versionId=" + projectId)).statusCode, 200);
  assert.equal(requestedVersion, projectId);
  assert.equal((await app.inject(path + "?versionId=invalid")).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: path + "?versionId=" + projectId, payload: {} })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: path, payload: { versionId: projectId } })).statusCode, 202);
  assert.equal(requestedVersion, projectId);
  assert.equal((await app.inject({ method: "POST", url: path, payload: { versionId: projectId } })).statusCode, 202);
  assert.equal(requestedVersion, projectId);
  releaseTranslation();
  await service.drain();
  const response = await app.inject(path);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.json().points, ["定时 2 小时"]);
  await assert.rejects(service.read("different-org", projectId, asin));
});

test("web proxy and agent client preserve pending and ready translation responses", async () => {
  for (const method of ["GET", "POST"] as const) {
    const requestPath = method === "GET" ? `${path}?versionId=${projectId}` : path;
    const result = { asin, sourceHash: "hash", state: method === "POST" ? "pending" : "ready", points: method === "POST" ? [] : ["中文卖点"], original: ["Original"], sourceComplete: true, message: null };
    const status = method === "POST" ? 202 : 200;
    const client = createAgentServiceClient({
      env: { AGENT_SERVICE_INTERNAL_URL: "http://127.0.0.1:39999", AGENT_SERVICE_PROXY_TOKEN: "fixture" },
      fetchImplementation: async (url, init) => {
        assert.equal(String(url), "http://127.0.0.1:39999" + requestPath);
        assert.equal(init?.method, method);
        return Response.json(result, { status, headers: { "Cache-Control": "no-store" } });
      },
    });
    const response = await proxyAgentRequest(new Request("http://localhost/api/agent" + requestPath, {
      method, ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: "{}" } : {}),
    }), { params: Promise.resolve({ path: path.slice(1).split("/") }) }, client);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), result);
  }
});
