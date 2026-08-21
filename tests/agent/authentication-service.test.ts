import assert from "node:assert/strict";
import test from "node:test";

import {
  AuthenticationService,
  type LoginResult,
} from "../../server/auth/authentication-service";
import { BoundedLoginRateLimiter } from "../../server/auth/login-rate-limiter";
import {
  DUMMY_PASSWORD_RECORD,
  type PasswordDeriver,
  verifyPassword,
} from "../../server/auth/password";
import { digestSessionToken } from "../../server/auth/session";
import type {
  ActiveSessionPrincipalRecord,
  AuthenticationRepository,
  AuthenticationUserRecord,
  SessionRecord,
  UserRecord,
} from "../../server/db/repository";

const NOW = new Date("2026-08-18T00:00:00.000Z");
const EXPIRES_AT = "2026-08-18T08:00:00.000Z";
const USER_ID = "10000000-0000-4000-8000-000000000001";
const DISABLED_USER_ID = "10000000-0000-4000-8000-000000000002";
const SESSION_ID = "30000000-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "20000000-0000-4000-8000-000000000001";
const RAW_TOKEN = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const TOKEN_HASH = digestSessionToken(RAW_TOKEN);
const VALID_PASSWORD_RECORD =
  "scrypt-v1$16384$8$1$YWdlbnQtYXV0aC1kdW1teQ$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function activeUser(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: USER_ID,
    organizationId: ORGANIZATION_ID,
    email: "member@example.com",
    displayName: "Member",
    role: "member",
    status: "active",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

class FakeAuthenticationRepository implements AuthenticationRepository {
  authenticationUsers = new Map<string, AuthenticationUserRecord>();
  publicUsers = new Map<string, UserRecord>();
  sessions: SessionRecord[] = [];
  principalByTokenHash = new Map<string, ActiveSessionPrincipalRecord | null>();
  revokedTokenHashes: string[] = [];
  findAuthenticationUserByEmailCalls: string[] = [];

  async createInitialAdmin(): Promise<UserRecord | null> {
    throw new Error("not used");
  }

  async findAuthenticationUserByEmail(
    email: string,
  ): Promise<AuthenticationUserRecord | null> {
    this.findAuthenticationUserByEmailCalls.push(email);
    return this.authenticationUsers.get(email.toLowerCase()) ?? null;
  }

  async createSession(session: SessionRecord): Promise<SessionRecord> {
    this.sessions.push(session);
    return session;
  }

  async findActiveSessionPrincipalByTokenHash(input: {
    tokenHash: string;
  }): Promise<ActiveSessionPrincipalRecord | null> {
    return this.principalByTokenHash.get(input.tokenHash) ?? null;
  }

  async revokeSessionByTokenHash(input: {
    tokenHash: string;
  }): Promise<boolean> {
    this.revokedTokenHashes.push(input.tokenHash);
    return (
      this.revokedTokenHashes.filter((hash) => hash === input.tokenHash)
        .length === 1
    );
  }

  async revokeUserSessions(): Promise<number> {
    throw new Error("not used");
  }

  async findUserById(id: string): Promise<UserRecord | null> {
    return this.publicUsers.get(id) ?? null;
  }
}

function serviceFixture(options: {
  repository?: FakeAuthenticationRepository;
  limiter?: BoundedLoginRateLimiter;
  verify?: typeof verifyPassword;
} = {}) {
  const repository = options.repository ?? new FakeAuthenticationRepository();
  const limiter =
    options.limiter ??
    new BoundedLoginRateLimiter({
      windowMs: 900_000,
      maxFailures: 5,
      maxEntries: 100,
    });
  const service = new AuthenticationService({
    repository,
    limiter,
    sessionTtlMs: 28_800_000,
    now: () => NOW,
    createId: () => SESSION_ID,
    createToken: () => ({ rawToken: RAW_TOKEN, tokenHash: TOKEN_HASH }),
    verify: options.verify,
  });
  return { service, repository, limiter };
}

function countingVerifier(result: boolean) {
  let calls = 0;
  const verify: typeof verifyPassword = async () => {
    calls += 1;
    return result;
  };
  return { verify, calls: () => calls };
}

function dummyVerifierWithCountingDeriver() {
  let deriveCalls = 0;
  const encodedRecords: string[] = [];
  const derive: PasswordDeriver = async () => {
    deriveCalls += 1;
    return Buffer.alloc(32, 1);
  };
  const verify: typeof verifyPassword = async (password, encoded) => {
    encodedRecords.push(encoded);
    return verifyPassword(password, encoded, derive);
  };
  return { verify, deriveCalls: () => deriveCalls, encodedRecords };
}

async function login(service: AuthenticationService): Promise<LoginResult> {
  return service.login({
    email: " member@example.com ",
    password: "submitted password",
    source: "203.0.113.7",
  });
}

test("invalid credential outcomes are generic and perform exactly one verification", async () => {
  const fixtures: Array<{
    name: string;
    configure: (repository: FakeAuthenticationRepository) => void;
  }> = [
    { name: "unknown", configure: () => undefined },
    {
      name: "disabled",
      configure: (repository) => {
        repository.authenticationUsers.set("member@example.com", {
          user: activeUser({ id: DISABLED_USER_ID, status: "disabled" }),
          passwordHash: VALID_PASSWORD_RECORD,
        });
      },
    },
    {
      name: "missing-hash",
      configure: (repository) => {
        repository.authenticationUsers.set("member@example.com", {
          user: activeUser(),
          passwordHash: null,
        });
      },
    },
    {
      name: "malformed-hash",
      configure: (repository) => {
        repository.authenticationUsers.set("member@example.com", {
          user: activeUser(),
          passwordHash: "not-a-password-record",
        });
      },
    },
    {
      name: "wrong-password",
      configure: (repository) => {
        repository.authenticationUsers.set("member@example.com", {
          user: activeUser(),
          passwordHash: VALID_PASSWORD_RECORD,
        });
      },
    },
  ];

  for (const fixture of fixtures) {
    const verifier = countingVerifier(false);
    const subject = serviceFixture({ verify: verifier.verify });
    fixture.configure(subject.repository);

    assert.deepEqual(await login(subject.service), {
      status: "invalid-credentials",
    });
    assert.equal(verifier.calls(), 1, fixture.name);
  }
});

test("unknown and disabled login paths execute the dummy password record derivation", async () => {
  for (const fixture of ["unknown", "disabled"] as const) {
    const verifier = dummyVerifierWithCountingDeriver();
    const subject = serviceFixture({ verify: verifier.verify });
    if (fixture === "disabled") {
      subject.repository.authenticationUsers.set("member@example.com", {
        user: activeUser({ status: "disabled" }),
        passwordHash: VALID_PASSWORD_RECORD,
      });
    }

    assert.deepEqual(await login(subject.service), {
      status: "invalid-credentials",
    });
    assert.equal(verifier.deriveCalls(), 1, fixture);
    assert.deepEqual(verifier.encodedRecords, [DUMMY_PASSWORD_RECORD]);
  }
});

test("successful login normalizes email, stores only token digest, and returns the raw token once", async () => {
  const verifier = countingVerifier(true);
  const subject = serviceFixture({ verify: verifier.verify });
  const user = activeUser();
  subject.repository.authenticationUsers.set("member@example.com", {
    user,
    passwordHash: VALID_PASSWORD_RECORD,
  });
  subject.limiter.recordFailure("member@example.com", "203.0.113.7");

  const result = await login(subject.service);

  assert.equal(result.status, "authenticated");
  assert.equal(
    subject.repository.findAuthenticationUserByEmailCalls[0],
    "member@example.com",
  );
  assert.equal(verifier.calls(), 1);
  assert.deepEqual(subject.repository.sessions, [
    {
      id: SESSION_ID,
      userId: USER_ID,
      tokenHash: TOKEN_HASH,
      expiresAt: EXPIRES_AT,
      revokedAt: null,
      createdAt: NOW.toISOString(),
      lastSeenAt: null,
    },
  ]);
  assert.equal(subject.repository.sessions[0]?.tokenHash === RAW_TOKEN, false);
  assert.equal(result.rawSessionToken, RAW_TOKEN);
  assert.equal(JSON.stringify(result).split(RAW_TOKEN).length - 1, 1);
  assert.deepEqual(result.principal, {
    kind: "user",
    userId: USER_ID,
    organizationId: ORGANIZATION_ID,
    role: "member",
    sessionId: SESSION_ID,
  });
  for (let index = 0; index < 4; index += 1) {
    subject.limiter.recordFailure("member@example.com", `203.0.113.${index + 8}`);
    subject.limiter.recordFailure(`other-${index}@example.com`, "203.0.113.7");
  }
  assert.equal(
    subject.limiter.check("member@example.com", "203.0.113.99").allowed,
    true,
  );
  assert.equal(
    subject.limiter.check("another@example.com", "203.0.113.7").allowed,
    false,
  );
});

test("rate-limited login does not query the repository or derive a password", async () => {
  const limiter = new BoundedLoginRateLimiter({
    windowMs: 900_000,
    maxFailures: 1,
    maxEntries: 100,
  });
  limiter.recordFailure("member@example.com", "203.0.113.7");
  const verifier = countingVerifier(true);
  const subject = serviceFixture({ limiter, verify: verifier.verify });

  assert.deepEqual(await login(subject.service), {
    status: "rate-limited",
    retryAfterSeconds: 900,
  });
  assert.equal(subject.repository.findAuthenticationUserByEmailCalls.length, 0);
  assert.equal(verifier.calls(), 0);
});

test("invalid source values collapse to the unknown-source limiter bucket", async () => {
  const limiter = new BoundedLoginRateLimiter({
    windowMs: 900_000,
    maxFailures: 1,
    maxEntries: 100,
  });
  limiter.recordFailure("other@example.com", "unknown-source");
  const verifier = countingVerifier(true);
  const subject = serviceFixture({ limiter, verify: verifier.verify });

  assert.deepEqual(
    await subject.service.login({
      email: "member@example.com",
      password: "submitted password",
      source: " ",
    }),
    { status: "rate-limited", retryAfterSeconds: 900 },
  );
  assert.equal(subject.repository.findAuthenticationUserByEmailCalls.length, 0);
  assert.equal(verifier.calls(), 0);
});

test("authenticate returns principals only for active sessions", async () => {
  const subject = serviceFixture();
  subject.repository.principalByTokenHash.set(TOKEN_HASH, {
    sessionId: SESSION_ID,
    userId: USER_ID,
    organizationId: ORGANIZATION_ID,
    role: "member",
  });

  assert.deepEqual(await subject.service.authenticate(RAW_TOKEN), {
    kind: "user",
    userId: USER_ID,
    organizationId: ORGANIZATION_ID,
    role: "member",
    sessionId: SESSION_ID,
  });
  assert.equal(await subject.service.authenticate(null), null);
  assert.equal(await subject.service.authenticate("malformed"), null);

  subject.repository.principalByTokenHash.set(TOKEN_HASH, null);
  assert.equal(await subject.service.authenticate(RAW_TOKEN), null);
});

test("logout hashes presented tokens and idempotently revokes matching sessions", async () => {
  const subject = serviceFixture();

  await subject.service.logout(RAW_TOKEN);
  await subject.service.logout(RAW_TOKEN);
  await subject.service.logout(null);
  await subject.service.logout("malformed");

  assert.deepEqual(subject.repository.revokedTokenHashes, [
    TOKEN_HASH,
    TOKEN_HASH,
  ]);
});

test("findPublicUser returns only active public users", async () => {
  const subject = serviceFixture();
  subject.repository.publicUsers.set(USER_ID, activeUser());
  subject.repository.publicUsers.set(
    DISABLED_USER_ID,
    activeUser({ id: DISABLED_USER_ID, status: "disabled" }),
  );

  assert.deepEqual(await subject.service.findPublicUser(USER_ID), activeUser());
  assert.equal(await subject.service.findPublicUser(DISABLED_USER_ID), null);
  assert.equal(await subject.service.findPublicUser("missing"), null);
});

test("repository and crypto failures map to safe authentication failures", async () => {
  const repository = new FakeAuthenticationRepository();
  repository.authenticationUsers.set("member@example.com", {
    user: activeUser(),
    passwordHash: VALID_PASSWORD_RECORD,
  });
  repository.createSession = async () => {
    throw new Error("raw database cause");
  };
  const subject = serviceFixture({
    repository,
    verify: countingVerifier(true).verify,
  });

  assert.deepEqual(await login(subject.service), {
    status: "invalid-credentials",
  });

  const cryptoFailure = serviceFixture({
    verify: async () => {
      throw new Error("raw scrypt cause");
    },
  });
  assert.deepEqual(await login(cryptoFailure.service), {
    status: "invalid-credentials",
  });
});
