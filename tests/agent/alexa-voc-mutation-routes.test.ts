import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import * as importRoute from "../../app/api/alexa-voc/import/route";
import { createAlexaVocImportHandler } from "../../app/api/alexa-voc/import/route";
import { createAlexaVocListHandler } from "../../app/api/alexa-voc/route";
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
  normalizedRecord,
  source: "postgres" as const,
  generation: "1",
  capturedAt: "2026-08-31T01:02:03.456Z",
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
    if (request.method === "POST") return result(201, { record });
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
    body: JSON.stringify({ asin: ASIN, marketplace: "US", text: rawText }),
  }));

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.deepEqual(body, { record });
  assert.equal(calls.length, 2);
  assert.deepEqual({ method: calls[0]?.method, path: calls[0]?.path }, { method: "GET", path: "/v1/auth/session" });
  assert.equal(new Headers(calls[0]?.headers).get("origin"), ORIGIN);
  assert.equal(new Headers(calls[0]?.headers).get("cookie"), COOKIE);
  assert.deepEqual({ method: calls[1]?.method, path: calls[1]?.path }, { method: "POST", path: "/v1/manual-alexa-voc/import" });
  assert.equal(calls[1]?.body, JSON.stringify({ asin: ASIN, marketplace: "US", rawText }));
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

test("GET proxy forwards only a parsed US marketplace and one to ten unique ASINs", async () => {
  const calls: AgentServiceRequest[] = [];
  const handler = createAlexaVocListHandler({ client: clientWithSession(calls) });
  const response = await handler(new Request(
    `${ORIGIN}/api/alexa-voc?marketplace=US&asins=${ASIN}&asins=${OTHER_ASIN}&ignored=secret`,
    { headers: { cookie: COOKIE } },
  ));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { records: [record] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.path, `/v1/manual-alexa-voc?marketplace=US&asins=${ASIN}&asins=${OTHER_ASIN}`);
  assert.equal(new Headers(calls[0]?.headers).get("origin"), ORIGIN);
  assert.equal(new Headers(calls[0]?.headers).get("cookie"), COOKIE);

  for (const query of [
    `marketplace=CA&asins=${ASIN}`,
    `marketplace=US&asins=${ASIN}&asins=${ASIN}`,
    "marketplace=US",
  ]) {
    const invalid = await handler(new Request(`${ORIGIN}/api/alexa-voc?${query}`, { headers: { cookie: COOKIE } }));
    assert.equal(invalid.status, 400);
  }
  assert.equal(calls.length, 1);
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
