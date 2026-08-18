import { Pool, type PoolConfig } from "pg";

import type { RuntimeAgentRepository } from "./repository";
import { PostgresAgentRunStore } from "./postgres/agent-run-store";
import { PostgresAnalysisReportStore } from "./postgres/analysis-report-store";
import { PostgresAnalysisRunLifecycleStore } from "./postgres/analysis-run-lifecycle-store";
import { PostgresCoreStore } from "./postgres/core-store";
import { PostgresDataSnapshotStore } from "./postgres/data-snapshot-store";
import { PostgresJobStore } from "./postgres/job-store";
import { PostgresKeywordAnalysisSnapshotStore } from "./postgres/keyword-analysis-snapshot-store";
import { runPostgresMigrations } from "./postgres/migrations";
import { PostgresModelBudgetStore } from "./postgres/model-budget-store";
import { PostgresProductDependencyReconciler } from "./postgres/product-dependency-reconciler";
import { PostgresQueryContext } from "./postgres/query-context";
import { PostgresTrafficDataSnapshotStore } from "./postgres/traffic-data-snapshot-store";

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
  }

  transaction: RuntimeAgentRepository["transaction"] = (operation) =>
    this.#queries.transaction(() => operation(this));

  close(): Promise<void> {
    return this.#queries.close();
  }

  createInitialAdmin: RuntimeAgentRepository["createInitialAdmin"] = (input) =>
    this.#core.createInitialAdmin(input);
  findAuthenticationUserByEmail:
    RuntimeAgentRepository["findAuthenticationUserByEmail"] = (email) =>
      this.#core.findAuthenticationUserByEmail(email);
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
  createUser: RuntimeAgentRepository["createUser"] = (user) =>
    this.#core.createUser(user);
  findUserById: RuntimeAgentRepository["findUserById"] = (id) =>
    this.#core.findUserById(id);
  createProject: RuntimeAgentRepository["createProject"] = (project) =>
    this.#core.createProject(project);
  findProjectById: RuntimeAgentRepository["findProjectById"] = (id) =>
    this.#core.findProjectById(id);
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

export async function openPostgresAgentRepository(
  options: OpenPostgresAgentRepositoryOptions,
): Promise<PostgresAgentRepository> {
  const pool = new Pool({
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
