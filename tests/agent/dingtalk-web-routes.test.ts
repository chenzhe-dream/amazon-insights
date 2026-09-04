import assert from "node:assert/strict";
import test from "node:test";

import { createDingTalkConfigHandler } from "../../app/api/auth/dingtalk/config/route";
import { createDingTalkOAuthStartHandler } from "../../app/api/auth/dingtalk/start/route";
import { createDingTalkOAuthCallbackHandler } from "../../app/api/auth/dingtalk/callback/route";
import type { AgentServiceClient } from "../../app/lib/agent-service-client";

function client(result: { status: number; headers?: Headers; body: unknown }): AgentServiceClient {
  return (async () => ({
    status: result.status,
    headers: result.headers ?? new Headers({ "content-type": "application/json" }),
    body: result.body,
  })) as AgentServiceClient;
}

test("Web config bridge returns public DingTalk configuration", async () => {
  const handler = createDingTalkConfigHandler({
    client: client({ status: 200, body: { enabled: true, clientId: "id", corpId: "corp", agentId: "agent" } }),
  });
  const response = await handler(new Request("http://127.0.0.1:31900/api/auth/dingtalk/config"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { enabled: true, clientId: "id", corpId: "corp", agentId: "agent" });
});

test("Web start bridge forwards state cookie and redirects only to DingTalk", async () => {
  let requestPath = "";
  const handler = createDingTalkOAuthStartHandler({
    client: (async (request) => {
      requestPath = request.path;
      assert.equal(new Headers(request.headers).get("origin"), "http://127.0.0.1:31900");
      return {
        status: 200,
        headers: new Headers({ "set-cookie": "dingtalk_oauth_state=state; Path=/; HttpOnly; SameSite=Lax" }),
        body: {
          authorizationUrl: "https://login.dingtalk.com/oauth2/auth?state=state",
          expiresAt: "2026-09-04T08:05:00.000Z",
        },
      };
    }) as AgentServiceClient,
  });
  const response = await handler(new Request(
    "http://127.0.0.1:31900/api/auth/dingtalk/start?returnPath=%2Fprojects%2Fcurrent",
  ));
  assert.equal(requestPath, "/v1/auth/dingtalk/oauth/start");
  assert.equal(response.status, 302);
  assert.match(response.headers.get("location") ?? "", /^https:\/\/login\.dingtalk\.com\/oauth2\/auth/);
  assert.match(response.headers.get("set-cookie") ?? "", /^dingtalk_oauth_state=/);
});

test("Web callback forwards session cookies and uses the stored safe local return path", async () => {
  const upstreamHeaders = new Headers();
  upstreamHeaders.append("set-cookie", "dingtalk_oauth_state=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax");
  upstreamHeaders.append("set-cookie", "agent_session=session; Max-Age=28800; Path=/; HttpOnly; SameSite=Lax");
  const handler = createDingTalkOAuthCallbackHandler({
    client: client({
      status: 200,
      headers: upstreamHeaders,
      body: {
        user: {
          id: "10000000-0000-4000-8000-000000000001",
          organizationId: "20000000-0000-4000-8000-000000000001",
          email: "member@example.com",
          displayName: "Member",
          role: "member",
          status: "active",
          createdAt: "2026-09-04T08:00:00.000Z",
          updatedAt: "2026-09-04T08:00:00.000Z",
        },
        returnPath: "/projects/current",
      },
    }),
  });
  const response = await handler(new Request(
    `http://127.0.0.1:31900/api/auth/dingtalk/callback?authCode=oauth-code&state=${"T".repeat(43)}`,
    { headers: { cookie: `dingtalk_oauth_state=${"T".repeat(43)}` } },
  ));
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "http://127.0.0.1:31900/projects/current");
  assert.match(response.headers.get("set-cookie") ?? "", /agent_session=session/);
});

test("Web callback converts Agent failures to fixed UI codes and keeps state clearing", async () => {
  const handler = createDingTalkOAuthCallbackHandler({
    client: client({
      status: 400,
      headers: new Headers({ "set-cookie": "dingtalk_oauth_state=; Max-Age=0; Path=/; HttpOnly" }),
      body: { error: { code: "DINGTALK_INVALID_STATE", message: "Login state expired", requestId: "req-1" } },
    }),
  });
  const response = await handler(new Request(
    `http://127.0.0.1:31900/api/auth/dingtalk/callback?code=bad&state=${"T".repeat(43)}`,
  ));
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "http://127.0.0.1:31900/?dingtalk_error=invalid_state");
  assert.match(response.headers.get("set-cookie") ?? "", /Max-Age=0/);
});

test("Web callback clears local OAuth state before rejecting malformed provider input", async () => {
  let agentCalled = false;
  const handler = createDingTalkOAuthCallbackHandler({
    client: (async () => {
      agentCalled = true;
      throw new Error("Agent must not receive malformed callback input");
    }) as AgentServiceClient,
  });
  const response = await handler(new Request(
    "http://127.0.0.1:31900/api/auth/dingtalk/callback?state=malformed",
  ));
  assert.equal(response.status, 302);
  assert.equal(agentCalled, false);
  assert.equal(response.headers.get("location"), "http://127.0.0.1:31900/?dingtalk_error=invalid_code");
  assert.match(response.headers.get("set-cookie") ?? "", /^dingtalk_oauth_state=; Max-Age=0;/);
});
