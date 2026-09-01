import { isDeepStrictEqual } from "node:util";

import type { QueryResultRow } from "pg";
import { z } from "zod";

import {
  EntityIdSchema,
} from "../../../shared/agent-contracts";
import {
  assertVocDataSnapshotRecordIntegrity,
  assertVocSnapshotCandidateIntegrity,
  canonicalizeVocSnapshotCandidate,
  deepFreeze,
  VocDataSnapshotRecordSchema,
  type VocDataSnapshotRecord,
} from "../../data/voc-data-snapshot";
import {
  DataSnapshotConflictError,
  DataSnapshotCutoffConflictError,
  DataSnapshotDataError,
  DataSnapshotSubjectNotFoundError,
  type CreateDataSnapshotForRunInput,
  type CreateDataSnapshotForRunResult,
  type DataSnapshotRepository,
  type DataSnapshotSubjectInput,
  type FindDataSnapshotByIdInput,
  type ListDataSnapshotsByRunInput,
} from "../data-snapshot-repository";
import { PostgresQueryContext } from "./query-context";
import {
  canonicalizeDateTime,
  mapDateTime,
  requireSnapshotSubject,
  sameDateTimeInstant,
  validateSnapshotSubjectInput,
} from "./snapshot-subject";

interface DataSnapshotRow extends QueryResultRow {
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

export class PostgresDataSnapshotStore implements DataSnapshotRepository {
  readonly #queries: PostgresQueryContext;

  constructor(queries: PostgresQueryContext) {
    this.#queries = queries;
  }

  revalidateDataSnapshotSubject(
    input: DataSnapshotSubjectInput,
  ): Promise<void> {
    return this.#execute(async () => {
      const validated = validateSnapshotSubjectInput(input);
      await this.#queries.transaction(async () => {
        await requireSnapshotSubject(this.#queries, validated);
      });
    });
  }

  createDataSnapshotForRun(
    input: CreateDataSnapshotForRunInput,
  ): Promise<CreateDataSnapshotForRunResult> {
    return this.#execute(async () => {
      const validated = validateCreateDataSnapshotInput(input);
      try {
        assertVocSnapshotCandidateIntegrity(validated.candidate);
      } catch {
        throw new DataSnapshotDataError();
      }

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

        const inserted = await this.#queries.query<DataSnapshotRow>(
          `INSERT INTO data_snapshots (
             id, run_id, snapshot_kind, artifact_kind, schema_version, marketplace,
             asins_json, data_cutoff_at, sources_json, payload_json,
             content_hash, created_at
           ) VALUES (
             $1, $2, 'voc', 'voc', $3, $4, $5::jsonb, $6, $7::jsonb, $8::jsonb, $9, $10
           )
           ON CONFLICT DO NOTHING
           RETURNING id, run_id, schema_version, marketplace, asins_json,
                     data_cutoff_at, sources_json, payload_json, content_hash,
                     created_at`,
          [
            validated.candidateId,
            subject.runId,
            validated.candidate.schemaVersion,
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
          return {
            snapshot: mapDataSnapshot(inserted.rows[0]),
            created: true,
          };
        }

        const existing = await this.#queries.query<DataSnapshotRow>(
          `SELECT id, run_id, schema_version, marketplace, asins_json,
                  data_cutoff_at, sources_json, payload_json, content_hash,
                  created_at
             FROM data_snapshots
            WHERE snapshot_kind = 'voc'
              AND run_id = $1
              AND schema_version = $2
              AND marketplace = $3
              AND asins_json = $4::jsonb
              AND data_cutoff_at = $5
              AND content_hash = $6
            FOR UPDATE`,
          [
            subject.runId,
            validated.candidate.schemaVersion,
            validated.candidate.marketplace,
            JSON.stringify(validated.candidate.asins),
            validated.candidate.dataCutoffAt,
            validated.candidate.contentHash,
          ],
        );
        const row = existing.rows[0];
        if (!row) throw new DataSnapshotConflictError();
        const snapshot = mapDataSnapshot(row);
        if (snapshot.contentHash !== validated.candidate.contentHash) {
          throw new DataSnapshotConflictError();
        }
        return { snapshot, created: false };
      });
    });
  }

  findDataSnapshotById(
    input: FindDataSnapshotByIdInput,
  ): Promise<VocDataSnapshotRecord | null> {
    return this.#execute(async () => {
      const actorOrganizationId = EntityIdSchema.parse(
        input.actorOrganizationId,
      );
      const snapshotId = EntityIdSchema.parse(input.snapshotId);
      const result = await this.#queries.query<DataSnapshotRow>(
        `SELECT ds.id, ds.run_id, ds.schema_version, ds.marketplace,
                ds.asins_json, ds.data_cutoff_at, ds.sources_json,
                ds.payload_json, ds.content_hash, ds.created_at
           FROM data_snapshots ds
           JOIN analysis_runs run ON run.id = ds.run_id
           JOIN projects project ON project.id = run.project_id
          WHERE ds.id = $1
            AND ds.snapshot_kind = 'voc'
            AND project.organization_id = $2`,
        [snapshotId, actorOrganizationId],
      );
      return result.rows[0] ? mapDataSnapshot(result.rows[0]) : null;
    });
  }

  listDataSnapshotsByRun(
    input: ListDataSnapshotsByRunInput,
  ): Promise<VocDataSnapshotRecord[]> {
    return this.#execute(async () => {
      const actorOrganizationId = EntityIdSchema.parse(
        input.actorOrganizationId,
      );
      const runId = EntityIdSchema.parse(input.runId);
      const result = await this.#queries.query<DataSnapshotRow>(
        `SELECT ds.id, ds.run_id, ds.schema_version, ds.marketplace,
                ds.asins_json, ds.data_cutoff_at, ds.sources_json,
                ds.payload_json, ds.content_hash, ds.created_at
           FROM data_snapshots ds
           JOIN analysis_runs run ON run.id = ds.run_id
           JOIN projects project ON project.id = run.project_id
          WHERE ds.run_id = $1
            AND ds.snapshot_kind = 'voc'
            AND project.organization_id = $2
          ORDER BY ds.created_at, ds.id`,
        [runId, actorOrganizationId],
      );
      return result.rows.map(mapDataSnapshot);
    });
  }

  async #execute<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof DataSnapshotConflictError ||
        error instanceof DataSnapshotCutoffConflictError ||
        error instanceof DataSnapshotDataError ||
        error instanceof DataSnapshotSubjectNotFoundError ||
        error instanceof TypeError ||
        error instanceof z.ZodError
      ) {
        throw error;
      }
      const code = postgresErrorCode(error);
      if (code === "23505") throw new DataSnapshotConflictError();
      if (code === "23503") throw new DataSnapshotSubjectNotFoundError();
      throw new DataSnapshotDataError();
    }
  }
}

function validateCreateDataSnapshotInput(
  input: CreateDataSnapshotForRunInput,
): CreateDataSnapshotForRunInput {
  return {
    ...validateSnapshotSubjectInput(input),
    candidateId: EntityIdSchema.parse(input.candidateId),
    createdAt: canonicalizeDateTime(input.createdAt),
    candidate: canonicalizeVocSnapshotCandidate(input.candidate),
  };
}

function mapDataSnapshot(row: DataSnapshotRow): VocDataSnapshotRecord {
  try {
    const record = VocDataSnapshotRecordSchema.parse({
      schemaVersion: row.schema_version,
      id: row.id,
      runId: row.run_id,
      marketplace: row.marketplace,
      asins: row.asins_json,
      dataCutoffAt: mapDateTime(row.data_cutoff_at),
      sources: row.sources_json,
      contentHash: row.content_hash,
      createdAt: mapDateTime(row.created_at),
      payload: row.payload_json,
    });
    assertVocDataSnapshotRecordIntegrity(record);
    return deepFreeze(record);
  } catch {
    throw new DataSnapshotDataError();
  }
}

function postgresErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}
