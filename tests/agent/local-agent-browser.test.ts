import assert from "node:assert/strict";
import test from "node:test";

import { localAgentFetch, subscribeToAuthenticationRequired } from "../../app/lib/local-agent-browser";
import { changeWebPassword, expireAuthenticatedSession, type AuthSessionState } from "../../app/lib/web-auth-session";

const authenticatedState: AuthSessionState = {
  status: "authenticated",
  sessionIdentity: "A".repeat(43),
  canViewUserPresence: false,
  user: {
    id: "018f1f5c-60f0-4b7a-8000-000000000001",
    organizationId: "018f1f5c-60f0-4b7a-8000-000000000002",
    email: "member@example.com",
    displayName: "Member",
    role: "member",
    status: "active",
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
  },
  message: null,
  retryAfterSeconds: null,
};

test("local Agent browser fetch routes through the same-origin proxy without public secrets", async () => {
  const calls: Array<{ input: string; headers: Headers; body: BodyInit | null | undefined }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      input: String(input),
      headers: new Headers(init?.headers),
      body: init?.body,
    });
    return Response.json({ ok: true });
  }) as typeof fetch;

  try {
    await localAgentFetch("/v1/local-voc", {
      method: "POST",
      body: JSON.stringify({ asins: ["B07VY9Q95Q", "B0BPXRVWYK", "B07DYG1C9B"], marketplace: "US" }),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.input, "/api/agent/v1/local-voc");
  assert.equal(calls[0]?.headers.get("x-agent-proxy-token"), null);
  assert.equal(calls[0]?.headers.get("content-type"), "application/json");
});

test("local Agent browser fetch preserves query strings on the same-origin proxy path", async () => {
  let observedInput = "";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    observedInput = String(input);
    return Response.json({ ok: true });
  }) as typeof fetch;

  try {
    await localAgentFetch("/v1/local-data/projects?kind=analysis");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(observedInput, "/api/agent/v1/local-data/projects?kind=analysis");
});

test("local Agent browser fetch always sends same-origin credentials", async () => {
  let observedCredentials: RequestCredentials | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    observedCredentials = init?.credentials;
    return Response.json({ ok: true });
  }) as typeof fetch;

  try {
    await localAgentFetch("/v1/local-data/projects", { credentials: "omit" });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(observedCredentials, "same-origin");
});

test("local Agent browser fetch notifies active subscribers once for an unauthorized response without replaying it", async () => {
  const response = new Response("expired", { status: 401 });
  const notifications: string[] = [];
  const unsubscribeFirst = subscribeToAuthenticationRequired(() => notifications.push("first"));
  const unsubscribeSecond = subscribeToAuthenticationRequired(() => notifications.push("second"));
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return response;
  }) as typeof fetch;

  try {
    assert.equal(await localAgentFetch("/v1/local-data/projects"), response);
    assert.deepEqual(notifications, ["first", "second"]);
    unsubscribeFirst();
    assert.equal(await localAgentFetch("/v1/local-data/projects"), response);
  } finally {
    globalThis.fetch = originalFetch;
    unsubscribeFirst();
    unsubscribeSecond();
  }

  assert.equal(fetchCalls, 2);
  assert.deepEqual(notifications, ["first", "second", "second"]);
});

test("local Agent browser fetch does not notify subscribers for non-unauthorized responses", async () => {
  let notifications = 0;
  const unsubscribe = subscribeToAuthenticationRequired(() => { notifications += 1; });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 500 })) as typeof fetch;

  try {
    await localAgentFetch("/v1/local-data/projects");
  } finally {
    globalThis.fetch = originalFetch;
    unsubscribe();
  }

  assert.equal(notifications, 0);
});

test("wrong-current-password stays inline while a genuine expired session expires the gate", async () => {
  const responses = [
    Response.json({ error: { code: "INVALID_CREDENTIALS", message: "safe", requestId: "password-wrong" } }, { status: 401 }),
    Response.json({ error: { code: "AUTHENTICATION_REQUIRED", message: "safe", requestId: "session-expired" } }, { status: 401 }),
  ];
  let gateState: AuthSessionState = authenticatedState;
  const unsubscribe = subscribeToAuthenticationRequired(() => {
    gateState = expireAuthenticatedSession(gateState);
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => responses.shift()!) as typeof fetch;
  const input = {
    currentPassword: "old-pass-1",
    newPassword: "new-pass-1",
    confirmation: "new-pass-1",
  };

  try {
    await assert.rejects(changeWebPassword(input));
    assert.equal(gateState.status, "authenticated");
    await assert.rejects(changeWebPassword(input));
    assert.equal(gateState.status, "unauthenticated");
  } finally {
    globalThis.fetch = originalFetch;
    unsubscribe();
  }
});
