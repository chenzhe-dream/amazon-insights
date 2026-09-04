import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  DingTalkAuthenticationError,
  DingTalkAuthenticationService,
} from "../../server/auth/dingtalk-authentication-service";
import type {
  DingTalkIdentityProvider,
  VerifiedDingTalkIdentity,
} from "../../server/auth/dingtalk-provider";
import type { DingTalkAuthenticationConfig } from "../../server/config";
import type {
  DingTalkAuthenticationRepository,
  OAuthLoginStateRecord,
  UserRecord,
  VerifiedDingTalkUserInput,
} from "../../server/db/repository";

const NOW = new Date("2026-09-04T08:00:00.000Z");
const RAW_STATE = "A".repeat(43);
const RAW_SESSION = "B".repeat(43);
const USER: UserRecord = {
  id: "10000000-0000-4000-8000-000000000001",
  organizationId: "20000000-0000-4000-8000-000000000001",
  email: "member@example.com",
  displayName: "测试成员",
  role: "member",
  status: "active",
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
};
const config: Extract<DingTalkAuthenticationConfig, { enabled: true }> = {
  enabled: true,
  clientId: "ding-client-id",
  clientSecret: "ding-client-secret-sentinel",
  corpId: "ding-corp-id",
  agentId: "ding-agent-id",
  localOrganizationId: USER.organizationId,
  redirectUri: "https://example.com/api/auth/dingtalk/callback",
  oauthStateTtlMs: 300_000,
};

class FakeRepository implements DingTalkAuthenticationRepository {
  states = new Map<string, OAuthLoginStateRecord>();
  identityInputs: VerifiedDingTalkUserInput[] = [];
  resolvedUser = USER;

  async createOAuthLoginState(input: Omit<OAuthLoginStateRecord, "consumedAt">) {
    const record = Object.freeze({ ...input, consumedAt: null });
    this.states.set(record.stateHash, record);
    return record;
  }

  async consumeOAuthLoginState(input: { stateHash: string; asOf: string; consumedAt: string }) {
    const state = this.states.get(input.stateHash);
    if (!state || state.consumedAt !== null || state.expiresAt <= input.asOf) return null;
    const consumed = Object.freeze({ ...state, consumedAt: input.consumedAt });
    this.states.set(input.stateHash, consumed);
    return consumed;
  }

  async findOrCreateDingTalkUser(input: VerifiedDingTalkUserInput) {
    this.identityInputs.push(input);
    return { user: this.resolvedUser, created: true };
  }
}

class FakeProvider implements DingTalkIdentityProvider {
  identity: VerifiedDingTalkIdentity = {
    corpId: config.corpId,
    subjectId: "employee-123",
    displayName: "测试成员",
    email: "member@example.com",
    active: true,
  };
  workbenchCodes: string[] = [];
  oauthCodes: string[] = [];

  async exchangeWorkbenchCode(code: string) {
    this.workbenchCodes.push(code);
    return this.identity;
  }

  async exchangeOAuthCode(code: string) {
    this.oauthCodes.push(code);
    return this.identity;
  }
}

function fixture() {
  const repository = new FakeRepository();
  const provider = new FakeProvider();
  const issuedUsers: UserRecord[] = [];
  const sessionIssuer = {
    async issueSessionForVerifiedUser(user: UserRecord) {
      issuedUsers.push(user);
      return {
        status: "authenticated" as const,
        user,
        principal: {
          kind: "user" as const,
          userId: user.id,
          organizationId: user.organizationId,
          email: user.email,
          role: user.role,
          sessionId: "30000000-0000-4000-8000-000000000001",
        },
        rawSessionToken: RAW_SESSION,
        expiresAt: "2026-09-04T16:00:00.000Z",
      };
    },
  };
  const service = new DingTalkAuthenticationService({
    config,
    repository,
    provider,
    sessionIssuer,
    now: () => NOW,
    createState: () => RAW_STATE,
    createId: (() => {
      const ids = [
        "10000000-0000-4000-8000-000000000009",
        "30000000-0000-4000-8000-000000000009",
      ];
      return () => ids.shift()!;
    })(),
  });
  return { service, repository, provider, issuedUsers };
}

test("OAuth start stores only a digest and completion consumes state once", async () => {
  const subject = fixture();
  const started = await subject.service.startOAuth("/projects/current");
  assert.match(started.authorizationUrl, /^https:\/\/login\.dingtalk\.com\/oauth2\/auth\?/);
  assert.equal(started.rawState, RAW_STATE);
  assert.equal(started.expiresAt, "2026-09-04T08:05:00.000Z");
  assert.equal(subject.repository.states.has(RAW_STATE), false);
  assert.equal(
    subject.repository.states.has(createHash("sha256").update(RAW_STATE).digest("hex")),
    true,
  );

  const completed = await subject.service.completeOAuth({
    code: "oauth-code",
    state: RAW_STATE,
    cookieState: RAW_STATE,
  });
  assert.equal(completed.user.role, "member");
  assert.equal(completed.returnPath, "/projects/current");
  assert.equal(completed.rawSessionToken, RAW_SESSION);
  await assert.rejects(subject.service.completeOAuth({
    code: "oauth-code",
    state: RAW_STATE,
    cookieState: RAW_STATE,
  }), /state/i);
});

test("OAuth state mismatch and unsafe return paths fail before provider exchange", async () => {
  const subject = fixture();
  await assert.rejects(subject.service.startOAuth("//evil.example/path"), /return path/i);
  await subject.service.startOAuth("/");
  await assert.rejects(subject.service.completeOAuth({
    code: "oauth-code",
    state: RAW_STATE,
    cookieState: "C".repeat(43),
  }), /state/i);
  assert.deepEqual(subject.provider.oauthCodes, []);
});

test("verified identities are tenant-bound, use deterministic fallback email, and preserve users", async () => {
  const subject = fixture();
  subject.provider.identity = { ...subject.provider.identity, email: null };
  const login = await subject.service.loginWorkbench("workbench-code");
  assert.equal(login.user, USER);
  assert.equal(subject.repository.identityInputs[0]?.candidateEmail.endsWith("@identity.invalid"), true);
  assert.equal(
    subject.repository.identityInputs[0]?.candidateEmail,
    subject.repository.identityInputs[0]?.fallbackEmail,
  );
  assert.deepEqual(subject.issuedUsers, [USER]);

  const wrongTenant = fixture();
  wrongTenant.provider.identity = { ...wrongTenant.provider.identity, corpId: "another-corp" };
  await assert.rejects(
    wrongTenant.service.loginWorkbench("code"),
    (error: unknown) => error instanceof DingTalkAuthenticationError && error.category === "tenant-mismatch",
  );

  const existingAdmin = fixture();
  existingAdmin.repository.resolvedUser = { ...USER, role: "admin" };
  assert.equal((await existingAdmin.service.loginWorkbench("code")).user.role, "admin");

  const disabled = fixture();
  disabled.repository.resolvedUser = { ...USER, status: "disabled" };
  await assert.rejects(
    disabled.service.loginWorkbench("code"),
    (error: unknown) => error instanceof DingTalkAuthenticationError && error.category === "disabled-user",
  );
});

test("public config omits the client secret", () => {
  const publicConfig = fixture().service.publicConfig();
  assert.deepEqual(publicConfig, {
    enabled: true,
    clientId: config.clientId,
    corpId: config.corpId,
    agentId: config.agentId,
  });
  assert.equal(JSON.stringify(publicConfig).includes(config.clientSecret), false);
});
