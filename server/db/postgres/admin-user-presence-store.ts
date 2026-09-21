import { DateTimeSchema, EntityIdSchema } from "../../../shared/agent-contracts";
import type {
  AdminUserPresenceHeartbeatInput,
  AdminUserPresenceHeartbeatResult,
  AdminUserPresenceReadInput,
  AdminUserPresenceReadResult,
  AdminUserPresenceRepository,
  AdminUserPresenceUserFact,
} from "../admin-user-presence-repository";
import { PostgresQueryContext } from "./query-context";

type PostgresRow = Record<string, unknown>;
import {RECENT_ACTIVITY_WINDOW_MS} from "../../../shared/usage-analytics-contracts";
import {PresenceQuerySchema} from '../../../shared/admin-user-presence-query';
const HEARTBEAT_THROTTLE_MS = 60_000;

export class PostgresAdminUserPresenceStore
  implements AdminUserPresenceRepository
{
  readonly #queries: PostgresQueryContext;

  constructor(queries: PostgresQueryContext) {
    this.#queries = queries;
  }

  async listOrganizationUsers(
    input: AdminUserPresenceReadInput,
  ): Promise<AdminUserPresenceReadResult> {
    if (input.query) return this.listPage(input);
    const organizationId = EntityIdSchema.parse(input.organizationId);
    const asOf = canonicalDateTime(input.asOf);
    const recentThreshold = offsetDateTime(asOf, -RECENT_ACTIVITY_WINDOW_MS);
    const result = await this.#queries.query<PostgresRow>(
      `WITH summaries AS (
         SELECT u.id AS user_id,
                COUNT(s.id)::integer AS login_count,
                MAX(s.created_at) AS last_login_at,
                MAX(s.last_seen_at) AS last_activity_at,
                MAX(CASE
                  WHEN u.status = 'active'
                   AND s.revoked_at IS NULL
                   AND s.expires_at > $2::timestamptz
                  THEN s.expires_at
                END) AS valid_session_expires_at,
                BOOL_OR(
                  u.status = 'active'
                  AND s.revoked_at IS NULL
                  AND s.expires_at > $2::timestamptz
                ) AS has_valid_session,
                BOOL_OR(
                  u.status = 'active'
                  AND s.revoked_at IS NULL
                  AND s.expires_at > $2::timestamptz
                  AND s.last_seen_at >= $3::timestamptz
                  AND s.last_seen_at <= $2::timestamptz
                ) AS has_recently_active_valid_session
           FROM users u
           LEFT JOIN sessions s ON s.user_id = u.id
          WHERE u.organization_id = $1
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
          WHERE u.organization_id = $1
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
        WHERE u.organization_id = $1 AND u.archived_at IS NULL
        ORDER BY lower(btrim(u.email)) ASC,
                 ranked_logins.created_at DESC,
                 ranked_logins.session_sort_id ASC`,
      [organizationId, asOf, recentThreshold],
    );
    return mapReadRows(result.rows);
  }

  private async listPage(input: AdminUserPresenceReadInput): Promise<AdminUserPresenceReadResult> {
    const organizationId=EntityIdSchema.parse(input.organizationId), asOf=canonicalDateTime(input.asOf);
    const query=PresenceQuerySchema.parse(input.query);
    const rows=await this.#queries.query<PostgresRow>(`
      WITH facts AS MATERIALIZED (
        SELECT u.id,u.email,u.display_name,u.role,u.status,
          CASE WHEN EXISTS(SELECT 1 FROM auth_identities i WHERE i.user_id=u.id AND i.provider='dingtalk') THEN 'dingtalk' ELSE 'local' END AS source,
          COUNT(s.id)::int AS login_count, MAX(s.created_at) AS last_login_at,
          MAX(s.last_seen_at) AS last_activity_at,
          MAX(s.expires_at) FILTER(WHERE u.status='active' AND s.revoked_at IS NULL AND s.expires_at>$2::timestamptz) AS valid_session_expires_at,
          COALESCE(BOOL_OR(u.status='active' AND s.revoked_at IS NULL AND s.expires_at>$2::timestamptz),false) AS has_valid_session,
          COALESCE(BOOL_OR(u.status='active' AND s.revoked_at IS NULL AND s.expires_at>$2::timestamptz
            AND s.last_seen_at >= $3::timestamptz AND s.last_seen_at <= $2::timestamptz),false) AS has_recently_active_valid_session
        FROM users u LEFT JOIN sessions s ON s.user_id=u.id
        WHERE u.organization_id=$1 AND u.archived_at IS NULL GROUP BY u.id
      ), scoped AS MATERIALIZED (
        SELECT *, CASE WHEN status='disabled' THEN 'disabled'
          WHEN has_recently_active_valid_session THEN 'recently-online'
          WHEN has_valid_session THEN 'valid-session-idle'
          WHEN login_count=0 THEN 'never-logged-in' ELSE 'session-expired' END AS presence_status
        FROM facts WHERE ($4='all' OR source=$4)
          AND ($5='' OR strpos(lower(display_name),lower($5))>0 OR strpos(lower(email),lower($5))>0)
      ), filtered AS MATERIALIZED (
        SELECT * FROM scoped WHERE $6='all' OR presence_status=$6
      ), meta AS (
        SELECT COUNT(*)::int AS total,
          LEAST($7::int,GREATEST(1,CEIL(COUNT(*)::numeric/$8::int)::int)) AS page
        FROM filtered
      ), summary AS (
        SELECT COUNT(*)::int AS summary_total,
          COUNT(*) FILTER(WHERE presence_status='recently-online')::int AS recently_online,
          COUNT(*) FILTER(WHERE presence_status='never-logged-in')::int AS never_logged_in FROM scoped
      ), selected AS (
        SELECT * FROM filtered ORDER BY last_activity_at DESC NULLS LAST,lower(email),id
        LIMIT $8 OFFSET (SELECT (page-1)*$8 FROM meta)
      )
      SELECT meta.*,summary.*,u.*,
        login.created_at AS login_created_at,login.last_seen_at AS login_last_seen_at,
        login.expires_at AS login_expires_at,login.revoked_at AS login_revoked_at
      FROM meta CROSS JOIN summary LEFT JOIN selected u ON true
      LEFT JOIN LATERAL (
        SELECT s.* FROM sessions s WHERE s.user_id=u.id ORDER BY s.created_at DESC,s.id LIMIT 10
      ) login ON true
      ORDER BY u.last_activity_at DESC NULLS LAST,lower(u.email),u.id,login.created_at DESC,login.id
    `,[organizationId,asOf,offsetDateTime(asOf,-RECENT_ACTIVITY_WINDOW_MS),query.source,query.q,query.status,query.page,query.pageSize]);
    const meta=rows.rows[0];
    return {
      ...mapReadRows(rows.rows.filter(row=>row.email!==null)),
      pagination:{page:Number(meta.page),pageSize:query.pageSize,total:Number(meta.total)},
      summary:{total:Number(meta.summary_total),recentlyOnline:Number(meta.recently_online),neverLoggedIn:Number(meta.never_logged_in)},
    };
  }

  async recordHeartbeat(
    input: AdminUserPresenceHeartbeatInput,
  ): Promise<AdminUserPresenceHeartbeatResult> {
    const parsed = parseHeartbeatInput(input);
    if (!parsed) return "inactive";
    const throttleThreshold = offsetDateTime(parsed.asOf, -HEARTBEAT_THROTTLE_MS);
    const result = await this.#queries.query<{ outcome: AdminUserPresenceHeartbeatResult }>(
      `WITH target AS MATERIALIZED (
         SELECT s.id, s.last_seen_at
           FROM sessions s
           JOIN users u ON u.id = s.user_id
          WHERE s.id = $1
            AND s.user_id = $2
            AND u.organization_id = $3
            AND u.status = 'active'
            AND s.revoked_at IS NULL
            AND s.expires_at > $4::timestamptz
          FOR UPDATE OF s
       ), updated AS (
         UPDATE sessions s
            SET last_seen_at = $4::timestamptz
           FROM target
          WHERE s.id = target.id
            AND (
              target.last_seen_at IS NULL
              OR target.last_seen_at <= $5::timestamptz
            )
         RETURNING s.id
       )
       SELECT CASE
         WHEN EXISTS (SELECT 1 FROM updated) THEN 'recorded'
         WHEN EXISTS (SELECT 1 FROM target) THEN 'throttled'
         ELSE 'inactive'
       END AS outcome`,
      [
        parsed.sessionId,
        parsed.userId,
        parsed.organizationId,
        parsed.asOf,
        throttleThreshold,
      ],
    );
    return result.rows[0]?.outcome ?? "inactive";
  }
}

function mapReadRows(rows: readonly PostgresRow[]): AdminUserPresenceReadResult {
  const users: AdminUserPresenceUserFact[] = [];
  let current: MutableUserFact | undefined;
  for (const row of rows) {
    const account = requireString(row.email);
    if (!current || current.account !== account) {
      current = {
        ...(row.source==='dingtalk'||row.source==='local'?{source:row.source}:{}),
        account,
        displayName: requireString(row.display_name),
        role: parseRole(row.role),
        accountStatus: parseStatus(row.status),
        loginCount: Number(row.login_count),
        lastLoginAt: nullableDateTime(row.last_login_at),
        lastActivityAt: nullableDateTime(row.last_activity_at),
        validSessionExpiresAt: nullableDateTime(row.valid_session_expires_at),
        hasValidSession: row.has_valid_session === true,
        hasRecentlyActiveValidSession:
          row.has_recently_active_valid_session === true,
        recentLogins: [],
      };
      users.push(current);
    }
    if (row.login_created_at !== null) {
      current.recentLogins.push(Object.freeze({
        loggedInAt: canonicalDateTimeValue(row.login_created_at),
        lastActivityAt: nullableDateTime(row.login_last_seen_at),
        expiresAt: canonicalDateTimeValue(row.login_expires_at),
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
  return value === null ? null : canonicalDateTimeValue(value);
}

function canonicalDateTimeValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return canonicalDateTime(requireString(value));
}

function canonicalDateTime(value: string): string {
  return new Date(DateTimeSchema.parse(value)).toISOString();
}

function offsetDateTime(value: string, milliseconds: number): string {
  return new Date(new Date(value).getTime() + milliseconds).toISOString();
}

function requireString(value: unknown): string {
  if (typeof value !== "string") throw new Error("Stored presence value is invalid");
  return value;
}
