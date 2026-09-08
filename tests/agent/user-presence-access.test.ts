import assert from "node:assert/strict";
import test from "node:test";

import type { AuthenticatedPrincipal } from "../../server/auth/authentication-service";
import { createUserPresenceAccess } from "../../server/auth/user-presence-access";
import type {
  AuthenticationRepository,
  DingTalkIdentityBinding,
  UserRecord,
} from "../../server/db/repository";

const ORGANIZATION_ID = "synthetic-organization";
const PRIMARY_USER_ID = "synthetic-primary-user";
const DINGTALK_USER_ID = "synthetic-dingtalk-user";
const PRIMARY_EMAIL = "primary@example.test";

function user(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: PRIMARY_USER_ID,
    organizationId: ORGANIZATION_ID,
    email: PRIMARY_EMAIL,
    displayName: "Synthetic User",
    role: "admin",
    status: "active",
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
    ...overrides,
  };
}

function principal(overrides: Partial<AuthenticatedPrincipal> = {}): AuthenticatedPrincipal {
  return {
    kind: "user",
    userId: PRIMARY_USER_ID,
    organizationId: ORGANIZATION_ID,
    email: PRIMARY_EMAIL,
    role: "admin",
    sessionId: "synthetic-session",
    ...overrides,
  };
}

function fullEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    AGENT_USER_PRESENCE_ORGANIZATION_ID: ORGANIZATION_ID,
    AGENT_USER_PRESENCE_PRIMARY_USER_ID: PRIMARY_USER_ID,
    AGENT_USER_PRESENCE_PRIMARY_EMAIL: PRIMARY_EMAIL,
    AGENT_USER_PRESENCE_DINGTALK_USER_ID: DINGTALK_USER_ID,
    AGENT_USER_PRESENCE_DINGTALK_CORP_ID: "synthetic-corp",
    AGENT_USER_PRESENCE_DINGTALK_SUBJECT_ID: "synthetic-subject",
    ...overrides,
  };
}

function repositoryWithBinding(
  read: () => Promise<DingTalkIdentityBinding | null>,
): Pick<AuthenticationRepository, "findDingTalkIdentityByUserId"> {
  return { findDingTalkIdentityByUserId: read };
}

function accessHarness(options: {
  env?: Record<string, string | undefined>;
  currentUser?: UserRecord | null;
  binding?: DingTalkIdentityBinding | null;
  bindingFailure?: Error;
}) {
  let currentUser = options.currentUser === undefined ? user() : options.currentUser;
  let binding = options.binding ?? null;
  const access = createUserPresenceAccess({
    env: options.env ?? fullEnv(),
    authService: {
      async findPublicUser(userId: string) {
        return currentUser?.id === userId && currentUser.status === "active"
          ? currentUser
          : null;
      },
    },
    repository: repositoryWithBinding(async () => {
      if (options.bindingFailure) throw options.bindingFailure;
      return binding;
    }),
  });
  return {
    access,
    setCurrentUser(value: UserRecord | null) { currentUser = value; },
    setBinding(value: DingTalkIdentityBinding | null) { binding = value; },
  };
}

test("designated active primary email administrator is allowed and current demotion revokes the grant", async () => {
  const harness = accessHarness({});
  assert.equal(await harness.access.canView(principal()), true);

  harness.setCurrentUser(user({ role: "member" }));
  assert.equal(await harness.access.canView(principal()), false);
});

test("only the exact verified active DingTalk binding is allowed independent of role", async () => {
  const dingTalkUser = user({
    id: DINGTALK_USER_ID,
    email: "personal@example.test",
    role: "member",
  });
  const harness = accessHarness({
    currentUser: dingTalkUser,
    binding: {
      userId: DINGTALK_USER_ID,
      organizationId: ORGANIZATION_ID,
      corpId: "synthetic-corp",
      subjectId: "synthetic-subject",
    },
  });
  const dingTalkPrincipal = principal({
    userId: DINGTALK_USER_ID,
    email: dingTalkUser.email,
    role: "member",
  });
  assert.equal(await harness.access.canView(dingTalkPrincipal), true);

  harness.setBinding(null);
  assert.equal(await harness.access.canView(dingTalkPrincipal), false);
});

test("other admins, same-email identities, cross-organization principals and stale users are denied", async () => {
  const cases = [
    {
      currentUser: user({ id: "other-admin", email: "other@example.test" }),
      principal: principal({ userId: "other-admin", email: "other@example.test" }),
    },
    {
      currentUser: user({ id: "same-email-other-id" }),
      principal: principal({ userId: "same-email-other-id" }),
    },
    {
      currentUser: user({ organizationId: "other-organization" }),
      principal: principal({ organizationId: "other-organization" }),
    },
    {
      currentUser: user({ id: "different-current-user" }),
      principal: principal(),
    },
  ];
  for (const candidate of cases) {
    const harness = accessHarness({ currentUser: candidate.currentUser });
    assert.equal(await harness.access.canView(candidate.principal), false);
  }

  const disabled = accessHarness({ currentUser: null });
  assert.equal(await disabled.access.canView(principal()), false);
});

test("a non-user session shape is denied even when every identity field matches", async () => {
  const harness = accessHarness({});
  assert.equal(await harness.access.canView({
    ...principal(),
    kind: "anonymous-loopback",
  } as unknown as AuthenticatedPrincipal), false);
});

test("missing or partial configuration and invalid bounded values fail closed", async () => {
  for (const env of [
    {},
    { AGENT_USER_PRESENCE_ORGANIZATION_ID: ORGANIZATION_ID },
    fullEnv({ AGENT_USER_PRESENCE_PRIMARY_EMAIL: undefined }),
    fullEnv({ AGENT_USER_PRESENCE_PRIMARY_EMAIL: "not-an-email" }),
    fullEnv({ AGENT_USER_PRESENCE_ORGANIZATION_ID: "x".repeat(201) }),
  ]) {
    const harness = accessHarness({ env });
    assert.equal(await harness.access.canView(principal()), false);
  }

  const partialDingTalk = accessHarness({
    env: fullEnv({ AGENT_USER_PRESENCE_DINGTALK_SUBJECT_ID: undefined }),
    currentUser: user({ id: DINGTALK_USER_ID, role: "member" }),
    binding: {
      userId: DINGTALK_USER_ID,
      organizationId: ORGANIZATION_ID,
      corpId: "synthetic-corp",
      subjectId: "synthetic-subject",
    },
  });
  assert.equal(await partialDingTalk.access.canView(principal({
    userId: DINGTALK_USER_ID,
    role: "member",
  })), false);
});

test("wrong DingTalk corp, subject, organization, user, missing seam and repository exceptions deny", async () => {
  const dingTalkPrincipal = principal({ userId: DINGTALK_USER_ID, role: "member" });
  const dingTalkUser = user({ id: DINGTALK_USER_ID, role: "member" });
  const baseBinding: DingTalkIdentityBinding = {
    userId: DINGTALK_USER_ID,
    organizationId: ORGANIZATION_ID,
    corpId: "synthetic-corp",
    subjectId: "synthetic-subject",
  };
  for (const binding of [
    { ...baseBinding, corpId: "wrong-corp" },
    { ...baseBinding, subjectId: "wrong-subject" },
    { ...baseBinding, organizationId: "wrong-organization" },
    { ...baseBinding, userId: "wrong-user" },
  ]) {
    const harness = accessHarness({ currentUser: dingTalkUser, binding });
    assert.equal(await harness.access.canView(dingTalkPrincipal), false);
  }

  const missingSeam = createUserPresenceAccess({
    env: fullEnv(),
    authService: { findPublicUser: async () => dingTalkUser },
    repository: {},
  });
  assert.equal(await missingSeam.canView(dingTalkPrincipal), false);

  const failed = accessHarness({
    currentUser: dingTalkUser,
    bindingFailure: new Error("private database details"),
  });
  assert.equal(await failed.access.canView(dingTalkPrincipal), false);
});

test("configuration is snapshotted and independent grants remain independently valid", async () => {
  const env = fullEnv();
  const harness = accessHarness({ env });
  env.AGENT_USER_PRESENCE_PRIMARY_USER_ID = "changed-after-start";
  assert.equal(await harness.access.canView(principal()), true);

  const both = accessHarness({
    currentUser: user(),
    binding: {
      userId: PRIMARY_USER_ID,
      organizationId: ORGANIZATION_ID,
      corpId: "synthetic-corp",
      subjectId: "synthetic-subject",
    },
    env: fullEnv({ AGENT_USER_PRESENCE_DINGTALK_USER_ID: PRIMARY_USER_ID }),
  });
  both.setCurrentUser(user({ role: "member" }));
  assert.equal(await both.access.canView(principal()), true);
});
