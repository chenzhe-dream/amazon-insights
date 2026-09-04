import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentApp } from "../../server/app";
import { DingTalkAuthenticationError } from "../../server/auth/dingtalk-authentication-service";
import { DingTalkProviderError } from "../../server/auth/dingtalk-provider";
import type { AuthenticationService } from "../../server/auth/authentication-service";
import type { DingTalkAuthenticationService } from "../../server/auth/dingtalk-authentication-service";
import {
  BoundedDingTalkAuthRateLimiter,
  type DingTalkAuthRateLimiter,
} from "../../server/auth/dingtalk-rate-limiter";
import type { AgentAuthenticationConfig } from "../../server/config";
import type { User } from "../../shared/agent-contracts";

const NOW = "2026-09-04T08:00:00.000Z";
const USER: User = {
  id: "10000000-0000-4000-8000-000000000001",
  organizationId: "20000000-0000-4000-8000-000000000001",
  email: "member@example.com",
  displayName: "Member",
  role: "member",
  status: "active",
  createdAt: NOW,
  updatedAt: NOW,
};
const SESSION_TOKEN = "S".repeat(43);
const STATE = "T".repeat(43);
const PROXY_TOKEN = "proxy-token-sentinel";
const ORIGIN = "http://127.0.0.1:31900";

const authConfig: AgentAuthenticationConfig = {
  mode: "authenticated",
  cookie: { name: "agent_session", secure: false, maxAgeSeconds: 28_800 },
  sessionTtlMs: 28_800_000,
  loginLimiter: { windowMs: 900_000, maxFailures: 5, maxEntries: 10_000 },
};

const session = {
  status: "authenticated" as const,
  user: USER,
  principal: {
    kind: "user" as const,
    userId: USER.id,
    organizationId: USER.organizationId,
    role: USER.role,
    sessionId: "30000000-0000-4000-8000-000000000001",
  },
  rawSessionToken: SESSION_TOKEN,
  expiresAt: "2026-09-04T16:00:00.000Z",
};

function authService() {
  return {
    authenticate: async () => null,
  } as unknown as AuthenticationService;
}

function headers(overrides: Record<string, string> = {}) {
  return {
    origin: ORIGIN,
    "x-agent-proxy-token": PROXY_TOKEN,
    "x-agent-client-ip": "127.0.0.1",
    ...overrides,
  };
}

function app(service: unknown, dingTalkRateLimiter?: DingTalkAuthRateLimiter) {
  return buildAgentApp({
    env: {
      AGENT_SERVICE_PROXY_TOKEN: PROXY_TOKEN,
      AGENT_SERVICE_TRUSTED_ORIGINS: ORIGIN,
    },
    authConfig,
    authService: authService(),
    dingTalkService: service as DingTalkAuthenticationService,
    dingTalkRateLimiter,
  });
}

test("DingTalk unauthenticated exchanges are bounded before storage or provider calls", async (t) => {
  let calls = 0;
  const denied: DingTalkAuthRateLimiter = {
    reserve: () => ({ allowed: false, retryAfterSeconds: 30 }),
  };
  const server = app({
    publicConfig: () => ({ enabled: true as const, clientId: "id", corpId: "corp", agentId: "agent" }),
    loginWorkbench: async () => { calls += 1; return session; },
    startOAuth: async () => { calls += 1; throw new Error("must not run"); },
  }, denied);
  t.after(() => server.close());

  for (const request of [
    { url: "/v1/auth/dingtalk/workbench", payload: { code: "workbench-code" } },
    { url: "/v1/auth/dingtalk/oauth/start", payload: { returnPath: "/" } },
  ]) {
    const response = await server.inject({ method: "POST", headers: headers(), ...request });
    assert.equal(response.statusCode, 429);
    assert.equal(response.headers["retry-after"], "30");
    assert.equal(response.json().error.code, "LOGIN_RATE_LIMITED");
  }
  assert.equal(calls, 0);
});

test("DingTalk limiter enforces both source and global fixed-window bounds", () => {
  let now = 1_000;
  const limiter = new BoundedDingTalkAuthRateLimiter({
    windowMs: 60_000,
    maxPerSource: 2,
    maxGlobal: 3,
    maxEntries: 10,
    now: () => now,
  });
  assert.equal(limiter.reserve("workbench", "source-a").allowed, true);
  assert.equal(limiter.reserve("workbench", "source-a").allowed, true);
  assert.equal(limiter.reserve("workbench", "source-a").allowed, false);
  assert.equal(limiter.reserve("workbench", "source-b").allowed, true);
  assert.equal(limiter.reserve("workbench", "source-c").allowed, false);
  now += 60_001;
  assert.equal(limiter.reserve("workbench", "source-a").allowed, true);
});

test("DingTalk Agent routes expose only public config and issue existing session cookies", async (t) => {
  const service = {
    publicConfig: () => ({
      enabled: true as const,
      clientId: "client-id",
      corpId: "corp-id",
      agentId: "agent-id",
    }),
    loginWorkbench: async (code: string) => {
      assert.equal(code, "workbench-code");
      return session;
    },
    startOAuth: async (returnPath: string) => {
      assert.equal(returnPath, "/projects/current");
      return {
        authorizationUrl: `https://login.dingtalk.com/oauth2/auth?state=${STATE}`,
        rawState: STATE,
        expiresAt: "2026-09-04T08:05:00.000Z",
      };
    },
    completeOAuth: async (input: { code: string; state: string; cookieState: string | null }) => {
      assert.deepEqual(input, { code: "oauth-code", state: STATE, cookieState: STATE });
      return { ...session, returnPath: "/projects/current" };
    },
  };
  const server = app(service);
  t.after(() => server.close());

  const config = await server.inject({
    method: "GET",
    url: "/v1/auth/dingtalk/config",
    headers: headers(),
  });
  assert.equal(config.statusCode, 200);
  assert.deepEqual(config.json(), {
    enabled: true,
    clientId: "client-id",
    corpId: "corp-id",
    agentId: "agent-id",
  });
  assert.doesNotMatch(config.body, /secret/i);

  const workbench = await server.inject({
    method: "POST",
    url: "/v1/auth/dingtalk/workbench",
    headers: headers(),
    payload: { code: "workbench-code" },
  });
  assert.equal(workbench.statusCode, 200);
  assert.match(String(workbench.headers["set-cookie"]), new RegExp(`^agent_session=${SESSION_TOKEN}`));

  const start = await server.inject({
    method: "POST",
    url: "/v1/auth/dingtalk/oauth/start",
    headers: headers(),
    payload: { returnPath: "/projects/current" },
  });
  assert.equal(start.statusCode, 200);
  assert.match(String(start.headers["set-cookie"]), new RegExp(`^dingtalk_oauth_state=${STATE}`));
  assert.equal(Object.hasOwn(start.json(), "rawState"), false);

  const callback = await server.inject({
    method: "POST",
    url: "/v1/auth/dingtalk/oauth/callback",
    headers: headers({ cookie: `dingtalk_oauth_state=${STATE}` }),
    payload: { code: "oauth-code", state: STATE },
  });
  assert.equal(callback.statusCode, 200);
  const cookies = callback.headers["set-cookie"];
  assert.ok(Array.isArray(cookies));
  assert.equal(cookies.length, 2);
  assert.match(cookies.join("\n"), /dingtalk_oauth_state=; Max-Age=0/);
  assert.match(cookies.join("\n"), new RegExp(`agent_session=${SESSION_TOKEN}`));
  assert.equal(callback.json().returnPath, "/projects/current");
});

test("DingTalk callback always clears state and maps stable public failures", async (t) => {
  const server = app({
    publicConfig: () => ({ enabled: true as const, clientId: "id", corpId: "corp", agentId: "agent" }),
    completeOAuth: async () => {
      throw new DingTalkAuthenticationError("invalid-state");
    },
  });
  t.after(() => server.close());

  const response = await server.inject({
    method: "POST",
    url: "/v1/auth/dingtalk/oauth/callback",
    headers: headers({ cookie: `dingtalk_oauth_state=${STATE}` }),
    payload: { code: "oauth-code", state: STATE },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "DINGTALK_INVALID_STATE");
  assert.match(String(response.headers["set-cookie"]), /dingtalk_oauth_state=; Max-Age=0/);
});

test("DingTalk provider details are replaced by stable route errors", async (t) => {
  const server = app({
    publicConfig: () => ({ enabled: true as const, clientId: "id", corpId: "corp", agentId: "agent" }),
    loginWorkbench: async () => {
      throw new DingTalkProviderError("not-member");
    },
  });
  t.after(() => server.close());

  const response = await server.inject({
    method: "POST",
    url: "/v1/auth/dingtalk/workbench",
    headers: headers(),
    payload: { code: "provider-secret-code" },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, "DINGTALK_NOT_MEMBER");
  assert.doesNotMatch(response.body, /provider-secret-code/);
});
