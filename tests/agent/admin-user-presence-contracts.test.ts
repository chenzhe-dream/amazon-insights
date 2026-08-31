import assert from "node:assert/strict";
import test from "node:test";

import {
  ActivityRequestSchema,
  ActivityResponseSchema,
  AdminUserPresenceResponseSchema,
  findHttpContract,
  InvalidationReasonSchema,
  PresenceStatusSchema,
} from "../../shared/agent-contracts";

const AS_OF = "2026-08-31T12:00:00.000Z";
const login = {
  loggedInAt: "2026-08-31T10:00:00.000Z",
  lastActivityAt: "2026-08-31T11:59:00.000Z",
  expiresAt: "2026-08-31T20:00:00.000Z",
  invalidationReason: null,
};
const user = {
  account: "admin@example.com",
  displayName: "Admin",
  role: "admin",
  accountStatus: "active",
  presenceStatus: "recently-online",
  loginCount: 1,
  lastLoginAt: login.loggedInAt,
  lastActivityAt: login.lastActivityAt,
  validSessionExpiresAt: login.expiresAt,
  recentLogins: [login],
};

test("admin user presence contracts are strict and expose only the approved fields", () => {
  assert.deepEqual(ActivityRequestSchema.parse({}), {});
  assert.deepEqual(ActivityResponseSchema.parse({ ok: true }), { ok: true });
  assert.equal(ActivityRequestSchema.safeParse({ account: "admin@example.com" }).success, false);
  assert.equal(ActivityResponseSchema.safeParse({ ok: false }).success, false);
  assert.equal(ActivityResponseSchema.safeParse({ ok: true, token: "secret" }).success, false);

  const response = AdminUserPresenceResponseSchema.parse({
    asOf: AS_OF,
    recentActivityWindowSeconds: 300,
    users: [user],
  });
  assert.deepEqual(response, {
    asOf: AS_OF,
    recentActivityWindowSeconds: 300,
    users: [user],
  });

  for (const presenceStatus of [
    "disabled",
    "recently-online",
    "valid-session-idle",
    "never-logged-in",
    "session-expired",
  ]) {
    assert.equal(PresenceStatusSchema.safeParse(presenceStatus).success, true);
  }
  for (const invalidationReason of ["account-disabled", "revoked", "expired", null]) {
    assert.equal(InvalidationReasonSchema.safeParse(invalidationReason).success, true);
  }

  for (const sensitiveField of [
    "cookie",
    "token",
    "tokenHash",
    "passwordHash",
    "sessionId",
    "ip",
    "id",
    "organizationId",
  ]) {
    assert.equal(
      AdminUserPresenceResponseSchema.safeParse({
        asOf: AS_OF,
        recentActivityWindowSeconds: 300,
        users: [{ ...user, [sensitiveField]: "must-not-leak" }],
      }).success,
      false,
      sensitiveField,
    );
    assert.equal(
      AdminUserPresenceResponseSchema.safeParse({
        asOf: AS_OF,
        recentActivityWindowSeconds: 300,
        users: [{ ...user, recentLogins: [{ ...login, [sensitiveField]: "must-not-leak" }] }],
      }).success,
      false,
      `recent login ${sensitiveField}`,
    );
  }
  assert.equal(
    AdminUserPresenceResponseSchema.safeParse({
      asOf: AS_OF,
      recentActivityWindowSeconds: 60,
      users: [user],
    }).success,
    false,
  );
  assert.equal(
    AdminUserPresenceResponseSchema.safeParse({
      asOf: AS_OF,
      recentActivityWindowSeconds: 300,
      users: [{ ...user, recentLogins: Array.from({ length: 11 }, () => login) }],
    }).success,
    false,
  );
});

test("admin user presence endpoints are registered with their strict contracts", () => {
  const activity = findHttpContract("POST", "/v1/auth/activity");
  assert.equal(activity?.request, ActivityRequestSchema);
  assert.equal(activity?.response, ActivityResponseSchema);

  const users = findHttpContract("GET", "/v1/admin/users");
  assert.equal(users?.response, AdminUserPresenceResponseSchema);
});
