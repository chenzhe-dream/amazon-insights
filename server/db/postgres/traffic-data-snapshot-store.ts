import { isDeepStrictEqual } from "node:util";

import type { QueryResultRow } from "pg";
import { z } from "zod";

import {
  EntityIdSchema,
} from "../../../shared/agent-contracts";
import {
  TrafficDataSnapshotRecordSchema,
  TrafficSnapshotCandidateSchema,
  type TrafficDataSnapshotRecord,
} from "../../data/traffic-data-snapshot";
import { deepFreeze } from "../../data/voc-data-snapshot";
import {
  DataSnapshotCutoffConflictError,
  DataSnapshotSubjectNotFoundError,
} from "../data-snapshot-repository";
import {
  TrafficDataSnapshotConflictError,
  TrafficDataSnapshotDataError,
  type CreateTrafficDataSnapshotForRunInput,
  type TrafficDataSnapshotRepository,
} from "../traffic-data-snapshot-repository";
import { PostgresQueryContext } from "./query-context";
import {
  canonicalizeDateTime,
  mapDateTime,
  requireSnapshotSubject,
  sameDateTimeInstant,
  validateSnapshotSubjectInput,
} from "./snapshot-subject";

interface TrafficDataSnapshotRow extends QueryResultRow {
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

export class PostgresTrafficDataSnapshotStore
implements TrafficDataSnapshotRepository {
  readonly #queries: PostgresQueryContext;

  constructor(queries: PostgresQueryContext) {
    this.#queries = queries;
  }

  createTrafficDataSnapshotForRun(
    input: CreateTrafficDataSnapshotForRunInput,
  ): Promise<{ snapshot: TrafficDataSnapshotRecord; created: boolean }> {
    return this.#execute(async () => {
      const validated = validateCreateTrafficDataSnapshotInput(input);

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

        const inserted = await this.#queries.query<TrafficDataSnapshotRow>(
          `INSERT INTO data_snapshots (
             id, run_id, snapshot_kind, artifact_kind, schema_version, marketplace,
             asins_json, data_cutoff_at, sources_json, payload_json,
             content_hash, created_at
           ) VALUES (
             $1, $2, NULL, 'traffic', $3, $4, $5::jsonb, $6,
             $7::jsonb, $8::jsonb, $9, $10
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
            snapshot: mapTrafficDataSnapshot(inserted.rows[0]),
            created: true,
          };
        }

        const existing = await this.#queries.query<TrafficDataSnapshotRow>(
          `SELECT id, run_id, schema_version, marketplace, asins_json,
                  data_cutoff_at, sources_json, payload_json, content_hash,
                  created_at
             FROM data_snapshots
            WHERE artifact_kind = 'traffic'
              AND schema_version = '1.0.0'
              AND run_id = $1
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
        if (!row) throw new TrafficDataSnapshotConflictError();
        const snapshot = mapTrafficDataSnapshot(row);
        if (snapshot.contentHash !== validated.candidate.contentHash) {
          throw new TrafficDataSnapshotConflictError();
        }
        return { snapshot, created: false };
      });
    });
  }

  findTrafficDataSnapshotById(input: {
    actorOrganizationId: string;
    snapshotId: string;
  }): Promise<TrafficDataSnapshotRecord | null> {
    return this.#execute(async () => {
      const actorOrganizationId = EntityIdSchema.parse(
        input.actorOrganizationId,
      );
      const snapshotId = EntityIdSchema.parse(input.snapshotId);
      const result = await this.#queries.query<TrafficDataSnapshotRow>(
        `SELECT ds.id, ds.run_id, ds.schema_version, ds.marketplace,
                ds.asins_json, ds.data_cutoff_at, ds.sources_json,
                ds.payload_json, ds.content_hash, ds.created_at
           FROM data_snapshots ds
           JOIN analysis_runs run ON run.id = ds.run_id
           JOIN projects project ON project.id = run.project_id
          WHERE ds.id = $1
            AND ds.artifact_kind = 'traffic'
            AND ds.schema_version = '1.0.0'
            AND project.organization_id = $2`,
        [snapshotId, actorOrganizationId],
      );
      return result.rows[0] ? mapTrafficDataSnapshot(result.rows[0]) : null;
    });
  }

  listTrafficDataSnapshotsByRun(input: {
    actorOrganizationId: string;
    runId: string;
  }): Promise<TrafficDataSnapshotRecord[]> {
    return this.#execute(async () => {
      const actorOrganizationId = EntityIdSchema.parse(
        input.actorOrganizationId,
      );
      const runId = EntityIdSchema.parse(input.runId);
      const result = await this.#queries.query<TrafficDataSnapshotRow>(
        `SELECT ds.id, ds.run_id, ds.schema_version, ds.marketplace,
                ds.asins_json, ds.data_cutoff_at, ds.sources_json,
                ds.payload_json, ds.content_hash, ds.created_at
           FROM data_snapshots ds
           JOIN analysis_runs run ON run.id = ds.run_id
           JOIN projects project ON project.id = run.project_id
          WHERE ds.run_id = $1
            AND ds.artifact_kind = 'traffic'
            AND ds.schema_version = '1.0.0'
            AND project.organization_id = $2
          ORDER BY ds.created_at, ds.id`,
        [runId, actorOrganizationId],
      );
      return result.rows.map(mapTrafficDataSnapshot);
    });
  }

  async #execute<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof TrafficDataSnapshotConflictError ||
        error instanceof TrafficDataSnapshotDataError ||
        error instanceof DataSnapshotCutoffConflictError ||
        error instanceof DataSnapshotSubjectNotFoundError ||
        error instanceof TypeError ||
        error instanceof z.ZodError
      ) {
        throw error;
      }
      const code = postgresErrorCode(error);
      if (code === "23505") throw new TrafficDataSnapshotConflictError();
      if (code === "23503") throw new DataSnapshotSubjectNotFoundError();
      throw new TrafficDataSnapshotDataError();
    }
  }
}

function validateCreateTrafficDataSnapshotInput(
  input: CreateTrafficDataSnapshotForRunInput,
): CreateTrafficDataSnapshotForRunInput {
  return {
    ...validateSnapshotSubjectInput(input),
    candidateId: EntityIdSchema.parse(input.candidateId),
    createdAt: canonicalizeDateTime(input.createdAt),
    candidate: TrafficSnapshotCandidateSchema.parse(input.candidate),
  };
}

function mapTrafficDataSnapshot(
  row: TrafficDataSnapshotRow,
): TrafficDataSnapshotRecord {
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
    throw new TrafficDataSnapshotDataError();
  }
}

function postgresErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}
