import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import {
  AnalysisRunSchema,
  DateTimeSchema,
  EntityIdSchema,
  ProjectSchema,
  RunStageSchema,
  Sha256Schema,
  UserSchema,
} from "../../../shared/agent-contracts";
import {
  ConnectorCredentialAuthorizationError,
  ConnectorCredentialConflictError,
} from "../repository";
import type {
  ActiveSessionPrincipalRecord,
  AnalysisRunRecord,
  AuthenticationRepository,
  AuthenticationUserRecord,
  ConnectorStatusRecord,
  ConnectorStatusRepository,
  ConnectorCredentialRecord,
  ConnectorCredentialRepository,
  CreateUserFeedbackInput,
  CreateLocalUserResult,
  CreateAnalysisRunResult,
  CreateProjectInput,
  FeedbackAttachmentMetadata,
  FeedbackAttachmentRecord,
  FeedbackAttachmentWrite,
  FeedbackDetailRecord,
  FeedbackListRecord,
  FeedbackStatus,
  FeedbackStatusEventRecord,
  InitialAdminInput,
  LocalUserInput,
  ProjectRecord,
  RevokeConnectorCredentialInput,
  RevokeConnectorCredentialResult,
  RunStageRecord,
  SessionRecord,
  RotateConnectorCredentialInput,
  UserRecord,
  UserFeedbackRecord,
} from "../repository";
import { PostgresQueryContext } from "./query-context";

const initialAdminSchema = z.strictObject({
  id: EntityIdSchema,
  organizationId: EntityIdSchema,
  email: z.email().max(320),
  displayName: z.string().trim().min(1).max(200),
  passwordHash: z.string().trim().min(1).max(1_000),
  createdAt: DateTimeSchema,
});

const sessionSchema = z.strictObject({
  id: EntityIdSchema,
  userId: EntityIdSchema,
  tokenHash: Sha256Schema,
  expiresAt: DateTimeSchema,
  revokedAt: DateTimeSchema.nullable(),
  createdAt: DateTimeSchema,
  lastSeenAt: DateTimeSchema.nullable(),
});

const userFeedbackSchema = z.strictObject({
  id: EntityIdSchema,
  organizationId: EntityIdSchema,
  actorUserId: EntityIdSchema,
  category: z.enum(["bug", "suggestion", "other"]),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(4_000),
  pagePath: z.string().startsWith("/").min(1).max(1_000).refine((value) => !/[?#]/.test(value)),
  appVersion: z.string().trim().min(1).max(100).nullable(),
  createdAt: DateTimeSchema,
});

const userFeedbackListSelect = `
  SELECT feedback.*, workflow.status, workflow.version AS workflow_version,
         workflow.admin_seen_at,
         (SELECT COUNT(*)::int FROM user_feedback_attachments attachment
           WHERE attachment.feedback_id = feedback.id
             AND attachment.organization_id = feedback.organization_id) AS attachment_count
    FROM user_feedback feedback
    JOIN user_feedback_workflow workflow
      ON workflow.feedback_id = feedback.id
     AND workflow.organization_id = feedback.organization_id`;

const analysisRunRecordSchema = AnalysisRunSchema.extend({
  idempotencyScope: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().trim().min(1).max(200),
});

const runStageRecordSchema = RunStageSchema.extend({
  lastError: z.record(z.string(), z.unknown()).nullable(),
});

const connectorStatusSchema = z.strictObject({
  id: EntityIdSchema,
  organizationId: EntityIdSchema,
  connector: z.enum(["sif", "sorftime", "sellerSprite"]),
  configured: z.boolean(),
  health: z.enum(["unknown", "available", "unavailable"]),
  lastCheckedAt: DateTimeSchema.nullable(),
  lastError: z
    .strictObject({
      code: z.literal("probe-failed"),
      message: z.string().trim().min(1).max(2_000),
    })
    .nullable(),
  updatedAt: DateTimeSchema,
});

type PostgresRow = Record<string, unknown>;

export class PostgresCoreStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostgresCoreStoreError";
  }
}

export class PostgresCoreStoreConflictError extends PostgresCoreStoreError {
  constructor(message = "PostgreSQL core store conflict") {
    super(message);
    this.name = "PostgresCoreStoreConflictError";
  }
}

export class PostgresCoreStoreDataError extends PostgresCoreStoreError {
  constructor() {
    super("PostgreSQL core store rejected invalid data");
    this.name = "PostgresCoreStoreDataError";
  }
}

class TransactionCallbackFailure {
  constructor(readonly cause: unknown) {}
}

export class PostgresCoreStore
  implements
    AuthenticationRepository,
    ConnectorStatusRepository,
    ConnectorCredentialRepository
{
  readonly #queries: PostgresQueryContext;

  constructor(queries: PostgresQueryContext) {
    this.#queries = queries;
  }

  async transaction<Result>(
    operation: (repository: PostgresCoreStore) => Promise<Result>,
  ): Promise<Result> {
    try {
      return await this.#queries.transaction(async () => {
        try {
          return await operation(this);
        } catch (error) {
          throw new TransactionCallbackFailure(error);
        }
      });
    } catch (error) {
      if (error instanceof TransactionCallbackFailure) throw error.cause;
      throw sanitizeStoreError(error);
    }
  }

  createInitialAdmin(input: InitialAdminInput): Promise<UserRecord | null> {
    return this.#execute(async () => {
      const admin = normalizeInitialAdmin(input);
      return await this.#queries.transaction(async () => {
        await this.#queries.query("LOCK TABLE users IN EXCLUSIVE MODE");
        const existing = await this.#queries.query("SELECT 1 FROM users LIMIT 1");
        if (existing.rowCount !== 0) return null;

        const inserted = await this.#queries.query<PostgresRow>(
          `INSERT INTO users (
             id, organization_id, email, display_name, password_hash,
             role, status, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, 'admin', 'active', $6, $6)
           RETURNING id, organization_id, email, display_name, role, status,
                     created_at, updated_at`,
          [
            admin.id,
            admin.organizationId,
            admin.email,
            admin.displayName,
            admin.passwordHash,
            admin.createdAt,
          ],
        );
        await this.#queries.query(
          `INSERT INTO audit_events (
             id, organization_id, actor_user_id, action, target_type,
             target_id, metadata_json, created_at
           ) VALUES ($1, $2, NULL, $3, $4, $5, $6::jsonb, $7)`,
          [
            randomUUID(),
            admin.organizationId,
            "auth.first-admin-initialized",
            "user",
            admin.id,
            JSON.stringify({ role: "admin" }),
            admin.createdAt,
          ],
        );
        return mapUser(requireRow(inserted.rows[0]));
      });
    });
  }

  createLocalUser(input: LocalUserInput): Promise<CreateLocalUserResult> {
    return this.#execute(async () => {
      const { passwordHash: passwordHashInput, ...candidate } = input;
      const user = normalizeUser(candidate);
      const passwordHash = z.string().trim().min(1).max(1_000).parse(passwordHashInput);
      return await this.#queries.transaction(async () => {
        const inserted = await this.#queries.query<PostgresRow>(
          `INSERT INTO users (
             id, organization_id, email, display_name, password_hash,
             role, status, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (lower(email)) DO NOTHING
           RETURNING id, organization_id, email, display_name, role, status,
                     created_at, updated_at`,
          [user.id, user.organizationId, user.email, user.displayName, passwordHash,
            user.role, user.status, user.createdAt, user.updatedAt],
        );
        if (inserted.rows[0]) {
          await this.#queries.query(
            `INSERT INTO audit_events (
               id, organization_id, actor_user_id, action, target_type,
               target_id, metadata_json, created_at
             ) VALUES ($1, $2, NULL, 'auth.local-user-created', 'user', $3, $4::jsonb, $5)`,
            [randomUUID(), user.organizationId, user.id, JSON.stringify({ role: user.role }), user.createdAt],
          );
          return Object.freeze({ user: mapUser(inserted.rows[0]), created: true });
        }
        const existing = await this.#queries.query<PostgresRow>(
          `SELECT id, organization_id, email, display_name, role, status, created_at, updated_at
             FROM users WHERE lower(email) = lower($1) LIMIT 1`,
          [user.email],
        );
        const existingUser = mapUser(requireRow(existing.rows[0]));
        if (existingUser.organizationId !== user.organizationId || existingUser.role !== user.role) {
          throw new PostgresCoreStoreConflictError();
        }
        return Object.freeze({ user: existingUser, created: false });
      });
    });
  }

  findAuthenticationUserByEmail(
    email: string,
  ): Promise<AuthenticationUserRecord | null> {
    const parsed = z.string().trim().min(1).max(320).safeParse(email);
    if (!parsed.success) return Promise.resolve(null);
    return this.#execute(async () => {
      const result = await this.#queries.query<PostgresRow>(
        `SELECT id, organization_id, email, display_name, password_hash,
                role, status, created_at, updated_at
           FROM users
          WHERE lower(email) = lower($1)
          LIMIT 1`,
        [parsed.data],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        user: mapUser(row),
        passwordHash:
          row.password_hash === null ? null : requireString(row.password_hash),
      };
    });
  }

  findAuthenticationUserById(userId: string): Promise<AuthenticationUserRecord | null> {
    const parsed = EntityIdSchema.safeParse(userId);
    if (!parsed.success) return Promise.resolve(null);
    return this.#execute(async () => {
      const result = await this.#queries.query<PostgresRow>(
        `SELECT id, organization_id, email, display_name, password_hash,
                role, status, created_at, updated_at
           FROM users WHERE id = $1 LIMIT 1`,
        [parsed.data],
      );
      const row = result.rows[0];
      return row ? { user: mapUser(row), passwordHash: row.password_hash === null ? null : requireString(row.password_hash) } : null;
    });
  }

  createSession(session: SessionRecord): Promise<SessionRecord> {
    return this.#execute(async () => {
      const validated = normalizeSession(session);
      const inserted = await this.#queries.query<PostgresRow>(
        `INSERT INTO sessions (
           id, user_id, token_hash, expires_at, revoked_at, created_at,
           last_seen_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, user_id, token_hash, expires_at, revoked_at, created_at,
                   last_seen_at`,
        [
          validated.id,
          validated.userId,
          validated.tokenHash,
          validated.expiresAt,
          validated.revokedAt,
          validated.createdAt,
          validated.lastSeenAt,
        ],
      );
      return mapSession(requireRow(inserted.rows[0]));
    });
  }

  findActiveSessionPrincipalByTokenHash(input: {
    tokenHash: string;
    asOf: string;
  }): Promise<ActiveSessionPrincipalRecord | null> {
    const tokenHash = Sha256Schema.safeParse(input.tokenHash);
    const asOf = DateTimeSchema.safeParse(input.asOf);
    if (!tokenHash.success || !asOf.success) return Promise.resolve(null);
    const canonicalAsOf = canonicalDateTime(asOf.data);

    return this.#execute(async () => {
      const result = await this.#queries.query<PostgresRow>(
        `SELECT s.id AS session_id, u.id AS user_id, u.organization_id, u.email,
                u.role
           FROM sessions s
           JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = $1
            AND s.revoked_at IS NULL
            AND s.expires_at > $2::timestamptz
            AND u.status = 'active'
          LIMIT 1`,
        [tokenHash.data, canonicalAsOf],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        sessionId: EntityIdSchema.parse(row.session_id),
        userId: EntityIdSchema.parse(row.user_id),
        organizationId: EntityIdSchema.parse(row.organization_id),
        email: z.email().max(320).parse(requireString(row.email).trim().toLowerCase()),
        role: z.enum(["admin", "member"]).parse(row.role),
      };
    });
  }

  revokeSessionByTokenHash(input: {
    tokenHash: string;
    revokedAt: string;
  }): Promise<boolean> {
    const tokenHash = Sha256Schema.safeParse(input.tokenHash);
    const revokedAt = DateTimeSchema.safeParse(input.revokedAt);
    if (!tokenHash.success || !revokedAt.success) return Promise.resolve(false);
    return this.#execute(async () => {
      const result = await this.#queries.query(
        `UPDATE sessions
            SET revoked_at = $2
          WHERE token_hash = $1 AND revoked_at IS NULL`,
        [tokenHash.data, canonicalDateTime(revokedAt.data)],
      );
      return result.rowCount === 1;
    });
  }

  revokeUserSessions(input: {
    userId: string;
    revokedAt: string;
  }): Promise<number> {
    const userId = EntityIdSchema.safeParse(input.userId);
    const revokedAt = DateTimeSchema.safeParse(input.revokedAt);
    if (!userId.success || !revokedAt.success) return Promise.resolve(0);
    return this.#execute(async () => {
      const canonicalRevokedAt = canonicalDateTime(revokedAt.data);
      const result = await this.#queries.query(
        `UPDATE sessions
            SET revoked_at = $2
          WHERE user_id = $1
            AND revoked_at IS NULL
            AND expires_at > $2::timestamptz`,
        [userId.data, canonicalRevokedAt],
      );
      return result.rowCount ?? 0;
    });
  }

  changeUserPassword(input: {
    userId: string;
    currentSessionId: string;
    expectedPasswordHash: string;
    passwordHash: string;
    changedAt: string;
    auditEventId: string;
  }): Promise<boolean> {
    const parsed = z.strictObject({
      userId: EntityIdSchema,
      currentSessionId: EntityIdSchema,
      expectedPasswordHash: z.string().trim().min(1).max(1_000),
      passwordHash: z.string().trim().min(1).max(1_000),
      changedAt: DateTimeSchema,
      auditEventId: EntityIdSchema,
    }).safeParse(input);
    if (!parsed.success) return Promise.resolve(false);
    return this.#execute(async () => this.#queries.transaction(async () => {
      const updated = await this.#queries.query(
        `UPDATE users SET password_hash = $2, updated_at = $3
          WHERE id = $1 AND status = 'active' AND password_hash = $4`,
        [parsed.data.userId, parsed.data.passwordHash, parsed.data.changedAt,
          parsed.data.expectedPasswordHash],
      );
      if (updated.rowCount !== 1) return false;
      await this.#queries.query(
        `UPDATE sessions SET revoked_at = $3
          WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
        [parsed.data.userId, parsed.data.currentSessionId, parsed.data.changedAt],
      );
      const user = await this.#queries.query<{ organization_id: string }>(
        "SELECT organization_id FROM users WHERE id = $1",
        [parsed.data.userId],
      );
      await this.#queries.query(
        `INSERT INTO audit_events (
           id, organization_id, actor_user_id, action, target_type, target_id,
           metadata_json, created_at
         ) VALUES ($1, $2, $3, 'auth.password-changed', 'user', $3, '{}'::jsonb, $4)`,
        [parsed.data.auditEventId, user.rows[0]!.organization_id, parsed.data.userId, parsed.data.changedAt],
      );
      return true;
    }));
  }

  createUserFeedback(input: CreateUserFeedbackInput): Promise<UserFeedbackRecord | null> {
    const parsed = normalizeUserFeedback(input);
    const initialEventId = EntityIdSchema.parse(input.initialEventId ?? parsed.id);
    const attachments = normalizeFeedbackAttachments(input.attachments ?? []);
    return this.#execute(async () => this.#queries.transaction(async () => {
      const inserted = await this.#queries.query<PostgresRow>(
        `INSERT INTO user_feedback (
           id, organization_id, actor_user_id, category, title, description,
           page_path, app_version, created_at
         )
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9
           FROM users
          WHERE id = $3 AND organization_id = $2 AND status = 'active'
         RETURNING *`,
        [parsed.id, parsed.organizationId, parsed.actorUserId, parsed.category,
          parsed.title, parsed.description, parsed.pagePath, parsed.appVersion,
          parsed.createdAt],
      );
      if (!inserted.rows[0]) return null;
      await this.#queries.query(
        `INSERT INTO user_feedback_workflow
           (feedback_id, organization_id, status, admin_seen_at, version, updated_at)
         VALUES ($1, $2, 'new', NULL, 1, $3)`,
        [parsed.id, parsed.organizationId, parsed.createdAt],
      );
      await this.#queries.query(
        `INSERT INTO user_feedback_events
           (id, feedback_id, organization_id, actor_user_id,
            event_type, from_status, to_status, created_at)
         VALUES ($1, $2, $3, $4, 'created', NULL, 'new', $5)`,
        [initialEventId, parsed.id, parsed.organizationId, parsed.actorUserId, parsed.createdAt],
      );
      for (const attachment of attachments) {
        await this.#queries.query(
          `INSERT INTO user_feedback_attachments
             (id, feedback_id, organization_id, created_by_user_id, file_name,
              media_type, byte_size, sha256, image_content, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [attachment.id, parsed.id, parsed.organizationId, parsed.actorUserId,
            attachment.fileName, attachment.mediaType, attachment.byteSize,
            attachment.sha256, attachment.imageContent, attachment.createdAt],
        );
      }
      return mapUserFeedback(inserted.rows[0]);
    }));
  }

  listOwnFeedback(input: { organizationId: string; actorUserId: string }): Promise<readonly FeedbackListRecord[]> {
    return this.#listFeedback(input.organizationId, input.actorUserId, null);
  }

  listOrganizationFeedback(input: { organizationId: string; status: FeedbackStatus | null }): Promise<readonly FeedbackListRecord[]> {
    return this.#listFeedback(input.organizationId, null, input.status);
  }

  #listFeedback(organizationIdInput: string, actorUserIdInput: string | null, statusInput: FeedbackStatus | null): Promise<readonly FeedbackListRecord[]> {
    const organizationId = EntityIdSchema.parse(organizationIdInput);
    const actorUserId = actorUserIdInput === null ? null : EntityIdSchema.parse(actorUserIdInput);
    const status = statusInput === null ? null : normalizeFeedbackStatus(statusInput);
    return this.#execute(async () => {
      const values: unknown[] = [organizationId];
      let where = "feedback.organization_id = $1";
      if (actorUserId !== null) {
        values.push(actorUserId);
        where += ` AND feedback.actor_user_id = $${values.length}`;
      }
      if (status !== null) {
        values.push(status);
        where += ` AND workflow.status = $${values.length}`;
      }
      const rows = await this.#queries.query<PostgresRow>(`${userFeedbackListSelect} WHERE ${where} ORDER BY feedback.created_at DESC, feedback.id`, values);
      return rows.rows.map(mapFeedbackList);
    });
  }

  getOwnFeedbackDetail(input: { organizationId: string; actorUserId: string; feedbackId: string }): Promise<FeedbackDetailRecord | null> {
    return this.#feedbackDetail(input.organizationId, input.feedbackId, input.actorUserId);
  }

  getOrganizationFeedbackDetail(input: { organizationId: string; feedbackId: string }): Promise<FeedbackDetailRecord | null> {
    return this.#feedbackDetail(input.organizationId, input.feedbackId, null);
  }

  #feedbackDetail(organizationIdInput: string, feedbackIdInput: string, actorUserIdInput: string | null): Promise<FeedbackDetailRecord | null> {
    const organizationId = EntityIdSchema.parse(organizationIdInput);
    const feedbackId = EntityIdSchema.parse(feedbackIdInput);
    const actorUserId = actorUserIdInput === null ? null : EntityIdSchema.parse(actorUserIdInput);
    return this.#execute(async () => {
      const values: unknown[] = [organizationId, feedbackId];
      const actorClause = actorUserId === null ? "" : (values.push(actorUserId), ` AND feedback.actor_user_id = $${values.length}`);
      const found = await this.#queries.query<PostgresRow>(`${userFeedbackListSelect} WHERE feedback.organization_id = $1 AND feedback.id = $2${actorClause}`, values);
      if (!found.rows[0]) return null;
      const [attachments, events] = await Promise.all([
        this.#queries.query<PostgresRow>(
          `SELECT id, feedback_id, file_name, media_type, byte_size, sha256, created_at
             FROM user_feedback_attachments WHERE organization_id = $1 AND feedback_id = $2
             ORDER BY created_at, id`, [organizationId, feedbackId]),
        this.#queries.query<PostgresRow>(
          `SELECT id, feedback_id, actor_user_id, event_type, from_status, to_status, created_at
             FROM user_feedback_events WHERE organization_id = $1 AND feedback_id = $2
             ORDER BY created_at, id`, [organizationId, feedbackId]),
      ]);
      return Object.freeze({
        ...mapFeedbackList(found.rows[0]),
        attachments: attachments.rows.map(mapFeedbackAttachmentMetadata),
        events: events.rows.map(mapFeedbackEvent),
      });
    });
  }

  readOwnFeedbackAttachment(input: { organizationId: string; actorUserId: string; feedbackId: string; attachmentId: string }): Promise<FeedbackAttachmentRecord | null> {
    return this.#readFeedbackAttachment(input.organizationId, input.feedbackId, input.attachmentId, input.actorUserId);
  }

  readOrganizationFeedbackAttachment(input: { organizationId: string; feedbackId: string; attachmentId: string }): Promise<FeedbackAttachmentRecord | null> {
    return this.#readFeedbackAttachment(input.organizationId, input.feedbackId, input.attachmentId, null);
  }

  #readFeedbackAttachment(organizationIdInput: string, feedbackIdInput: string, attachmentIdInput: string, actorUserIdInput: string | null): Promise<FeedbackAttachmentRecord | null> {
    const organizationId = EntityIdSchema.parse(organizationIdInput);
    const feedbackId = EntityIdSchema.parse(feedbackIdInput);
    const attachmentId = EntityIdSchema.parse(attachmentIdInput);
    const actorUserId = actorUserIdInput === null ? null : EntityIdSchema.parse(actorUserIdInput);
    return this.#execute(async () => {
      const values: unknown[] = [organizationId, feedbackId, attachmentId];
      const actorClause = actorUserId === null ? "" : (values.push(actorUserId), ` AND feedback.actor_user_id = $${values.length}`);
      const found = await this.#queries.query<PostgresRow>(
        `SELECT attachment.id, attachment.feedback_id, attachment.file_name,
                attachment.media_type, attachment.byte_size, attachment.sha256,
                attachment.image_content, attachment.created_at
           FROM user_feedback_attachments attachment
           JOIN user_feedback feedback ON feedback.id = attachment.feedback_id
          WHERE attachment.organization_id = $1 AND attachment.feedback_id = $2
            AND attachment.id = $3${actorClause}`, values);
      const row = found.rows[0];
      return row ? Object.freeze({ ...mapFeedbackAttachmentMetadata(row), imageContent: Buffer.from(row.image_content as Uint8Array) }) : null;
    });
  }

  countUnreadOrganizationFeedback(organizationIdInput: string): Promise<number> {
    const organizationId = EntityIdSchema.parse(organizationIdInput);
    return this.#execute(async () => Number((await this.#queries.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM user_feedback_workflow WHERE organization_id = $1 AND admin_seen_at IS NULL",
      [organizationId],
    )).rows[0]?.count ?? 0));
  }

  markOrganizationFeedbackSeen(input: { organizationId: string; feedbackId: string; seenAt: string }): Promise<"changed" | "unchanged" | null> {
    const organizationId = EntityIdSchema.parse(input.organizationId);
    const feedbackId = EntityIdSchema.parse(input.feedbackId);
    const seenAt = canonicalDateTime(input.seenAt);
    return this.#execute(async () => this.#queries.transaction(async () => {
      const updated = await this.#queries.query(
        `UPDATE user_feedback_workflow SET admin_seen_at = $1, updated_at = $1
          WHERE organization_id = $2 AND feedback_id = $3 AND admin_seen_at IS NULL`,
        [seenAt, organizationId, feedbackId],
      );
      if (updated.rowCount === 1) return "changed";
      const exists = await this.#queries.query(
        "SELECT 1 FROM user_feedback_workflow WHERE organization_id = $1 AND feedback_id = $2",
        [organizationId, feedbackId],
      );
      return exists.rowCount === 1 ? "unchanged" : null;
    }));
  }

  changeOrganizationFeedbackStatus(input: { organizationId: string; feedbackId: string; actorUserId: string; expectedVersion: number; status: FeedbackStatus; eventId: string; changedAt: string }): Promise<FeedbackListRecord | null> {
    const organizationId = EntityIdSchema.parse(input.organizationId);
    const feedbackId = EntityIdSchema.parse(input.feedbackId);
    const actorUserId = EntityIdSchema.parse(input.actorUserId);
    const eventId = EntityIdSchema.parse(input.eventId);
    const status = normalizeFeedbackStatus(input.status);
    const changedAt = canonicalDateTime(input.changedAt);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new TypeError("Invalid feedback workflow version");
    return this.#execute(async () => this.#queries.transaction(async () => {
      const current = await this.#queries.query<PostgresRow>(
        `SELECT workflow.status
           FROM user_feedback_workflow workflow
           JOIN users actor ON actor.id = $1 AND actor.organization_id = workflow.organization_id AND actor.status = 'active'
          WHERE workflow.organization_id = $2 AND workflow.feedback_id = $3 AND workflow.version = $4
          FOR UPDATE`, [actorUserId, organizationId, feedbackId, input.expectedVersion]);
      if (!current.rows[0]) return null;
      if (current.rows[0].status === status) {
        const row = await this.#queries.query<PostgresRow>(`${userFeedbackListSelect} WHERE feedback.organization_id = $1 AND feedback.id = $2`, [organizationId, feedbackId]);
        return mapFeedbackList(requireRow(row.rows[0]));
      }
      const updated = await this.#queries.query(
        `UPDATE user_feedback_workflow SET status = $1, version = version + 1, updated_at = $2
          WHERE organization_id = $3 AND feedback_id = $4 AND version = $5`,
        [status, changedAt, organizationId, feedbackId, input.expectedVersion],
      );
      if (updated.rowCount !== 1) return null;
      await this.#queries.query(
        `INSERT INTO user_feedback_events
           (id, feedback_id, organization_id, actor_user_id, event_type, from_status, to_status, created_at)
         VALUES ($1, $2, $3, $4, 'status_changed', $5, $6, $7)`,
        [eventId, feedbackId, organizationId, actorUserId, current.rows[0].status, status, changedAt],
      );
      const row = await this.#queries.query<PostgresRow>(`${userFeedbackListSelect} WHERE feedback.organization_id = $1 AND feedback.id = $2`, [organizationId, feedbackId]);
      return mapFeedbackList(requireRow(row.rows[0]));
    }));
  }

  createUser(user: UserRecord): Promise<UserRecord> {
    return this.#execute(async () => {
      const validated = normalizeUser(user);
      const inserted = await this.#queries.query<PostgresRow>(
        `INSERT INTO users (
           id, organization_id, email, display_name, password_hash,
           role, status, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8)
         RETURNING id, organization_id, email, display_name, role, status,
                   created_at, updated_at`,
        [
          validated.id,
          validated.organizationId,
          validated.email,
          validated.displayName,
          validated.role,
          validated.status,
          validated.createdAt,
          validated.updatedAt,
        ],
      );
      return mapUser(requireRow(inserted.rows[0]));
    });
  }

  findUserById(id: string): Promise<UserRecord | null> {
    const parsed = EntityIdSchema.safeParse(id);
    if (!parsed.success) return Promise.resolve(null);
    return this.#execute(async () => {
      const result = await this.#queries.query<PostgresRow>(
        `SELECT id, organization_id, email, display_name, role, status,
                created_at, updated_at
           FROM users WHERE id = $1`,
        [parsed.data],
      );
      return result.rows[0] ? mapUser(result.rows[0]) : null;
    });
  }

  createProject(project: CreateProjectInput): Promise<ProjectRecord> {
    return this.#execute(async () => {
      const validated = normalizeProject(project);
      const inserted = await this.#queries.query<PostgresRow>(
        `INSERT INTO projects (
           id, organization_id, name, marketplace, asins_json, created_by,
           current_run_id, created_at, updated_at
         )
         SELECT $1, $2, $3, $4, $5::jsonb, $6, NULL, $7, $8
           FROM users
          WHERE id = $6 AND organization_id = $2
         RETURNING id, organization_id, name, marketplace, asins_json,
                   created_by, current_run_id, created_at, updated_at`,
        [
          validated.id,
          validated.organizationId,
          validated.name,
          validated.marketplace,
          JSON.stringify(validated.asins),
          validated.createdBy,
          validated.createdAt,
          validated.updatedAt,
        ],
      );
      if (!inserted.rows[0]) {
        throw new PostgresCoreStoreConflictError(
          "PostgreSQL core store organization boundary conflict",
        );
      }
      return mapProject(inserted.rows[0]);
    });
  }

  findProjectById(id: string): Promise<ProjectRecord | null> {
    const parsed = EntityIdSchema.safeParse(id);
    if (!parsed.success) return Promise.resolve(null);
    return this.#execute(async () => {
      const result = await this.#queries.query<PostgresRow>(
        `SELECT id, organization_id, name, marketplace, asins_json,
                created_by, current_run_id, created_at, updated_at
           FROM projects WHERE id = $1`,
        [parsed.data],
      );
      return result.rows[0] ? mapProject(result.rows[0]) : null;
    });
  }

  createAnalysisRun(run: AnalysisRunRecord): Promise<AnalysisRunRecord> {
    return this.createAnalysisRunOnce(run).then((result) => result.run);
  }

  createAnalysisRunOnce(
    run: AnalysisRunRecord,
  ): Promise<CreateAnalysisRunResult> {
    return this.#execute(async () => {
      const validated = normalizeAnalysisRun(run);
      return await this.#queries.transaction(async () => {
        const inserted = await this.#queries.query<PostgresRow>(
          `INSERT INTO analysis_runs (
             id, project_id, mode, status, created_by, data_cutoff_at,
             idempotency_scope, idempotency_key, created_at, updated_at
           )
           SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
             FROM projects p
             JOIN users u ON u.id = $5
            WHERE p.id = $2 AND p.organization_id = u.organization_id
           ON CONFLICT (idempotency_scope, idempotency_key) DO NOTHING
           RETURNING id, project_id, mode, status, created_by, data_cutoff_at,
                     idempotency_scope, idempotency_key, created_at, updated_at`,
          [
            validated.id,
            validated.projectId,
            validated.mode,
            validated.status,
            validated.createdBy,
            validated.dataCutoffAt,
            validated.idempotencyScope,
            validated.idempotencyKey,
            validated.createdAt,
            validated.updatedAt,
          ],
        );
        if (inserted.rows[0]) {
          await this.#queries.query(
            `UPDATE projects
                SET current_run_id = $1, updated_at = $2
              WHERE id = $3`,
            [validated.id, validated.updatedAt, validated.projectId],
          );
          return { run: mapAnalysisRun(inserted.rows[0]), created: true };
        }

        const existing = await this.#queries.query<PostgresRow>(
          `SELECT id, project_id, mode, status, created_by, data_cutoff_at,
                  idempotency_scope, idempotency_key, created_at, updated_at
             FROM analysis_runs
            WHERE idempotency_scope = $1 AND idempotency_key = $2`,
          [validated.idempotencyScope, validated.idempotencyKey],
        );
        if (!existing.rows[0]) {
          throw new PostgresCoreStoreConflictError(
            "PostgreSQL core store organization boundary conflict",
          );
        }
        const stored = mapAnalysisRun(existing.rows[0]);
        if (!sameAnalysisRunRequest(stored, validated)) {
          throw new PostgresCoreStoreConflictError(
            "PostgreSQL core store idempotency payload conflict",
          );
        }
        return { run: stored, created: false };
      });
    });
  }

  findAnalysisRun(id: string): Promise<AnalysisRunRecord | null> {
    const parsed = EntityIdSchema.safeParse(id);
    if (!parsed.success) return Promise.resolve(null);
    return this.#execute(async () => {
      const result = await this.#queries.query<PostgresRow>(
        `SELECT id, project_id, mode, status, created_by, data_cutoff_at,
                idempotency_scope, idempotency_key, created_at, updated_at
           FROM analysis_runs WHERE id = $1`,
        [parsed.data],
      );
      return result.rows[0] ? mapAnalysisRun(result.rows[0]) : null;
    });
  }

  listAnalysisRuns(projectId: string): Promise<AnalysisRunRecord[]> {
    const parsed = EntityIdSchema.safeParse(projectId);
    if (!parsed.success) return Promise.resolve([]);
    return this.#execute(async () => {
      const result = await this.#queries.query<PostgresRow>(
        `SELECT id, project_id, mode, status, created_by, data_cutoff_at,
                idempotency_scope, idempotency_key, created_at, updated_at
           FROM analysis_runs
          WHERE project_id = $1
          ORDER BY created_at, id`,
        [parsed.data],
      );
      return result.rows.map(mapAnalysisRun);
    });
  }

  createRunStage(stage: RunStageRecord): Promise<RunStageRecord> {
    return this.#execute(async () => {
      const validated = normalizeRunStage(stage);
      assertValidInitialStageState(validated);
      const inserted = await this.#queries.query<PostgresRow>(
        `INSERT INTO run_stages (
           id, run_id, stage, status, progress, attempt_count, started_at,
           completed_at, last_error_json, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
         RETURNING id, run_id, stage, status, progress, attempt_count,
                   started_at, completed_at, last_error_json, created_at,
                   updated_at`,
        [
          validated.id,
          validated.runId,
          validated.stage,
          validated.status,
          validated.progress,
          validated.attemptCount,
          validated.startedAt,
          validated.completedAt,
          validated.lastError === null
            ? null
            : JSON.stringify(validated.lastError),
          validated.createdAt,
          validated.updatedAt,
        ],
      );
      return mapRunStage(requireRow(inserted.rows[0]));
    });
  }

  findRunStage(id: string): Promise<RunStageRecord | null> {
    const parsed = EntityIdSchema.safeParse(id);
    if (!parsed.success) return Promise.resolve(null);
    return this.#execute(async () => {
      const result = await this.#queries.query<PostgresRow>(
        `SELECT id, run_id, stage, status, progress, attempt_count,
                started_at, completed_at, last_error_json, created_at,
                updated_at
           FROM run_stages WHERE id = $1`,
        [parsed.data],
      );
      return result.rows[0] ? mapRunStage(result.rows[0]) : null;
    });
  }

  listRunStages(runId: string): Promise<RunStageRecord[]> {
    const parsed = EntityIdSchema.safeParse(runId);
    if (!parsed.success) return Promise.resolve([]);
    return this.#execute(async () => {
      const result = await this.#queries.query<PostgresRow>(
        `SELECT id, run_id, stage, status, progress, attempt_count,
                started_at, completed_at, last_error_json, created_at,
                updated_at
           FROM run_stages
          WHERE run_id = $1
          ORDER BY CASE stage
            WHEN 'traffic-analysis' THEN 1
            WHEN 'alexa-voc-normalization' THEN 2
            WHEN 'voc-positioning' THEN 3
            WHEN 'product-definition' THEN 4
          END`,
        [parsed.data],
      );
      return result.rows.map(mapRunStage);
    });
  }

  upsertConnectorStatus(
    status: ConnectorStatusRecord,
  ): Promise<ConnectorStatusRecord> {
    return this.#execute(async () => {
      const validated = normalizeConnectorStatus(status);
      const result = await this.#queries.query<PostgresRow>(
        `INSERT INTO connector_status (
           id, organization_id, connector, configured, health,
           last_checked_at, last_error_json, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         ON CONFLICT (organization_id, connector) DO UPDATE SET
           configured = EXCLUDED.configured,
           health = EXCLUDED.health,
           last_checked_at = EXCLUDED.last_checked_at,
           last_error_json = EXCLUDED.last_error_json,
           updated_at = EXCLUDED.updated_at
         RETURNING id, organization_id, connector, configured, health,
                   last_checked_at, last_error_json, updated_at`,
        [
          validated.id,
          validated.organizationId,
          validated.connector,
          validated.configured,
          validated.health,
          validated.lastCheckedAt,
          validated.lastError === null
            ? null
            : JSON.stringify(validated.lastError),
          validated.updatedAt,
        ],
      );
      return mapConnectorStatus(requireRow(result.rows[0]));
    });
  }

  findConnectorStatus(
    organizationId: string,
    connector: ConnectorStatusRecord["connector"],
  ): Promise<ConnectorStatusRecord | null> {
    const organization = EntityIdSchema.safeParse(organizationId);
    const connectorName = z
      .enum(["sif", "sorftime", "sellerSprite"])
      .safeParse(connector);
    if (!organization.success || !connectorName.success) {
      return Promise.resolve(null);
    }
    return this.#execute(async () => {
      const result = await this.#queries.query<PostgresRow>(
        `SELECT id, organization_id, connector, configured, health,
                last_checked_at, last_error_json, updated_at
           FROM connector_status
          WHERE organization_id = $1 AND connector = $2`,
        [organization.data, connectorName.data],
      );
      return result.rows[0] ? mapConnectorStatus(result.rows[0]) : null;
    });
  }

  listConnectorStatuses(
    organizationId: string,
  ): Promise<ConnectorStatusRecord[]> {
    const parsed = EntityIdSchema.safeParse(organizationId);
    if (!parsed.success) return Promise.resolve([]);
    return this.#execute(async () => {
      const result = await this.#queries.query<PostgresRow>(
        `SELECT id, organization_id, connector, configured, health,
                last_checked_at, last_error_json, updated_at
           FROM connector_status
          WHERE organization_id = $1
          ORDER BY connector`,
        [parsed.data],
      );
      return result.rows.map(mapConnectorStatus);
    });
  }

  findLatestConnectorCredential(
    organizationId: string,
    connector: ConnectorCredentialRecord["connector"],
  ): Promise<ConnectorCredentialRecord | null> {
    const identity = normalizeConnectorCredentialIdentity(
      organizationId,
      connector,
    );
    if (!identity) return Promise.resolve(null);
    return this.#execute(async () => {
      const result = await this.#queries.query<PostgresRow>(
        `SELECT * FROM connector_credentials
         WHERE organization_id = $1 AND connector = $2
         ORDER BY version DESC
         LIMIT 1`,
        [identity.organizationId, identity.connector],
      );
      return result.rows[0] ? mapConnectorCredential(result.rows[0]) : null;
    });
  }

  rotateConnectorCredential(
    input: RotateConnectorCredentialInput,
  ): Promise<ConnectorCredentialRecord> {
    const validated = normalizeRotateConnectorCredentialInput(input);
    return this.#execute(async () =>
      await this.#queries.transaction(async () => {
        await this.#lockConnectorCredential(
          validated.organizationId,
          validated.connector,
        );
        await this.#requireActiveConnectorAdmin(
          validated.organizationId,
          validated.actorUserId,
        );
        const latest = await this.#latestConnectorCredentialRow(
          validated.organizationId,
          validated.connector,
        );
        const latestVersion = latest ? requireNumber(latest.version) : null;
        if (
          latestVersion !== validated.expectedLatestVersion ||
          validated.version !== (latestVersion ?? 0) + 1
        ) {
          throw new ConnectorCredentialConflictError();
        }
        if (latest && requireString(latest.status) === "active") {
          await this.#queries.query(
            `UPDATE connector_credentials
             SET status = 'revoked', revoked_by = $1, revoked_at = $2
             WHERE id = $3 AND status = 'active'`,
            [validated.actorUserId, validated.rotatedAt, requireString(latest.id)],
          );
        }
        const inserted = await this.#queries.query<PostgresRow>(
          `INSERT INTO connector_credentials (
             id, organization_id, connector, version, status, ciphertext, nonce,
             auth_tag, key_id, created_by, created_at, revoked_by, revoked_at
           ) VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, $8, $9, $10,
                     NULL, NULL)
           RETURNING *`,
          [
            validated.id,
            validated.organizationId,
            validated.connector,
            validated.version,
            validated.ciphertext,
            validated.nonce,
            validated.authTag,
            validated.keyId,
            validated.actorUserId,
            validated.rotatedAt,
          ],
        );
        await this.#writeConnectorCredentialStatus({
          id: validated.statusId,
          organizationId: validated.organizationId,
          connector: validated.connector,
          configured: true,
          updatedAt: validated.rotatedAt,
        });
        await this.#appendConnectorCredentialAudit({
          id: validated.auditEventId,
          organizationId: validated.organizationId,
          actorUserId: validated.actorUserId,
          action: "connector.credential-rotated",
          connector: validated.connector,
          version: validated.version,
          createdAt: validated.rotatedAt,
        });
        return mapConnectorCredential(requireRow(inserted.rows[0]));
      }),
    );
  }

  revokeConnectorCredential(
    input: RevokeConnectorCredentialInput,
  ): Promise<RevokeConnectorCredentialResult> {
    const validated = normalizeRevokeConnectorCredentialInput(input);
    return this.#execute(async () =>
      await this.#queries.transaction(async () => {
        await this.#lockConnectorCredential(
          validated.organizationId,
          validated.connector,
        );
        await this.#requireActiveConnectorAdmin(
          validated.organizationId,
          validated.actorUserId,
        );
        const latest = await this.#latestConnectorCredentialRow(
          validated.organizationId,
          validated.connector,
        );
        const latestVersion = latest ? requireNumber(latest.version) : null;
        if (latestVersion !== validated.expectedLatestVersion) {
          throw new ConnectorCredentialConflictError();
        }
        let changed = false;
        let credential: ConnectorCredentialRecord;
        if (!latest) {
          changed = true;
          const inserted = await this.#queries.query<PostgresRow>(
            `INSERT INTO connector_credentials (
               id, organization_id, connector, version, status, ciphertext, nonce,
               auth_tag, key_id, created_by, created_at, revoked_by, revoked_at
             ) VALUES ($1, $2, $3, 1, 'revoked', $4, $5, $6, $7, $8, $9,
                       $8, $9)
             RETURNING *`,
            [
              validated.tombstoneId,
              validated.organizationId,
              validated.connector,
              validated.ciphertext,
              validated.nonce,
              validated.authTag,
              validated.keyId,
              validated.actorUserId,
              validated.revokedAt,
            ],
          );
          credential = mapConnectorCredential(requireRow(inserted.rows[0]));
        } else if (requireString(latest.status) === "active") {
          changed = true;
          const updated = await this.#queries.query<PostgresRow>(
            `UPDATE connector_credentials
             SET status = 'revoked', revoked_by = $1, revoked_at = $2
             WHERE id = $3 AND status = 'active'
             RETURNING *`,
            [validated.actorUserId, validated.revokedAt, requireString(latest.id)],
          );
          credential = mapConnectorCredential(requireRow(updated.rows[0]));
        } else {
          credential = mapConnectorCredential(latest);
        }
        await this.#writeConnectorCredentialStatus({
          id: validated.statusId,
          organizationId: validated.organizationId,
          connector: validated.connector,
          configured: false,
          updatedAt: validated.revokedAt,
        });
        if (changed) {
          await this.#appendConnectorCredentialAudit({
            id: validated.auditEventId,
            organizationId: validated.organizationId,
            actorUserId: validated.actorUserId,
            action: "connector.credential-revoked",
            connector: validated.connector,
            version: credential.version,
            createdAt: validated.revokedAt,
          });
        }
        return Object.freeze({ credential, changed });
      }),
    );
  }

  async #lockConnectorCredential(
    organizationId: string,
    connector: ConnectorCredentialRecord["connector"],
  ) {
    await this.#queries.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`${organizationId}:${connector}`],
    );
  }

  async #requireActiveConnectorAdmin(
    organizationId: string,
    actorUserId: string,
  ) {
    const result = await this.#queries.query(
      `SELECT 1 FROM users
       WHERE id = $1 AND organization_id = $2
         AND role = 'admin' AND status = 'active'`,
      [actorUserId, organizationId],
    );
    if (result.rowCount !== 1) {
      throw new ConnectorCredentialAuthorizationError();
    }
  }

  async #latestConnectorCredentialRow(
    organizationId: string,
    connector: ConnectorCredentialRecord["connector"],
  ): Promise<PostgresRow | undefined> {
    const result = await this.#queries.query<PostgresRow>(
      `SELECT * FROM connector_credentials
       WHERE organization_id = $1 AND connector = $2
       ORDER BY version DESC
       LIMIT 1
       FOR UPDATE`,
      [organizationId, connector],
    );
    return result.rows[0];
  }

  async #writeConnectorCredentialStatus(input: {
    id: string;
    organizationId: string;
    connector: ConnectorCredentialRecord["connector"];
    configured: boolean;
    updatedAt: string;
  }) {
    await this.#queries.query(
      `INSERT INTO connector_status (
         id, organization_id, connector, configured, health,
         last_checked_at, last_error_json, updated_at
       ) VALUES ($1, $2, $3, $4, 'unknown', NULL, NULL, $5)
       ON CONFLICT (organization_id, connector) DO UPDATE SET
         configured = EXCLUDED.configured,
         health = 'unknown',
         last_checked_at = NULL,
         last_error_json = NULL,
         updated_at = EXCLUDED.updated_at`,
      [
        input.id,
        input.organizationId,
        input.connector,
        input.configured,
        input.updatedAt,
      ],
    );
  }

  async #appendConnectorCredentialAudit(input: {
    id: string;
    organizationId: string;
    actorUserId: string;
    action: "connector.credential-rotated" | "connector.credential-revoked";
    connector: ConnectorCredentialRecord["connector"];
    version: number;
    createdAt: string;
  }) {
    await this.#queries.query(
      `INSERT INTO audit_events (
         id, organization_id, actor_user_id, action, target_type,
         target_id, metadata_json, created_at
       ) VALUES ($1, $2, $3, $4, 'connector', $5, $6::jsonb, $7)`,
      [
        input.id,
        input.organizationId,
        input.actorUserId,
        input.action,
        input.connector,
        JSON.stringify({ connector: input.connector, version: input.version }),
        input.createdAt,
      ],
    );
  }

  async #execute<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await operation();
    } catch (error) {
      throw sanitizeStoreError(error);
    }
  }
}

function normalizeInitialAdmin(input: InitialAdminInput) {
  const parsed = initialAdminSchema.parse({
    ...input,
    createdAt: canonicalDateTime(input.createdAt),
  });
  return { ...parsed, email: parsed.email.trim() };
}

function normalizeSession(input: SessionRecord): SessionRecord {
  return sessionSchema.parse({
    ...input,
    expiresAt: canonicalDateTime(input.expiresAt),
    revokedAt:
      input.revokedAt === null ? null : canonicalDateTime(input.revokedAt),
    createdAt: canonicalDateTime(input.createdAt),
    lastSeenAt:
      input.lastSeenAt === null ? null : canonicalDateTime(input.lastSeenAt),
  });
}

function normalizeUser(input: UserRecord): UserRecord {
  return UserSchema.parse({
    ...input,
    createdAt: canonicalDateTime(input.createdAt),
    updatedAt: canonicalDateTime(input.updatedAt),
  });
}

function normalizeUserFeedback(input: UserFeedbackRecord): UserFeedbackRecord {
  return userFeedbackSchema.parse({
    id: input.id,
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    category: input.category,
    title: input.title,
    description: input.description,
    pagePath: input.pagePath,
    appVersion: input.appVersion,
    createdAt: canonicalDateTime(input.createdAt),
  });
}

function normalizeFeedbackStatus(value: string): FeedbackStatus {
  if (value === "new" || value === "processing" || value === "resolved" || value === "closed") return value;
  throw new TypeError("Invalid feedback status");
}

function normalizeFeedbackAttachments(input: readonly FeedbackAttachmentWrite[]) {
  if (input.length > 3) throw new TypeError("Invalid feedback attachments");
  return input.map((attachment) => {
    const id = EntityIdSchema.parse(attachment.id);
    const fileName = attachment.fileName.trim();
    const imageContent = Buffer.from(attachment.imageContent);
    if (
      fileName.length < 1 || fileName.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(fileName) ||
      !["image/png", "image/jpeg", "image/webp"].includes(attachment.mediaType) ||
      !Number.isSafeInteger(attachment.byteSize) || attachment.byteSize < 1 || attachment.byteSize > 5 * 1024 * 1024 ||
      imageContent.byteLength !== attachment.byteSize || !/^[0-9a-f]{64}$/.test(attachment.sha256)
    ) throw new TypeError("Invalid feedback attachment");
    return Object.freeze({
      ...attachment,
      id,
      fileName,
      imageContent,
      createdAt: canonicalDateTime(attachment.createdAt),
    });
  });
}

function normalizeProject(input: CreateProjectInput): CreateProjectInput {
  const parsed = ProjectSchema.parse({
    ...input,
    currentRunId: null,
    createdAt: canonicalDateTime(input.createdAt),
    updatedAt: canonicalDateTime(input.updatedAt),
  });
  return {
    id: parsed.id,
    organizationId: parsed.organizationId,
    name: parsed.name,
    marketplace: parsed.marketplace,
    asins: parsed.asins,
    createdBy: parsed.createdBy,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
  };
}

function normalizeAnalysisRun(input: AnalysisRunRecord): AnalysisRunRecord {
  return analysisRunRecordSchema.parse({
    ...input,
    dataCutoffAt: canonicalDateTime(input.dataCutoffAt),
    createdAt: canonicalDateTime(input.createdAt),
    updatedAt: canonicalDateTime(input.updatedAt),
  });
}

function normalizeRunStage(input: RunStageRecord): RunStageRecord {
  return runStageRecordSchema.parse({
    ...input,
    startedAt:
      input.startedAt === null ? null : canonicalDateTime(input.startedAt),
    completedAt:
      input.completedAt === null ? null : canonicalDateTime(input.completedAt),
    createdAt: canonicalDateTime(input.createdAt),
    updatedAt: canonicalDateTime(input.updatedAt),
  });
}

function normalizeConnectorStatus(
  input: ConnectorStatusRecord,
): ConnectorStatusRecord {
  return connectorStatusSchema.parse({
    ...input,
    lastCheckedAt:
      input.lastCheckedAt === null
        ? null
        : canonicalDateTime(input.lastCheckedAt),
    updatedAt: canonicalDateTime(input.updatedAt),
  });
}

const connectorCredentialConnectorSchema = z.enum([
  "sif",
  "sorftime",
  "sellerSprite",
]);
const connectorCredentialKeyIdSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/);

function normalizeConnectorCredentialIdentity(
  organizationId: string,
  connector: ConnectorCredentialRecord["connector"],
) {
  const organization = EntityIdSchema.safeParse(organizationId);
  const connectorId = connectorCredentialConnectorSchema.safeParse(connector);
  if (!organization.success || !connectorId.success) return null;
  return { organizationId: organization.data, connector: connectorId.data };
}

function normalizeEncryptedConnectorCredential(input: {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  authTag: Uint8Array;
  keyId: string;
}) {
  const ciphertext = Buffer.from(input.ciphertext);
  const nonce = Buffer.from(input.nonce);
  const authTag = Buffer.from(input.authTag);
  if (
    ciphertext.byteLength < 1 ||
    ciphertext.byteLength > 8_192 ||
    nonce.byteLength !== 12 ||
    authTag.byteLength !== 16
  ) {
    throw new TypeError("Invalid encrypted connector credential");
  }
  return {
    ciphertext,
    nonce,
    authTag,
    keyId: connectorCredentialKeyIdSchema.parse(input.keyId),
  };
}

function normalizeExpectedConnectorCredentialVersion(value: number | null) {
  if (
    value !== null &&
    (!Number.isSafeInteger(value) || value < 1)
  ) {
    throw new TypeError("Invalid connector credential version");
  }
  return value;
}

function normalizeRotateConnectorCredentialInput(
  input: RotateConnectorCredentialInput,
): RotateConnectorCredentialInput {
  const identity = normalizeConnectorCredentialIdentity(
    input.organizationId,
    input.connector,
  );
  if (!identity || !Number.isSafeInteger(input.version) || input.version < 1) {
    throw new TypeError("Invalid connector credential rotation");
  }
  return Object.freeze({
    ...identity,
    id: EntityIdSchema.parse(input.id),
    version: input.version,
    expectedLatestVersion: normalizeExpectedConnectorCredentialVersion(
      input.expectedLatestVersion,
    ),
    ...normalizeEncryptedConnectorCredential(input),
    actorUserId: EntityIdSchema.parse(input.actorUserId),
    rotatedAt: canonicalDateTime(input.rotatedAt),
    statusId: EntityIdSchema.parse(input.statusId),
    auditEventId: EntityIdSchema.parse(input.auditEventId),
  });
}

function normalizeRevokeConnectorCredentialInput(
  input: RevokeConnectorCredentialInput,
): RevokeConnectorCredentialInput {
  const identity = normalizeConnectorCredentialIdentity(
    input.organizationId,
    input.connector,
  );
  if (!identity) throw new TypeError("Invalid connector credential revocation");
  return Object.freeze({
    ...identity,
    expectedLatestVersion: normalizeExpectedConnectorCredentialVersion(
      input.expectedLatestVersion,
    ),
    actorUserId: EntityIdSchema.parse(input.actorUserId),
    revokedAt: canonicalDateTime(input.revokedAt),
    tombstoneId: EntityIdSchema.parse(input.tombstoneId),
    ...normalizeEncryptedConnectorCredential(input),
    statusId: EntityIdSchema.parse(input.statusId),
    auditEventId: EntityIdSchema.parse(input.auditEventId),
  });
}

function canonicalDateTime(value: string): string {
  const parsed = DateTimeSchema.parse(value);
  return new Date(parsed).toISOString();
}

function assertValidInitialStageState(stage: RunStageRecord): void {
  const incomplete = stage.completedAt === null;
  const terminal = [
    "succeeded",
    "skipped",
    "failed",
    "budget-exceeded",
    "cancelled",
  ].includes(stage.status);
  if (
    (stage.status === "queued" &&
      (stage.progress !== 0 || stage.startedAt !== null || !incomplete)) ||
    (stage.status === "running" &&
      (stage.startedAt === null || !incomplete || stage.progress === 100)) ||
    (stage.status === "waiting-input" && !incomplete) ||
    (["succeeded", "skipped"].includes(stage.status) &&
      (stage.progress !== 100 || incomplete)) ||
    (terminal && incomplete)
  ) {
    throw new PostgresCoreStoreDataError();
  }
}

function sameAnalysisRunRequest(
  stored: AnalysisRunRecord,
  candidate: AnalysisRunRecord,
): boolean {
  return isDeepStrictEqual(
    {
      projectId: stored.projectId,
      mode: stored.mode,
      status: stored.status,
      createdBy: stored.createdBy,
      dataCutoffAt: stored.dataCutoffAt,
      idempotencyScope: stored.idempotencyScope,
      idempotencyKey: stored.idempotencyKey,
    },
    {
      projectId: candidate.projectId,
      mode: candidate.mode,
      status: candidate.status,
      createdBy: candidate.createdBy,
      dataCutoffAt: candidate.dataCutoffAt,
      idempotencyScope: candidate.idempotencyScope,
      idempotencyKey: candidate.idempotencyKey,
    },
  );
}

function mapUser(row: PostgresRow): UserRecord {
  return normalizeUser({
    id: requireString(row.id),
    organizationId: requireString(row.organization_id),
    email: requireString(row.email),
    displayName: requireString(row.display_name),
    role: requireString(row.role) as UserRecord["role"],
    status: requireString(row.status) as UserRecord["status"],
    createdAt: mapDateTime(row.created_at),
    updatedAt: mapDateTime(row.updated_at),
  });
}

function mapUserFeedback(row: PostgresRow): UserFeedbackRecord {
  return normalizeUserFeedback({
    id: requireString(row.id),
    organizationId: requireString(row.organization_id),
    actorUserId: requireString(row.actor_user_id),
    category: requireString(row.category) as UserFeedbackRecord["category"],
    title: requireString(row.title),
    description: requireString(row.description),
    pagePath: requireString(row.page_path),
    appVersion: row.app_version === null ? null : requireString(row.app_version),
    createdAt: mapDateTime(row.created_at),
  });
}

function mapFeedbackList(row: PostgresRow): FeedbackListRecord {
  return Object.freeze({
    ...mapUserFeedback(row),
    status: normalizeFeedbackStatus(requireString(row.status)),
    workflowVersion: Number(row.workflow_version),
    adminSeenAt: row.admin_seen_at === null ? null : mapDateTime(row.admin_seen_at),
    attachmentCount: Number(row.attachment_count),
  });
}

function mapFeedbackAttachmentMetadata(row: PostgresRow): FeedbackAttachmentMetadata {
  return Object.freeze({
    id: EntityIdSchema.parse(row.id),
    feedbackId: EntityIdSchema.parse(row.feedback_id),
    fileName: requireString(row.file_name),
    mediaType: requireString(row.media_type) as FeedbackAttachmentMetadata["mediaType"],
    byteSize: Number(row.byte_size),
    sha256: requireString(row.sha256),
    createdAt: mapDateTime(row.created_at),
  });
}

function mapFeedbackEvent(row: PostgresRow): FeedbackStatusEventRecord {
  return Object.freeze({
    id: EntityIdSchema.parse(row.id),
    feedbackId: EntityIdSchema.parse(row.feedback_id),
    actorUserId: EntityIdSchema.parse(row.actor_user_id),
    eventType: requireString(row.event_type) as FeedbackStatusEventRecord["eventType"],
    fromStatus: row.from_status === null ? null : normalizeFeedbackStatus(requireString(row.from_status)),
    toStatus: normalizeFeedbackStatus(requireString(row.to_status)),
    createdAt: mapDateTime(row.created_at),
  });
}

function mapSession(row: PostgresRow): SessionRecord {
  return normalizeSession({
    id: requireString(row.id),
    userId: requireString(row.user_id),
    tokenHash: requireString(row.token_hash),
    expiresAt: mapDateTime(row.expires_at),
    revokedAt: row.revoked_at === null ? null : mapDateTime(row.revoked_at),
    createdAt: mapDateTime(row.created_at),
    lastSeenAt:
      row.last_seen_at === null ? null : mapDateTime(row.last_seen_at),
  });
}

function mapProject(row: PostgresRow): ProjectRecord {
  return ProjectSchema.parse({
    id: requireString(row.id),
    organizationId: requireString(row.organization_id),
    name: requireString(row.name),
    marketplace: requireString(row.marketplace),
    asins: row.asins_json,
    createdBy: requireString(row.created_by),
    currentRunId:
      row.current_run_id === null ? null : requireString(row.current_run_id),
    createdAt: mapDateTime(row.created_at),
    updatedAt: mapDateTime(row.updated_at),
  });
}

function mapAnalysisRun(row: PostgresRow): AnalysisRunRecord {
  return normalizeAnalysisRun({
    id: requireString(row.id),
    projectId: requireString(row.project_id),
    mode: requireString(row.mode) as AnalysisRunRecord["mode"],
    status: requireString(row.status) as AnalysisRunRecord["status"],
    createdBy: requireString(row.created_by),
    dataCutoffAt: mapDateTime(row.data_cutoff_at),
    idempotencyScope: requireString(row.idempotency_scope),
    idempotencyKey: requireString(row.idempotency_key),
    createdAt: mapDateTime(row.created_at),
    updatedAt: mapDateTime(row.updated_at),
  });
}

function mapRunStage(row: PostgresRow): RunStageRecord {
  return normalizeRunStage({
    id: requireString(row.id),
    runId: requireString(row.run_id),
    stage: requireString(row.stage) as RunStageRecord["stage"],
    status: requireString(row.status) as RunStageRecord["status"],
    progress: requireNumber(row.progress),
    attemptCount: requireNumber(row.attempt_count),
    startedAt: row.started_at === null ? null : mapDateTime(row.started_at),
    completedAt:
      row.completed_at === null ? null : mapDateTime(row.completed_at),
    lastError:
      row.last_error_json === null
        ? null
        : (row.last_error_json as Record<string, unknown>),
    createdAt: mapDateTime(row.created_at),
    updatedAt: mapDateTime(row.updated_at),
  });
}

function mapConnectorStatus(row: PostgresRow): ConnectorStatusRecord {
  return normalizeConnectorStatus({
    id: requireString(row.id),
    organizationId: requireString(row.organization_id),
    connector: requireString(row.connector) as ConnectorStatusRecord["connector"],
    configured: requireBoolean(row.configured),
    health: requireString(row.health) as ConnectorStatusRecord["health"],
    lastCheckedAt:
      row.last_checked_at === null ? null : mapDateTime(row.last_checked_at),
    lastError:
      row.last_error_json === null
        ? null
        : (row.last_error_json as ConnectorStatusRecord["lastError"]),
    updatedAt: mapDateTime(row.updated_at),
  });
}

function mapConnectorCredential(row: PostgresRow): ConnectorCredentialRecord {
  const identity = normalizeConnectorCredentialIdentity(
    requireString(row.organization_id),
    requireString(row.connector) as ConnectorCredentialRecord["connector"],
  );
  const version = requireNumber(row.version);
  const status = requireString(row.status);
  if (
    !identity ||
    version < 1 ||
    (status !== "active" && status !== "revoked") ||
    !(row.ciphertext instanceof Uint8Array) ||
    !(row.nonce instanceof Uint8Array) ||
    !(row.auth_tag instanceof Uint8Array)
  ) {
    throw new PostgresCoreStoreDataError();
  }
  const encrypted = normalizeEncryptedConnectorCredential({
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    authTag: row.auth_tag,
    keyId: requireString(row.key_id),
  });
  return Object.freeze({
    id: EntityIdSchema.parse(row.id),
    ...identity,
    version,
    status,
    ...encrypted,
    createdBy: EntityIdSchema.parse(row.created_by),
    createdAt: mapDateTime(row.created_at),
    revokedBy:
      row.revoked_by === null ? null : EntityIdSchema.parse(row.revoked_by),
    revokedAt:
      row.revoked_at === null ? null : mapDateTime(row.revoked_at),
  });
}

function requireRow(row: PostgresRow | undefined): PostgresRow {
  if (!row) throw new PostgresCoreStoreDataError();
  return row;
}

function requireString(value: unknown): string {
  if (typeof value !== "string") throw new PostgresCoreStoreDataError();
  return value;
}

function requireNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new PostgresCoreStoreDataError();
  }
  return value;
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new PostgresCoreStoreDataError();
  return value;
}

function mapDateTime(value: unknown): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "string") return canonicalDateTime(value);
  throw new PostgresCoreStoreDataError();
}

function sanitizeStoreError(error: unknown): Error {
  if (
    error instanceof PostgresCoreStoreError ||
    error instanceof ConnectorCredentialAuthorizationError ||
    error instanceof ConnectorCredentialConflictError
  ) return error;
  if (error instanceof z.ZodError || error instanceof TypeError) {
    return new PostgresCoreStoreDataError();
  }
  const code = postgresErrorCode(error);
  if (code === "23505" || code === "23503") {
    return new PostgresCoreStoreConflictError();
  }
  if (code === "23502" || code === "23514" || code === "22P02") {
    return new PostgresCoreStoreDataError();
  }
  return new PostgresCoreStoreError("PostgreSQL core store operation failed");
}

function postgresErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}
