import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

import { AuthSessionController } from "../../app/lib/auth-session-controller";
import {
  WebAuthError,
  changeWebPassword,
  expireAuthenticatedSession,
  loginAndReadWebSession,
  logoutWebSession,
  readWebSession,
} from "../../app/lib/web-auth-session";

const user = Object.freeze({
  id: "018f1f5c-60f0-4b7a-8000-000000000001",
  organizationId: "018f1f5c-60f0-4b7a-8000-000000000002",
  email: "member@example.com",
  displayName: "Member",
  role: "member" as const,
  status: "active" as const,
  createdAt: "2026-08-19T00:00:00.000Z",
  updatedAt: "2026-08-19T00:00:00.000Z",
});

const execFileAsync = promisify(execFile);

function queuedFetch(...responses: Array<Response | Error>) {
  const calls: Array<{ path: string; init: RequestInit | undefined }> = [];
  return {
    calls,
    fetch: async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      if (!response) throw new Error("Unexpected fetch call");
      return response;
    },
  };
}

async function expectWebAuthError(
  action: () => Promise<unknown>,
  kind: "invalid-credentials" | "rate-limited" | "unavailable",
  retryAfterSeconds: number | null = null,
) {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof WebAuthError);
    assert.equal(error.kind, kind);
    assert.equal(error.retryAfterSeconds, retryAfterSeconds);
    return true;
  });
}

test("readWebSession returns null for an anonymous validated session", async () => {
  const stub = queuedFetch(Response.json({ authenticated: false, user: null }));

  assert.equal(await readWebSession(stub.fetch), null);
  assert.deepEqual(stub.calls, [{ path: "/v1/auth/session", init: undefined }]);
});

test("readWebSession returns the exact validated authenticated user", async () => {
  const stub = queuedFetch(Response.json({ authenticated: true, user }));

  assert.deepEqual(await readWebSession(stub.fetch), user);
});

test("readWebSession rejects contradictory and malformed session payloads as unavailable", async () => {
  for (const payload of [
    { authenticated: true, user: null },
    { authenticated: false, user },
    { authenticated: true, user: { ...user, email: "not-an-email" } },
  ]) {
    const stub = queuedFetch(Response.json(payload));
    await expectWebAuthError(() => readWebSession(stub.fetch), "unavailable");
  }
});

test("loginAndReadWebSession submits validated credentials then confirms the session", async () => {
  const stub = queuedFetch(
    Response.json({ user }),
    Response.json({ authenticated: true, user }),
  );

  assert.deepEqual(
    await loginAndReadWebSession({ email: user.email, password: "password" }, stub.fetch),
    user,
  );
  assert.equal(stub.calls.length, 2);
  assert.equal(stub.calls[0]?.path, "/v1/auth/login");
  assert.equal(stub.calls[0]?.init?.method, "POST");
  assert.equal(stub.calls[0]?.init?.body, JSON.stringify({ email: user.email, password: "password" }));
  assert.equal(stub.calls[1]?.path, "/v1/auth/session");
  assert.equal(stub.calls[1]?.init, undefined);
});

test("loginAndReadWebSession maps 401 to invalid credentials", async () => {
  const stub = queuedFetch(new Response(null, { status: 401 }));

  await expectWebAuthError(
    () => loginAndReadWebSession({ email: user.email, password: "password" }, stub.fetch),
    "invalid-credentials",
  );
  assert.equal(stub.calls.length, 1);
});

test("loginAndReadWebSession maps 429 only with a canonical non-negative integer Retry-After", async () => {
  for (const [header, retryAfterSeconds] of [
    ["0", 0],
    ["60", 60],
    ["01", null],
    ["+1", null],
    ["1.5", null],
    ["-1", null],
    ["1e2", null],
    [null, null],
  ] as const) {
    const headers = header === null ? undefined : { "Retry-After": header };
    const stub = queuedFetch(new Response(null, { status: 429, headers }));
    await expectWebAuthError(
      () => loginAndReadWebSession({ email: user.email, password: "password" }, stub.fetch),
      "rate-limited",
      retryAfterSeconds,
    );
  }
});

test("loginAndReadWebSession treats invalid input, non-OK responses, malformed JSON, and a missing confirmed user as unavailable", async () => {
  const invalidInput = queuedFetch();
  await expectWebAuthError(
    () => loginAndReadWebSession({ email: "bad", password: "" } as never, invalidInput.fetch),
    "unavailable",
  );
  assert.equal(invalidInput.calls.length, 0);

  for (const responses of [
    [new Response(null, { status: 500 })],
    [new Response("not json")],
    [Response.json({ user }), Response.json({ authenticated: false, user: null })],
    [new Error("network failed")],
  ]) {
    const stub = queuedFetch(...responses);
    await expectWebAuthError(
      () => loginAndReadWebSession({ email: user.email, password: "password" }, stub.fetch),
      "unavailable",
    );
  }
});

test("logoutWebSession posts and validates its successful response", async () => {
  const stub = queuedFetch(Response.json({ ok: true }));

  await logoutWebSession(stub.fetch);
  assert.deepEqual(stub.calls, [{ path: "/v1/auth/logout", init: { method: "POST" } }]);
});

test("logoutWebSession treats non-OK and malformed responses as unavailable", async () => {
  for (const response of [new Response(null, { status: 500 }), Response.json({ ok: false }), new Response("not json")]) {
    const stub = queuedFetch(response);
    await expectWebAuthError(() => logoutWebSession(stub.fetch), "unavailable");
  }
});

test("changeWebPassword validates and posts the typed password contract", async () => {
  const stub = queuedFetch(Response.json({ ok: true }));
  await changeWebPassword({ currentPassword: "old-pass-1", newPassword: "new-pass-1", confirmation: "new-pass-1" }, stub.fetch);
  assert.deepEqual(stub.calls, [{ path: "/v1/auth/password", init: {
    method: "POST",
    body: JSON.stringify({ currentPassword: "old-pass-1", newPassword: "new-pass-1", confirmation: "new-pass-1" }),
  } }]);
  await expectWebAuthError(
    () => changeWebPassword({ currentPassword: "old-pass-1", newPassword: "1234567", confirmation: "1234567" }, stub.fetch),
    "unavailable",
  );
});

test("expireAuthenticatedSession only expires authenticated state", () => {
  const authenticated = {
    status: "authenticated" as const,
    user,
    message: null,
    retryAfterSeconds: null,
  };
  const unauthenticated = {
    status: "unauthenticated" as const,
    user: null,
    message: "Already signed out",
    retryAfterSeconds: null,
  };

  assert.deepEqual(expireAuthenticatedSession(authenticated), {
    status: "unauthenticated",
    user: null,
    message: "登录已失效，请重新登录",
    retryAfterSeconds: null,
  });
  assert.equal(expireAuthenticatedSession(unauthenticated), unauthenticated);
});

test("expireAuthenticatedSession preserves checking, submitting, unavailable, and rate-limited login states", () => {
  const states = [
    { status: "checking" as const, user: null, message: null, retryAfterSeconds: null },
    { status: "submitting" as const, user: null, message: null, retryAfterSeconds: null },
    { status: "unavailable" as const, user: null, message: "登录服务暂时不可用，请重试", retryAfterSeconds: null },
    { status: "unauthenticated" as const, user: null, message: "尝试次数过多，请稍后再试", retryAfterSeconds: 60 },
  ];

  for (const state of states) assert.equal(expireAuthenticatedSession(state), state);
});

test("AuthSessionController starts checking, returns the exact confirmed user, and clears the submitted password", async () => {
  const controller = new AuthSessionController({
    readSession: async () => null,
    login: async () => user,
    logout: async () => {},
  });

  assert.deepEqual(controller.state, { status: "checking", user: null, message: null, retryAfterSeconds: null });
  controller.setCredentials(user.email, "password");
  await controller.bootstrap();
  assert.equal(controller.state.status, "unauthenticated");
  await controller.submit();
  assert.deepEqual(controller.state, { status: "authenticated", user, message: null, retryAfterSeconds: null });
  assert.equal(controller.password, "");
});

test("AuthSessionController keeps the application authenticated after logout failure and allows retry", async () => {
  let logoutAttempts = 0;
  const controller = new AuthSessionController({
    readSession: async () => user,
    login: async () => user,
    logout: async () => {
      logoutAttempts += 1;
      if (logoutAttempts === 1) throw new Error("offline");
    },
  });

  await controller.bootstrap();
  await controller.logout();
  assert.equal(controller.state.status, "authenticated");
  assert.equal(controller.logoutError, "登录服务暂时不可用，请重试");
  await controller.logout();
  assert.deepEqual(controller.state, { status: "unauthenticated", user: null, message: null, retryAfterSeconds: null });
});

test("AuthSessionController decrements a valid rate limit one bounded second at a time and retries bootstrap", async () => {
  let bootstrapCalls = 0;
  const controller = new AuthSessionController({
    readSession: async () => {
      bootstrapCalls += 1;
      if (bootstrapCalls === 1) throw new Error("offline");
      return null;
    },
    login: async () => {
      throw new WebAuthError("rate-limited", 2);
    },
    logout: async () => {},
  });

  await controller.bootstrap();
  assert.equal(controller.state.status, "unavailable");
  await controller.bootstrap(true);
  assert.equal(controller.state.status, "unauthenticated");
  controller.setCredentials(user.email, "password");
  await controller.submit();
  assert.equal(controller.state.retryAfterSeconds, 2);
  controller.tickRateLimit();
  assert.equal(controller.state.retryAfterSeconds, 1);
  controller.tickRateLimit();
  assert.equal(controller.state.retryAfterSeconds, 0);
  controller.tickRateLimit();
  assert.equal(controller.state.retryAfterSeconds, 0);
});

test("AuthSessionGate and its rendered views expose only the approved unauthenticated and confirmed-identity markup", async () => {
  const { stdout } = await execFileAsync("cmd.exe", ["/d", "/s", "/c", "npx tsx tests/agent/helpers/render-auth-session-gate.tsx"], { cwd: process.cwd() });
  const rendered = JSON.parse(stdout) as { checking: string; childRenderCount: number; login: string; identity: string };

  assert.equal(rendered.childRenderCount, 0);
  assert.match(rendered.checking, /正在检查登录状态/);
  assert.doesNotMatch(rendered.checking, /protected-app|竞品概览|产品机会洞察/);
  assert.match(rendered.login, /登录您的账户/);
  assert.match(rendered.login, /name="email"/);
  assert.match(rendered.login, /type="email"/);
  assert.match(rendered.login, /name="password"/);
  assert.match(rendered.login, /type="password"/);
  assert.match(rendered.login, /aria-label="显示密码"/);
  assert.match(rendered.login, />登录</);
  assert.match(rendered.login, /role="status"/);
  assert.doesNotMatch(rendered.login, /Google|GitHub|其他方式|注册|忘记密码/);
  assert.match(rendered.identity, /Member/);
  assert.match(rendered.identity, /member/);
  assert.match(rendered.identity, /退出登录/);
});
