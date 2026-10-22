import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import * as importRoute from "../../app/api/alexa-voc/import/route";
import { createAlexaVocImportHandler } from "../../app/api/alexa-voc/import/route";
import { createAlexaVocListHandler } from "../../app/api/alexa-voc/route";
import { createAlexaVocPendingHandler } from "../../app/api/alexa-voc/pending/route";
import { createAlexaVocSyncHandler } from "../../app/api/alexa-voc/sync/route";
import { createSystemRebuildHandler } from "../../app/api/system/rebuild/route";
import type {
  AgentServiceClient,
  AgentServiceRequest,
  AgentServiceResult,
} from "../../app/lib/agent-service-client";

const ORIGIN = "http://127.0.0.1:31900";
const ASIN = "B0T2TASK02";
const OTHER_ASIN = "B07VY9Q95Q";
const PROJECT_ID = "10000000-0000-4000-8000-000000000003";
const RUN_ID = "10000000-0000-4000-8000-000000000004";
const COOKIE = "__Host-agent_session=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const SESSION_IDENTITY = "S".repeat(43);

const user = {
  id: "10000000-0000-4000-8000-000000000001",
  organizationId: "10000000-0000-4000-8000-000000000002",
  email: "member@example.com",
  displayName: "Member",
  role: "member" as const,
  status: "active" as const,
  createdAt: "2026-08-31T01:02:03.456Z",
  updatedAt: "2026-08-31T01:02:03.456Z",
};
const normalizedRecord = {
  asin: ASIN,
  attention: ["安装"],
  positives: ["可靠"],
  negatives: ["包装"],
  unmet: [],
  audiences: [],
  scenarios: [],
  motives: [],
  captureStatus: "dialog" as const,
  alexaReport: {
    title: "顾客评价深度分析",
    asin: ASIN,
    rating: 0,
    reviewCount: 0,
    prompt: "这个产品的顾客关注点是什么，好评点是什么，差评点是什么，未被满足的需求是什么，使用人群是谁，使用场景是什么，核心购买动机是什么。",
    overallConclusion: "已录入",
    captureStatus: "dialog" as const,
  },
};
const record = {
  asin: ASIN,
  marketplace: "US" as const,
  revision: "1",
  contentHash: "c".repeat(64),
  normalizedRecord,
  source: "postgres" as const,
  generation: "1",
  capturedAt: "2026-08-31T01:02:03.456Z",
};
const writeResponse = {
  disposition: "success" as const,
  record,
  normalization: { asin: ASIN, fingerprint: "d".repeat(64), status: "success" as const, revision: "1", error: null },
};

function result(status: number, body: unknown): AgentServiceResult {
  return { status, headers: new Headers({ "content-type": "application/json", "x-request-id": "upstream-request" }), body } as AgentServiceResult;
}

function clientWithSession(calls: AgentServiceRequest[]): AgentServiceClient {
  return (async (request: AgentServiceRequest) => {
    calls.push(request);
    if (request.path === "/v1/auth/session") {
      return result(200, { authenticated: true, user, sessionIdentity: SESSION_IDENTITY });
    }
    if (request.method === "POST") return result(201, writeResponse);
    return result(200, { records: [record] });
  }) as AgentServiceClient;
}

test("unauthorized Alexa import returns before reading the body or calling the import endpoint", async () => {
  const calls: AgentServiceRequest[] = [];
  const handler = createAlexaVocImportHandler({
    authorize: async () => ({
      ok: false as const,
      response: Response.json({ error: "请先登录后再操作" }, { status: 401 }),
    }),
    client: clientWithSession(calls),
  });

  const response = await handler(new Request(`${ORIGIN}/api/alexa-voc/import`, {
    method: "POST",
    headers: { origin: ORIGIN, cookie: COOKIE },
    body: "not-json",
  }));

  assert.equal(response.status, 401);
  assert.deepEqual(calls, []);
});

test("authorized import uses one Agent client for session authorization and the canonical POST", async () => {
  const calls: AgentServiceRequest[] = [];
  const handler = createAlexaVocImportHandler({ client: clientWithSession(calls) });
  const rawText = `${ASIN} — 顾客评价深度分析`;

  const response = await handler(new Request(`${ORIGIN}/api/alexa-voc/import`, {
    method: "POST",
    headers: { origin: ORIGIN, cookie: COOKIE, "x-request-id": "browser-request" },
    body: JSON.stringify({ projectId: PROJECT_ID, runId: RUN_ID, asin: ASIN, marketplace: "US", text: rawText }),
  }));

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.deepEqual(body, writeResponse);
  assert.equal(body.record.contentHash, "c".repeat(64));
  assert.equal(calls.length, 2);
  assert.deepEqual({ method: calls[0]?.method, path: calls[0]?.path }, { method: "GET", path: "/v1/auth/session" });
  assert.equal(new Headers(calls[0]?.headers).get("origin"), ORIGIN);
  assert.equal(new Headers(calls[0]?.headers).get("cookie"), COOKIE);
  assert.deepEqual({ method: calls[1]?.method, path: calls[1]?.path }, { method: "POST", path: "/v1/manual-alexa-voc/import" });
  assert.equal(calls[1]?.body, JSON.stringify({ projectId: PROJECT_ID, runId: RUN_ID, asin: ASIN, marketplace: "US", rawText }));
  assert.equal(calls[1]?.requestId, "browser-request");
  assert.equal(new Headers(calls[1]?.headers).get("origin"), ORIGIN);
  assert.equal(new Headers(calls[1]?.headers).get("cookie"), COOKIE);
  assert.doesNotMatch(JSON.stringify(body), /rawText|createdBy|organizationId/);
});

test("import rejects non-object, exact-one violations, and oversized bodies after authorization", async () => {
  for (const body of [
    "null",
    JSON.stringify({ asin: ASIN, marketplace: "US", text: "report", rawText: "report" }),
    JSON.stringify({ asin: ASIN, marketplace: "US", rawText: "x".repeat(300_000) }),
  ]) {
    const calls: AgentServiceRequest[] = [];
    const handler = createAlexaVocImportHandler({ client: clientWithSession(calls) });
    const response = await handler(new Request(`${ORIGIN}/api/alexa-voc/import`, {
      method: "POST",
      headers: { origin: ORIGIN, cookie: COOKIE },
      body,
    }));
    assert.equal(response.status, body.length > 256 * 1024 ? 413 : 400);
    assert.deepEqual(calls.map(call => call.path), ["/v1/auth/session"]);
  }
});

test("GET proxy forwards a supported marketplace and one to ten unique ASINs", async () => {
  const calls: AgentServiceRequest[] = [];
  const handler = createAlexaVocListHandler({ client: clientWithSession(calls) });
  const response = await handler(new Request(
    `${ORIGIN}/api/alexa-voc?projectId=${PROJECT_ID}&marketplace=US&asins=${ASIN}&asins=${OTHER_ASIN}&ignored=secret`,
    { headers: { cookie: COOKIE } },
  ));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, { records: [record] });
  assert.equal(body.records[0].contentHash, "c".repeat(64));
  assert.doesNotMatch(JSON.stringify(body), /rawText|rawReport|createdBy|organizationId/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.path, `/v1/manual-alexa-voc?projectId=${PROJECT_ID}&marketplace=US&asins=${ASIN}&asins=${OTHER_ASIN}`);
  assert.equal(new Headers(calls[0]?.headers).get("origin"), ORIGIN);
  assert.equal(new Headers(calls[0]?.headers).get("cookie"), COOKIE);

  for (const query of [
    `projectId=${PROJECT_ID}&marketplace=JP&asins=${ASIN}`,
    `projectId=${PROJECT_ID}&marketplace=US&asins=${ASIN}&asins=${ASIN}`,
    `projectId=${PROJECT_ID}&marketplace=US`,
  ]) {
    const invalid = await handler(new Request(`${ORIGIN}/api/alexa-voc?${query}`, { headers: { cookie: COOKIE } }));
    assert.equal(invalid.status, 400);
  }
  assert.equal(calls.length, 1);
});

test("pending proxy forwards exact project/run/ASIN scope and rejects unsafe responses", async () => {
  const calls: AgentServiceRequest[] = [];
  const client = (async (request: AgentServiceRequest) => {
    calls.push(request);
    return result(200, { records: [{
      asin: ASIN,
      fingerprint: "d".repeat(64),
      status: "pending",
      revision: null,
      error: null,
    }] });
  }) as AgentServiceClient;
  const handler = createAlexaVocPendingHandler({ client });
  const response = await handler(new Request(
    `${ORIGIN}/api/alexa-voc/pending?projectId=${PROJECT_ID}&runId=${RUN_ID}&marketplace=US&asins=${ASIN}&ignored=secret`,
    { headers: { cookie: COOKIE } },
  ));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { records: [{
    asin: ASIN,
    fingerprint: "d".repeat(64),
    status: "pending",
    revision: null,
    error: null,
  }] });
  assert.equal(calls[0]?.path, `/v1/manual-alexa-voc/normalization-status?projectId=${PROJECT_ID}&runId=${RUN_ID}&marketplace=US&asins=${ASIN}`);
  assert.equal(new Headers(calls[0]?.headers).get("cookie"), COOKIE);

  const unsafe = createAlexaVocPendingHandler({
    client: (async () => result(200, { records: [], rawText: "secret", modelResponse: "secret" })) as AgentServiceClient,
  });
  const rejected = await unsafe(new Request(
    `${ORIGIN}/api/alexa-voc/pending?projectId=${PROJECT_ID}&runId=${RUN_ID}&marketplace=US&asins=${ASIN}`,
    { headers: { cookie: COOKIE } },
  ));
  assert.equal(rejected.status, 502);
  assert.doesNotMatch(JSON.stringify(await rejected.json()), /secret|rawText|modelResponse/i);
});

test("disabled Manual VOC UI stops import and hydration before the Agent data endpoints", async () => {
  const calls: AgentServiceRequest[] = [];
  const client = clientWithSession(calls);
  const importer = createAlexaVocImportHandler({ client, uiEnabled: false });
  const importResponse = await importer(new Request(`${ORIGIN}/api/alexa-voc/import`, {
    method: "POST",
    headers: { origin: ORIGIN, cookie: COOKIE },
    body: JSON.stringify({ asin: ASIN, marketplace: "US", rawText: "report" }),
  }));
  assert.equal(importResponse.status, 503);
  assert.deepEqual(await importResponse.json(), { error: "Manual Alexa VOC 录入功能暂未启用，请联系管理员" });
  assert.deepEqual(calls.map(call => call.path), ["/v1/auth/session"]);

  calls.length = 0;
  const list = createAlexaVocListHandler({ client, uiEnabled: false });
  const listResponse = await list(new Request(
    `${ORIGIN}/api/alexa-voc?projectId=${PROJECT_ID}&marketplace=US&asins=${ASIN}`,
    { headers: { cookie: COOKIE } },
  ));
  assert.equal(listResponse.status, 200);
  assert.deepEqual(await listResponse.json(), { records: [] });
  assert.deepEqual(calls, []);
});

test("legacy sync and rebuild routes retain their existing authorization boundaries", async () => {
  const rejected = async () => ({ ok: false as const, response: new Response(null, { status: 401 }) });
  const syncCalls: string[] = [];
  const sync = createAlexaVocSyncHandler({
    authorize: rejected,
    spawn: () => { syncCalls.push("spawn"); return { unref() { syncCalls.push("unref"); } }; },
  });
  const rebuildCalls: string[] = [];
  const rebuild = createSystemRebuildHandler({
    authorize: rejected,
    rebuild: () => { rebuildCalls.push("rebuild"); return { started: true, message: "unexpected" }; },
  });

  assert.equal((await sync(new Request(`${ORIGIN}/api/alexa-voc/sync`, { method: "POST", body: "not-json" }))).status, 401);
  assert.equal((await rebuild(new Request(`${ORIGIN}/api/system/rebuild`, { method: "POST" }))).status, 401);
  assert.deepEqual(syncCalls, []);
  assert.deepEqual(rebuildCalls, []);
});

test("Alexa sync uses one detached coordinator and defers publication until capture succeeds", async () => {
  const calls: Array<{ args: readonly string[]; cwd: unknown; env: NodeJS.ProcessEnv | undefined }> = [];
  const handler = createAlexaVocSyncHandler({
    authorize: async () => ({ ok: true as const, role: "admin" as const }),
    resolveWorktree: () => "C:\\formal-worktree",
    spawn: ((_command: string, args: readonly string[], options: { cwd?: unknown; env?: NodeJS.ProcessEnv }) => {
      calls.push({ args, cwd: options.cwd, env: options.env });
      return { unref() {} };
    }) as never,
  });
  const response = await handler(new Request(`${ORIGIN}/api/alexa-voc/sync`, {
    method: "POST", body: JSON.stringify({ asins: [ASIN], rebuild: true }),
  }));
  assert.equal(response.status, 202);
  assert.deepEqual(calls, [{
    args: [path.join("C:\\formal-worktree", "scripts", "run-alexa-voc-capture.mjs"), ASIN],
    cwd: "C:\\formal-worktree",
    env: {
      ...process.env,
      AGENT_FORMAL_WORKTREE_ROOT: "C:\\formal-worktree",
      ALEXA_ASINS: ASIN,
      ALEXA_MARKETPLACE: "US",
      ALEXA_HEADLESS: process.env.ALEXA_HEADLESS ?? "1",
      ALEXA_PUBLISH_AFTER_CAPTURE: "1",
    },
  }]);
});

test("manual import modules expose no CORS OPTIONS handler or source-tree publication dependencies", () => {
  assert.equal(Object.hasOwn(importRoute, "OPTIONS"), false);
  const source = String(importRoute.createAlexaVocImportHandler);
  assert.doesNotMatch(source, /saveAlexaVocToSystem|resolveFormalWorktreeRoot|triggerBackgroundRebuild|autoRebuild|reload/i);
});

test("client Manual VOC paths hydrate through the scoped hook without tenant data imports or polling", () => {
  const sources = [
    "app/page.tsx",
    "app/alexa-voc-import-panel.tsx",
    "app/voc-development-summary.ts",
    "app/voc-display-schema.ts",
    "app/manual-alexa-voc-store.ts",
    "app/use-manual-alexa-voc.ts",
  ].map(file => [file, readFileSync(file, "utf8")] as const);

  for (const [file, source] of sources) {
    assert.doesNotMatch(source, /(?:from\s+|import\s*\()["'][^"']*rufus-voc-data["']/, file);
  }

  const pageSource = sources.find(([file]) => file === "app/page.tsx")?.[1] ?? "";
  const panelSource = sources.find(([file]) => file === "app/alexa-voc-import-panel.tsx")?.[1] ?? "";
  const hookSource = sources.find(([file]) => file === "app/use-manual-alexa-voc.ts")?.[1] ?? "";
  assert.match(pageSource, /useManualAlexaVoc/);
  assert.match(pageSource, /effectiveVocByAsin/);
  assert.match(panelSource, /onImported/);
  assert.match(hookSource, /addEventListener\(["']focus["']/);
  assert.match(hookSource, /current\.marketplace === input\.marketplace/);
  assert.match(hookSource, /projectId: activeProjectId/);
  assert.match(hookSource, /manualVocScopeChanged\(input\.sessionIdentity, input\.organizationId, input\.marketplace, activeProjectId\)/);
  assert.match(hookSource, /enabled && state\.projectId === input\.projectId/);
  assert.match(
    hookSource,
    /abortManualVocRequests\(requestsRef\.current\);[\s\S]{0,300}manualVocScopeChanged\(input\.sessionIdentity, input\.organizationId, input\.marketplace, activeProjectId\)/,
  );
  assert.doesNotMatch(hookSource, /setInterval|setTimeout/);
});

test("pending proxy preserves DE rather than silently querying US", async () => {
  const calls: AgentServiceRequest[]=[];
  const handler=createAlexaVocPendingHandler({client:(async request=>{calls.push(request);return result(200,{records:[]});}) as AgentServiceClient});
  const response=await handler(new Request(`${ORIGIN}/api/alexa-voc/pending?projectId=${PROJECT_ID}&runId=${RUN_ID}&marketplace=DE&asins=${ASIN}`,{headers:{cookie:COOKIE}}));
  assert.equal(response.status,200);
  assert.match(calls[0].path,/marketplace=DE/);
});
