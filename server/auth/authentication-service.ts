import { randomUUID } from "node:crypto";

import { DUMMY_PASSWORD_RECORD, hashPassword, verifyPassword } from "./password";
import { createSessionToken, digestSessionToken } from "./session";
import type {
  AgentRepository,
  AuthenticationRepository,
  UserRecord,
} from "../db/repository";
import type { BoundedLoginRateLimiter } from "./login-rate-limiter";

export type AuthenticatedPrincipal = Readonly<{
  kind: "user";
  userId: string;
  organizationId: string;
  email: string;
  role: "admin" | "member";
  sessionId: string;
}>;

export type LoginResult =
  | AuthenticatedSessionResult
  | Readonly<{ status: "invalid-credentials" }>
  | Readonly<{ status: "rate-limited"; retryAfterSeconds: number }>;

export type AuthenticatedSessionResult = Readonly<{
      status: "authenticated";
      user: UserRecord;
      principal: AuthenticatedPrincipal;
      rawSessionToken: string;
      expiresAt: string;
    }>;

const PASSWORD_RECORD_PATTERN =
  /^scrypt-v1\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SOURCE_PATTERN = /^[a-z0-9:._-]{1,128}$/;

export class AuthenticationService {
  private readonly repository: AuthenticationRepository &
    Pick<AgentRepository, "findUserById">;
  private readonly limiter: BoundedLoginRateLimiter;
  private readonly sessionTtlMs: number;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly createToken: () => Readonly<{
    rawToken: string;
    tokenHash: string;
  }>;
  private readonly verify: typeof verifyPassword;
  private readonly hash: typeof hashPassword;

  constructor(options: {
    repository: AuthenticationRepository & Pick<AgentRepository, "findUserById">;
    limiter: BoundedLoginRateLimiter;
    sessionTtlMs: number;
    now?: () => Date;
    createId?: () => string;
    createToken?: () => Readonly<{ rawToken: string; tokenHash: string }>;
    verify?: typeof verifyPassword;
    hash?: typeof hashPassword;
  }) {
    this.repository = options.repository;
    this.limiter = options.limiter;
    this.sessionTtlMs = options.sessionTtlMs;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.createToken = options.createToken ?? createSessionToken;
    this.verify = options.verify ?? verifyPassword;
    this.hash = options.hash ?? hashPassword;
  }

  async login(input: {
    email: string;
    password: string;
    source: string;
  }): Promise<LoginResult> {
    const email = normalizeEmail(input.email);
    const source = normalizeSource(input.source);
    const limit = this.limiter.check(email, source);
    if (!limit.allowed) {
      return {
        status: "rate-limited",
        retryAfterSeconds: limit.retryAfterSeconds,
      };
    }

    try {
      const found = await this.repository.findAuthenticationUserByEmail(email);
      const selected =
        found &&
        found.user.status === "active" &&
        isSupportedPasswordRecord(found.passwordHash)
          ? found
          : null;
      const passwordRecord = selected
        ? selected.passwordHash!
        : DUMMY_PASSWORD_RECORD;
      const accepted = await this.verify(input.password, passwordRecord);

      if (!selected || !accepted) {
        this.limiter.recordFailure(email, source);
        return { status: "invalid-credentials" };
      }

      const issued = await this.issueSessionForVerifiedUser(selected.user);

      this.limiter.recordSuccess(email);
      return issued;
    } catch {
      this.limiter.recordFailure(email, source);
      return { status: "invalid-credentials" };
    }
  }

  async issueSessionForVerifiedUser(
    user: UserRecord,
  ): Promise<AuthenticatedSessionResult> {
    if (user.status !== "active") {
      throw new Error("Verified user must be active");
    }
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + this.sessionTtlMs);
    const token = this.createToken();
    const session = await this.repository.createSession({
      id: this.createId(),
      userId: user.id,
      tokenHash: token.tokenHash,
      expiresAt: expiresAt.toISOString(),
      revokedAt: null,
      createdAt: createdAt.toISOString(),
      lastSeenAt: null,
    });
    return Object.freeze({
      status: "authenticated" as const,
      user,
      principal: principalFromSessionRecord({
        sessionId: session.id,
        userId: user.id,
        organizationId: user.organizationId,
        email: user.email,
        role: user.role,
      }),
      rawSessionToken: token.rawToken,
      expiresAt: session.expiresAt,
    });
  }

  async authenticate(rawToken: string | null): Promise<AuthenticatedPrincipal | null> {
    if (!rawToken || !SESSION_TOKEN_PATTERN.test(rawToken)) return null;

    try {
      const record =
        await this.repository.findActiveSessionPrincipalByTokenHash({
          tokenHash: digestSessionToken(rawToken),
          asOf: this.now().toISOString(),
        });
      return record ? principalFromSessionRecord(record) : null;
    } catch {
      return null;
    }
  }

  async logout(rawToken: string | null): Promise<void> {
    if (!rawToken || !SESSION_TOKEN_PATTERN.test(rawToken)) return;

    try {
      await this.repository.revokeSessionByTokenHash({
        tokenHash: digestSessionToken(rawToken),
        revokedAt: this.now().toISOString(),
      });
    } catch {
      return;
    }
  }

  async findPublicUser(userId: string): Promise<UserRecord | null> {
    try {
      const user = await this.repository.findUserById(userId);
      return user?.status === "active" ? user : null;
    } catch {
      return null;
    }
  }

  async changePassword(
    principal: AuthenticatedPrincipal,
    input: { currentPassword: string; newPassword: string },
  ): Promise<Readonly<{ status: "changed" | "invalid-credentials" }>> {
    try {
      if (!this.repository.findAuthenticationUserById || !this.repository.changeUserPassword) {
        return { status: "invalid-credentials" };
      }
      const found = await this.repository.findAuthenticationUserById(principal.userId);
      if (
        !found ||
        found.user.status !== "active" ||
        !isSupportedPasswordRecord(found.passwordHash) ||
        !(await this.verify(input.currentPassword, found.passwordHash))
      ) {
        return { status: "invalid-credentials" };
      }
      const changedAt = this.now().toISOString();
      const changed = await this.repository.changeUserPassword({
        userId: principal.userId,
        currentSessionId: principal.sessionId,
        expectedPasswordHash: found.passwordHash,
        passwordHash: await this.hash(input.newPassword),
        changedAt,
        auditEventId: this.createId(),
      });
      return changed ? { status: "changed" } : { status: "invalid-credentials" };
    } catch {
      return { status: "invalid-credentials" };
    }
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeSource(source: string): string {
  const normalized = source.trim().toLowerCase();
  return SOURCE_PATTERN.test(normalized) ? normalized : "unknown-source";
}

function isSupportedPasswordRecord(
  passwordHash: string | null,
): passwordHash is string {
  return passwordHash !== null && PASSWORD_RECORD_PATTERN.test(passwordHash);
}

function principalFromSessionRecord(record: {
  sessionId: string;
  userId: string;
  organizationId: string;
  email: string;
  role: "admin" | "member";
}): AuthenticatedPrincipal {
  return Object.freeze({
    kind: "user",
    userId: record.userId,
    organizationId: record.organizationId,
    email: normalizeEmail(record.email),
    role: record.role,
    sessionId: record.sessionId,
  });
}
