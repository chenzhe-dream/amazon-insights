import type { DatabaseSync } from "node:sqlite";

import { DateTimeSchema, EntityIdSchema } from "../../../shared/agent-contracts";
import type {
  AdminUserPresenceHeartbeatInput,
  AdminUserPresenceHeartbeatResult,
  AdminUserPresenceReadInput,
  AdminUserPresenceReadResult,
  AdminUserPresenceRepository,
  AdminUserPresenceUserFact,
} from "../admin-user-presence-repository";

type SqliteRow = Record<string, string | number | bigint | Uint8Array | null>;
type Serialize = <Result>(operation: () => Result | Promise<Result>) => Promise<Result>;
type WriteTransaction = <Result>(operation: () => Result) => Promise<Result>;

import {RECENT_ACTIVITY_WINDOW_MS} from "../../../shared/usage-analytics-contracts";
const HEARTBEAT_THROTTLE_MS = 60_000;

export class SqliteAdminUserPresenceStore
  implements AdminUserPresenceRepository
{
  readonly #database: DatabaseSync;
  readonly #serialize: Serialize;
  readonly #writeTransaction: WriteTransaction;

  constructor(options: Readonly<{
    database: DatabaseSync;
    serialize: Serialize;
    writeTransaction: WriteTransaction;
  }>) {
    this.#database = options.database;
    this.#serialize = options.serialize;
    this.#writeTransaction = options.writeTransaction;
  }

  listOrganizationUsers(
    input: AdminUserPresenceReadInput,
  ): Promise<AdminUserPresenceReadResult> {
    const organizationId = EntityIdSchema.parse(input.organizationId);
    const asOf = canonicalDateTime(input.asOf);
    const recentThreshold = offsetDateTime(asOf, -RECENT_ACTIVITY_WINDOW_MS);
    return this.#serialize(() => {
      const rows = this.#database.prepare(
        `WITH summaries AS (
           SELECT u.id AS user_id,
                  COUNT(s.id) AS login_count,
                  MAX(s.created_at) AS last_login_at,
                  MAX(s.last_seen_at) AS last_activity_at,
                  MAX(CASE
                    WHEN u.status = 'active'
                     AND s.revoked_at IS NULL
                     AND s.expires_at > ?
                    THEN s.expires_at
                  END) AS valid_session_expires_at,
                  MAX(CASE
                    WHEN u.status = 'active'
                     AND s.revoked_at IS NULL
                     AND s.expires_at > ?
                    THEN 1 ELSE 0
                  END) AS has_valid_session,
                  MAX(CASE
                    WHEN u.status = 'active'
                     AND s.revoked_at IS NULL
                     AND s.expires_at > ?
                     AND s.last_seen_at >= ?
                     AND s.last_seen_at <= ?
                    THEN 1 ELSE 0
                  END) AS has_recently_active_valid_session
             FROM users u
             LEFT JOIN sessions s ON s.user_id = u.id
            WHERE u.organization_id = ?
            GROUP BY u.id
         ), ranked_logins AS (
           SELECT s.id AS session_sort_id, s.user_id, s.created_at, s.last_seen_at, s.expires_at,
                  s.revoked_at,
                  ROW_NUMBER() OVER (
                    PARTITION BY s.user_id
                    ORDER BY s.created_at DESC, s.id ASC
                  ) AS recent_rank
             FROM sessions s
             JOIN users u ON u.id = s.user_id
            WHERE u.organization_id = ?
         )
         SELECT u.email, u.display_name, u.role, u.status,
                summaries.login_count, summaries.last_login_at,
                summaries.last_activity_at,
                summaries.valid_session_expires_at,
                summaries.has_valid_session,
                summaries.has_recently_active_valid_session,
                ranked_logins.created_at AS login_created_at,
                ranked_logins.last_seen_at AS login_last_seen_at,
                ranked_logins.expires_at AS login_expires_at,
                ranked_logins.revoked_at AS login_revoked_at
           FROM users u
           JOIN summaries ON summaries.user_id = u.id
           LEFT JOIN ranked_logins
             ON ranked_logins.user_id = u.id
            AND ranked_logins.recent_rank <= 10
          WHERE u.organization_id = ? AND u.archived_at IS NULL
          ORDER BY lower(trim(u.email)) ASC,
                   ranked_logins.created_at DESC,
                   ranked_logins.session_sort_id ASC`,
      ).all(
        asOf,
        asOf,
        asOf,
        recentThreshold,
        asOf,
        organizationId,
        organizationId,
        organizationId,
      ) as SqliteRow[];
      return mapReadRows(rows);
    });
  }

  recordHeartbeat(
    input: AdminUserPresenceHeartbeatInput,
  ): Promise<AdminUserPresenceHeartbeatResult> {
    const parsed = parseHeartbeatInput(input);
    if (!parsed) return Promise.resolve("inactive");
    const throttleThreshold = offsetDateTime(parsed.asOf, -HEARTBEAT_THROTTLE_MS);
    return this.#writeTransaction(() => {
      const updated = this.#database.prepare(
        `UPDATE sessions
            SET last_seen_at = ?
          WHERE id = ?
            AND user_id = ?
            AND revoked_at IS NULL
            AND expires_at > ?
            AND (last_seen_at IS NULL OR last_seen_at <= ?)
            AND EXISTS (
              SELECT 1
                FROM users
               WHERE users.id = sessions.user_id
                 AND users.organization_id = ?
                 AND users.status = 'active'
            )`,
      ).run(
        parsed.asOf,
        parsed.sessionId,
        parsed.userId,
        parsed.asOf,
        throttleThreshold,
        parsed.organizationId,
      );
      if (Number(updated.changes) === 1) return "recorded";

      const active = this.#database.prepare(
        `SELECT 1
           FROM sessions s
           JOIN users u ON u.id = s.user_id
          WHERE s.id = ?
            AND s.user_id = ?
            AND u.organization_id = ?
            AND u.status = 'active'
            AND s.revoked_at IS NULL
            AND s.expires_at > ?
          LIMIT 1`,
      ).get(
        parsed.sessionId,
        parsed.userId,
        parsed.organizationId,
        parsed.asOf,
      );
      return active ? "throttled" : "inactive";
    });
  }
}

function mapReadRows(rows: readonly SqliteRow[]): AdminUserPresenceReadResult {
  const users: AdminUserPresenceUserFact[] = [];
  let current: MutableUserFact | undefined;
  for (const row of rows) {
    const account = String(row.email);
    if (!current || current.account !== account) {
      current = {
        account,
        displayName: String(row.display_name),
        role: parseRole(row.role),
        accountStatus: parseStatus(row.status),
        loginCount: Number(row.login_count),
        lastLoginAt: nullableDateTime(row.last_login_at),
        lastActivityAt: nullableDateTime(row.last_activity_at),
        validSessionExpiresAt: nullableDateTime(row.valid_session_expires_at),
        hasValidSession: Number(row.has_valid_session) === 1,
        hasRecentlyActiveValidSession:
          Number(row.has_recently_active_valid_session) === 1,
        recentLogins: [],
      };
      users.push(current);
    }
    if (row.login_created_at !== null) {
      current.recentLogins.push(Object.freeze({
        loggedInAt: canonicalDateTime(String(row.login_created_at)),
        lastActivityAt: nullableDateTime(row.login_last_seen_at),
        expiresAt: canonicalDateTime(String(row.login_expires_at)),
        revokedAt: nullableDateTime(row.login_revoked_at),
      }));
    }
  }
  return Object.freeze({
    users: Object.freeze(users.map((user) => Object.freeze({
      ...user,
      recentLogins: Object.freeze(user.recentLogins),
    }))),
  });
}

type MutableUserFact = Omit<AdminUserPresenceUserFact, "recentLogins"> & {
  recentLogins: Array<AdminUserPresenceUserFact["recentLogins"][number]>;
};

function parseHeartbeatInput(input: AdminUserPresenceHeartbeatInput) {
  const organizationId = EntityIdSchema.safeParse(input.organizationId);
  const userId = EntityIdSchema.safeParse(input.userId);
  const sessionId = EntityIdSchema.safeParse(input.sessionId);
  const asOf = DateTimeSchema.safeParse(input.asOf);
  if (!organizationId.success || !userId.success || !sessionId.success || !asOf.success) {
    return null;
  }
  return {
    organizationId: organizationId.data,
    userId: userId.data,
    sessionId: sessionId.data,
    asOf: new Date(asOf.data).toISOString(),
  };
}

function parseRole(value: unknown): AdminUserPresenceUserFact["role"] {
  if (value === "admin" || value === "member") return value;
  throw new Error("Stored presence role is invalid");
}

function parseStatus(value: unknown): AdminUserPresenceUserFact["accountStatus"] {
  if (value === "active" || value === "disabled") return value;
  throw new Error("Stored presence status is invalid");
}

function nullableDateTime(value: unknown): string | null {
  return value === null ? null : canonicalDateTime(String(value));
}

function canonicalDateTime(value: string): string {
  return new Date(DateTimeSchema.parse(value)).toISOString();
}

function offsetDateTime(value: string, milliseconds: number): string {
  return new Date(new Date(value).getTime() + milliseconds).toISOString();
}
