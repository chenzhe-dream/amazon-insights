import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  WebAuthError,
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

test("AuthSessionGate defines the checking boundary, approved login controls, and confirmed identity control", async () => {
  const source = await readFile(new URL("../../app/auth-session-gate.tsx", import.meta.url), "utf8");

  assert.match(source, /正在检查登录状态/);
  assert.match(source, /if \(state\.status === "authenticated"\) return children/);
  assert.match(source, /登录您的账户/);
  assert.match(source, /name="email" type="email"/);
  assert.match(source, /name="password" type=\{showPassword \? "text" : "password"\}/);
  assert.match(source, /aria-label=\{showPassword \? "隐藏密码" : "显示密码"\}/);
  assert.match(source, /className="auth-login-submit"/);
  assert.match(source, /role="status"/);
  assert.match(source, /user\.displayName \|\| user\.email/);
  assert.match(source, /\{user\.role\}/);
  assert.match(source, /退出登录/);
  assert.doesNotMatch(source, /Google|GitHub|其他方式|注册|忘记密码/);
});
