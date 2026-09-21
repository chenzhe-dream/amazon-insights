import assert from "node:assert/strict";
import test from "node:test";

import type { AdminUserPresenceResponse } from "../../shared/agent-contracts";
import {
  ADMIN_USER_PRESENCE_ERROR_MESSAGE,
  AdminUserPresenceLoaderController,
  readAdminUserPresence,
} from "../../app/lib/admin-user-presence-browser";
import { subscribeToAuthenticationRequired } from "../../app/lib/local-agent-browser";

const responseFixture: AdminUserPresenceResponse = {
  asOf: "2026-08-31T04:00:00.000Z",
  recentActivityWindowSeconds: 900,
  users: [{
    account: "admin@example.com",
    displayName: "Admin",
    role: "admin",
    accountStatus: "active",
    presenceStatus: "recently-online",
    loginCount: 1,
    lastLoginAt: "2026-08-31T03:00:00.000Z",
    lastActivityAt: "2026-08-31T03:59:00.000Z",
    validSessionExpiresAt: "2026-09-01T03:00:00.000Z",
    recentLogins: [{
      loggedInAt: "2026-08-31T03:00:00.000Z",
      lastActivityAt: "2026-08-31T03:59:00.000Z",
      expiresAt: "2026-09-01T03:00:00.000Z",
      invalidationReason: null,
    }],
  }],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("admin presence helper sends the exact bodyless GET and strictly parses success", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const signal = new AbortController().signal;

  const result = await readAdminUserPresence(signal, async (path, init) => {
    calls.push({ path, init });
    return Response.json(responseFixture);
  });

  assert.deepEqual(result, responseFixture);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.path, "/v1/admin/users");
  assert.deepEqual(Object.keys(calls[0]?.init ?? {}).sort(), ["method", "signal"]);
  assert.equal(calls[0]?.init?.method, "GET");
  assert.equal(calls[0]?.init?.signal, signal);
  assert.equal(calls[0]?.init?.body, undefined);
  assert.deepEqual([...new Headers(calls[0]?.init?.headers).entries()], []);
});

test("admin presence helper rejects non-OK, malformed, unknown, sensitive, and partial payloads generically", async () => {
  const sentinel = "backend-private-sentinel";
  const cases: Array<() => Promise<Response>> = [
    async () => Response.json({ error: { message: sentinel }, token: sentinel }, { status: 503 }),
    async () => new Response("not-json"),
    async () => Response.json({ ...responseFixture, internalOrganizationId: sentinel }),
    async () => Response.json({
      ...responseFixture,
      users: [{ ...responseFixture.users[0], tokenHash: sentinel }],
    }),
    async () => Response.json({
      ...responseFixture,
      users: [{ ...responseFixture.users[0], lastActivityAt: "malformed" }],
    }),
    async () => Response.json({
      ...responseFixture,
      users: [{ ...responseFixture.users[0], recentLogins: [
        { ...responseFixture.users[0]!.recentLogins[0], sessionId: sentinel },
      ] }],
    }),
  ];

  for (const fetchImpl of cases) {
    await assert.rejects(
      readAdminUserPresence(new AbortController().signal, fetchImpl),
      (error: unknown) => {
        assert.equal(error instanceof Error ? error.message : String(error), ADMIN_USER_PRESENCE_ERROR_MESSAGE);
        assert.doesNotMatch(String(error), new RegExp(sentinel));
        return true;
      },
    );
  }
});

test("admin presence helper exposes only a typed forbidden classification for 403", async () => {
  await assert.rejects(
    readAdminUserPresence(
      new AbortController().signal,
      async () => Response.json({ error: { message: "private details" } }, { status: 403 }),
    ),
    (error: unknown) => {
      assert.equal((error as { kind?: unknown }).kind, "forbidden");
      assert.equal(error instanceof Error ? error.message : "", ADMIN_USER_PRESENCE_ERROR_MESSAGE);
      assert.doesNotMatch(String(error), /private details/);
      return true;
    },
  );
});

test("admin presence helper preserves the shared authentication-required notification on 401", async () => {
  const originalFetch = globalThis.fetch;
  let authenticationRequired = 0;
  const unsubscribe = subscribeToAuthenticationRequired(() => { authenticationRequired += 1; });
  globalThis.fetch = (async () => Response.json(
    { error: { code: "AUTHENTICATION_REQUIRED", message: "backend-private-sentinel", requestId: "admin-users-401" } },
    { status: 401 },
  )) as typeof fetch;

  try {
    await assert.rejects(
      readAdminUserPresence(new AbortController().signal),
      new Error(ADMIN_USER_PRESENCE_ERROR_MESSAGE),
    );
  } finally {
    globalThis.fetch = originalFetch;
    unsubscribe();
  }

  assert.equal(authenticationRequired, 1);
});

test("loader controller exposes loading then ready or empty", async () => {
  const cases: Array<[AdminUserPresenceResponse, "ready" | "empty"]> = [
    [responseFixture, "ready"],
    [{ ...responseFixture, users: [] }, "empty"],
  ];
  for (const [payload, expected] of cases) {
    const states: string[] = [];
    const controller = new AdminUserPresenceLoaderController(async () => payload);
    controller.start((state) => states.push(state.status));
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(states, ["loading", expected]);
  }
});

test("loader controller maps failures safely and ignores stopped or stale completions", async () => {
  const errorStates: Array<{ status: string; message?: string }> = [];
  const failed = new AdminUserPresenceLoaderController(async () => {
    throw new Error("database token backend-private-sentinel");
  });
  failed.start((state) => errorStates.push(state));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(errorStates, [
    { status: "loading" },
    { status: "error", message: ADMIN_USER_PRESENCE_ERROR_MESSAGE },
  ]);

  const first = deferred<AdminUserPresenceResponse>();
  const signals: AbortSignal[] = [];
  const states: string[] = [];
  const controller = new AdminUserPresenceLoaderController((signal) => {
    signals.push(signal);
    return first.promise;
  });
  controller.start((state) => states.push(state.status));
  controller.stop();
  assert.equal(signals[0]?.aborted, true);
  first.resolve(responseFixture);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(states, ["loading"]);

  const stale = deferred<AdminUserPresenceResponse>();
  const replacementStates: string[] = [];
  let loadCount = 0;
  const replacement = new AdminUserPresenceLoaderController(async () => {
    loadCount += 1;
    return loadCount === 1 ? stale.promise : { ...responseFixture, users: [] };
  });
  replacement.start((state) => replacementStates.push(state.status));
  replacement.start((state) => replacementStates.push(state.status));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(replacementStates, ["loading", "loading", "empty"]);
  stale.resolve(responseFixture);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(replacementStates, ["loading", "loading", "empty"]);
});

test("loader clears data and revokes only the captured current session on forbidden", async () => {
  const states: string[] = [];
  const revoked: string[] = [];
  const controller = new AdminUserPresenceLoaderController(async () => {
    const error = new Error(ADMIN_USER_PRESENCE_ERROR_MESSAGE) as Error & { kind: string };
    error.kind = "forbidden";
    throw error;
  });
  controller.start(
    (state) => states.push(state.status),
    { sessionIdentity: "current-session", onForbidden: (identity) => revoked.push(identity) },
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(states, ["loading", "forbidden"]);
  assert.deepEqual(revoked, ["current-session"]);

  const stale = deferred<AdminUserPresenceResponse>();
  const oldRevocations: string[] = [];
  let call = 0;
  const replacement = new AdminUserPresenceLoaderController(async () => {
    call += 1;
    if (call === 1) return stale.promise;
    return { ...responseFixture, users: [] };
  });
  replacement.start(() => {}, {
    sessionIdentity: "old-session",
    onForbidden: (identity) => oldRevocations.push(identity),
  });
  replacement.start(() => {}, {
    sessionIdentity: "new-session",
    onForbidden: (identity) => oldRevocations.push(identity),
  });
  stale.reject(Object.assign(new Error(ADMIN_USER_PRESENCE_ERROR_MESSAGE), { kind: "forbidden" }));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(oldRevocations, []);
});
