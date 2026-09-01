import { randomUUID } from "node:crypto";

import { Pool, type PoolConfig } from "pg";

import { DateTimeSchema, EntityIdSchema } from "../../shared/agent-contracts";
import {
  canonicalProjectCreationPayload,
  hasSameProjectImmutableScope,
  ImmutableProjectScopeError,
  LegacyProjectOwnerBindingError,
  parseProjectCreationIdempotencyKey,
  ProjectCreationIdempotencyConflictError,
  type BindLegacyProjectOwnerInput,
  type BindLegacyProjectOwnerResult,
  type CreateProjectOnceInput,
  type CreateProjectResult,
  type LegacyProjectOwnerBindingRecord,
  type ProjectRecord,
  type RuntimeAgentRepository,
  type UpdateProjectMetadataInput,
} from "./repository";
import { PostgresAgentRunStore } from "./postgres/agent-run-store";
import { PostgresAnalysisReportStore } from "./postgres/analysis-report-store";
import { PostgresAnalysisRunLifecycleStore } from "./postgres/analysis-run-lifecycle-store";
import { PostgresCoreStore } from "./postgres/core-store";
import { PostgresConcurrencyControlStore } from "./postgres/concurrency-control-store";
import { PostgresDataSnapshotStore } from "./postgres/data-snapshot-store";
import { PostgresJobStore } from "./postgres/job-store";
import { PostgresKeywordAnalysisSnapshotStore } from "./postgres/keyword-analysis-snapshot-store";
import { runPostgresMigrations } from "./postgres/migrations";
import { PostgresModelBudgetStore } from "./postgres/model-budget-store";
import { PostgresManualAlexaVocStore } from "./postgres/manual-alexa-voc-store";
import { PostgresProductDependencyReconciler } from "./postgres/product-dependency-reconciler";
import { PostgresQueryContext } from "./postgres/query-context";
import { PostgresSyncJobStore } from "./postgres/sync-job-store";
import { PostgresTrafficDataSnapshotStore } from "./postgres/traffic-data-snapshot-store";
import { PostgresAdminUserPresenceStore } from "./postgres/admin-user-presence-store";

export interface OpenPostgresAgentRepositoryOptions {
  readonly connectionString: string;
  readonly pool?: Omit<PoolConfig, "connectionString">;
}

export class PostgresAgentRepositoryOpenError extends Error {
  constructor() {
    super("Failed to open PostgreSQL agent repository");
    this.name = "PostgresAgentRepositoryOpenError";
  }
}

export class PostgresAgentRepository implements RuntimeAgentRepository {
  readonly #queries: PostgresQueryContext;
  readonly #core: PostgresCoreStore;
  readonly #lifecycle: PostgresAnalysisRunLifecycleStore;
  readonly #jobs: PostgresJobStore;
  readonly #budget: PostgresModelBudgetStore;
  readonly #agentRuns: PostgresAgentRunStore;
  readonly #dataSnapshots: PostgresDataSnapshotStore;
  readonly #trafficSnapshots: PostgresTrafficDataSnapshotStore;
  readonly #keywordSnapshots: PostgresKeywordAnalysisSnapshotStore;
  readonly #reports: PostgresAnalysisReportStore;
  readonly manualAlexaVoc: PostgresManualAlexaVocStore;
  readonly syncJobs: PostgresSyncJobStore;
  readonly concurrencyControl: PostgresConcurrencyControlStore;
  readonly adminUserPresence: PostgresAdminUserPresenceStore;

  constructor(pool: Pool) {
    this.#queries = new PostgresQueryContext(pool);
    const productDependencyReconciler =
      new PostgresProductDependencyReconciler(this.#queries);
    this.#core = new PostgresCoreStore(this.#queries);
    this.#lifecycle = new PostgresAnalysisRunLifecycleStore(this.#queries);
    this.#jobs = new PostgresJobStore(this.#queries);
    this.#budget = new PostgresModelBudgetStore(this.#queries);
    this.#agentRuns = new PostgresAgentRunStore(this.#queries);
    this.#dataSnapshots = new PostgresDataSnapshotStore(this.#queries);
    this.#trafficSnapshots = new PostgresTrafficDataSnapshotStore(this.#queries);
    this.#keywordSnapshots = new PostgresKeywordAnalysisSnapshotStore(
      this.#queries,
      { dependencyReconciler: productDependencyReconciler },
    );
    this.#reports = new PostgresAnalysisReportStore(this.#queries, {
      dependencyReconciler: productDependencyReconciler,
    });
    this.manualAlexaVoc = new PostgresManualAlexaVocStore(this.#queries);
    this.syncJobs = new PostgresSyncJobStore(this.#queries);
    this.concurrencyControl = new PostgresConcurrencyControlStore(
      this.#queries,
      { permitId: () => randomUUID() },
    );
    this.adminUserPresence = new PostgresAdminUserPresenceStore(this.#queries);
  }

  transaction: RuntimeAgentRepository["transaction"] = (operation) =>
    this.manualAlexaVoc.transaction(() => operation(this));

  close(): Promise<void> {
    return this.#queries.close();
  }

  createInitialAdmin: RuntimeAgentRepository["createInitialAdmin"] = (input) =>
    this.#core.createInitialAdmin(input);
  createLocalUser: RuntimeAgentRepository["createLocalUser"] = (input) =>
    this.#core.createLocalUser(input);
  findAuthenticationUserByEmail:
    RuntimeAgentRepository["findAuthenticationUserByEmail"] = (email) =>
      this.#core.findAuthenticationUserByEmail(email);
  findAuthenticationUserById:
    RuntimeAgentRepository["findAuthenticationUserById"] = (userId) =>
      this.#core.findAuthenticationUserById(userId);
  createSession: RuntimeAgentRepository["createSession"] = (session) =>
    this.#core.createSession(session);
  findActiveSessionPrincipalByTokenHash:
    RuntimeAgentRepository["findActiveSessionPrincipalByTokenHash"] = (input) =>
      this.#core.findActiveSessionPrincipalByTokenHash(input);
  revokeSessionByTokenHash:
    RuntimeAgentRepository["revokeSessionByTokenHash"] = (input) =>
      this.#core.revokeSessionByTokenHash(input);
  revokeUserSessions: RuntimeAgentRepository["revokeUserSessions"] = (input) =>
    this.#core.revokeUserSessions(input);
  changeUserPassword: RuntimeAgentRepository["changeUserPassword"] = (input) =>
    this.#core.changeUserPassword(input);
  createUserFeedback: RuntimeAgentRepository["createUserFeedback"] = (input) =>
    this.#core.createUserFeedback(input);
  listOwnFeedback: RuntimeAgentRepository["listOwnFeedback"] = (input) =>
    this.#core.listOwnFeedback(input);
  getOwnFeedbackDetail: RuntimeAgentRepository["getOwnFeedbackDetail"] = (input) =>
    this.#core.getOwnFeedbackDetail(input);
  readOwnFeedbackAttachment: RuntimeAgentRepository["readOwnFeedbackAttachment"] = (input) =>
    this.#core.readOwnFeedbackAttachment(input);
  listOrganizationFeedback: RuntimeAgentRepository["listOrganizationFeedback"] = (input) =>
    this.#core.listOrganizationFeedback(input);
  getOrganizationFeedbackDetail: RuntimeAgentRepository["getOrganizationFeedbackDetail"] = (input) =>
    this.#core.getOrganizationFeedbackDetail(input);
  readOrganizationFeedbackAttachment: RuntimeAgentRepository["readOrganizationFeedbackAttachment"] = (input) =>
    this.#core.readOrganizationFeedbackAttachment(input);
  countUnreadOrganizationFeedback: RuntimeAgentRepository["countUnreadOrganizationFeedback"] = (organizationId) =>
    this.#core.countUnreadOrganizationFeedback(organizationId);
  markOrganizationFeedbackSeen: RuntimeAgentRepository["markOrganizationFeedbackSeen"] = (input) =>
    this.#core.markOrganizationFeedbackSeen(input);
  changeOrganizationFeedbackStatus: RuntimeAgentRepository["changeOrganizationFeedbackStatus"] = (input) =>
    this.#core.changeOrganizationFeedbackStatus(input);
  createUser: RuntimeAgentRepository["createUser"] = (user) =>
    this.#core.createUser(user);
  findUserById: RuntimeAgentRepository["findUserById"] = (id) =>
    this.#core.findUserById(id);
  createProject: RuntimeAgentRepository["createProject"] = (project) =>
    this.#core.createProject(project);
  findProjectById: RuntimeAgentRepository["findProjectById"] = (id) =>
    this.#core.findProjectById(id);
  createProjectOnce = (input: CreateProjectOnceInput): Promise<CreateProjectResult> => {
    const idempotencyKey = parseProjectCreationIdempotencyKey(input.idempotencyKey);
    const canonicalPayload = canonicalProjectCreationPayload(input.project);
    return this.#queries.transaction(async () => {
      const readIdempotencyBinding = () => this.#queries.query<{
        project_id: string;
        same_payload: boolean;
      }>(
        `SELECT project_id, canonical_payload = $3::jsonb AS same_payload
           FROM project_creation_idempotency
          WHERE organization_id = $1 AND idempotency_key = $2`,
        [input.project.organizationId, idempotencyKey, canonicalPayload],
      );
      const existing = await readIdempotencyBinding();
      if (existing.rows[0]) {
        if (!existing.rows[0].same_payload) {
          throw new ProjectCreationIdempotencyConflictError();
        }
        const project = await this.#core.findProjectById(existing.rows[0].project_id);
        if (!project || project.organizationId !== input.project.organizationId) {
          throw new ProjectCreationIdempotencyConflictError();
        }
        return { project, created: false };
      }

      const legacyProject = await this.#core.findProjectById(input.project.id);
      if (legacyProject) {
        if (!hasSameProjectImmutableScope(legacyProject, input.project)) {
          throw new ProjectCreationIdempotencyConflictError();
        }
        await this.#queries.query(
          `INSERT INTO project_creation_idempotency (
             organization_id, idempotency_key, canonical_payload, project_id, created_at
           ) VALUES ($1, $2, $3::jsonb, $4, $5)
           ON CONFLICT DO NOTHING`,
          [
            input.project.organizationId,
            idempotencyKey,
            canonicalPayload,
            legacyProject.id,
            input.project.createdAt,
          ],
        );
        const binding = await readIdempotencyBinding();
        if (
          !binding.rows[0]
          || !binding.rows[0].same_payload
          || binding.rows[0].project_id !== legacyProject.id
        ) {
          throw new ProjectCreationIdempotencyConflictError();
        }
        return { project: legacyProject, created: false };
      }

      const project = await this.#core.createProject(input.project);
      await this.#queries.query(
        `INSERT INTO project_creation_idempotency (
           organization_id, idempotency_key, canonical_payload, project_id, created_at
         ) VALUES ($1, $2, $3::jsonb, $4, $5)`,
        [
          project.organizationId,
          idempotencyKey,
          canonicalPayload,
          project.id,
          project.createdAt,
        ],
      );
      return { project, created: true };
    });
  };
  listProjectsByOrganization = async (organizationId: string): Promise<ProjectRecord[]> => {
    const parsedOrganizationId = EntityIdSchema.parse(organizationId);
    const rows = await this.#queries.query<{ id: string }>(
      `SELECT id FROM projects
        WHERE organization_id = $1
        ORDER BY updated_at DESC, id`,
      [parsedOrganizationId],
    );
    const projects = await Promise.all(rows.rows.map(({ id }) => this.#core.findProjectById(id)));
    return projects.filter((project): project is ProjectRecord => project !== null);
  };
  updateProjectMetadata = async (
    input: UpdateProjectMetadataInput,
  ): Promise<ProjectRecord | null> => {
    if ("marketplace" in input || "asins" in input) {
      throw new ImmutableProjectScopeError();
    }
    const organizationId = EntityIdSchema.parse(input.organizationId);
    const projectId = EntityIdSchema.parse(input.projectId);
    const updatedAt = DateTimeSchema.parse(input.updatedAt);
    if (input.name === undefined) throw new TypeError("Project metadata update is empty");
    const name = input.name.trim();
    if (name.length < 1 || name.length > 200) throw new TypeError("Invalid project name");
    const updated = await this.#queries.query(
      `UPDATE projects SET name = $1, updated_at = $2
        WHERE id = $3 AND organization_id = $4`,
      [name, updatedAt, projectId, organizationId],
    );
    return updated.rowCount === 1 ? this.#core.findProjectById(projectId) : null;
  };
  bindLegacyProjectOwnerOnce = (
    input: BindLegacyProjectOwnerInput,
  ): Promise<BindLegacyProjectOwnerResult> => {
    const binding = normalizePostgresLegacyProjectOwnerBinding(input);
    return this.#queries.transaction(async () => {
      const existing = await this.#queries.query<Record<string, unknown>>(
        `SELECT legacy_project_id, organization_id, owner_user_id,
                operator_user_id, bound_at
           FROM legacy_project_owner_bindings WHERE legacy_project_id = $1`,
        [binding.legacyProjectId],
      );
      if (existing.rows[0]) {
        const record = mapPostgresLegacyProjectOwnerBinding(existing.rows[0]);
        if (
          record.organizationId !== binding.organizationId ||
          record.ownerUserId !== binding.ownerUserId
        ) {
          throw new LegacyProjectOwnerBindingError("Legacy project ownership is already bound");
        }
        return { binding: record, created: false };
      }

      const users = await this.#queries.query<{ owner_active: boolean; operator_active: boolean }>(
        `SELECT
           EXISTS(
             SELECT 1 FROM users
              WHERE id = $1 AND organization_id = $2 AND status = 'active'
           ) AS owner_active,
           EXISTS(
             SELECT 1 FROM users
              WHERE id = $3 AND organization_id = $2 AND status = 'active' AND role = 'admin'
           ) AS operator_active`,
        [binding.ownerUserId, binding.organizationId, binding.operatorUserId],
      );
      if (!users.rows[0]?.owner_active || !users.rows[0]?.operator_active) {
        throw new LegacyProjectOwnerBindingError();
      }

      await this.#queries.query(
        `INSERT INTO legacy_project_owner_bindings (
           legacy_project_id, organization_id, owner_user_id, operator_user_id, bound_at
         ) VALUES ($1, $2, $3, $4, $5)`,
        [
          binding.legacyProjectId,
          binding.organizationId,
          binding.ownerUserId,
          binding.operatorUserId,
          binding.boundAt,
        ],
      );
      return { binding, created: true };
    });
  };
  findLegacyProjectOwnerBinding = async (
    legacyProjectId: string,
  ): Promise<LegacyProjectOwnerBindingRecord | null> => {
    const normalized = normalizePostgresLegacyProjectId(legacyProjectId);
    const result = await this.#queries.query<Record<string, unknown>>(
      `SELECT legacy_project_id, organization_id, owner_user_id,
              operator_user_id, bound_at
         FROM legacy_project_owner_bindings WHERE legacy_project_id = $1`,
      [normalized],
    );
    return result.rows[0] ? mapPostgresLegacyProjectOwnerBinding(result.rows[0]) : null;
  };
  createAnalysisRunOnce: RuntimeAgentRepository["createAnalysisRunOnce"] = (
    run,
  ) => this.#core.createAnalysisRunOnce(run);
  createAnalysisRun: RuntimeAgentRepository["createAnalysisRun"] = (run) =>
    this.#core.createAnalysisRun(run);
  findAnalysisRun: RuntimeAgentRepository["findAnalysisRun"] = (id) =>
    this.#core.findAnalysisRun(id);
  listAnalysisRuns: RuntimeAgentRepository["listAnalysisRuns"] = (projectId) =>
    this.#core.listAnalysisRuns(projectId);
  createRunStage: RuntimeAgentRepository["createRunStage"] = (stage) =>
    this.#core.createRunStage(stage);
  findRunStage: RuntimeAgentRepository["findRunStage"] = (id) =>
    this.#core.findRunStage(id);
  listRunStages: RuntimeAgentRepository["listRunStages"] = (runId) =>
    this.#core.listRunStages(runId);
  upsertConnectorStatus: RuntimeAgentRepository["upsertConnectorStatus"] = (
    status,
  ) => this.#core.upsertConnectorStatus(status);
  findConnectorStatus: RuntimeAgentRepository["findConnectorStatus"] = (
    organizationId,
    connector,
  ) => this.#core.findConnectorStatus(organizationId, connector);
  listConnectorStatuses: RuntimeAgentRepository["listConnectorStatuses"] = (
    organizationId,
  ) => this.#core.listConnectorStatuses(organizationId);
  findLatestConnectorCredential:
    RuntimeAgentRepository["findLatestConnectorCredential"] = (
      organizationId,
      connector,
    ) => this.#core.findLatestConnectorCredential(organizationId, connector);
  rotateConnectorCredential:
    RuntimeAgentRepository["rotateConnectorCredential"] = (input) =>
      this.#core.rotateConnectorCredential(input);
  revokeConnectorCredential:
    RuntimeAgentRepository["revokeConnectorCredential"] = (input) =>
      this.#core.revokeConnectorCredential(input);

  cancelAnalysisRun: RuntimeAgentRepository["cancelAnalysisRun"] = (input) =>
    this.#lifecycle.cancelAnalysisRun(input);
  retryFailedRunStage: RuntimeAgentRepository["retryFailedRunStage"] = (input) =>
    this.#lifecycle.retryFailedRunStage(input);
  resumeWaitingInputRunStage:
    RuntimeAgentRepository["resumeWaitingInputRunStage"] = (input) =>
      this.#lifecycle.resumeWaitingInputRunStage(input);

  enqueueJob: RuntimeAgentRepository["enqueueJob"] = (job) =>
    this.#jobs.enqueueJob(job);
  claimNextJob: RuntimeAgentRepository["claimNextJob"] = (input) =>
    this.#jobs.claimNextJob(input);
  renewJobLease: RuntimeAgentRepository["renewJobLease"] = (input) =>
    this.#jobs.renewJobLease(input);
  releaseJobLease: RuntimeAgentRepository["releaseJobLease"] = (input) =>
    this.#jobs.releaseJobLease(input);
  completeJob: RuntimeAgentRepository["completeJob"] = (input) =>
    this.#jobs.completeJob(input);
  failJob: RuntimeAgentRepository["failJob"] = (input) =>
    this.#jobs.failJob(input);
  listJobAttempts: RuntimeAgentRepository["listJobAttempts"] = (stageId) =>
    this.#jobs.listJobAttempts(stageId);

  resolveModelBudgetSubject:
    RuntimeAgentRepository["resolveModelBudgetSubject"] = (input) =>
      this.#budget.resolveModelBudgetSubject(input);
  reserveModelBudget: RuntimeAgentRepository["reserveModelBudget"] = (input) =>
    this.#budget.reserveModelBudget(input);
  getModelBudgetUsage: RuntimeAgentRepository["getModelBudgetUsage"] = (input) =>
    this.#budget.getModelBudgetUsage(input);
  dispatchModelBudget: RuntimeAgentRepository["dispatchModelBudget"] = (input) =>
    this.#budget.dispatchModelBudget(input);
  releaseModelBudget: RuntimeAgentRepository["releaseModelBudget"] = (input) =>
    this.#budget.releaseModelBudget(input);
  settleModelBudget: RuntimeAgentRepository["settleModelBudget"] = (input) =>
    this.#budget.settleModelBudget(input);

  registerSkillVersion: RuntimeAgentRepository["registerSkillVersion"] = (
    input,
  ) => this.#agentRuns.registerSkillVersion(input);
  beginAgentRun: RuntimeAgentRepository["beginAgentRun"] = (input) =>
    this.#agentRuns.beginAgentRun(input);
  assertAgentRunClaim: RuntimeAgentRepository["assertAgentRunClaim"] = (input) =>
    this.#agentRuns.assertAgentRunClaim(input);
  finalizeAgentRun: RuntimeAgentRepository["finalizeAgentRun"] = (input) =>
    this.#agentRuns.finalizeAgentRun(input);
  listAgentRuns: RuntimeAgentRepository["listAgentRuns"] = (input) =>
    this.#agentRuns.listAgentRuns(input);
  getAgentRunUsage: RuntimeAgentRepository["getAgentRunUsage"] = (input) =>
    this.#agentRuns.getAgentRunUsage(input);
  getJobAttemptModelUsage:
    RuntimeAgentRepository["getJobAttemptModelUsage"] = (input) =>
      this.#agentRuns.getJobAttemptModelUsage(input);

  revalidateDataSnapshotSubject:
    RuntimeAgentRepository["revalidateDataSnapshotSubject"] = (input) =>
      this.#dataSnapshots.revalidateDataSnapshotSubject(input);
  createDataSnapshotForRun:
    RuntimeAgentRepository["createDataSnapshotForRun"] = (input) =>
      this.#dataSnapshots.createDataSnapshotForRun(input);
  findDataSnapshotById: RuntimeAgentRepository["findDataSnapshotById"] = (
    input,
  ) => this.#dataSnapshots.findDataSnapshotById(input);
  listDataSnapshotsByRun: RuntimeAgentRepository["listDataSnapshotsByRun"] = (
    input,
  ) => this.#dataSnapshots.listDataSnapshotsByRun(input);

  createTrafficDataSnapshotForRun:
    RuntimeAgentRepository["createTrafficDataSnapshotForRun"] = (input) =>
      this.#trafficSnapshots.createTrafficDataSnapshotForRun(input);
  findTrafficDataSnapshotById:
    RuntimeAgentRepository["findTrafficDataSnapshotById"] = (input) =>
      this.#trafficSnapshots.findTrafficDataSnapshotById(input);
  listTrafficDataSnapshotsByRun:
    RuntimeAgentRepository["listTrafficDataSnapshotsByRun"] = (input) =>
      this.#trafficSnapshots.listTrafficDataSnapshotsByRun(input);

  createKeywordAnalysisSnapshotForRun:
    RuntimeAgentRepository["createKeywordAnalysisSnapshotForRun"] = (input) =>
      this.#keywordSnapshots.createKeywordAnalysisSnapshotForRun(input);
  findKeywordAnalysisSnapshotById:
    RuntimeAgentRepository["findKeywordAnalysisSnapshotById"] = (input) =>
      this.#keywordSnapshots.findKeywordAnalysisSnapshotById(input);
  listKeywordAnalysisSnapshotsByRun:
    RuntimeAgentRepository["listKeywordAnalysisSnapshotsByRun"] = (input) =>
      this.#keywordSnapshots.listKeywordAnalysisSnapshotsByRun(input);
  getKeywordAnalysisArtifact:
    RuntimeAgentRepository["getKeywordAnalysisArtifact"] = (runId) =>
      this.#keywordSnapshots.getKeywordAnalysisArtifact(runId);

  publishVocPositioningReport:
    RuntimeAgentRepository["publishVocPositioningReport"] = (input) =>
      this.#reports.publishVocPositioningReport(input);
  publishTrafficAnalysisReport:
    RuntimeAgentRepository["publishTrafficAnalysisReport"] = (input) =>
      this.#reports.publishTrafficAnalysisReport(input);
  publishProductDefinitionReport:
    RuntimeAgentRepository["publishProductDefinitionReport"] = (input) =>
      this.#reports.publishProductDefinitionReport(input);
  listAnalysisReports: RuntimeAgentRepository["listAnalysisReports"] = (
    input,
  ) => this.#reports.listAnalysisReports(input);
  findAnalysisReportById: RuntimeAgentRepository["findAnalysisReportById"] = (
    input,
  ) => this.#reports.findAnalysisReportById(input);
}

function normalizePostgresLegacyProjectId(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 200 || /[\\/\u0000-\u001f\u007f]/.test(normalized)) {
    throw new TypeError("Invalid legacy project id");
  }
  return normalized;
}

function normalizePostgresLegacyProjectOwnerBinding(
  input: BindLegacyProjectOwnerInput,
): LegacyProjectOwnerBindingRecord {
  return Object.freeze({
    legacyProjectId: normalizePostgresLegacyProjectId(input.legacyProjectId),
    organizationId: EntityIdSchema.parse(input.organizationId),
    ownerUserId: EntityIdSchema.parse(input.ownerUserId),
    operatorUserId: EntityIdSchema.parse(input.operatorUserId),
    boundAt: DateTimeSchema.parse(input.boundAt),
  });
}

function mapPostgresLegacyProjectOwnerBinding(
  row: Record<string, unknown>,
): LegacyProjectOwnerBindingRecord {
  return Object.freeze({
    legacyProjectId: String(row.legacy_project_id),
    organizationId: String(row.organization_id),
    ownerUserId: String(row.owner_user_id),
    operatorUserId: String(row.operator_user_id),
    boundAt: row.bound_at instanceof Date
      ? row.bound_at.toISOString()
      : DateTimeSchema.parse(String(row.bound_at)),
  });
}

export async function openPostgresAgentRepository(
  options: OpenPostgresAgentRepositoryOptions,
): Promise<PostgresAgentRepository> {
  const pool = new Pool({
    max: 10,
    ...options.pool,
    connectionString: options.connectionString,
  });
  try {
    await runPostgresMigrations(pool);
    return new PostgresAgentRepository(pool);
  } catch {
    await pool.end().catch(() => undefined);
    throw new PostgresAgentRepositoryOpenError();
  }
}
