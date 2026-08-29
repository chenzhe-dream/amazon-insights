import assert from "node:assert/strict";
import test from "node:test";

import { authorizeWebMutation } from "../../app/lib/authenticated-web-mutation";
import type { AgentServiceClient } from "../../app/lib/agent-service-client";

const user = {
  id: "10000000-0000-4000-8000-000000000001",
  organizationId: "10000000-0000-4000-8000-000000000002",
  email: "member@example.com",
  displayName: "Member",
  role: "member" as const,
  status: "active" as const,
  createdAt: "2026-08-29T00:00:00.000Z",
  updatedAt: "2026-08-29T00:00:00.000Z",
};

function request(origin = "http://127.0.0.1:31900") {
  return new Request("http://127.0.0.1:31900/api/alexa-voc/import", {
    method: "POST",
    headers: { origin, cookie: "agent_session=opaque" },
  });
}

test("rejects a cross-origin mutation before calling Agent", async () => {
  let calls = 0;
  const client = (async () => { calls += 1; throw new Error("must not run"); }) as AgentServiceClient;
  const result = await authorizeWebMutation(request("http://untrusted.example"), {
    allowedRoles: ["admin", "member"], client,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.response.status, 403);
    await assertNoSecrets(result.response);
  }
  assert.equal(calls, 0);
});

test("returns the authenticated role from a valid Agent session", async () => {
  const client = (async (input) => {
    assert.equal(input.path, "/v1/auth/session");
    assert.equal(new Headers(input.headers).get("cookie"), "agent_session=opaque");
    return { status: 200, headers: new Headers(), body: { authenticated: true, user } };
  }) as AgentServiceClient;
  assert.deepEqual(await authorizeWebMutation(request(), {
    allowedRoles: ["admin", "member"], client,
  }), { ok: true, role: "member" });
});

const failures = [
  { name: "missing Origin", origin: null, body: { authenticated: true, user }, status: 403 },
  { name: "missing session", origin: "http://127.0.0.1:31900", body: { authenticated: false, user: null }, status: 401 },
] as const;

for (const scenario of failures) {
  test(`rejects ${scenario.name}`, async () => {
    const headers: Record<string, string> = { cookie: "agent_session=opaque" };
    if (scenario.origin) headers.origin = scenario.origin;
    const client = (async () => ({ status: 200, headers: new Headers(), body: scenario.body })) as AgentServiceClient;
    const result = await authorizeWebMutation(new Request(
      "http://127.0.0.1:31900/api/alexa-voc/import",
      { method: "POST", headers },
    ), { allowedRoles: ["admin", "member"], client });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.response.status, scenario.status);
      await assertNoSecrets(result.response);
    }
  });
}

function assertNoSecrets(response: Response) {
  return response.text().then((body) => {
    for (const secret of ["internal-url-sentinel", "proxy-token-sentinel", "agent_session=opaque", "upstream-body-sentinel"]) {
      assert.equal(body.includes(secret), false);
    }
  });
}

test("rejects a member when only admin is allowed without leaking secrets", async () => {
  const client = (async () => ({ status: 200, headers: new Headers(), body: { authenticated: true, user } })) as AgentServiceClient;
  const result = await authorizeWebMutation(request(), { allowedRoles: ["admin"], client });
  assert.equal(result.ok, false);
  if (!result.ok) { assert.equal(result.response.status, 403); await assertNoSecrets(result.response); }
});

test("rejects Agent status 502 without leaking secrets", async () => {
  const client = (async () => ({ status: 502, headers: new Headers(), body: { error: "upstream-body-sentinel", url: "internal-url-sentinel", token: "proxy-token-sentinel" } })) as AgentServiceClient;
  const result = await authorizeWebMutation(request(), { allowedRoles: ["admin", "member"], client });
  assert.equal(result.ok, false);
  if (!result.ok) { assert.equal(result.response.status, 503); await assertNoSecrets(result.response); }
});

test("rejects an unknown Agent session response key without leaking secrets", async () => {
  const client = (async () => ({ status: 200, headers: new Headers(), body: { authenticated: true, user, unknown: "upstream-body-sentinel" } })) as AgentServiceClient;
  const result = await authorizeWebMutation(request(), { allowedRoles: ["admin", "member"], client });
  assert.equal(result.ok, false);
  if (!result.ok) { assert.equal(result.response.status, 503); await assertNoSecrets(result.response); }
});
