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
import type {
  ActiveSessionPrincipalRecord,
  AnalysisRunRecord,
  AuthenticationRepository,
  AuthenticationUserRecord,
  ConnectorStatusRecord,
  ConnectorStatusRepository,
  CreateAnalysisRunResult,
  CreateProjectInput,
  InitialAdminInput,
  ProjectRecord,
  RunStageRecord,
  SessionRecord,
  UserRecord,
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

const analysisRunRecordSchema = AnalysisRunSchema.extend({
  idempotencyScope: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().trim().min(1).max(200),
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
  implements AuthenticationRepository, ConnectorStatusRepository
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
        `SELECT s.id AS session_id, u.id AS user_id, u.organization_id, u.role
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
            WHEN 'voc-positioning' THEN 2
            WHEN 'product-definition' THEN 3
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
  return RunStageSchema.parse({
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
  if (error instanceof PostgresCoreStoreError) return error;
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
