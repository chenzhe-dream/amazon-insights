import assert from "node:assert/strict";
import test from "node:test";

import {
  DingTalkProviderError,
  RemoteDingTalkIdentityProvider,
} from "../../server/auth/dingtalk-provider";
import type { DingTalkAuthenticationConfig } from "../../server/config";

const CLIENT_SECRET = "dingtalk-provider-secret-sentinel";
const config: Extract<DingTalkAuthenticationConfig, { enabled: true }> = {
  enabled: true,
  clientId: "ding-client-id",
  clientSecret: CLIENT_SECRET,
  corpId: "ding-corp-id",
  agentId: "ding-agent-id",
  localOrganizationId: "20000000-0000-4000-8000-000000000001",
  redirectUri: "https://example.com/api/auth/dingtalk/callback",
  oauthStateTtlMs: 300_000,
};

type FetchStep = (url: string, init: RequestInit) => Response | Promise<Response>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function scriptedFetch(steps: FetchStep[]) {
  const bodies: unknown[] = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    bodies.push(body);
    const step = steps.shift();
    assert.ok(step, `unexpected request ${String(input)}`);
    return await step(String(input), init);
  };
  return { fetchImpl, bodies, remaining: steps };
}

function appTokenStep(): FetchStep {
  return (url, init) => {
    assert.equal(url, "https://api.dingtalk.com/v1.0/oauth2/accessToken");
    assert.equal(init.method, "POST");
    return json({ accessToken: "app-token", expireIn: 7200 });
  };
}

function memberStep(overrides: Record<string, unknown> = {}): FetchStep {
  return (url, init) => {
    assert.match(url, /^https:\/\/oapi\.dingtalk\.com\/topapi\/v2\/user\/get\?access_token=app-token$/);
    assert.equal(init.method, "POST");
    return json({
      errcode: 0,
      errmsg: "ok",
      result: {
        userid: "employee-123",
        unionid: "union-123",
        name: "测试成员",
        email: "member@example.com",
        active: true,
        ...overrides,
      },
    });
  };
}

test("workbench code is exchanged through the corp app and returns a verified member", async () => {
  const scripted = scriptedFetch([
    appTokenStep(),
    (url, init) => {
      assert.match(url, /\/topapi\/v2\/user\/getuserinfo\?access_token=app-token$/);
      assert.equal(init.method, "POST");
      return json({ errcode: 0, errmsg: "ok", result: { userid: "employee-123" } });
    },
    memberStep(),
  ]);
  const provider = new RemoteDingTalkIdentityProvider({
    config,
    fetchImpl: scripted.fetchImpl,
  });

  const identity = await provider.exchangeWorkbenchCode("workbench-code");
  assert.deepEqual(identity, {
    corpId: "ding-corp-id",
    subjectId: "employee-123",
    displayName: "测试成员",
    email: "member@example.com",
    active: true,
  });
  assert.equal(scripted.bodies.some((body) => JSON.stringify(body).includes(CLIENT_SECRET)), true);
  assert.equal(JSON.stringify(identity).includes(CLIENT_SECRET), false);
  assert.equal(scripted.remaining.length, 0);
});

test("OAuth code resolves unionId into a corp member before returning identity", async () => {
  const scripted = scriptedFetch([
    (url, init) => {
      assert.equal(url, "https://api.dingtalk.com/v1.0/oauth2/userAccessToken");
      assert.equal(init.method, "POST");
      return json({ accessToken: "user-token", expireIn: 7200 });
    },
    (url, init) => {
      assert.equal(url, "https://api.dingtalk.com/v1.0/contact/users/me");
      const headers = new Headers(init.headers);
      assert.equal(headers.get("x-acs-dingtalk-access-token"), "user-token");
      assert.equal(headers.get("authorization"), null);
      return json({ unionId: "union-123", nick: "OAuth Member" });
    },
    appTokenStep(),
    (url) => {
      assert.match(url, /\/topapi\/user\/getbyunionid\?access_token=app-token$/);
      return json({ errcode: 0, errmsg: "ok", result: { userid: "employee-123" } });
    },
    memberStep(),
  ]);
  const provider = new RemoteDingTalkIdentityProvider({ config, fetchImpl: scripted.fetchImpl });
  const identity = await provider.exchangeOAuthCode("oauth-code");
  assert.equal(identity.subjectId, "employee-123");
  assert.equal(identity.corpId, config.corpId);
  assert.equal(scripted.remaining.length, 0);
});

test("provider exposes stable invalid-code, membership, activity, and tenant categories", async () => {
  const cases: Array<{
    category: DingTalkProviderError["category"];
    steps: FetchStep[];
    operation: "workbench" | "oauth";
  }> = [
    {
      category: "invalid-code",
      operation: "workbench",
      steps: [appTokenStep(), () => json({ errcode: 40078, errmsg: "invalid auth code secret-sentinel" })],
    },
    {
      category: "not-member",
      operation: "oauth",
      steps: [
        () => json({ accessToken: "user-token", expireIn: 7200 }),
        () => json({ unionId: "union-123", nick: "Outside User" }),
        appTokenStep(),
        () => json({ errcode: 60121, errmsg: "user not found secret-sentinel" }),
      ],
    },
    {
      category: "inactive-member",
      operation: "workbench",
      steps: [
        appTokenStep(),
        () => json({ errcode: 0, errmsg: "ok", result: { userid: "employee-123" } }),
        memberStep({ active: false }),
      ],
    },
    {
      category: "tenant-mismatch",
      operation: "oauth",
      steps: [
        () => json({ accessToken: "user-token", expireIn: 7200 }),
        () => json({ unionId: "union-123", nick: "Wrong Tenant" }),
        appTokenStep(),
        () => json({ errcode: 0, errmsg: "ok", result: { userid: "employee-123" } }),
        memberStep({ unionid: "union-other" }),
      ],
    },
  ];

  for (const item of cases) {
    const scripted = scriptedFetch(item.steps);
    const provider = new RemoteDingTalkIdentityProvider({ config, fetchImpl: scripted.fetchImpl });
    const call = item.operation === "workbench"
      ? provider.exchangeWorkbenchCode("code")
      : provider.exchangeOAuthCode("code");
    await assert.rejects(call, (error: unknown) => {
      assert.ok(error instanceof DingTalkProviderError);
      assert.equal(error.category, item.category);
      assert.doesNotMatch(error.message, /secret-sentinel|dingtalk-provider-secret/);
      return true;
    });
  }
});

test("timeouts, non-JSON, and oversized provider responses fail unavailable without leakage", async () => {
  const failures: Array<{ fetchImpl: typeof fetch; maxResponseBytes?: number }> = [
    {
      fetchImpl: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("secret timeout", "AbortError")));
      }),
    },
    { fetchImpl: async () => new Response("not-json secret-sentinel") },
    { fetchImpl: async () => new Response("x".repeat(65)), maxResponseBytes: 64 },
  ];

  for (const failure of failures) {
    const provider = new RemoteDingTalkIdentityProvider({
      config,
      fetchImpl: failure.fetchImpl,
      timeoutMs: 10,
      ...(failure.maxResponseBytes === undefined
        ? {}
        : { maxResponseBytes: failure.maxResponseBytes }),
    });
    await assert.rejects(provider.exchangeWorkbenchCode("code"), (error: unknown) => {
      assert.ok(error instanceof DingTalkProviderError);
      assert.equal(error.category, "unavailable");
      assert.equal(error.message, "DingTalk identity provider is unavailable");
      return true;
    });
  }
});

test("OAuth provider failures retain only a safe failing-stage label", async () => {
  const provider = new RemoteDingTalkIdentityProvider({
    config,
    fetchImpl: scriptedFetch([
      () => json({ accessToken: "user-token", expireIn: 7200 }),
      () => json({ code: "Forbidden.AccessDenied", message: "secret-sentinel" }, 403),
    ]).fetchImpl,
  });

  await assert.rejects(provider.exchangeOAuthCode("oauth-code"), (error: unknown) => {
    assert.ok(error instanceof DingTalkProviderError);
    assert.equal((error as DingTalkProviderError & { stage?: string }).stage, "current-user");
    assert.equal((error as DingTalkProviderError & { httpStatus?: number }).httpStatus, 403);
    assert.equal(
      (error as DingTalkProviderError & { providerCode?: string }).providerCode,
      "Forbidden.AccessDenied",
    );
    assert.doesNotMatch(JSON.stringify(error), /secret-sentinel|user-token|oauth-code/);
    return true;
  });
});
