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
    sessions: [],
    ...overrides,
  };
}

function session(overrides: Partial<AdminUserPresenceUserFact["sessions"][number]> = {}) {
  return {
    createdAt: "2026-08-31T10:00:00.000Z",
    lastSeenAt: null,
    expiresAt: "2026-08-31T20:00:00.000Z",
    revokedAt: null,
    stableSortKey: "session-a",
    ...overrides,
  };
}

function list(users: readonly AdminUserPresenceUserFact[]) {
  return new AdminUserPresenceService({ asOf: () => AS_OF }).list(users);
}

test("presence service table classifies all state priorities and five-minute boundaries", () => {
  const cases: ReadonlyArray<{
    name: string;
    subject: AdminUserPresenceUserFact;
    expected: string;
  }> = [
    { name: "never logged in", subject: user(), expected: "never-logged-in" },
    {
      name: "multiple sessions use a qualifying active session",
      subject: user({
        sessions: [
          session({ revokedAt: "2026-08-31T11:00:00.000Z", lastSeenAt: "2026-08-31T11:59:59.000Z" }),
          session({ stableSortKey: "session-b", lastSeenAt: "2026-08-31T11:57:00.000Z" }),
        ],
      }),
      expected: "recently-online",
    },
    {
      name: "disabled account takes precedence",
      subject: user({ accountStatus: "disabled", sessions: [session({ lastSeenAt: asOf })] }),
      expected: "disabled",
    },
    {
      name: "valid session without activity is idle",
      subject: user({ sessions: [session()] }),
      expected: "valid-session-idle",
    },
    {
      name: "activity before five-minute boundary is idle",
      subject: user({ sessions: [session({ lastSeenAt: "2026-08-31T11:54:59.999Z" })] }),
      expected: "valid-session-idle",
    },
    {
      name: "activity equal to five-minute boundary is recent",
      subject: user({ sessions: [session({ lastSeenAt: "2026-08-31T11:55:00.000Z" })] }),
      expected: "recently-online",
    },
    {
      name: "activity after five-minute boundary is recent",
      subject: user({ sessions: [session({ lastSeenAt: "2026-08-31T11:55:00.001Z" })] }),
      expected: "recently-online",
    },
    {
      name: "revoked sessions are expired",
      subject: user({ sessions: [session({ revokedAt: "2026-08-31T11:00:00.000Z" })] }),
      expected: "session-expired",
    },
    {
      name: "expired sessions are expired",
      subject: user({ sessions: [session({ expiresAt: asOf })] }),
      expected: "session-expired",
    },
    {
      name: "recent activity on a revoked session is ignored",
      subject: user({
        sessions: [session({ revokedAt: "2026-08-31T11:00:00.000Z", lastSeenAt: asOf })],
      }),
      expected: "session-expired",
    },
  ];

  for (const row of cases) {
    assert.equal(list([row.subject]).users[0]?.presenceStatus, row.expected, row.name);
  }
});

test("presence service uses all history for maxima, returns ten stable recent logins, and sorts accounts", () => {
  const sessions = Array.from({ length: 11 }, (_, index) => session({
    createdAt: `2026-08-31T${String(index).padStart(2, "0")}:00:00.000Z`,
    lastSeenAt: index === 10 ? "2026-08-31T11:58:00.000Z" : null,
    expiresAt: index === 8 ? "2026-09-02T00:00:00.000Z" : index === 9 ? "2026-09-01T00:00:00.000Z" : "2026-08-31T20:00:00.000Z",
    revokedAt: index === 8 ? "2026-08-31T11:00:00.000Z" : null,
    stableSortKey: `stable-${String(10 - index).padStart(2, "0")}`,
  }));
  const output = list([
    user({ account: "Zebra@example.com", sessions }),
    user({ account: "Alpha@example.com", displayName: "Alpha", sessions: [session()] }),
  ]);

  assert.deepEqual(output.users.map((entry) => entry.account), ["Alpha@example.com", "Zebra@example.com"]);
  const zebra = output.users[1]!;
  assert.equal(zebra.loginCount, 11);
  assert.equal(zebra.lastLoginAt, "2026-08-31T10:00:00.000Z");
  assert.equal(zebra.lastActivityAt, "2026-08-31T11:58:00.000Z");
  assert.equal(zebra.validSessionExpiresAt, "2026-09-01T00:00:00.000Z");
  assert.equal(zebra.recentLogins.length, 10);
  assert.deepEqual(
    zebra.recentLogins.slice(0, 2).map((entry) => entry.loggedInAt),
    ["2026-08-31T10:00:00.000Z", "2026-08-31T09:00:00.000Z"],
  );
  assert.equal(zebra.recentLogins[0]?.invalidationReason, null);
  assert.equal(output.asOf, asOf);
  assert.equal(output.recentActivityWindowSeconds, 300);
});

test("presence service uses its internal stable key to order equal-time logins", () => {
  const first = session({
    createdAt: "2026-08-31T10:00:00.000Z",
    expiresAt: "2026-08-31T20:00:00.000Z",
    stableSortKey: "a",
  });
  const second = session({
    createdAt: "2026-08-31T10:00:00.000Z",
    expiresAt: "2026-08-31T21:00:00.000Z",
    stableSortKey: "b",
  });

  const forward = list([user({ sessions: [first, second] })]).users[0]!.recentLogins;
  const reverse = list([user({ sessions: [second, first] })]).users[0]!.recentLogins;

  assert.deepEqual(forward, reverse);
});

test("presence service maps only public fields from repository facts", () => {
  const subject = {
    ...user({ sessions: [{ ...session(), tokenHash: "must-not-leak", sessionId: "must-not-leak" }] }),
    id: "must-not-leak",
    organizationId: "must-not-leak",
    passwordHash: "must-not-leak",
  } as unknown as AdminUserPresenceUserFact;
  const output = list([subject]);
  const serialized = JSON.stringify(output);

  assert.equal(serialized.includes("must-not-leak"), false);
  assert.equal("id" in output.users[0]!, false);
  assert.equal("sessionId" in output.users[0]!.recentLogins[0]!, false);
});
