import {
  AdminUserPresenceResponseSchema,
  type AdminUserPresenceResponse,
  type InvalidationReason,
  type PresenceStatus,
} from "../../shared/agent-contracts";
import type {
  AdminUserPresenceRecentLoginFact,
  AdminUserPresenceUserFact,
} from "../db/admin-user-presence-repository";

export type {
  AdminUserPresenceRecentLoginFact,
  AdminUserPresenceUserFact,
} from "../db/admin-user-presence-repository";

const RECENT_LOGIN_LIMIT = 10;

export class AdminUserPresenceService {
  readonly #asOf: () => Date;

  constructor(options: { asOf: () => Date }) {
    this.#asOf = options.asOf;
  }

  list(users: readonly AdminUserPresenceUserFact[]): AdminUserPresenceResponse {
    const asOf = this.#asOf();
    const asOfEpoch = asOf.getTime();

    return AdminUserPresenceResponseSchema.parse({
      asOf: asOf.toISOString(),
      recentActivityWindowSeconds: 300,
      users: [...users]
        .sort((left, right) => compareNormalizedAccount(left.account, right.account))
        .map((user) => summarizeUser(user, asOfEpoch)),
    });
  }
}

function summarizeUser(user: AdminUserPresenceUserFact, asOfEpoch: number) {
  return {
    account: user.account,
    displayName: user.displayName,
    role: user.role,
    accountStatus: user.accountStatus,
    presenceStatus: presenceStatus(user),
    loginCount: user.loginCount,
    lastLoginAt: user.lastLoginAt,
    lastActivityAt: user.lastActivityAt,
    validSessionExpiresAt:
      user.accountStatus === "active" ? user.validSessionExpiresAt : null,
    recentLogins: user.recentLogins.slice(0, RECENT_LOGIN_LIMIT).map((login) => ({
      loggedInAt: login.loggedInAt,
      lastActivityAt: login.lastActivityAt,
      expiresAt: login.expiresAt,
      invalidationReason: invalidationReason(user.accountStatus, login, asOfEpoch),
    })),
  };
}

function presenceStatus(user: AdminUserPresenceUserFact): PresenceStatus {
  if (user.accountStatus === "disabled") return "disabled";
  if (user.hasRecentlyActiveValidSession) return "recently-online";
  if (user.hasValidSession) return "valid-session-idle";
  if (user.loginCount === 0) return "never-logged-in";
  return "session-expired";
}

function invalidationReason(
  accountStatus: AdminUserPresenceUserFact["accountStatus"],
  login: AdminUserPresenceRecentLoginFact,
  asOfEpoch: number,
): InvalidationReason {
  if (accountStatus === "disabled") return "account-disabled";
  if (login.revokedAt !== null) return "revoked";
  if (new Date(login.expiresAt).getTime() <= asOfEpoch) return "expired";
  return null;
}

function compareNormalizedAccount(left: string, right: string): number {
  return compareText(left.trim().toLowerCase(), right.trim().toLowerCase());
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
