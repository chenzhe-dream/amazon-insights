import { createHash, randomUUID } from "node:crypto";

import type { QueryResultRow } from "pg";

import { EntityIdSchema } from "../../../shared/agent-contracts";
import { PostgresQueryContext } from "./query-context";
import { canonicalizeDateTime } from "./snapshot-subject";

interface StageRow extends QueryResultRow {
  id: string;
  status: string;
}

export class PostgresProductDependencyReconciler {
  readonly #queries: PostgresQueryContext;

  constructor(queries: PostgresQueryContext) {
    this.#queries = queries;
  }

  async reconcileProductDefinitionStage(
    runId: string,
    updatedAt: string,
  ): Promise<void> {
    const validatedRunId = EntityIdSchema.parse(runId);
    const canonicalUpdatedAt = canonicalizeDateTime(updatedAt);
    await this.#queries.transaction(async () => {
      const stageResult = await this.#queries.query<StageRow>(
        `SELECT id, status
           FROM run_stages
          WHERE run_id = $1 AND stage = 'product-definition'
          FOR UPDATE`,
        [validatedRunId],
      );
      const stage = stageResult.rows[0];
      if (!stage || !["queued", "waiting-input"].includes(stage.status)) {
        return;
      }

      const vocReady = Boolean((await this.#queries.query(
        `SELECT 1 FROM analysis_reports
          WHERE run_id = $1
            AND stage = 'voc-positioning'
            AND status IN ('complete', 'partial')
          LIMIT 1`,
        [validatedRunId],
      )).rows[0]);
      const keywordReady = Boolean((await this.#queries.query(
        "SELECT 1 FROM keyword_analysis_snapshots WHERE run_id = $1 LIMIT 1",
        [validatedRunId],
      )).rows[0]);
      const missing: Array<{ path: string; message: string }> = [];
      if (!vocReady) {
        missing.push({
          path: "dependencies.voc-positioning-report",
          message: "Validated VOC positioning report is required",
        });
      }
      if (!keywordReady) {
        missing.push({
          path: "dependencies.keyword-analysis-snapshot",
          message: "Keyword analysis snapshot is required",
        });
      }
      if (missing.length > 0) {
        await this.#queries.query(
          `UPDATE run_stages
              SET status = 'waiting-input', progress = 0,
                  completed_at = NULL, last_error_json = $1::jsonb,
                  updated_at = $2
            WHERE id = $3 AND status IN ('queued', 'waiting-input')`,
          [
            JSON.stringify({
              code: "DATA_QUALITY_ERROR",
              message: "Product definition dependencies are not satisfied",
              requestId: `product-dependencies:${validatedRunId}`,
              details: missing,
              retryable: false,
            }),
            canonicalUpdatedAt,
            stage.id,
          ],
        );
        await this.#setRunStatus(validatedRunId, "waiting-input", canonicalUpdatedAt);
        return;
      }

      const existingJob = Boolean((await this.#queries.query(
        "SELECT 1 FROM job_attempts WHERE stage_id = $1 LIMIT 1",
        [stage.id],
      )).rows[0]);
      if (!existingJob) {
        await this.#queries.query(
          `INSERT INTO job_attempts (
             id, stage_id, attempt_number, max_attempts,
             retry_cycle_start_attempt, status, available_at, leased_by,
             lease_expires_at, lease_generation, retryable, retry_scheduled_at,
             started_at, completed_at, error_json, created_at, updated_at
           ) VALUES ($1, $2, 1, 3, 1, 'queued', $3, NULL, NULL, 0,
                     FALSE, NULL, NULL, NULL, NULL, $3, $3)`,
          [randomUUID(), stage.id, canonicalUpdatedAt],
        );
      }
      await this.#queries.query(
        `UPDATE run_stages
            SET status = 'queued', progress = 0, completed_at = NULL,
                last_error_json = NULL, updated_at = $1
          WHERE id = $2 AND status IN ('queued', 'waiting-input')`,
        [canonicalUpdatedAt, stage.id],
      );
      await this.#setRunStatus(validatedRunId, "queued", canonicalUpdatedAt);
    });
  }

  async #setRunStatus(
    runId: string,
    status: "queued" | "waiting-input",
    updatedAt: string,
  ) {
    await this.#queries.query(
      "UPDATE analysis_runs SET status = $1, updated_at = $2 WHERE id = $3",
      [status, updatedAt, runId],
    );
  }
}

export function createLogicalExecutionCycleIdForProductDependency(): string {
  return createHash("sha256").update(randomUUID()).digest("hex");
}
