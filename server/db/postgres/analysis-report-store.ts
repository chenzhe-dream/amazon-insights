import { isDeepStrictEqual } from "node:util";

import type { QueryResultRow } from "pg";
import { z } from "zod";

import {
  AnalysisReportSchema,
  EntityIdSchema,
  ModelProvenanceSchema,
  Sha256Schema,
  SkillProvenanceSchema,
  type AnalysisReport,
  type SkillProvenance,
} from "../../../shared/agent-contracts";
import {
  KeywordAnalysisSnapshotRecordSchema,
  type KeywordAnalysisSnapshotRecord,
} from "../../data/keyword-analysis-snapshot";
import {
  TrafficDataSnapshotRecordSchema,
  type TrafficDataSnapshotRecord,
} from "../../data/traffic-data-snapshot";
import {
  VocDataSnapshotRecordSchema,
  assertVocDataSnapshotRecordIntegrity,
  deepFreeze,
  type VocDataSnapshotRecord,
} from "../../data/voc-data-snapshot";
import {
  ProductDefinitionOutputShapeSchema,
  assertProductDefinitionCapabilityLanguage,
  buildProductDefinitionInput,
  createProductDefinitionOutputSchema,
  type ProductDefinitionOutput,
} from "../../domain/product/product-definition-contracts";
import {
  TrafficAnalysisOutputSchema,
  assertTrafficCapabilityLanguage,
  canonicalizeTrafficAnalysisOutput,
  type TrafficAnalysisOutput,
} from "../../domain/traffic/traffic-analysis-contracts";
import { preprocessVocSnapshot } from "../../domain/voc/preprocess-voc-snapshot";
import {
  VocPositioningOutputShapeSchema,
  buildVocPositioningInput,
  type VocPositioningOutput,
} from "../../domain/voc/voc-positioning-contracts";
import {
  AmazonVocInsightOutputSchema,
  createAmazonVocInsightOutputSchema,
  type AmazonVocInsightOutput,
} from "../../domain/voc/amazon-voc-insight-contracts";
import {
  AnalysisReportConflictError,
  AnalysisReportDataError,
  AnalysisReportLeaseLostError,
  AnalysisReportSubjectNotFoundError,
  type AnalysisReportRepository,
  type FindAnalysisReportByIdInput,
  type ListAnalysisReportsInput,
  type PublishProductDefinitionReportInput,
  type PublishProductDefinitionReportResult,
  type PublishTrafficAnalysisReportInput,
  type PublishTrafficAnalysisReportResult,
  type PublishVocPositioningReportInput,
  type PublishVocPositioningReportResult,
  type VocPositioningReportOutput,
} from "../analysis-report-repository";
import { PostgresProductDependencyReconciler } from "./product-dependency-reconciler";
import { PostgresQueryContext } from "./query-context";
import {
  canonicalizeDateTime,
  mapDateTime,
  sameDateTimeInstant,
} from "./snapshot-subject";

interface ReportSubjectRow extends QueryResultRow {
  actor_organization_id: string;
  actor_status: string;
  project_organization_id: string;
  project_marketplace: string;
  project_asins_json: unknown;
  run_project_id: string;
  run_data_cutoff_at: Date | string;
  stage_run_id: string;
  stage: "traffic-analysis" | "voc-positioning" | "product-definition";
  job_stage_id: string;
  job_status: string;
  leased_by: string | null;
  lease_generation: number;
  lease_expires_at: Date | string | null;
  job_logical_execution_cycle_id: string;
  agent_run_run_id: string;
  agent_run_stage_id: string;
  agent_run_job_attempt_id: string;
  snapshot_ids_json: unknown;
  provider: string;
  model: string;
  response_id: string | null;
  output_schema_version: string;
  output_json: unknown | null;
  validation_status: string;
  terminal_status: string | null;
  logical_execution_lineage: string | null;
  logical_execution_cycle_id: string | null;
  skill_id: string;
  skill_version: string;
  skill_content_hash: string;
  transaction_now: Date | string;
}

interface AnalysisReportRow extends QueryResultRow {
  id: string;
  run_id: string;
  agent_run_id: string;
  version: number;
  stage: "traffic-analysis" | "voc-positioning" | "product-definition";
  schema_version: string;
  status: string;
  snapshot_ids_json: unknown;
  evidence_json: unknown;
  result_json: unknown;
  data_cutoff_at: Date | string;
  created_at: Date | string;
  skill_id: string;
  skill_version: string;
  skill_content_hash: string;
  provider: string;
  model: string;
  response_id: string | null;
}

interface SnapshotRow extends QueryResultRow {
  id: string;
  run_id: string;
  schema_version: string;
  marketplace: string;
  asins_json: unknown;
  data_cutoff_at: Date | string;
  sources_json: unknown;
  payload_json: unknown;
  content_hash: string;
  created_at: Date | string;
}

const analysisReportSelect = `
  SELECT report.*, skill.skill_id, skill.version AS skill_version,
         skill.content_hash AS skill_content_hash,
         agent.provider, agent.model, agent.response_id
    FROM analysis_reports report
    JOIN agent_runs agent ON agent.id = report.agent_run_id
    JOIN skill_versions skill ON skill.id = agent.skill_version_id
    JOIN analysis_runs run ON run.id = report.run_id
    JOIN projects project ON project.id = run.project_id`;

export interface PostgresAnalysisReportStoreOptions {
  readonly dependencyReconciler?: PostgresProductDependencyReconciler;
  readonly now?: () => string;
}

export class PostgresAnalysisReportStore
implements AnalysisReportRepository {
  readonly #queries: PostgresQueryContext;
  readonly #dependencyReconciler: PostgresProductDependencyReconciler;
  readonly #now?: () => string;

  constructor(
    queries: PostgresQueryContext,
    options: PostgresAnalysisReportStoreOptions = {},
  ) {
    this.#queries = queries;
    this.#dependencyReconciler =
      options.dependencyReconciler ??
      new PostgresProductDependencyReconciler(queries);
    this.#now = options.now;
  }

  publishVocPositioningReport(
    input: PublishVocPositioningReportInput,
  ): Promise<PublishVocPositioningReportResult> {
    return this.#execute(async () => {
      const validated = validatePublishVocPositioningReportInput(input);
      return await this.#queries.transaction(async () => {
        const subject = await this.#requireSubject(
          validated,
          "voc-positioning",
        );
        const stored = parseStoredAgentRun(subject, validated);
        if (!isDeepStrictEqual(stored.snapshotIds, [validated.snapshotId])) {
          throw new AnalysisReportConflictError();
        }

        const snapshot = await this.#requireVocSnapshot(
          validated.snapshotId,
          validated.runId,
        );
        const facts = preprocessVocSnapshot(snapshot);
        if (
          facts.factsDigest !== validated.factsDigest ||
          facts.snapshot.contentHash !==
            validated.result.positioningProjection.identity.contentHash ||
          !sameDateTimeInstant(
            mapDateTime(subject.run_data_cutoff_at),
            validated.result.positioningProjection.identity.dataCutoffAt,
          ) ||
          subject.project_marketplace !== facts.snapshot.marketplace ||
          !(snapshot.payload.evidenceSelection ? facts.snapshot.asins.every(asin => storedTextList(subject.project_asins_json)?.includes(asin)) : isDeepStrictEqual(storedTextList(subject.project_asins_json), facts.snapshot.asins))
        ) {
          throw new AnalysisReportConflictError();
        }
        const result = createAmazonVocInsightOutputSchema(
          buildVocPositioningInput(facts),
        ).safeParse(validated.result);
        if (!result.success) throw new AnalysisReportConflictError();
        if (!isDeepStrictEqual(stored.output, result.data)) {
          throw new AnalysisReportConflictError();
        }

        const existing = await this.#findByAgentRun(validated.agentRunId);
        if (existing) {
          if (
            samePublishedVocReport(existing, {
              ...validated,
              result: result.data,
              skill: stored.skill,
              model: stored.model,
            })
          ) {
            await this.#dependencyReconciler.reconcileProductDefinitionStage(
              validated.runId,
              validated.publishedAt,
            );
            return {
              report: existing as Readonly<AnalysisReport<AmazonVocInsightOutput>>,
              created: false,
            };
          }
          throw new AnalysisReportConflictError();
        }

        const report = await this.#insertReport({
          id: validated.id,
          runId: validated.runId,
          agentRunId: validated.agentRunId,
          stage: "voc-positioning",
          status: result.data.positioningProjection.status,
          snapshotIds: [validated.snapshotId],
          evidence: analysisReportEvidence(
            result.data.positioningProjection,
            facts,
          ),
          result: result.data,
          dataCutoffAt: result.data.positioningProjection.identity.dataCutoffAt,
          createdAt: validated.publishedAt,
        });
        await this.#dependencyReconciler.reconcileProductDefinitionStage(
          validated.runId,
          validated.publishedAt,
        );
        return {
          report: report as Readonly<AnalysisReport<AmazonVocInsightOutput>>,
          created: true,
        };
      });
    });
  }

  publishTrafficAnalysisReport(
    input: PublishTrafficAnalysisReportInput,
  ): Promise<PublishTrafficAnalysisReportResult> {
    return this.#execute(async () => {
      const validated = validatePublishTrafficAnalysisReportInput(input);
      return await this.#queries.transaction(async () => {
        const subject = await this.#requireSubject(
          validated,
          "traffic-analysis",
        );
        const stored = parseStoredAgentRun(subject, validated);
        if (!isDeepStrictEqual(stored.snapshotIds, [validated.snapshotId])) {
          throw new AnalysisReportConflictError();
        }
        const snapshot = await this.#requireTrafficSnapshot(
          validated.snapshotId,
          validated.runId,
          mapDateTime(subject.run_data_cutoff_at),
        );
        if (
          snapshot.marketplace !== subject.project_marketplace ||
          !isDeepStrictEqual(storedTextList(subject.project_asins_json), snapshot.asins)
        ) {
          throw new AnalysisReportConflictError();
        }
        let result: TrafficAnalysisOutput;
        try {
          result = canonicalizeTrafficAnalysisOutput(
            validated.result,
            snapshot.payload.input,
          );
        } catch {
          throw new AnalysisReportConflictError();
        }
        if (
          !isDeepStrictEqual(result, validated.result) ||
          !isDeepStrictEqual(stored.output, result)
        ) {
          throw new AnalysisReportConflictError();
        }
        assertTrafficCapabilityLanguage(result);

        const existing = await this.#findByAgentRun(validated.agentRunId);
        if (existing) {
          if (
            samePublishedTrafficReport(existing, {
              ...validated,
              result,
              skill: stored.skill,
              model: stored.model,
            })
          ) {
            return {
              report: existing as Readonly<AnalysisReport<TrafficAnalysisOutput>>,
              created: false,
            };
          }
          throw new AnalysisReportConflictError();
        }
        const report = await this.#insertReport({
          id: validated.id,
          runId: validated.runId,
          agentRunId: validated.agentRunId,
          stage: "traffic-analysis",
          status: result.status,
          snapshotIds: [validated.snapshotId],
          evidence: [{
            id: snapshot.id,
            type: "snapshot" as const,
            sourceId: "traffic-data-snapshot",
            capturedAt: snapshot.createdAt,
          }],
          result,
          dataCutoffAt: result.identity.dataCutoffAt,
          createdAt: validated.publishedAt,
        });
        return {
          report: report as Readonly<AnalysisReport<TrafficAnalysisOutput>>,
          created: true,
        };
      });
    });
  }

  publishProductDefinitionReport(
    input: PublishProductDefinitionReportInput,
  ): Promise<PublishProductDefinitionReportResult> {
    return this.#execute(async () => {
      const validated = validatePublishProductDefinitionReportInput(input);
      return await this.#queries.transaction(async () => {
        const subject = await this.#requireSubject(
          validated,
          "product-definition",
        );
        const stored = parseStoredAgentRun(subject, validated);
        const vocReport = await this.#requireVocReport(
          validated.vocReportId,
          validated.runId,
        );
        const keywordSnapshot = await this.#requireKeywordSnapshot(
          validated.keywordSnapshotId,
          validated.runId,
        );
        const vocSnapshot = await this.#requireVocSnapshot(vocReport.snapshotIds[0], validated.runId);
        if (
          !isDeepStrictEqual(vocSnapshot.asins, keywordSnapshot.asins) ||
          !isDeepStrictEqual(stored.snapshotIds, vocReport.snapshotIds) ||
          keywordSnapshot.marketplace !== "US" ||
          subject.project_marketplace !== keywordSnapshot.marketplace ||
          !(vocSnapshot.payload.evidenceSelection ? keywordSnapshot.asins.every(asin => storedTextList(subject.project_asins_json)?.includes(asin)) : isDeepStrictEqual(storedTextList(subject.project_asins_json), keywordSnapshot.asins)) ||
          !sameDateTimeInstant(
            mapDateTime(subject.run_data_cutoff_at),
            keywordSnapshot.dataCutoffAt,
          )
        ) {
          throw new AnalysisReportConflictError();
        }
        const productInput = buildProductDefinitionInput({
          evidenceSelection: vocSnapshot.payload.evidenceSelection,
          marketplace: "US",
          asins: keywordSnapshot.asins,
          dataCutoffAt: keywordSnapshot.dataCutoffAt,
          vocReport,
          keywordSnapshot,
        });
        const parsed = createProductDefinitionOutputSchema(productInput).safeParse(
          validated.result,
        );
        if (!parsed.success) throw new AnalysisReportConflictError();
        assertProductDefinitionCapabilityLanguage(parsed.data);
        if (!isDeepStrictEqual(stored.output, parsed.data)) {
          throw new AnalysisReportConflictError();
        }

        const existing = await this.#findByAgentRun(validated.agentRunId);
        if (existing) {
          if (
            samePublishedProductReport(
              existing,
              { ...validated, result: parsed.data, skill: stored.skill, model: stored.model },
              vocReport.snapshotIds,
            )
          ) {
            return {
              report: existing as Readonly<AnalysisReport<ProductDefinitionOutput>>,
              created: false,
            };
          }
          throw new AnalysisReportConflictError();
        }
        const report = await this.#insertReport({
          id: validated.id,
          runId: validated.runId,
          agentRunId: validated.agentRunId,
          stage: "product-definition",
          status: parsed.data.status,
          snapshotIds: [...vocReport.snapshotIds, keywordSnapshot.id],
          evidence: [
            {
              id: vocReport.id,
              type: "report" as const,
              sourceId: "voc-positioning-report",
              capturedAt: vocReport.createdAt,
            },
            {
              id: keywordSnapshot.id,
              type: "snapshot" as const,
              sourceId: "keyword-analysis-snapshot",
              capturedAt: keywordSnapshot.createdAt,
            },
          ],
          result: parsed.data,
          dataCutoffAt: parsed.data.identity.dataCutoffAt,
          createdAt: validated.publishedAt,
        });
        return {
          report: report as Readonly<AnalysisReport<ProductDefinitionOutput>>,
          created: true,
        };
      });
    });
  }

  listAnalysisReports(
    input: ListAnalysisReportsInput,
  ): Promise<ReadonlyArray<Readonly<AnalysisReport<VocPositioningReportOutput | TrafficAnalysisOutput | ProductDefinitionOutput>>>> {
    return this.#execute(async () => {
      const actorOrganizationId = EntityIdSchema.parse(input.actorOrganizationId);
      const runId = EntityIdSchema.parse(input.runId);
      const stage = parseReportStage(input.stage);
      const result = await this.#queries.query<AnalysisReportRow>(
        `${analysisReportSelect}
          WHERE report.run_id = $1 AND report.stage = $2
            AND project.organization_id = $3
          ORDER BY report.version, report.id`,
        [runId, stage, actorOrganizationId],
      );
      return result.rows.map(mapAnalysisReport);
    });
  }

  findAnalysisReportById(
    input: FindAnalysisReportByIdInput,
  ): Promise<Readonly<AnalysisReport<VocPositioningReportOutput | TrafficAnalysisOutput | ProductDefinitionOutput>> | null> {
    return this.#execute(async () => {
      const actorOrganizationId = EntityIdSchema.parse(input.actorOrganizationId);
      const reportId = EntityIdSchema.parse(input.reportId);
      const result = await this.#queries.query<AnalysisReportRow>(
        `${analysisReportSelect}
          WHERE report.id = $1 AND project.organization_id = $2`,
        [reportId, actorOrganizationId],
      );
      return result.rows[0] ? mapAnalysisReport(result.rows[0]) : null;
    });
  }

  async #requireSubject(
    input: PublishVocPositioningReportInput | PublishTrafficAnalysisReportInput | PublishProductDefinitionReportInput,
    expectedStage: "traffic-analysis" | "voc-positioning" | "product-definition",
  ): Promise<ReportSubjectRow> {
    const result = await this.#queries.query<ReportSubjectRow>(
      `SELECT actor.organization_id AS actor_organization_id,
              actor.status AS actor_status,
              project.organization_id AS project_organization_id,
              project.marketplace AS project_marketplace,
              project.asins_json AS project_asins_json,
              run.project_id AS run_project_id,
              run.data_cutoff_at AS run_data_cutoff_at,
              stage.run_id AS stage_run_id,
              stage.stage,
              job.stage_id AS job_stage_id,
              job.status AS job_status,
              job.leased_by,
              job.lease_generation,
              job.lease_expires_at,
              job.logical_execution_cycle_id AS job_logical_execution_cycle_id,
              agent.run_id AS agent_run_run_id,
              agent.stage_id AS agent_run_stage_id,
              agent.job_attempt_id AS agent_run_job_attempt_id,
              agent.snapshot_ids_json,
              agent.provider,
              agent.model,
              agent.response_id,
              agent.output_schema_version,
              agent.output_json,
              agent.validation_status,
              agent.terminal_status,
              agent.logical_execution_lineage,
              agent.logical_execution_cycle_id,
              skill.skill_id,
              skill.version AS skill_version,
              skill.content_hash AS skill_content_hash,
              CURRENT_TIMESTAMP AS transaction_now
         FROM users actor
         JOIN projects project ON project.id = $1
         JOIN analysis_runs run ON run.id = $2
         JOIN run_stages stage ON stage.id = $3
         JOIN job_attempts job ON job.id = $4
         JOIN agent_runs agent ON agent.id = $5
         JOIN skill_versions skill ON skill.id = agent.skill_version_id
        WHERE actor.id = $6
        FOR UPDATE OF actor, project, run, stage, job, agent`,
      [
        input.expectedProjectId,
        input.runId,
        input.stageId,
        input.jobAttemptId,
        input.agentRunId,
        input.actorId,
      ],
    );
    const subject = result.rows[0];
    if (
      !subject ||
      subject.actor_status !== "active" ||
      subject.actor_organization_id !== input.actorOrganizationId ||
      subject.project_organization_id !== input.actorOrganizationId ||
      subject.run_project_id !== input.expectedProjectId ||
      subject.stage_run_id !== input.runId ||
      subject.stage !== expectedStage ||
      subject.job_stage_id !== input.stageId ||
      subject.agent_run_run_id !== input.runId ||
      subject.agent_run_stage_id !== input.stageId
    ) {
      throw new AnalysisReportSubjectNotFoundError();
    }

    const transactionNow = this.#now
      ? canonicalizeDateTime(this.#now())
      : mapDateTime(subject.transaction_now);
    if (
      subject.job_status !== "running" ||
      subject.leased_by !== input.leaseOwnerId ||
      Number(subject.lease_generation) !== input.leaseGeneration ||
      subject.lease_expires_at === null ||
      mapDateTime(subject.lease_expires_at) <= transactionNow
    ) {
      throw new AnalysisReportLeaseLostError();
    }
    if (
      subject.validation_status !== "passed" ||
      subject.terminal_status !== "succeeded" ||
      subject.logical_execution_lineage !== input.logicalExecutionLineage ||
      subject.logical_execution_cycle_id !==
        subject.job_logical_execution_cycle_id ||
      subject.output_schema_version !== "1.0.0" ||
      subject.output_json === null
    ) {
      throw new AnalysisReportConflictError();
    }
    return subject;
  }

  async #requireVocSnapshot(
    snapshotId: string,
    runId: string,
  ): Promise<VocDataSnapshotRecord> {
    const result = await this.#queries.query<SnapshotRow>(
      `SELECT id, run_id, schema_version, marketplace, asins_json,
              data_cutoff_at, sources_json, payload_json, content_hash,
              created_at
         FROM data_snapshots
        WHERE id = $1 AND run_id = $2 AND snapshot_kind = 'voc'
        FOR UPDATE`,
      [snapshotId, runId],
    );
    if (!result.rows[0]) throw new AnalysisReportSubjectNotFoundError();
    return mapVocSnapshot(result.rows[0]);
  }

  async #requireTrafficSnapshot(
    snapshotId: string,
    runId: string,
    dataCutoffAt: string,
  ): Promise<TrafficDataSnapshotRecord> {
    const result = await this.#queries.query<SnapshotRow>(
      `SELECT id, run_id, schema_version, marketplace, asins_json,
              data_cutoff_at, sources_json, payload_json, content_hash,
              created_at
         FROM data_snapshots
        WHERE id = $1 AND run_id = $2 AND data_cutoff_at = $3
          AND artifact_kind = 'traffic' AND schema_version = '1.0.0'
        FOR UPDATE`,
      [snapshotId, runId, dataCutoffAt],
    );
    if (!result.rows[0]) throw new AnalysisReportSubjectNotFoundError();
    return mapTrafficSnapshot(result.rows[0]);
  }

  async #requireKeywordSnapshot(
    snapshotId: string,
    runId: string,
  ): Promise<KeywordAnalysisSnapshotRecord> {
    const result = await this.#queries.query<SnapshotRow>(
      `SELECT id, run_id, schema_version, marketplace, asins_json,
              data_cutoff_at, sources_json, payload_json, content_hash,
              created_at
         FROM keyword_analysis_snapshots
        WHERE id = $1 AND run_id = $2
        FOR UPDATE`,
      [snapshotId, runId],
    );
    if (!result.rows[0]) throw new AnalysisReportSubjectNotFoundError();
    return mapKeywordSnapshot(result.rows[0]);
  }

  async #requireVocReport(
    reportId: string,
    runId: string,
  ): Promise<AnalysisReport<VocPositioningReportOutput>> {
    const result = await this.#queries.query<AnalysisReportRow>(
      `${analysisReportSelect}
        WHERE report.id = $1 AND report.run_id = $2
          AND report.stage = 'voc-positioning'
          AND report.status IN ('complete', 'partial')
        FOR UPDATE OF report`,
      [reportId, runId],
    );
    if (!result.rows[0]) throw new AnalysisReportSubjectNotFoundError();
    return mapAnalysisReport(result.rows[0]) as AnalysisReport<VocPositioningReportOutput>;
  }

  async #findByAgentRun(
    agentRunId: string,
  ): Promise<AnalysisReport<VocPositioningReportOutput | TrafficAnalysisOutput | ProductDefinitionOutput> | null> {
    const result = await this.#queries.query<AnalysisReportRow>(
      `${analysisReportSelect}
        WHERE report.agent_run_id = $1
        FOR UPDATE OF report`,
      [agentRunId],
    );
    return result.rows[0] ? mapAnalysisReport(result.rows[0]) : null;
  }

  async #insertReport(input: {
    id: string;
    runId: string;
    agentRunId: string;
    stage: "traffic-analysis" | "voc-positioning" | "product-definition";
    status: "complete" | "partial" | "unavailable";
    snapshotIds: readonly string[];
    evidence: readonly Record<string, unknown>[];
    result: Record<string, unknown>;
    dataCutoffAt: string;
    createdAt: string;
  }): Promise<AnalysisReport<VocPositioningReportOutput | TrafficAnalysisOutput | ProductDefinitionOutput>> {
    const versionResult = await this.#queries.query<{ version: number }>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS version
         FROM analysis_reports
        WHERE run_id = $1 AND stage = $2`,
      [input.runId, input.stage],
    );
    const version = Number(versionResult.rows[0]?.version);
    if (!Number.isSafeInteger(version) || version <= 0) {
      throw new AnalysisReportDataError();
    }
    await this.#queries.query(
      `INSERT INTO analysis_reports (
         id, run_id, agent_run_id, version, stage, schema_version, status,
         snapshot_ids_json, evidence_json, result_json, data_cutoff_at,
         created_at
       ) VALUES (
         $1, $2, $3, $4, $5, '1.0.0', $6, $7::jsonb, $8::jsonb, $9::jsonb,
         $10, $11
       )`,
      [
        input.id,
        input.runId,
        input.agentRunId,
        version,
        input.stage,
        input.status,
        JSON.stringify(input.snapshotIds),
        JSON.stringify(input.evidence),
        JSON.stringify(input.result),
        input.dataCutoffAt,
        input.createdAt,
      ],
    );
    const created = await this.#queries.query<AnalysisReportRow>(
      `${analysisReportSelect} WHERE report.id = $1`,
      [input.id],
    );
    if (!created.rows[0]) throw new AnalysisReportDataError();
    return mapAnalysisReport(created.rows[0]);
  }

  async #execute<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof AnalysisReportConflictError ||
        error instanceof AnalysisReportDataError ||
        error instanceof AnalysisReportLeaseLostError ||
        error instanceof AnalysisReportSubjectNotFoundError ||
        error instanceof TypeError ||
        error instanceof z.ZodError
      ) {
        throw error;
      }
      const code = postgresErrorCode(error);
      if (code === "23503") throw new AnalysisReportSubjectNotFoundError();
      if (code === "23505") throw new AnalysisReportConflictError();
      throw new AnalysisReportDataError();
    }
  }
}

function validatePublishVocPositioningReportInput(
  input: PublishVocPositioningReportInput,
): PublishVocPositioningReportInput {
  return {
    ...input,
    id: EntityIdSchema.parse(input.id),
    actorId: EntityIdSchema.parse(input.actorId),
    actorOrganizationId: EntityIdSchema.parse(input.actorOrganizationId),
    expectedProjectId: EntityIdSchema.parse(input.expectedProjectId),
    runId: EntityIdSchema.parse(input.runId),
    stageId: EntityIdSchema.parse(input.stageId),
    jobAttemptId: EntityIdSchema.parse(input.jobAttemptId),
    agentRunId: EntityIdSchema.parse(input.agentRunId),
    snapshotId: EntityIdSchema.parse(input.snapshotId),
    factsDigest: Sha256Schema.parse(input.factsDigest),
    logicalExecutionLineage: Sha256Schema.parse(input.logicalExecutionLineage),
    skill: SkillProvenanceSchema.parse(input.skill),
    model: ModelProvenanceSchema.parse(input.model),
    leaseOwnerId: parseNonEmptyString(input.leaseOwnerId),
    leaseGeneration: parseLeaseGeneration(input.leaseGeneration),
    publishedAt: canonicalizeDateTime(input.publishedAt),
    result: AmazonVocInsightOutputSchema.parse(input.result),
  };
}

function validatePublishTrafficAnalysisReportInput(
  input: PublishTrafficAnalysisReportInput,
): PublishTrafficAnalysisReportInput {
  const result = TrafficAnalysisOutputSchema.parse(input.result);
  assertTrafficCapabilityLanguage(result);
  return {
    ...input,
    id: EntityIdSchema.parse(input.id),
    actorId: EntityIdSchema.parse(input.actorId),
    actorOrganizationId: EntityIdSchema.parse(input.actorOrganizationId),
    expectedProjectId: EntityIdSchema.parse(input.expectedProjectId),
    runId: EntityIdSchema.parse(input.runId),
    stageId: EntityIdSchema.parse(input.stageId),
    jobAttemptId: EntityIdSchema.parse(input.jobAttemptId),
    agentRunId: EntityIdSchema.parse(input.agentRunId),
    snapshotId: EntityIdSchema.parse(input.snapshotId),
    logicalExecutionLineage: Sha256Schema.parse(input.logicalExecutionLineage),
    skill: SkillProvenanceSchema.parse(input.skill),
    model: ModelProvenanceSchema.parse(input.model),
    leaseOwnerId: parseNonEmptyString(input.leaseOwnerId),
    leaseGeneration: parseLeaseGeneration(input.leaseGeneration),
    publishedAt: canonicalizeDateTime(input.publishedAt),
    result,
  };
}

function validatePublishProductDefinitionReportInput(
  input: PublishProductDefinitionReportInput,
): PublishProductDefinitionReportInput {
  const result = ProductDefinitionOutputShapeSchema.parse(input.result);
  assertProductDefinitionCapabilityLanguage(result);
  return {
    ...input,
    id: EntityIdSchema.parse(input.id),
    actorId: EntityIdSchema.parse(input.actorId),
    actorOrganizationId: EntityIdSchema.parse(input.actorOrganizationId),
    expectedProjectId: EntityIdSchema.parse(input.expectedProjectId),
    runId: EntityIdSchema.parse(input.runId),
    stageId: EntityIdSchema.parse(input.stageId),
    jobAttemptId: EntityIdSchema.parse(input.jobAttemptId),
    agentRunId: EntityIdSchema.parse(input.agentRunId),
    vocReportId: EntityIdSchema.parse(input.vocReportId),
    keywordSnapshotId: EntityIdSchema.parse(input.keywordSnapshotId),
    logicalExecutionLineage: Sha256Schema.parse(input.logicalExecutionLineage),
    skill: SkillProvenanceSchema.parse(input.skill),
    model: ModelProvenanceSchema.parse(input.model),
    leaseOwnerId: parseNonEmptyString(input.leaseOwnerId),
    leaseGeneration: parseLeaseGeneration(input.leaseGeneration),
    publishedAt: canonicalizeDateTime(input.publishedAt),
    result,
  };
}

function parseStoredAgentRun(
  subject: ReportSubjectRow,
  input: {
    skill: SkillProvenance;
    model: { provider: string; model: string; responseId?: string };
  },
) {
  const skill = SkillProvenanceSchema.parse({
    id: subject.skill_id,
    version: subject.skill_version,
    contentHash: subject.skill_content_hash,
  });
  const model = ModelProvenanceSchema.parse({
    provider: subject.provider,
    model: subject.model,
    ...(subject.response_id === null ? {} : { responseId: subject.response_id }),
  });
  if (
    !isDeepStrictEqual(skill, input.skill) ||
    !isDeepStrictEqual(model, input.model)
  ) {
    throw new AnalysisReportConflictError();
  }
  try {
    return {
      skill,
      model,
      snapshotIds: parseStoredJson(subject.snapshot_ids_json),
      output: parseStoredJson(subject.output_json),
    };
  } catch {
    throw new AnalysisReportDataError();
  }
}

function samePublishedVocReport(
  report: AnalysisReport<VocPositioningReportOutput | TrafficAnalysisOutput | ProductDefinitionOutput>,
  input: PublishVocPositioningReportInput,
) {
  return (
    report.runId === input.runId &&
    report.agentRunId === input.agentRunId &&
    report.stage === "voc-positioning" &&
    report.status === input.result.positioningProjection.status &&
    isDeepStrictEqual(report.skill, input.skill) &&
    isDeepStrictEqual(report.snapshotIds, [input.snapshotId]) &&
    isDeepStrictEqual(report.model, input.model) &&
    sameDateTimeInstant(
      report.dataCutoffAt,
      input.result.positioningProjection.identity.dataCutoffAt,
    ) &&
    isDeepStrictEqual(report.result, input.result)
  );
}

function samePublishedTrafficReport(
  report: AnalysisReport<VocPositioningReportOutput | TrafficAnalysisOutput | ProductDefinitionOutput>,
  input: PublishTrafficAnalysisReportInput,
) {
  return (
    report.runId === input.runId &&
    report.agentRunId === input.agentRunId &&
    report.stage === "traffic-analysis" &&
    report.status === input.result.status &&
    isDeepStrictEqual(report.skill, input.skill) &&
    isDeepStrictEqual(report.snapshotIds, [input.snapshotId]) &&
    isDeepStrictEqual(report.model, input.model) &&
    sameDateTimeInstant(report.dataCutoffAt, input.result.identity.dataCutoffAt) &&
    isDeepStrictEqual(report.result, input.result)
  );
}

function samePublishedProductReport(
  report: AnalysisReport<VocPositioningReportOutput | TrafficAnalysisOutput | ProductDefinitionOutput>,
  input: PublishProductDefinitionReportInput,
  vocSnapshotIds: readonly string[],
) {
  return (
    report.runId === input.runId &&
    report.agentRunId === input.agentRunId &&
    report.stage === "product-definition" &&
    report.status === input.result.status &&
    isDeepStrictEqual(report.skill, input.skill) &&
    isDeepStrictEqual(report.snapshotIds, [...vocSnapshotIds, input.keywordSnapshotId]) &&
    isDeepStrictEqual(report.model, input.model) &&
    sameDateTimeInstant(report.dataCutoffAt, input.result.identity.dataCutoffAt) &&
    isDeepStrictEqual(report.result, input.result)
  );
}

function analysisReportEvidence(
  result: VocPositioningOutput,
  facts: ReturnType<typeof preprocessVocSnapshot>,
) {
  const ids = new Set<string>();
  const add = (values: readonly string[]) => values.forEach((id) => ids.add(id));
  add(result.coreConclusion.evidenceIds);
  result.positioning.forEach((item) => add(item.evidenceIds));
  result.themeJudgments.forEach((item) => add(item.evidenceIds));
  result.actions.forEach((item) => add(item.evidenceIds));
  Object.values(result.checklists).forEach((list) =>
    list.forEach((item) => add(item.evidenceIds)),
  );
  result.nextValidations.forEach((item) => add(item.evidenceIds));
  const byId = new Map(facts.evidenceIndex.map((item) => [item.id, item]));
  return [...ids].sort().map((id) => {
    const evidence = byId.get(id);
    if (!evidence) throw new AnalysisReportConflictError();
    return {
      id,
      type: "theme" as const,
      sourceId: evidence.sourceId,
      capturedAt: evidence.capturedAt,
    };
  });
}

function mapAnalysisReport(
  row: AnalysisReportRow,
): Readonly<AnalysisReport<VocPositioningReportOutput | TrafficAnalysisOutput | ProductDefinitionOutput>> {
  try {
    const resultJson = parseStoredJson(row.result_json);
    const result = row.stage === "traffic-analysis"
      ? TrafficAnalysisOutputSchema.parse(resultJson)
      : row.stage === "product-definition"
        ? ProductDefinitionOutputShapeSchema.parse(resultJson)
        : parseStoredVocPositioningReport(resultJson);
    if (row.stage === "traffic-analysis") assertTrafficCapabilityLanguage(result);
    if (row.stage === "product-definition") {
      assertProductDefinitionCapabilityLanguage(result);
    }
    const report = AnalysisReportSchema.parse({
      schemaVersion: row.schema_version,
      id: row.id,
      runId: row.run_id,
      agentRunId: row.agent_run_id,
      version: Number(row.version),
      stage: row.stage,
      status: row.status,
      skill: {
        id: row.skill_id,
        version: row.skill_version,
        contentHash: row.skill_content_hash,
      },
      snapshotIds: parseStoredJson(row.snapshot_ids_json),
      model: {
        provider: row.provider,
        model: row.model,
        ...(row.response_id === null ? {} : { responseId: row.response_id }),
      },
      dataCutoffAt: mapDateTime(row.data_cutoff_at),
      evidence: parseStoredJson(row.evidence_json),
      result,
      createdAt: mapDateTime(row.created_at),
    });
    return deepFreeze({ ...report, result });
  } catch {
    throw new AnalysisReportDataError();
  }
}

function parseStoredVocPositioningReport(value: unknown): VocPositioningReportOutput {
  const combined = AmazonVocInsightOutputSchema.safeParse(value);
  if (combined.success) return combined.data;
  return VocPositioningOutputShapeSchema.parse(value);
}

function mapVocSnapshot(row: SnapshotRow): VocDataSnapshotRecord {
  try {
    const snapshot = VocDataSnapshotRecordSchema.parse({
      schemaVersion: row.schema_version,
      id: row.id,
      runId: row.run_id,
      marketplace: row.marketplace,
      asins: row.asins_json,
      dataCutoffAt: mapDateTime(row.data_cutoff_at),
      sources: row.sources_json,
      payload: row.payload_json,
      contentHash: row.content_hash,
      createdAt: mapDateTime(row.created_at),
    });
    assertVocDataSnapshotRecordIntegrity(snapshot);
    return deepFreeze(snapshot);
  } catch {
    throw new AnalysisReportDataError();
  }
}

function mapTrafficSnapshot(row: SnapshotRow): TrafficDataSnapshotRecord {
  try {
    return deepFreeze(TrafficDataSnapshotRecordSchema.parse({
      kind: "traffic",
      schemaVersion: row.schema_version,
      id: row.id,
      runId: row.run_id,
      marketplace: row.marketplace,
      asins: row.asins_json,
      dataCutoffAt: mapDateTime(row.data_cutoff_at),
      sources: row.sources_json,
      payload: row.payload_json,
      contentHash: row.content_hash,
      createdAt: mapDateTime(row.created_at),
    }));
  } catch {
    throw new AnalysisReportDataError();
  }
}

function mapKeywordSnapshot(row: SnapshotRow): KeywordAnalysisSnapshotRecord {
  try {
    return deepFreeze(KeywordAnalysisSnapshotRecordSchema.parse({
      kind: "keyword-analysis",
      schemaVersion: row.schema_version,
      id: row.id,
      runId: row.run_id,
      marketplace: row.marketplace,
      asins: row.asins_json,
      dataCutoffAt: mapDateTime(row.data_cutoff_at),
      sources: row.sources_json,
      payload: row.payload_json,
      contentHash: row.content_hash,
      createdAt: mapDateTime(row.created_at),
    }));
  } catch {
    throw new AnalysisReportDataError();
  }
}

function parseStoredJson(value: unknown): unknown {
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

function storedTextList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((item) => (typeof item === "string" ? item : ""));
}

function parseReportStage(value: string) {
  if (
    value !== "voc-positioning" &&
    value !== "traffic-analysis" &&
    value !== "product-definition"
  ) {
    throw new TypeError("Invalid analysis report stage");
  }
  return value;
}

function parseNonEmptyString(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("Invalid analysis report lease owner");
  }
  return value;
}

function parseLeaseGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("Invalid analysis report lease generation");
  }
  return value;
}

function postgresErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}
