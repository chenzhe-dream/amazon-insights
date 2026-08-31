import {
  AdminUserPresenceResponseSchema,
  type AdminUserPresenceResponse,
  type InvalidationReason,
  type PresenceStatus,
} from "../../shared/agent-contracts";

const RECENT_ACTIVITY_WINDOW_MS = 300_000;
const RECENT_LOGIN_LIMIT = 10;

export type AdminUserPresenceSessionFact = Readonly<{
  createdAt: string;
  lastSeenAt: string | null;
  expiresAt: string;
  revokedAt: string | null;
  stableSortKey: string;
}>;

export type AdminUserPresenceUserFact = Readonly<{
  account: string;
  displayName: string;
  role: "admin" | "member";
  accountStatus: "active" | "disabled";
  sessions: readonly AdminUserPresenceSessionFact[];
}>;

export class AdminUserPresenceService {
  readonly #asOf: () => Date;

  constructor(options: { asOf: () => Date }) {
    this.#asOf = options.asOf;
  }

  list(users: readonly AdminUserPresenceUserFact[]): AdminUserPresenceResponse {
    const asOf = this.#asOf();
    const asOfEpoch = asOf.getTime();
    const asOfValue = asOf.toISOString();

    return AdminUserPresenceResponseSchema.parse({
      asOf: asOfValue,
      recentActivityWindowSeconds: 300,
      users: [...users]
        .sort((left, right) => compareNormalizedAccount(left.account, right.account))
        .map((user) => summarizeUser(user, asOfEpoch)),
    });
  }
}

function summarizeUser(user: AdminUserPresenceUserFact, asOfEpoch: number) {
  const validSessions = user.accountStatus === "active"
    ? user.sessions.filter((session) => isValidSession(session, asOfEpoch))
    : [];
  const status = presenceStatus(user, validSessions, asOfEpoch);

  return {
    account: user.account,
    displayName: user.displayName,
    role: user.role,
    accountStatus: user.accountStatus,
    presenceStatus: status,
    loginCount: user.sessions.length,
    lastLoginAt: maximumDateTime(user.sessions.map((session) => session.createdAt)),
    lastActivityAt: maximumDateTime(
      user.sessions.flatMap((session) => session.lastSeenAt === null ? [] : [session.lastSeenAt]),
    ),
    validSessionExpiresAt: maximumDateTime(validSessions.map((session) => session.expiresAt)),
    recentLogins: [...user.sessions]
      .sort(compareRecentSessions)
      .slice(0, RECENT_LOGIN_LIMIT)
      .map((session) => ({
        loggedInAt: session.createdAt,
        lastActivityAt: session.lastSeenAt,
        expiresAt: session.expiresAt,
        invalidationReason: invalidationReason(user.accountStatus, session, asOfEpoch),
      })),
  };
}

function presenceStatus(
  user: AdminUserPresenceUserFact,
  validSessions: readonly AdminUserPresenceSessionFact[],
  asOfEpoch: number,
): PresenceStatus {
  if (user.accountStatus === "disabled") return "disabled";
  if (validSessions.some((session) => isRecentlyActive(session, asOfEpoch))) {
    return "recently-online";
  }
  if (validSessions.length > 0) return "valid-session-idle";
  if (user.sessions.length === 0) return "never-logged-in";
  return "session-expired";
}

function invalidationReason(
  accountStatus: AdminUserPresenceUserFact["accountStatus"],
  session: AdminUserPresenceSessionFact,
  asOfEpoch: number,
): InvalidationReason {
  if (accountStatus === "disabled") return "account-disabled";
  if (session.revokedAt !== null) return "revoked";
  if (dateEpoch(session.expiresAt) <= asOfEpoch) return "expired";
  return null;
}

function isValidSession(session: AdminUserPresenceSessionFact, asOfEpoch: number): boolean {
  return session.revokedAt === null && dateEpoch(session.expiresAt) > asOfEpoch;
}

function isRecentlyActive(session: AdminUserPresenceSessionFact, asOfEpoch: number): boolean {
  if (session.lastSeenAt === null) return false;
  const lastSeenAt = dateEpoch(session.lastSeenAt);
  return lastSeenAt >= asOfEpoch - RECENT_ACTIVITY_WINDOW_MS && lastSeenAt <= asOfEpoch;
}

function maximumDateTime(values: readonly string[]): string | null {
  let maximum: string | null = null;
  let maximumEpoch = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const epoch = dateEpoch(value);
    if (epoch > maximumEpoch) {
      maximum = value;
      maximumEpoch = epoch;
    }
  }
  return maximum;
}

function compareRecentSessions(
  left: AdminUserPresenceSessionFact,
  right: AdminUserPresenceSessionFact,
): number {
  const createdDifference = dateEpoch(right.createdAt) - dateEpoch(left.createdAt);
  return createdDifference === 0
    ? compareText(left.stableSortKey, right.stableSortKey)
    : createdDifference;
}

function compareNormalizedAccount(left: string, right: string): number {
  return compareText(left.trim().toLowerCase(), right.trim().toLowerCase());
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function dateEpoch(value: string): number {
  return new Date(value).getTime();
}
