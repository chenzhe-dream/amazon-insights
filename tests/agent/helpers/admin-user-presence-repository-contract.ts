import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";

import type {
  AdminUserPresenceHeartbeatInput,
  AdminUserPresenceHeartbeatResult,
  AdminUserPresenceRepository,
} from "../../../server/db/admin-user-presence-repository";
import type { AgentRepository } from "../../../server/db/repository";

const AS_OF = "2026-08-31T12:00:00.000Z";
const ORGANIZATION_ID = "91000000-0000-4000-8000-000000000001";
const OTHER_ORGANIZATION_ID = "91000000-0000-4000-8000-000000000002";
const ACTIVE_USER_ID = "91000000-0000-4000-8000-000000000003";
const DISABLED_USER_ID = "91000000-0000-4000-8000-000000000004";
const NEVER_USER_ID = "91000000-0000-4000-8000-000000000005";
const OTHER_USER_ID = "91000000-0000-4000-8000-000000000006";
const IDLE_USER_ID = "91000000-0000-4000-8000-000000000007";

export interface AdminUserPresenceRepositoryTestContext {
  readonly repository: AgentRepository;
  inspectLastSeenAt(sessionId: string): Promise<string | null>;
  beginRevocationTransition?(
    input: AdminUserPresenceHeartbeatInput,
  ): Promise<OrchestratedInactiveTransition>;
  close(): Promise<void>;
}

export interface OrchestratedInactiveTransition {
  startHeartbeat(): Promise<AdminUserPresenceHeartbeatResult>;
  waitUntilHeartbeatBlocked(): Promise<void>;
  commit(): Promise<void>;
  close(): Promise<void>;
}

export type CreateAdminUserPresenceRepositoryTestContext = (
  t: TestContext,
) => Promise<AdminUserPresenceRepositoryTestContext>;

export function registerAdminUserPresenceRepositoryContract(
  backend: string,
  createContext: CreateAdminUserPresenceRepositoryTestContext,
): void {
  test(`${backend} presence repository reads scoped all-history aggregates and bounded stable details`, async (t) => {
    const context = await createContext(t);
    t.after(() => context.close());
    const presence = requirePresenceCapability(context.repository);
    const seeded = await seedReadFixture(context.repository);

    const result = await presence.listOrganizationUsers({
      organizationId: ORGANIZATION_ID,
      asOf: AS_OF,
    });

    assert.deepEqual(result, expectedReadResult());
    assert.equal(JSON.stringify(result).includes(OTHER_USER_ID), false);

    const serialized = JSON.stringify(result);
    for (const sensitive of [
      ORGANIZATION_ID,
      ACTIVE_USER_ID,
      seeded.sessionIds[0]!,
      seeded.tokenHashes[0]!,
      "password-secret",
    ]) {
      assert.equal(serialized.includes(sensitive), false, `leaked ${sensitive}`);
    }
    assert.equal(/sessionId|token|hash|password|ipAddress/i.test(serialized), false);
  });

  test(`${backend} presence heartbeat enforces first, before, equal, and after 60-second boundaries atomically`, async (t) => {
    const context = await createContext(t);
    t.after(() => context.close());
    const presence = requirePresenceCapability(context.repository);
    await seedHeartbeatUser(context.repository);

    const firstId = sessionId(101);
    await createSession(context.repository, ACTIVE_USER_ID, firstId, null);
    assert.equal(await heartbeat(presence, firstId), "recorded");
    assert.equal(await context.inspectLastSeenAt(firstId), AS_OF);
    assert.equal(await heartbeat(presence, firstId), "throttled");

    const beforeId = sessionId(102);
    await createSession(
      context.repository,
      ACTIVE_USER_ID,
      beforeId,
      "2026-08-31T11:59:00.001Z",
    );
    assert.equal(await heartbeat(presence, beforeId), "throttled");
    assert.equal(
      await context.inspectLastSeenAt(beforeId),
      "2026-08-31T11:59:00.001Z",
    );

    const equalId = sessionId(103);
    await createSession(
      context.repository,
      ACTIVE_USER_ID,
      equalId,
      "2026-08-31T11:59:00.000Z",
    );
    const equalResults = await Promise.all(
      Array.from({ length: 8 }, () => heartbeat(presence, equalId)),
    );
    assert.equal(equalResults.filter((result) => result === "recorded").length, 1);
    assert.equal(equalResults.filter((result) => result === "throttled").length, 7);
    assert.equal(await context.inspectLastSeenAt(equalId), AS_OF);

    const afterId = sessionId(104);
    await createSession(
      context.repository,
      ACTIVE_USER_ID,
      afterId,
      "2026-08-31T11:58:59.999Z",
    );
    assert.equal(await heartbeat(presence, afterId), "recorded");
    assert.equal(await context.inspectLastSeenAt(afterId), AS_OF);
  });

  test(`${backend} presence heartbeat duplicate calls are idempotent and inactive races fail closed`, async (t) => {
    const context = await createContext(t);
    t.after(() => context.close());
    const presence = requirePresenceCapability(context.repository);
    await seedHeartbeatUser(context.repository);

    const duplicateId = sessionId(201);
    await createSession(context.repository, ACTIVE_USER_ID, duplicateId, null);
    const duplicateResults = await Promise.all(
      Array.from({ length: 12 }, () => heartbeat(presence, duplicateId)),
    );
    assert.equal(duplicateResults.filter((result) => result === "recorded").length, 1);
    assert.equal(duplicateResults.filter((result) => result === "throttled").length, 11);
    assert.equal(await context.inspectLastSeenAt(duplicateId), AS_OF);

    const revokedId = sessionId(202);
    const revokedHash = await createSession(
      context.repository,
      ACTIVE_USER_ID,
      revokedId,
      null,
    );
    await context.repository.revokeSessionByTokenHash({
      tokenHash: revokedHash,
      revokedAt: "2026-08-31T11:59:59.000Z",
    });
    assert.equal(await heartbeat(presence, revokedId), "inactive");
    assert.equal(await context.inspectLastSeenAt(revokedId), null);

    const expiredId = sessionId(203);
    await createSession(context.repository, ACTIVE_USER_ID, expiredId, null, AS_OF);
    assert.equal(await heartbeat(presence, expiredId), "inactive");

    const disabledId = sessionId(204);
    await createSession(context.repository, DISABLED_USER_ID, disabledId, null);
    assert.equal(await heartbeat(presence, disabledId, DISABLED_USER_ID), "inactive");
    assert.equal(await context.inspectLastSeenAt(disabledId), null);

    assert.equal(await heartbeat(presence, sessionId(999)), "inactive");
    assert.equal(
      await heartbeat(presence, duplicateId, DISABLED_USER_ID),
      "inactive",
    );
    assert.equal(
      await heartbeat(presence, duplicateId, ACTIVE_USER_ID, OTHER_ORGANIZATION_ID),
      "inactive",
    );
  });

  test(`${backend} presence heartbeat linearizes after an in-flight revocation and stays inactive`, async (t) => {
    const context = await createContext(t);
    t.after(() => context.close());
    await seedHeartbeatUser(context.repository);
    const raceId = sessionId(301);
    await createSession(context.repository, ACTIVE_USER_ID, raceId, null);

    assert.ok(
      context.beginRevocationTransition,
      `${backend} test adapter must orchestrate inactive transitions`,
    );
    const transition = await context.beginRevocationTransition({
      organizationId: ORGANIZATION_ID,
      userId: ACTIVE_USER_ID,
      sessionId: raceId,
      asOf: AS_OF,
    });
    try {
      const heartbeatResult = transition.startHeartbeat();
      await transition.waitUntilHeartbeatBlocked();
      await transition.commit();

      assert.equal(await heartbeatResult, "inactive");
      assert.equal(await context.inspectLastSeenAt(raceId), null);
    } finally {
      await transition.close();
    }
  });
}

function requirePresenceCapability(
  repository: AgentRepository,
): AdminUserPresenceRepository {
  const capability = (repository as AgentRepository & {
    adminUserPresence?: AdminUserPresenceRepository;
  }).adminUserPresence;
  assert.ok(capability, "runtime repository must expose adminUserPresence");
  return capability;
}

async function seedReadFixture(repository: AgentRepository) {
  await Promise.all([
    createUser(repository, NEVER_USER_ID, ORGANIZATION_ID, "alpha@example.com", "active"),
    createUser(repository, DISABLED_USER_ID, ORGANIZATION_ID, "disabled@example.com", "disabled"),
    createUser(repository, ACTIVE_USER_ID, ORGANIZATION_ID, "zebra@example.com", "active"),
    createUser(repository, IDLE_USER_ID, ORGANIZATION_ID, "idle@example.com", "active"),
    createUser(repository, OTHER_USER_ID, OTHER_ORGANIZATION_ID, "other@example.com", "active"),
  ]);

  await createSession(
    repository,
    DISABLED_USER_ID,
    sessionId(90),
    "2026-08-31T11:59:30.000Z",
    "2026-09-05T00:00:00.000Z",
  );
  await createSession(repository, OTHER_USER_ID, sessionId(91), null);
  await createSession(
    repository,
    IDLE_USER_ID,
    sessionId(92),
    "2026-08-31T11:44:59.999Z",
  );
  await createSession(
    repository,
    IDLE_USER_ID,
    sessionId(93),
    AS_OF,
    "2026-09-02T00:00:00.000Z",
    "2026-08-31T11:30:00.000Z",
    "2026-08-31T11:45:00.000Z",
  );

  const sessionIds: string[] = [];
  const tokenHashes: string[] = [];
  for (let index = 0; index < 12; index += 1) {
    const id = sessionId(index + 1);
    const loggedInHour = index >= 10 ? 11 : index;
    const loggedInAt = `2026-08-31T${String(loggedInHour).padStart(2, "0")}:00:00.000Z`;
    const expiresAt = index === 0
      ? "2026-08-31T11:00:00.000Z"
      : index === 1
        ? "2026-09-03T00:00:00.000Z"
        : index === 8
          ? AS_OF
          : `2026-09-01T${String(index).padStart(2, "0")}:00:00.000Z`;
    const lastSeenAt = index === 0
      ? "2026-08-31T11:59:00.000Z"
      : index === 11
        ? "2026-08-31T11:55:00.000Z"
        : null;
    const tokenHash = await createSession(
      repository,
      ACTIVE_USER_ID,
      id,
      lastSeenAt,
      expiresAt,
      loggedInAt,
      index === 9 ? "2026-08-31T11:30:00.000Z" : null,
    );
    sessionIds.push(id);
    tokenHashes.push(tokenHash);
  }
  return { sessionIds, tokenHashes };
}

async function seedHeartbeatUser(repository: AgentRepository) {
  await Promise.all([
    createUser(repository, ACTIVE_USER_ID, ORGANIZATION_ID, "active@example.com", "active"),
    createUser(repository, DISABLED_USER_ID, ORGANIZATION_ID, "disabled@example.com", "disabled"),
  ]);
}

async function createUser(
  repository: AgentRepository,
  id: string,
  organizationId: string,
  email: string,
  status: "active" | "disabled",
) {
  await repository.createUser({
    id,
    organizationId,
    email,
    displayName: email.split("@")[0]!,
    role: "member",
    status,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  });
}

async function createSession(
  repository: AgentRepository,
  userId: string,
  id: string,
  lastSeenAt: string | null,
  expiresAt = "2026-09-02T00:00:00.000Z",
  createdAt = "2026-08-31T10:00:00.000Z",
  revokedAt: string | null = null,
): Promise<string> {
  const tokenHash = createHash("sha256").update(id).digest("hex");
  await repository.createSession({
    id,
    userId,
    tokenHash,
    expiresAt,
    revokedAt,
    createdAt,
    lastSeenAt,
  });
  return tokenHash;
}

function heartbeat(
  repository: AdminUserPresenceRepository,
  id: string,
  userId = ACTIVE_USER_ID,
  organizationId = ORGANIZATION_ID,
) {
  return repository.recordHeartbeat({
    organizationId,
    userId,
    sessionId: id,
    asOf: AS_OF,
  });
}

function sessionId(index: number): string {
  return `92000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function expectedReadResult() {
  return {
    users: [
      {
        account: "alpha@example.com",
        displayName: "alpha",
        role: "member",
        accountStatus: "active",
        loginCount: 0,
        lastLoginAt: null,
        lastActivityAt: null,
        validSessionExpiresAt: null,
        hasValidSession: false,
        hasRecentlyActiveValidSession: false,
        recentLogins: [],
      },
      {
        account: "disabled@example.com",
        displayName: "disabled",
        role: "member",
        accountStatus: "disabled",
        loginCount: 1,
        lastLoginAt: "2026-08-31T10:00:00.000Z",
        lastActivityAt: "2026-08-31T11:59:30.000Z",
        validSessionExpiresAt: null,
        hasValidSession: false,
        hasRecentlyActiveValidSession: false,
        recentLogins: [
          {
            loggedInAt: "2026-08-31T10:00:00.000Z",
            lastActivityAt: "2026-08-31T11:59:30.000Z",
            expiresAt: "2026-09-05T00:00:00.000Z",
            revokedAt: null,
          },
        ],
      },
      {
        account: "idle@example.com",
        displayName: "idle",
        role: "member",
        accountStatus: "active",
        loginCount: 2,
        lastLoginAt: "2026-08-31T11:30:00.000Z",
        lastActivityAt: AS_OF,
        validSessionExpiresAt: "2026-09-02T00:00:00.000Z",
        hasValidSession: true,
        hasRecentlyActiveValidSession: false,
        recentLogins: [
          {
            loggedInAt: "2026-08-31T11:30:00.000Z",
            lastActivityAt: AS_OF,
            expiresAt: "2026-09-02T00:00:00.000Z",
            revokedAt: "2026-08-31T11:45:00.000Z",
          },
          {
            loggedInAt: "2026-08-31T10:00:00.000Z",
            lastActivityAt: "2026-08-31T11:44:59.999Z",
            expiresAt: "2026-09-02T00:00:00.000Z",
            revokedAt: null,
          },
        ],
      },
      {
        account: "zebra@example.com",
        displayName: "zebra",
        role: "member",
        accountStatus: "active",
        loginCount: 12,
        lastLoginAt: "2026-08-31T11:00:00.000Z",
        lastActivityAt: "2026-08-31T11:59:00.000Z",
        validSessionExpiresAt: "2026-09-03T00:00:00.000Z",
        hasValidSession: true,
        hasRecentlyActiveValidSession: true,
        recentLogins: [
          recentLogin(11, null),
          recentLogin(12, "2026-08-31T11:55:00.000Z"),
          recentLogin(10, null, "2026-08-31T11:30:00.000Z"),
          {
            loggedInAt: "2026-08-31T08:00:00.000Z",
            lastActivityAt: null,
            expiresAt: AS_OF,
            revokedAt: null,
          },
          recentLogin(8, null),
          recentLogin(7, null),
          recentLogin(6, null),
          recentLogin(5, null),
          recentLogin(4, null),
          recentLogin(3, null),
        ],
      },
    ],
  };
}

function recentLogin(
  fixtureNumber: number,
  lastActivityAt: string | null,
  revokedAt: string | null = null,
) {
  const fixtureIndex = fixtureNumber - 1;
  const loginHour = fixtureIndex >= 10 ? 11 : fixtureIndex;
  return {
    loggedInAt: `2026-08-31T${String(loginHour).padStart(2, "0")}:00:00.000Z`,
    lastActivityAt,
    expiresAt: `2026-09-01T${String(fixtureIndex).padStart(2, "0")}:00:00.000Z`,
    revokedAt,
  };
}
