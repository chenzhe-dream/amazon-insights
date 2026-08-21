import { isDeepStrictEqual } from "node:util";

import type { QueryResultRow } from "pg";
import { z } from "zod";

import { EntityIdSchema } from "../../../shared/agent-contracts";
import {
  KeywordAnalysisSnapshotCandidateSchema,
  KeywordAnalysisSnapshotRecordSchema,
  type KeywordAnalysisSnapshotRecord,
} from "../../data/keyword-analysis-snapshot";
import { deepFreeze } from "../../data/voc-data-snapshot";
import {
  DataSnapshotCutoffConflictError,
  DataSnapshotSubjectNotFoundError,
} from "../data-snapshot-repository";
import {
  KeywordAnalysisSnapshotConflictError,
  KeywordAnalysisSnapshotDataError,
  type CreateKeywordAnalysisSnapshotForRunInput,
  type KeywordAnalysisSnapshotRepository,
} from "../keyword-analysis-snapshot-repository";
import { PostgresProductDependencyReconciler } from "./product-dependency-reconciler";
import { PostgresQueryContext } from "./query-context";
import {
  canonicalizeDateTime,
  mapDateTime,
  requireSnapshotSubject,
  sameDateTimeInstant,
  validateSnapshotSubjectInput,
} from "./snapshot-subject";

interface KeywordAnalysisSnapshotRow extends QueryResultRow {
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

export interface PostgresKeywordAnalysisSnapshotStoreOptions {
  readonly dependencyReconciler?: PostgresProductDependencyReconciler;
}

export class PostgresKeywordAnalysisSnapshotStore
implements KeywordAnalysisSnapshotRepository {
  readonly #queries: PostgresQueryContext;
  readonly #dependencyReconciler: PostgresProductDependencyReconciler;

  constructor(
    queries: PostgresQueryContext,
    options: PostgresKeywordAnalysisSnapshotStoreOptions = {},
  ) {
    this.#queries = queries;
    this.#dependencyReconciler =
      options.dependencyReconciler ??
      new PostgresProductDependencyReconciler(queries);
  }

  createKeywordAnalysisSnapshotForRun(
    input: CreateKeywordAnalysisSnapshotForRunInput,
  ): Promise<{ snapshot: KeywordAnalysisSnapshotRecord; created: boolean }> {
    return this.#execute(async () => {
      const validated = validateCreateKeywordAnalysisSnapshotInput(input);
      return await this.#queries.transaction(async () => {
        const subject = await requireSnapshotSubject(this.#queries, validated);
        if (
          validated.candidate.marketplace !== validated.expectedMarketplace ||
          !isDeepStrictEqual(
            validated.candidate.asins,
            validated.expectedAsins,
          )
        ) {
          throw new DataSnapshotSubjectNotFoundError();
        }
        if (
          !sameDateTimeInstant(
            validated.candidate.dataCutoffAt,
            subject.dataCutoffAt,
          )
        ) {
          throw new DataSnapshotCutoffConflictError();
        }

        const inserted = await this.#queries.query<KeywordAnalysisSnapshotRow>(
          `INSERT INTO keyword_analysis_snapshots (
             id, run_id, schema_version, marketplace, asins_json,
             data_cutoff_at, sources_json, payload_json, content_hash,
             created_at
           ) VALUES ($1, $2, '1.0.0', $3, $4::jsonb, $5, $6::jsonb,
                     $7::jsonb, $8, $9)
           ON CONFLICT DO NOTHING
           RETURNING id, run_id, schema_version, marketplace, asins_json,
                     data_cutoff_at, sources_json, payload_json, content_hash,
                     created_at`,
          [
            validated.candidateId,
            subject.runId,
            validated.candidate.marketplace,
            JSON.stringify(validated.candidate.asins),
            validated.candidate.dataCutoffAt,
            JSON.stringify(validated.candidate.sources),
            JSON.stringify(validated.candidate.payload),
            validated.candidate.contentHash,
            validated.createdAt,
          ],
        );
        if (inserted.rows[0]) {
          await this.#dependencyReconciler.reconcileProductDefinitionStage(
            subject.runId,
            validated.createdAt,
          );
          return {
            snapshot: mapKeywordAnalysisSnapshot(inserted.rows[0]),
            created: true,
          };
        }

        const existing = await this.#queries.query<KeywordAnalysisSnapshotRow>(
          `SELECT id, run_id, schema_version, marketplace, asins_json,
                  data_cutoff_at, sources_json, payload_json, content_hash,
                  created_at
             FROM keyword_analysis_snapshots
            WHERE run_id = $1
              AND schema_version = '1.0.0'
              AND marketplace = $2
              AND asins_json = $3::jsonb
              AND data_cutoff_at = $4
            FOR UPDATE`,
          [
            subject.runId,
            validated.candidate.marketplace,
            JSON.stringify(validated.candidate.asins),
            validated.candidate.dataCutoffAt,
          ],
        );
        const row = existing.rows[0];
        if (!row) throw new KeywordAnalysisSnapshotConflictError();
        const snapshot = mapKeywordAnalysisSnapshot(row);
        if (snapshot.contentHash !== validated.candidate.contentHash) {
          throw new KeywordAnalysisSnapshotConflictError();
        }
        await this.#dependencyReconciler.reconcileProductDefinitionStage(
          subject.runId,
          validated.createdAt,
        );
        return { snapshot, created: false };
      });
    });
  }

  findKeywordAnalysisSnapshotById(input: {
    actorOrganizationId: string;
    snapshotId: string;
  }): Promise<KeywordAnalysisSnapshotRecord | null> {
    return this.#execute(async () => {
      const actorOrganizationId = EntityIdSchema.parse(input.actorOrganizationId);
      const snapshotId = EntityIdSchema.parse(input.snapshotId);
      const result = await this.#queries.query<KeywordAnalysisSnapshotRow>(
        `SELECT snapshot.id, snapshot.run_id, snapshot.schema_version,
                snapshot.marketplace, snapshot.asins_json,
                snapshot.data_cutoff_at, snapshot.sources_json,
                snapshot.payload_json, snapshot.content_hash,
                snapshot.created_at
           FROM keyword_analysis_snapshots snapshot
           JOIN analysis_runs run ON run.id = snapshot.run_id
           JOIN projects project ON project.id = run.project_id
          WHERE snapshot.id = $1 AND project.organization_id = $2`,
        [snapshotId, actorOrganizationId],
      );
      return result.rows[0] ? mapKeywordAnalysisSnapshot(result.rows[0]) : null;
    });
  }

  listKeywordAnalysisSnapshotsByRun(input: {
    actorOrganizationId: string;
    runId: string;
  }): Promise<KeywordAnalysisSnapshotRecord[]> {
    return this.#execute(async () => {
      const actorOrganizationId = EntityIdSchema.parse(input.actorOrganizationId);
      const runId = EntityIdSchema.parse(input.runId);
      const result = await this.#queries.query<KeywordAnalysisSnapshotRow>(
        `SELECT snapshot.id, snapshot.run_id, snapshot.schema_version,
                snapshot.marketplace, snapshot.asins_json,
                snapshot.data_cutoff_at, snapshot.sources_json,
                snapshot.payload_json, snapshot.content_hash,
                snapshot.created_at
           FROM keyword_analysis_snapshots snapshot
           JOIN analysis_runs run ON run.id = snapshot.run_id
           JOIN projects project ON project.id = run.project_id
          WHERE snapshot.run_id = $1 AND project.organization_id = $2
          ORDER BY snapshot.created_at, snapshot.id`,
        [runId, actorOrganizationId],
      );
      return result.rows.map(mapKeywordAnalysisSnapshot);
    });
  }

  getKeywordAnalysisArtifact(runId: string) {
    return this.#execute(async () => {
      const validatedRunId = EntityIdSchema.parse(runId);
      const result = await this.#queries.query<{ content_hash: string }>(
        `SELECT content_hash FROM keyword_analysis_snapshots
          WHERE run_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
        [validatedRunId],
      );
      const row = result.rows[0];
      return row
        ? Object.freeze({ available: true as const, version: row.content_hash })
        : Object.freeze({ available: false as const, version: null });
    });
  }

  async #execute<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof KeywordAnalysisSnapshotConflictError ||
        error instanceof KeywordAnalysisSnapshotDataError ||
        error instanceof DataSnapshotCutoffConflictError ||
        error instanceof DataSnapshotSubjectNotFoundError ||
        error instanceof TypeError ||
        error instanceof z.ZodError
      ) {
        throw error;
      }
      const code = postgresErrorCode(error);
      if (code === "23505") throw new KeywordAnalysisSnapshotConflictError();
      if (code === "23503") throw new DataSnapshotSubjectNotFoundError();
      throw new KeywordAnalysisSnapshotDataError();
    }
  }
}

function validateCreateKeywordAnalysisSnapshotInput(
  input: CreateKeywordAnalysisSnapshotForRunInput,
): CreateKeywordAnalysisSnapshotForRunInput {
  return {
    ...validateSnapshotSubjectInput(input),
    candidateId: EntityIdSchema.parse(input.candidateId),
    createdAt: canonicalizeDateTime(input.createdAt),
    candidate: KeywordAnalysisSnapshotCandidateSchema.parse(input.candidate),
  };
}

function mapKeywordAnalysisSnapshot(
  row: KeywordAnalysisSnapshotRow,
): KeywordAnalysisSnapshotRecord {
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
    throw new KeywordAnalysisSnapshotDataError();
  }
}

function postgresErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}
