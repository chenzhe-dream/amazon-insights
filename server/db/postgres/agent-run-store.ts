import { isDeepStrictEqual } from "node:util";

import type { QueryResultRow } from "pg";
import { ZodError } from "zod";

import {
  AgentRunAttemptSchema,
  AgentRunAuditSchema,
  type AgentRunAudit,
  EntityIdSchema,
} from "../../../shared/agent-contracts";
import { SkillManifestSchema } from "../../skills/manifest";
import {
  AgentRunClaimLostError,
  AgentRunConflictError,
  AgentRunDataError,
  AgentRunLeaseLostError,
  AgentRunSubjectNotFoundError,
  type AgentRunRepository,
  type AgentRunUsageSummary,
  type AssertAgentRunClaimInput,
  type BeginAgentRunInput,
  type BeginAgentRunResult,
  type FinalizeAgentRunInput,
  type FinalizeAgentRunResult,
  type JobAttemptModelUsage,
  type JobAttemptModelUsageInput,
  type ListAgentRunsInput,
  type RegisterSkillVersionInput,
  type SkillVersionRecord,
  SkillVersionConflictError,
} from "../agent-run-repository";
import { PostgresQueryContext } from "./query-context";

interface AgentRunRow extends QueryResultRow {
  id: string;
  run_id: string;
  stage_id: string;
  job_attempt_id: string;
  skill_version_id: string;
  schema_version: string;
  snapshot_ids_json: unknown;
  provider: string;
  model: string;
  response_id: string | null;
  input_summary_json: unknown;
  output_schema_version: string;
  output_json: unknown | null;
  validation_status: "pending" | "passed" | "failed";
  input_tokens: string | number | null;
  output_tokens: string | number | null;
  duration_ms: string | number | null;
  estimated_cost_micros: string | number | null;
  error_json: unknown | null;
  data_cutoff_at: Date | string;
  started_at: Date | string;
  completed_at: Date | string | null;
  execution_fingerprint: string;
  output_schema_digest: string;
  logical_execution_lineage: string | null;
  logical_execution_cycle_id: string | null;
  active_job_attempt_id: string | null;
  terminal_status: string | null;
  usage_completeness: string | null;
  attempt_count: string | number | null;
  attempts_json: unknown;
  execution_claim_token: string;
  execution_claim_owner_id: string;
  execution_claim_generation: number;
  execution_claim_acquired_at: Date | string;
  execution_claim_expires_at: Date | string;
  terminal_metadata_json: unknown | null;
  stage: AgentRunAudit["stage"];
  skill_id: string;
  skill_version: string;
  skill_content_hash: string;
  organization_id: string;
}

interface SkillVersionRow extends QueryResultRow {
  id: string;
  skill_id: string;
  version: string;
  content_hash: string;
  manifest_json: unknown;
  created_at: Date | string;
}

interface ModelAttemptRow extends QueryResultRow {
  state: "dispatched" | "settled";
  projected_input_tokens: string | number;
  projected_output_tokens: string | number;
  projected_cost_micros: string | number;
  actual_input_tokens: string | number | null;
  actual_output_tokens: string | number | null;
  actual_cost_micros: string | number | null;
  request_ordinal: number;
  attempt_kind: "initial" | "transient-retry" | "format-repair";
  transient_retry_count: number;
  format_repair: boolean;
  response_id: string | null;
}

const sha256Pattern = /^[0-9a-f]{64}$/;
const agentRunSelect = `
  SELECT ar.*, rs.stage AS stage, skill.skill_id AS skill_id,
         skill.version AS skill_version,
         skill.content_hash AS skill_content_hash,
         project.organization_id AS organization_id
    FROM agent_runs ar
    JOIN run_stages rs ON rs.id = ar.stage_id
    JOIN skill_versions skill ON skill.id = ar.skill_version_id
    JOIN analysis_runs run ON run.id = ar.run_id
    JOIN projects project ON project.id = run.project_id`;

export class PostgresAgentRunStore implements AgentRunRepository {
  readonly #queries: PostgresQueryContext;

  constructor(queries: PostgresQueryContext) {
    this.#queries = queries;
  }

  registerSkillVersion(
    input: RegisterSkillVersionInput,
  ): Promise<SkillVersionRecord> {
    return this.#execute(
      async () => {
        const validated = validateSkillVersionInput(input);
        return await this.#queries.transaction(async () => {
          await this.#queries.query(
            "LOCK TABLE skill_versions IN SHARE ROW EXCLUSIVE MODE",
          );
          const existing = await this.#queries.query<SkillVersionRow>(
            `SELECT id, skill_id, version, content_hash, manifest_json, created_at
               FROM skill_versions WHERE skill_id = $1 AND version = $2`,
            [validated.skillId, validated.version],
          );
          if (existing.rows[0]) {
            const record = mapSkillVersion(existing.rows[0]);
            if (sameSkillVersion(record, validated)) return record;
            throw new SkillVersionConflictError();
          }
          const contentOwner = await this.#queries.query(
            `SELECT 1 FROM skill_versions
              WHERE skill_id = $1 AND content_hash = $2`,
            [validated.skillId, validated.contentHash],
          );
          if (contentOwner.rowCount) throw new SkillVersionConflictError();
          await this.#queries.query(
            `INSERT INTO skill_versions
               (id, skill_id, version, content_hash, manifest_json, created_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
            [
              validated.id,
              validated.skillId,
              validated.version,
              validated.contentHash,
              JSON.stringify(validated.manifest),
              validated.createdAt,
            ],
          );
          return validated;
        });
      },
      () => new SkillVersionConflictError(),
    );
  }

  beginAgentRun(input: BeginAgentRunInput): Promise<BeginAgentRunResult> {
    return this.#execute(
      async () => {
        const validated = validateBeginAgentRunInput(input);
        return await this.#queries.transaction(async () => {
          const subjectResult = await this.#queries.query<
            QueryResultRow & {
              id: string;
              status: string;
              leased_by: string | null;
              lease_expires_at: Date | string | null;
              lease_generation: number;
              stage_id: string;
              run_id: string;
              logical_execution_cycle_id: string;
              organization_id: string;
              data_cutoff_at: Date | string;
            }
          >(
            `SELECT attempt.id, attempt.status, attempt.leased_by,
                    attempt.lease_expires_at, attempt.lease_generation,
                    attempt.stage_id, stage.run_id,
                    attempt.logical_execution_cycle_id,
                    project.organization_id, run.data_cutoff_at
               FROM job_attempts attempt
               JOIN run_stages stage ON stage.id = attempt.stage_id
               JOIN analysis_runs run ON run.id = stage.run_id
               JOIN projects project ON project.id = run.project_id
              WHERE attempt.id = $1 AND attempt.stage_id = $2
                AND stage.run_id = $3 AND project.organization_id = $4
              FOR UPDATE OF attempt`,
            [
              validated.jobAttemptId,
              validated.stageId,
              validated.runId,
              validated.organizationId,
            ],
          );
          const subject = subjectResult.rows[0];
          if (!subject) throw new AgentRunSubjectNotFoundError();
          const storedCutoffAt = mapTimestamp(subject.data_cutoff_at);
          if (
            subject.status !== "running" ||
            subject.leased_by !== validated.leaseOwnerId ||
            subject.lease_generation !== validated.leaseGeneration ||
            subject.lease_expires_at === null ||
            mapTimestamp(subject.lease_expires_at) <= validated.claimAcquiredAt
          ) {
            throw new AgentRunLeaseLostError();
          }
          if (
            validated.logicalExecutionLineage &&
            subject.logical_execution_cycle_id !==
              validated.logicalExecutionCycleId
          ) {
            throw new AgentRunConflictError();
          }

          const skill = await this.#queries.query(
            "SELECT 1 FROM skill_versions WHERE id = $1",
            [validated.skillVersionId],
          );
          if (skill.rowCount !== 1) throw new AgentRunSubjectNotFoundError();

          const snapshots = await this.#queries.query<
            QueryResultRow & {
              id: string;
              run_id: string;
              data_cutoff_at: Date | string;
            }
          >(
            `SELECT id, run_id, data_cutoff_at FROM data_snapshots
              WHERE id = ANY($1::text[])`,
            [[...validated.snapshotIds]],
          );
          if (
            snapshots.rows.length !== validated.snapshotIds.length ||
            snapshots.rows.some(({ run_id }) => run_id !== validated.runId)
          ) {
            throw new AgentRunSubjectNotFoundError();
          }
          const cutoffMatches =
            sameDateTimeInstant(storedCutoffAt, validated.dataCutoffAt) &&
            snapshots.rows.every(({ data_cutoff_at }) =>
              sameDateTimeInstant(
                mapTimestamp(data_cutoff_at),
                validated.dataCutoffAt,
              ),
            );

          if (validated.logicalExecutionLineage) {
            const predecessorResult = await this.#queries.query<AgentRunRow>(
              `${agentRunSelect}
                WHERE ar.stage_id = $1
                  AND ar.logical_execution_cycle_id = $2
                  AND ar.execution_fingerprint = $3
                  AND ar.schema_version = '1.1.0'
                  AND ar.execution_fingerprint IS NOT NULL
                  AND ar.output_schema_digest IS NOT NULL
                FOR UPDATE OF ar`,
              [
                validated.stageId,
                validated.logicalExecutionCycleId,
                validated.executionFingerprint,
              ],
            );
            const predecessor = predecessorResult.rows[0];
            if (predecessor) {
              const record = await this.#mapAgentRun(predecessor);
              if (!sameAgentRunLogicalIdentity(record, predecessor, validated)) {
                throw new AgentRunConflictError();
              }
              if (record.jobAttemptId !== validated.jobAttemptId) {
                if (record.validationStatus === "pending") {
                  return await this.#recoverPendingAgentRun(
                    predecessor,
                    record,
                    validated,
                  );
                }
                if (
                  record.validationStatus !== "passed" ||
                  record.status !== "succeeded"
                ) {
                  throw new AgentRunConflictError();
                }
                return { record, created: false, claimStatus: "terminal" };
              }
            } else {
              const lineageOwner = await this.#queries.query(
                `SELECT 1 FROM agent_runs
                  WHERE logical_execution_lineage = $1`,
                [validated.logicalExecutionLineage],
              );
              if (lineageOwner.rowCount) throw new AgentRunConflictError();
            }
          }

          const existingResult = await this.#queries.query<AgentRunRow>(
            `${agentRunSelect}
              WHERE ar.job_attempt_id = $1
                AND ar.execution_fingerprint = $2
                AND ar.schema_version = '1.1.0'
                AND ar.execution_fingerprint IS NOT NULL
                AND ar.output_schema_digest IS NOT NULL
              FOR UPDATE OF ar`,
            [validated.jobAttemptId, validated.executionFingerprint],
          );
          const existing = existingResult.rows[0];
          if (existing) {
            const record = await this.#mapAgentRun(existing);
            if (!sameAgentRunBeginIdentity(record, existing, validated)) {
              throw new AgentRunConflictError();
            }
            if (record.validationStatus !== "pending") {
              return { record, created: false, claimStatus: "terminal" };
            }
            if (existing.execution_claim_token === validated.claimToken) {
              return { record, created: false, claimStatus: "acquired" };
            }
            if (
              existing.execution_claim_owner_id === validated.leaseOwnerId &&
              existing.execution_claim_generation === validated.leaseGeneration
            ) {
              return { record, created: false, claimStatus: "observing" };
            }
            const rotated = await this.#queries.query(
              `UPDATE agent_runs
                  SET execution_claim_token = $1,
                      execution_claim_owner_id = $2,
                      execution_claim_generation = $3,
                      execution_claim_acquired_at = $4,
                      execution_claim_expires_at = $5
                WHERE id = $6 AND validation_status = 'pending'
                  AND execution_claim_token = $7`,
              [
                validated.claimToken,
                validated.leaseOwnerId,
                validated.leaseGeneration,
                validated.claimAcquiredAt,
                validated.claimExpiresAt,
                record.id,
                existing.execution_claim_token,
              ],
            );
            if (rotated.rowCount !== 1) throw new AgentRunClaimLostError();
            return {
              record: await this.#requireAgentRun(record.id),
              created: false,
              claimStatus: "acquired",
            };
          }
          if (!cutoffMatches) throw new AgentRunSubjectNotFoundError();

          await this.#queries.query(
            `INSERT INTO agent_runs (
               id, run_id, stage_id, job_attempt_id, skill_version_id,
               schema_version, snapshot_ids_json, provider, model, response_id,
               input_summary_json, output_schema_version, output_json,
               validation_status, input_tokens, output_tokens, duration_ms,
               estimated_cost_micros, error_json, data_cutoff_at, started_at,
               completed_at, execution_fingerprint, output_schema_digest,
               logical_execution_lineage, logical_execution_cycle_id,
               active_job_attempt_id, terminal_status, usage_completeness,
               attempt_count, attempts_json, execution_claim_token,
               execution_claim_owner_id, execution_claim_generation,
               execution_claim_acquired_at, execution_claim_expires_at,
               terminal_metadata_json
             ) VALUES (
               $1, $2, $3, $4, $5, '1.1.0', $6::jsonb, $7, $8, NULL,
               $9::jsonb, $10, NULL, 'pending', NULL, NULL, NULL, NULL, NULL,
               $11, $12, NULL, $13, $14, $15, $16, $17, NULL, NULL, NULL,
               '[]'::jsonb, $18, $19, $20, $21, $22, NULL
             )`,
            [
              validated.id,
              validated.runId,
              validated.stageId,
              validated.jobAttemptId,
              validated.skillVersionId,
              JSON.stringify(validated.snapshotIds),
              validated.provider,
              validated.model,
              JSON.stringify(validated.inputSummary),
              validated.outputSchemaVersion,
              storedCutoffAt,
              validated.startedAt,
              validated.executionFingerprint,
              validated.outputSchemaDigest,
              validated.logicalExecutionLineage ?? null,
              validated.logicalExecutionCycleId ?? null,
              validated.logicalExecutionLineage
                ? validated.jobAttemptId
                : null,
              validated.claimToken,
              validated.leaseOwnerId,
              validated.leaseGeneration,
              validated.claimAcquiredAt,
              validated.claimExpiresAt,
            ],
          );
          for (const [ordinal, snapshotId] of validated.snapshotIds.entries()) {
            await this.#queries.query(
              `INSERT INTO agent_run_snapshots
                 (agent_run_id, snapshot_id, ordinal)
               VALUES ($1, $2, $3)`,
              [validated.id, snapshotId, ordinal],
            );
          }
          return {
            record: await this.#requireAgentRun(validated.id),
            created: true,
            claimStatus: "acquired",
          };
        });
      },
      () => new AgentRunConflictError(),
    );
  }

  assertAgentRunClaim(input: AssertAgentRunClaimInput): Promise<void> {
    return this.#execute(async () => {
      validateAssertAgentRunClaimInput(input);
      const result = await this.#queries.query<
        QueryResultRow & {
          validation_status: string;
          execution_claim_token: string;
          status: string;
          leased_by: string | null;
          lease_generation: number;
          lease_expires_at: Date | string | null;
        }
      >(
        `SELECT ar.validation_status, ar.execution_claim_token,
                attempt.status, attempt.leased_by, attempt.lease_generation,
                attempt.lease_expires_at
           FROM agent_runs ar
           JOIN job_attempts attempt
             ON attempt.id = COALESCE(ar.active_job_attempt_id, ar.job_attempt_id)
           JOIN run_stages stage ON stage.id = attempt.stage_id
           JOIN analysis_runs run ON run.id = stage.run_id
           JOIN projects project ON project.id = run.project_id
          WHERE ar.id = $1
            AND COALESCE(ar.active_job_attempt_id, ar.job_attempt_id) = $2
            AND project.organization_id = $3`,
        [input.agentRunId, input.jobAttemptId, input.organizationId],
      );
      const row = result.rows[0];
      if (!row) throw new AgentRunSubjectNotFoundError();
      if (
        row.validation_status !== "pending" ||
        row.execution_claim_token !== input.claimToken
      ) {
        throw new AgentRunClaimLostError();
      }
      if (
        row.status !== "running" ||
        row.leased_by !== input.leaseOwnerId ||
        row.lease_generation !== input.leaseGeneration ||
        row.lease_expires_at === null ||
        mapTimestamp(row.lease_expires_at) <= input.asOf
      ) {
        throw new AgentRunLeaseLostError();
      }
    });
  }

  finalizeAgentRun(
    input: FinalizeAgentRunInput,
  ): Promise<FinalizeAgentRunResult> {
    return this.#execute(async () => {
      validateFinalizeAgentRunInput(input);
      return await this.#queries.transaction(async () => {
        const currentResult = await this.#queries.query<AgentRunRow>(
          `${agentRunSelect}
            WHERE ar.id = $1 AND project.organization_id = $2
            FOR UPDATE OF ar`,
          [input.agentRunId, input.organizationId],
        );
        const currentRow = currentResult.rows[0];
        if (!currentRow) throw new AgentRunSubjectNotFoundError();
        const current = await this.#mapAgentRun(currentRow);
        const candidate = finalizedAgentRun(current, input);
        if (current.validationStatus !== "pending") {
          if (isDeepStrictEqual(current, candidate)) {
            return { record: current, transitioned: false };
          }
          throw new AgentRunConflictError();
        }
        const outcome = input.outcome;
        const update = await this.#queries.query(
          `UPDATE agent_runs
              SET terminal_status = $1, response_id = $2,
                  output_json = $3::jsonb, validation_status = $4,
                  input_tokens = $5, output_tokens = $6, duration_ms = $7,
                  estimated_cost_micros = $8, error_json = $9::jsonb,
                  completed_at = $10, usage_completeness = $11,
                  attempt_count = $12, attempts_json = $13::jsonb,
                  terminal_metadata_json = $14::jsonb
            WHERE id = $15 AND validation_status = 'pending'
              AND execution_claim_token = $16
              AND EXISTS (
                SELECT 1 FROM job_attempts attempt
                 WHERE attempt.id = COALESCE(
                   agent_runs.active_job_attempt_id,
                   agent_runs.job_attempt_id
                 )
                   AND attempt.status = 'running'
                   AND attempt.leased_by = $17
                   AND attempt.lease_generation = $18
                   AND attempt.lease_expires_at > $10
              )`,
          [
            outcome.terminalStatus,
            outcome.responseId,
            outcome.output === null ? null : JSON.stringify(outcome.output),
            outcome.validationStatus,
            outcome.inputTokens,
            outcome.outputTokens,
            outcome.durationMs,
            outcome.estimatedCostMicros,
            outcome.error === null ? null : JSON.stringify(outcome.error),
            input.completedAt,
            outcome.usageCompleteness,
            outcome.attemptCount,
            JSON.stringify(outcome.attempts),
            JSON.stringify(outcome.terminalMetadata),
            input.agentRunId,
            input.claimToken,
            input.leaseOwnerId,
            input.leaseGeneration,
          ],
        );
        if (update.rowCount !== 1) {
          const raced = await this.#requireAgentRunRow(input.agentRunId);
          const record = await this.#mapAgentRun(raced);
          if (
            record.validationStatus !== "pending" &&
            isDeepStrictEqual(record, candidate)
          ) {
            return { record, transitioned: false };
          }
          if (record.validationStatus !== "pending") {
            throw new AgentRunConflictError();
          }
          if (raced.execution_claim_token !== input.claimToken) {
            throw new AgentRunClaimLostError();
          }
          throw new AgentRunLeaseLostError();
        }
        return {
          record: await this.#requireAgentRun(input.agentRunId),
          transitioned: true,
        };
      });
    });
  }

  listAgentRuns(input: ListAgentRunsInput): Promise<AgentRunAudit[]> {
    return this.#execute(async () => {
      validateListAgentRunsInput(input);
      const result = await this.#queries.query<AgentRunRow>(
        `${agentRunSelect}
          WHERE ar.run_id = $1 AND project.organization_id = $2
            AND ar.schema_version = '1.1.0'
            AND ar.execution_fingerprint IS NOT NULL
            AND ar.output_schema_digest IS NOT NULL
          ORDER BY ar.started_at, ar.id`,
        [input.runId, input.organizationId],
      );
      return await Promise.all(result.rows.map((row) => this.#mapAgentRun(row)));
    });
  }

  async getAgentRunUsage(
    input: ListAgentRunsInput,
  ): Promise<AgentRunUsageSummary> {
    const records = await this.listAgentRuns(input);
    const known = records.filter(
      (record) =>
        record.inputTokens !== null &&
        record.outputTokens !== null &&
        record.estimatedCostMicros !== null,
    );
    const usageCompleteness =
      known.length === 0
        ? "unavailable"
        : known.length === records.length &&
            records.every((record) => record.usageCompleteness === "complete")
          ? "complete"
          : "partial";
    return {
      usageCompleteness,
      inputTokens: sumNullableSafeIntegers(
        known.map((record) => record.inputTokens),
      ),
      outputTokens: sumNullableSafeIntegers(
        known.map((record) => record.outputTokens),
      ),
      estimatedCostMicros: sumNullableSafeIntegers(
        known.map((record) => record.estimatedCostMicros),
      ),
      durationMs: sumNullableSafeIntegers(
        records.map((record) => record.durationMs),
      ),
      attemptCount: sumNullableSafeIntegers(
        records.map((record) => record.attemptCount),
      ),
      agentRunCount: records.length,
    };
  }

  getJobAttemptModelUsage(
    input: JobAttemptModelUsageInput,
  ): Promise<JobAttemptModelUsage> {
    return this.#execute(async () => {
      validateJobAttemptModelUsageInput(input);
      const result = await this.#queries.query<ModelAttemptRow>(
        `SELECT reservation.state, reservation.projected_input_tokens,
                reservation.projected_output_tokens,
                reservation.projected_cost_micros,
                reservation.actual_input_tokens,
                reservation.actual_output_tokens,
                reservation.actual_cost_micros, reservation.request_ordinal,
                reservation.attempt_kind, reservation.transient_retry_count,
                reservation.format_repair, reservation.response_id
           FROM model_budget_reservations reservation
           JOIN agent_runs agent_run ON agent_run.id = reservation.agent_run_id
           JOIN job_attempts attempt ON attempt.id = agent_run.job_attempt_id
           JOIN run_stages stage ON stage.id = attempt.stage_id
           JOIN analysis_runs run ON run.id = stage.run_id
           JOIN projects project ON project.id = run.project_id
          WHERE reservation.agent_run_id = $1
            AND agent_run.job_attempt_id = $2
            AND reservation.run_id = $3
            AND project.organization_id = $4
            AND reservation.state IN ('dispatched', 'settled')
          ORDER BY reservation.request_ordinal`,
        [
          input.agentRunId,
          input.jobAttemptId,
          input.runId,
          input.organizationId,
        ],
      );
      if (result.rows.length === 0) {
        return {
          usageCompleteness: "unavailable",
          inputTokens: null,
          outputTokens: null,
          estimatedCostMicros: null,
          responseId: null,
          attempts: [],
        };
      }
      let inputTokens = BigInt(0);
      let outputTokens = BigInt(0);
      let estimatedCostMicros = BigInt(0);
      const attempts = result.rows.map((row, index) => {
        const settled = row.state === "settled";
        const inputValue = safeStoredInteger(
          settled ? row.actual_input_tokens : row.projected_input_tokens,
        );
        const outputValue = safeStoredInteger(
          settled ? row.actual_output_tokens : row.projected_output_tokens,
        );
        const costValue = safeStoredInteger(
          settled ? row.actual_cost_micros : row.projected_cost_micros,
        );
        if (row.request_ordinal !== index) throw new AgentRunDataError();
        inputTokens += BigInt(inputValue);
        outputTokens += BigInt(outputValue);
        estimatedCostMicros += BigInt(costValue);
        return AgentRunAttemptSchema.parse({
          ordinal: row.request_ordinal,
          kind: row.attempt_kind,
          transientRetryCount: row.transient_retry_count,
          formatRepair: row.format_repair,
          accounting: settled ? "settled" : "projected",
          errorClassification: "unavailable",
        });
      });
      assertSafeAggregate(inputTokens);
      assertSafeAggregate(outputTokens);
      assertSafeAggregate(estimatedCostMicros);
      return {
        usageCompleteness: result.rows.every(({ state }) => state === "settled")
          ? "complete"
          : "partial",
        inputTokens: Number(inputTokens),
        outputTokens: Number(outputTokens),
        estimatedCostMicros: Number(estimatedCostMicros),
        responseId: result.rows.reduce<string | null>((latest, row) => {
          if (row.response_id === null) return latest;
          if (
            row.response_id.trim().length === 0 ||
            row.response_id.length > 500
          ) {
            throw new AgentRunDataError();
          }
          return row.response_id;
        }, null),
        attempts,
      };
    });
  }

  async #recoverPendingAgentRun(
    predecessor: AgentRunRow,
    record: AgentRunAudit,
    validated: BeginAgentRunInput,
  ): Promise<BeginAgentRunResult> {
    const activeJobAttemptId = predecessor.active_job_attempt_id;
    if (
      activeJobAttemptId === validated.jobAttemptId &&
      predecessor.execution_claim_token === validated.claimToken
    ) {
      return { record, created: false, claimStatus: "acquired" };
    }
    if (
      activeJobAttemptId === validated.jobAttemptId &&
      predecessor.execution_claim_owner_id === validated.leaseOwnerId &&
      predecessor.execution_claim_generation === validated.leaseGeneration
    ) {
      return { record, created: false, claimStatus: "observing" };
    }
    const rotated = await this.#queries.query(
      `UPDATE agent_runs
          SET active_job_attempt_id = $1, execution_claim_token = $2,
              execution_claim_owner_id = $3,
              execution_claim_generation = $4,
              execution_claim_acquired_at = $5,
              execution_claim_expires_at = $6
        WHERE id = $7 AND validation_status = 'pending'
          AND execution_claim_token = $8`,
      [
        validated.jobAttemptId,
        validated.claimToken,
        validated.leaseOwnerId,
        validated.leaseGeneration,
        validated.claimAcquiredAt,
        validated.claimExpiresAt,
        record.id,
        predecessor.execution_claim_token,
      ],
    );
    if (rotated.rowCount !== 1) throw new AgentRunClaimLostError();
    return {
      record: await this.#requireAgentRun(record.id),
      created: false,
      claimStatus: "acquired",
    };
  }

  async #requireAgentRun(id: string) {
    return await this.#mapAgentRun(await this.#requireAgentRunRow(id));
  }

  async #requireAgentRunRow(id: string) {
    const result = await this.#queries.query<AgentRunRow>(
      `${agentRunSelect} WHERE ar.id = $1`,
      [id],
    );
    if (!result.rows[0]) throw new AgentRunDataError();
    return result.rows[0];
  }

  async #mapAgentRun(row: AgentRunRow): Promise<AgentRunAudit> {
    try {
      const links = await this.#queries.query<
        QueryResultRow & { snapshot_id: string }
      >(
        `SELECT snapshot_id FROM agent_run_snapshots
          WHERE agent_run_id = $1 ORDER BY ordinal`,
        [row.id],
      );
      const snapshotIds = row.snapshot_ids_json;
      const linkedSnapshotIds = links.rows.map(({ snapshot_id }) => snapshot_id);
      if (!isDeepStrictEqual(snapshotIds, linkedSnapshotIds)) {
        throw new AgentRunDataError();
      }
      return AgentRunAuditSchema.parse({
        schemaVersion: row.schema_version,
        id: row.id,
        runId: row.run_id,
        stageId: row.stage_id,
        jobAttemptId: row.job_attempt_id,
        executionFingerprint: row.execution_fingerprint,
        outputSchemaDigest: row.output_schema_digest,
        stage: row.stage,
        status:
          row.validation_status === "pending" ? "running" : row.terminal_status,
        skill: {
          id: row.skill_id,
          version: row.skill_version,
          contentHash: row.skill_content_hash,
        },
        snapshotIds,
        model:
          row.response_id === null
            ? { provider: row.provider, model: row.model }
            : {
                provider: row.provider,
                model: row.model,
                responseId: row.response_id,
              },
        inputSummary: row.input_summary_json,
        outputSchemaVersion: row.output_schema_version,
        output: row.output_json,
        validationStatus: row.validation_status,
        error: row.error_json,
        dataCutoffAt: mapTimestamp(row.data_cutoff_at),
        inputTokens: nullableStoredInteger(row.input_tokens),
        outputTokens: nullableStoredInteger(row.output_tokens),
        estimatedCostMicros: nullableStoredInteger(row.estimated_cost_micros),
        durationMs: nullableStoredInteger(row.duration_ms),
        attemptCount: nullableStoredInteger(row.attempt_count),
        usageCompleteness: row.usage_completeness,
        attempts: row.attempts_json,
        terminalMetadata: row.terminal_metadata_json,
        startedAt: mapTimestamp(row.started_at),
        completedAt:
          row.completed_at === null ? null : mapTimestamp(row.completed_at),
      });
    } catch (error) {
      if (error instanceof AgentRunDataError) throw error;
      throw new AgentRunDataError();
    }
  }

  async #execute<Result>(
    operation: () => Promise<Result>,
    conflictFactory?: () => Error,
  ): Promise<Result> {
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof AgentRunClaimLostError ||
        error instanceof AgentRunConflictError ||
        error instanceof AgentRunDataError ||
        error instanceof AgentRunLeaseLostError ||
        error instanceof AgentRunSubjectNotFoundError ||
        error instanceof SkillVersionConflictError ||
        error instanceof TypeError ||
        error instanceof ZodError
      ) {
        throw error;
      }
      const code = postgresErrorCode(error);
      if ((code === "23503" || code === "23505") && conflictFactory) {
        throw conflictFactory();
      }
      throw new AgentRunDataError();
    }
  }
}

function validateSkillVersionInput(
  input: RegisterSkillVersionInput,
): RegisterSkillVersionInput {
  assertCanonicalEntityId(input.id, "skillVersionId");
  assertTimestamp(input.createdAt, "skillVersion.createdAt");
  const manifest = SkillManifestSchema.parse(input.manifest);
  if (
    input.skillId !== manifest.id ||
    input.version !== manifest.version ||
    input.contentHash !== manifest.contentHash ||
    !sha256Pattern.test(input.contentHash)
  ) {
    throw new TypeError("Invalid Skill version provenance");
  }
  return { ...input, manifest };
}

function validateBeginAgentRunInput(
  input: BeginAgentRunInput,
): BeginAgentRunInput {
  for (const [label, value] of [
    ["id", input.id],
    ["runId", input.runId],
    ["stageId", input.stageId],
    ["jobAttemptId", input.jobAttemptId],
    ["skillVersionId", input.skillVersionId],
  ] as const) {
    assertCanonicalEntityId(value, label);
  }
  assertNonEmptyString(input.organizationId, "organizationId");
  assertNonEmptyString(input.leaseOwnerId, "leaseOwnerId");
  assertNonEmptyString(input.claimToken, "claimToken");
  assertNonEmptyString(input.provider, "provider");
  assertNonEmptyString(input.model, "model");
  if (
    !sha256Pattern.test(input.executionFingerprint) ||
    (input.logicalExecutionLineage !== undefined &&
      !sha256Pattern.test(input.logicalExecutionLineage)) ||
    (input.logicalExecutionCycleId !== undefined &&
      !sha256Pattern.test(input.logicalExecutionCycleId)) ||
    (input.logicalExecutionLineage === undefined) !==
      (input.logicalExecutionCycleId === undefined) ||
    !sha256Pattern.test(input.outputSchemaDigest) ||
    !sha256Pattern.test(input.inputSummary.contentHash) ||
    !Number.isSafeInteger(input.inputSummary.recordCount) ||
    input.inputSummary.recordCount < 0 ||
    !/^\d+\.\d+\.\d+$/.test(input.outputSchemaVersion) ||
    !Number.isSafeInteger(input.leaseGeneration) ||
    input.leaseGeneration <= 0
  ) {
    throw new TypeError("Invalid agent run audit identity");
  }
  assertTimestamp(input.dataCutoffAt, "agentRun.dataCutoffAt");
  assertTimestamp(input.startedAt, "agentRun.startedAt");
  assertTimestamp(input.claimAcquiredAt, "agentRun.claimAcquiredAt");
  assertTimestamp(input.claimExpiresAt, "agentRun.claimExpiresAt");
  if (
    input.claimExpiresAt <= input.claimAcquiredAt ||
    input.claimToken.length > 200
  ) {
    throw new TypeError("Invalid agent run execution claim");
  }
  if (
    input.snapshotIds.length === 0 ||
    new Set(input.snapshotIds).size !== input.snapshotIds.length
  ) {
    throw new TypeError("Invalid agent run snapshot provenance");
  }
  input.snapshotIds.forEach((id) => assertCanonicalEntityId(id, "snapshotId"));
  return {
    ...input,
    snapshotIds: [...input.snapshotIds],
    inputSummary: { ...input.inputSummary },
  };
}

function validateAssertAgentRunClaimInput(input: AssertAgentRunClaimInput) {
  assertCanonicalEntityId(input.agentRunId, "agentRunId");
  assertCanonicalEntityId(input.jobAttemptId, "jobAttemptId");
  assertNonEmptyString(input.organizationId, "organizationId");
  assertNonEmptyString(input.leaseOwnerId, "leaseOwnerId");
  assertNonEmptyString(input.claimToken, "claimToken");
  assertTimestamp(input.asOf, "agentRun.claimAsOf");
  if (!Number.isSafeInteger(input.leaseGeneration) || input.leaseGeneration <= 0) {
    throw new TypeError("Invalid agent run lease generation");
  }
}

function validateFinalizeAgentRunInput(input: FinalizeAgentRunInput) {
  assertCanonicalEntityId(input.agentRunId, "agentRunId");
  assertNonEmptyString(input.organizationId, "organizationId");
  assertNonEmptyString(input.leaseOwnerId, "leaseOwnerId");
  assertNonEmptyString(input.claimToken, "claimToken");
  assertTimestamp(input.completedAt, "agentRun.completedAt");
  if (!Number.isSafeInteger(input.leaseGeneration) || input.leaseGeneration <= 0) {
    throw new TypeError("Invalid agent run lease generation");
  }
}

function validateListAgentRunsInput(input: ListAgentRunsInput) {
  assertCanonicalEntityId(input.runId, "runId");
  assertNonEmptyString(input.organizationId, "organizationId");
}

function validateJobAttemptModelUsageInput(input: JobAttemptModelUsageInput) {
  validateListAgentRunsInput(input);
  assertCanonicalEntityId(input.jobAttemptId, "jobAttemptId");
  assertCanonicalEntityId(input.agentRunId, "agentRunId");
}

function mapSkillVersion(row: SkillVersionRow): SkillVersionRecord {
  try {
    return validateSkillVersionInput({
      id: row.id,
      skillId: row.skill_id,
      version: row.version,
      contentHash: row.content_hash,
      manifest: SkillManifestSchema.parse(row.manifest_json),
      createdAt: mapTimestamp(row.created_at),
    });
  } catch (error) {
    if (error instanceof SkillVersionConflictError) throw error;
    throw new AgentRunDataError();
  }
}

function sameSkillVersion(
  stored: SkillVersionRecord,
  input: RegisterSkillVersionInput,
) {
  return (
    stored.skillId === input.skillId &&
    stored.version === input.version &&
    stored.contentHash === input.contentHash &&
    isDeepStrictEqual(stored.manifest, input.manifest)
  );
}

function sameAgentRunBeginIdentity(
  record: AgentRunAudit,
  row: AgentRunRow,
  input: BeginAgentRunInput,
) {
  return (
    record.runId === input.runId &&
    record.stageId === input.stageId &&
    record.jobAttemptId === input.jobAttemptId &&
    row.logical_execution_lineage === (input.logicalExecutionLineage ?? null) &&
    row.logical_execution_cycle_id === (input.logicalExecutionCycleId ?? null) &&
    row.skill_version_id === input.skillVersionId &&
    record.executionFingerprint === input.executionFingerprint &&
    record.outputSchemaDigest === input.outputSchemaDigest &&
    isDeepStrictEqual(record.snapshotIds, input.snapshotIds) &&
    record.model.provider === input.provider &&
    record.model.model === input.model &&
    isDeepStrictEqual(record.inputSummary, input.inputSummary) &&
    record.outputSchemaVersion === input.outputSchemaVersion &&
    sameDateTimeInstant(record.dataCutoffAt, input.dataCutoffAt)
  );
}

function sameAgentRunLogicalIdentity(
  record: AgentRunAudit,
  row: AgentRunRow,
  input: BeginAgentRunInput,
) {
  return (
    record.runId === input.runId &&
    record.stageId === input.stageId &&
    row.logical_execution_lineage === (input.logicalExecutionLineage ?? null) &&
    row.logical_execution_cycle_id === (input.logicalExecutionCycleId ?? null) &&
    row.skill_version_id === input.skillVersionId &&
    record.executionFingerprint === input.executionFingerprint &&
    record.outputSchemaDigest === input.outputSchemaDigest &&
    isDeepStrictEqual(record.snapshotIds, input.snapshotIds) &&
    record.model.provider === input.provider &&
    record.model.model === input.model &&
    isDeepStrictEqual(record.inputSummary, input.inputSummary) &&
    record.outputSchemaVersion === input.outputSchemaVersion &&
    sameDateTimeInstant(record.dataCutoffAt, input.dataCutoffAt)
  );
}

function finalizedAgentRun(
  current: AgentRunAudit,
  input: FinalizeAgentRunInput,
) {
  const outcome = input.outcome;
  return AgentRunAuditSchema.parse({
    ...current,
    status: outcome.terminalStatus,
    model:
      outcome.responseId === null
        ? { provider: current.model.provider, model: current.model.model }
        : {
            provider: current.model.provider,
            model: current.model.model,
            responseId: outcome.responseId,
          },
    output: outcome.output,
    validationStatus: outcome.validationStatus,
    error: outcome.error,
    inputTokens: outcome.inputTokens,
    outputTokens: outcome.outputTokens,
    estimatedCostMicros: outcome.estimatedCostMicros,
    durationMs: outcome.durationMs,
    attemptCount: outcome.attemptCount,
    usageCompleteness: outcome.usageCompleteness,
    attempts: outcome.attempts.map((attempt) => ({ ...attempt })),
    terminalMetadata: { ...outcome.terminalMetadata },
    completedAt: input.completedAt,
  });
}

function assertCanonicalEntityId(value: string, label: string) {
  try {
    EntityIdSchema.parse(value);
  } catch {
    throw new TypeError(`Invalid ${label}`);
  }
}

function assertNonEmptyString(value: string, label: string) {
  if (typeof value !== "string" || value.length < 1 || value.length > 500) {
    throw new TypeError(`Invalid ${label}`);
  }
}

function assertTimestamp(value: string, label: string) {
  if (
    typeof value !== "string" ||
    !value ||
    !Number.isFinite(new Date(value).getTime()) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError(`Invalid ${label}`);
  }
}

function mapTimestamp(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new AgentRunDataError();
  return date.toISOString();
}

function sameDateTimeInstant(left: string, right: string) {
  return new Date(left).getTime() === new Date(right).getTime();
}

function safeStoredInteger(value: string | number | null): number {
  if (value === null) throw new AgentRunDataError();
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new AgentRunDataError();
  return parsed;
}

function nullableStoredInteger(value: string | number | null) {
  return value === null ? null : safeStoredInteger(value);
}

function sumNullableSafeIntegers(values: readonly (number | null)[]) {
  if (values.length === 0 || values.some((value) => value === null)) return null;
  let sum = BigInt(0);
  for (const value of values) {
    if (value === null || !Number.isSafeInteger(value) || value < 0) {
      throw new AgentRunDataError();
    }
    sum += BigInt(value);
  }
  assertSafeAggregate(sum);
  return Number(sum);
}

function assertSafeAggregate(value: bigint) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new AgentRunDataError();
}

function postgresErrorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}
