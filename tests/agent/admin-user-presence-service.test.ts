import assert from "node:assert/strict";
import test from "node:test";

import {
  AdminUserPresenceService,
  type AdminUserPresenceUserFact,
} from "../../server/services/admin-user-presence-service";

const AS_OF = new Date("2026-08-31T12:00:00.000Z");
const asOf = AS_OF.toISOString();

function user(overrides: Partial<AdminUserPresenceUserFact> = {}): AdminUserPresenceUserFact {
  return {
    account: "member@example.com",
    displayName: "Member",
    role: "member",
    accountStatus: "active",
    loginCount: 0,
    lastLoginAt: null,
    lastActivityAt: null,
    validSessionExpiresAt: null,
    hasValidSession: false,
    hasRecentlyActiveValidSession: false,
    recentLogins: [],
    ...overrides,
  };
}

function login(
  overrides: Partial<AdminUserPresenceUserFact["recentLogins"][number]> = {},
) {
  return {
    loggedInAt: "2026-08-31T10:00:00.000Z",
    lastActivityAt: null,
    expiresAt: "2026-08-31T20:00:00.000Z",
    revokedAt: null,
    ...overrides,
  };
}

function list(users: readonly AdminUserPresenceUserFact[]) {
  return new AdminUserPresenceService({ asOf: () => AS_OF }).list(users);
}

test("presence service applies fixed state priority to aggregate facts", () => {
  const cases: ReadonlyArray<{
    name: string;
    subject: AdminUserPresenceUserFact;
    expected: string;
  }> = [
    { name: "never logged in", subject: user(), expected: "never-logged-in" },
    {
      name: "disabled overrides valid and recent flags",
      subject: user({
        accountStatus: "disabled",
        loginCount: 1,
        hasValidSession: true,
        hasRecentlyActiveValidSession: true,
      }),
      expected: "disabled",
    },
    {
      name: "recent valid activity",
      subject: user({
        loginCount: 2,
        hasValidSession: true,
        hasRecentlyActiveValidSession: true,
      }),
      expected: "recently-online",
    },
    {
      name: "valid session without recent activity",
      subject: user({ loginCount: 1, hasValidSession: true }),
      expected: "valid-session-idle",
    },
    {
      name: "history without a valid session",
      subject: user({ loginCount: 1 }),
      expected: "session-expired",
    },
  ];

  for (const row of cases) {
    assert.equal(list([row.subject]).users[0]?.presenceStatus, row.expected, row.name);
  }
});

test("presence service consumes all-history aggregates with only bounded recent-login facts", () => {
  const recentLogins = Array.from({ length: 11 }, (_, index) => login({
    loggedInAt: `2026-08-31T${String(11 - index).padStart(2, "0")}:00:00.000Z`,
    expiresAt: index === 1 ? asOf : "2026-09-01T00:00:00.000Z",
    revokedAt: index === 2 ? "2026-08-31T11:30:00.000Z" : null,
  }));
  const output = list([
    user({
      account: "Zebra@example.com",
      loginCount: 27,
      lastLoginAt: "2026-08-31T11:00:00.000Z",
      lastActivityAt: "2026-08-31T11:59:00.000Z",
      validSessionExpiresAt: "2026-09-03T00:00:00.000Z",
      hasValidSession: true,
      hasRecentlyActiveValidSession: true,
      recentLogins,
    }),
    user({ account: "Alpha@example.com", displayName: "Alpha" }),
  ]);

  assert.deepEqual(output.users.map((entry) => entry.account), [
    "Alpha@example.com",
    "Zebra@example.com",
  ]);
  const aggregate = output.users[1]!;
  assert.equal(aggregate.loginCount, 27);
  assert.equal(aggregate.lastLoginAt, "2026-08-31T11:00:00.000Z");
  assert.equal(aggregate.lastActivityAt, "2026-08-31T11:59:00.000Z");
  assert.equal(aggregate.validSessionExpiresAt, "2026-09-03T00:00:00.000Z");
  assert.equal(aggregate.presenceStatus, "recently-online");
  assert.equal(aggregate.recentLogins.length, 10);
  assert.equal(aggregate.recentLogins[0]?.invalidationReason, null);
  assert.equal(aggregate.recentLogins[1]?.invalidationReason, "expired");
  assert.equal(aggregate.recentLogins[2]?.invalidationReason, "revoked");
  assert.equal(output.asOf, asOf);
  assert.equal(output.recentActivityWindowSeconds, 900);
});

test("presence service makes disabled status override expiry facts and strips internal extras", () => {
  const subject = {
    ...user({
      accountStatus: "disabled",
      loginCount: 1,
      validSessionExpiresAt: "2026-09-01T00:00:00.000Z",
      recentLogins: [{
        ...login(),
        tokenHash: "must-not-leak",
        sessionId: "must-not-leak",
      } as unknown as AdminUserPresenceUserFact["recentLogins"][number]],
    }),
    id: "must-not-leak",
    organizationId: "must-not-leak",
    passwordHash: "must-not-leak",
  } as unknown as AdminUserPresenceUserFact;
  const output = list([subject]);
  const serialized = JSON.stringify(output);

  assert.equal(output.users[0]?.validSessionExpiresAt, null);
  assert.equal(
    output.users[0]?.recentLogins[0]?.invalidationReason,
    "account-disabled",
  );
  assert.equal(serialized.includes("must-not-leak"), false);
  assert.equal("id" in output.users[0]!, false);
  assert.equal("sessionId" in output.users[0]!.recentLogins[0]!, false);
});
