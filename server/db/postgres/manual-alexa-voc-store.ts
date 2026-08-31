import { AsyncLocalStorage } from "node:async_hooks";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { QueryResult, QueryResultRow } from "pg";

import {
  AsinSchema,
  DateTimeSchema,
  EntityIdSchema,
  ManualAlexaVocNormalizedRecordSchema,
  type ManualAlexaVocNormalizedRecord,
} from "../../../shared/agent-contracts";
import {
  createRunCreationFingerprint,
  ManualAlexaVocRepositoryError,
  type ManualAlexaVocOutboxLease,
  type ManualAlexaVocRawAccessAuditEvent,
  type ManualAlexaVocRawEnvelopeRecord,
  type ManualAlexaVocRepository,
  type ManualAlexaVocRevision,
  type ManualAlexaVocScope,
  type ManualAlexaVocWriteResult,
  type PutManualAlexaVocInput,
  type RunCreationClaim,
  type RunCreationClaimInput,
  type RunCreationCompleteInput,
} from "../manual-alexa-voc-repository";

export interface PostgresQueryExecutor {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
  transaction<Result>(operation: () => Promise<Result>): Promise<Result>;
}

interface ManualAlexaVocTransactionContext {
  readonly lockedScopes: Set<string>;
}

interface RevisionRow extends QueryResultRow {
  organization_id: unknown;
  marketplace: unknown;
  asin: unknown;
  revision: unknown;
  content_hash: unknown;
  captured_at: unknown;
  normalized_record: unknown;
  normalized_schema_version: unknown;
  parser_version: unknown;
}

interface HeadRow extends QueryResultRow {
  latest_revision: unknown;
  latest_content_hash: unknown;
  latest_captured_at: unknown;
  generation: unknown;
}

interface OutboxStatusRow extends QueryResultRow {
  status: unknown;
}

interface OutboxLeaseRow extends QueryResultRow {
  organization_id: unknown;
  marketplace: unknown;
  asin: unknown;
  revision: unknown;
  content_hash: unknown;
  generation: unknown;
  lease_generation: unknown;
  leased_by: unknown;
  lease_expires_at: unknown;
}

interface RunCreationRow extends QueryResultRow {
  request_fingerprint: unknown;
  project_id?: unknown;
  run_id: unknown;
  snapshot_id: unknown;
  completed_at: unknown;
}

interface LegacyRunCreationRow extends QueryResultRow {
  run_id: unknown;
  project_id: unknown;
  mode: unknown;
  run_created_at: unknown;
  marketplace: unknown;
  asins_json: unknown;
  snapshot_id: unknown;
  snapshot_created_at: unknown;
}

interface RawRevisionRow extends QueryResultRow {
  marketplace: unknown;
  asin: unknown;
  revision: unknown;
}

interface RawEnvelopeRow extends QueryResultRow {
  organization_id: unknown;
  marketplace: unknown;
  asin: unknown;
  revision: unknown;
  content_hash: unknown;
  captured_at: unknown;
  normalized_schema_version: unknown;
  parser_version: unknown;
  raw_report_sha256: unknown;
  raw_report_alg_version: unknown;
  raw_report_key_id: unknown;
  raw_report_wrapped_dek: unknown;
  raw_report_nonce: unknown;
  raw_report_ciphertext: unknown;
  raw_report_tag: unknown;
  raw_report_aad_sha256: unknown;
  raw_report_plaintext_bytes: unknown;
}

interface RawAccessAuditRow extends QueryResultRow {
  id: unknown;
  organization_id: unknown;
  actor_user_id: unknown;
  marketplace: unknown;
  asin: unknown;
  revision: unknown;
  purpose: unknown;
  result: unknown;
  created_at: unknown;
}

const sha256Pattern = /^[a-f0-9]{64}$/;
const decimalPattern = /^[1-9]\d*$/;
const maximumCounter = BigInt("9223372036854775807");
const rawAccessPurposes = new Set<unknown>([
  "decrypt",
  "reparse",
  "export",
  "key-rewrap",
]);
const rawAccessResults = new Map<unknown, string>([
  ["succeeded", "allowed"],
  ["denied", "denied"],
  ["failed", "not-found"],
]);
const storedRawAccessPurposes = new Set<unknown>([
  "create",
  "decrypt",
  "reparse",
  "export",
  "key-rewrap",
  "delete-policy",
]);
const storedRawAccessResults = new Map<unknown, string>([
  ["allowed", "succeeded"],
  ["denied", "denied"],
  ["not-found", "failed"],
]);
const rawEnvelopeSelect = `
  SELECT organization_id, marketplace, asin,
         revision::text AS revision, content_hash, captured_at,
         normalized_schema_version, parser_version, raw_report_sha256,
         raw_report_alg_version, raw_report_key_id, raw_report_wrapped_dek,
         raw_report_nonce, raw_report_ciphertext, raw_report_tag,
         raw_report_aad_sha256, raw_report_plaintext_bytes
    FROM manual_alexa_voc_revisions`;

export class PostgresManualAlexaVocStore implements ManualAlexaVocRepository {
  readonly #queries: PostgresQueryExecutor;
  readonly #transactionContext =
    new AsyncLocalStorage<ManualAlexaVocTransactionContext>();

  constructor(queries: PostgresQueryExecutor) {
    this.#queries = queries;
  }

  async transaction<Result>(operation: () => Promise<Result>): Promise<Result> {
    if (this.#transactionContext.getStore()) return operation();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let operationEntered = false;
      let operationCompleted = false;
      try {
        return await this.#queries.transaction(async () => {
          operationEntered = true;
          const result = await this.#transactionContext.run(
            { lockedScopes: new Set() },
            operation,
          );
          operationCompleted = true;
          return result;
        });
      } catch (error) {
        if (error instanceof ManualAlexaVocFirstWriteRetryError) {
          if (attempt === 0) continue;
          throw new ManualAlexaVocRepositoryError("conflict", { cause: error });
        }
        if (error instanceof ManualAlexaVocRepositoryError) throw error;
        if (!operationEntered || operationCompleted || isPostgresDriverError(error)) {
          throw mapRepositoryError(error);
        }
        throw error;
      }
    }

    throw new ManualAlexaVocRepositoryError("conflict");
  }

  put(input: PutManualAlexaVocInput): Promise<ManualAlexaVocWriteResult> {
    return this.#execute(() => this.#put(input));
  }

  getCurrent(input: ManualAlexaVocScope): Promise<ManualAlexaVocRevision | null> {
    return this.#execute(async () => {
      const scope = validateScope(input);
      const result = await this.#queries.query<RevisionRow>(
        `SELECT r.organization_id, r.marketplace, r.asin,
                r.revision::text AS revision, r.content_hash, r.captured_at,
                r.normalized_record, r.normalized_schema_version, r.parser_version
           FROM manual_alexa_voc_heads h
           JOIN manual_alexa_voc_revisions r
             ON r.organization_id = h.organization_id
            AND r.marketplace = h.marketplace AND r.asin = h.asin
            AND r.revision = h.latest_revision
            AND r.content_hash = h.latest_content_hash
            AND r.captured_at = h.latest_captured_at
          WHERE h.organization_id = $1 AND h.marketplace = $2 AND h.asin = $3`,
        [scope.organizationId, scope.marketplace, scope.asin],
      );
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1) deserializeFailure();
      return mapRevision(result.rows[0]);
    });
  }

  listCurrent(input: Readonly<{
    organizationId: string;
    marketplace: "US";
    asins: readonly string[];
  }>): Promise<readonly ManualAlexaVocRevision[]> {
    return this.#execute(async () => {
      const scope = validateListScope(input);
      if (scope.asins.length === 0) return Object.freeze([]);
      const result = await this.#queries.query<RevisionRow>(
        `SELECT r.organization_id, r.marketplace, r.asin,
                r.revision::text AS revision, r.content_hash, r.captured_at,
                r.normalized_record, r.normalized_schema_version, r.parser_version
           FROM manual_alexa_voc_heads h
           JOIN manual_alexa_voc_revisions r
             ON r.organization_id = h.organization_id
            AND r.marketplace = h.marketplace AND r.asin = h.asin
            AND r.revision = h.latest_revision
            AND r.content_hash = h.latest_content_hash
            AND r.captured_at = h.latest_captured_at
          WHERE h.organization_id = $1 AND h.marketplace = $2
            AND h.asin = ANY($3::text[])
          ORDER BY h.asin`,
        [scope.organizationId, scope.marketplace, [...scope.asins]],
      );
      return Object.freeze(result.rows.map(mapRevision));
    });
  }

  listAtCutoff(input: Readonly<{
    organizationId: string;
    marketplace: "US";
    asins: readonly string[];
    dataCutoffAt: string;
  }>): Promise<readonly ManualAlexaVocRevision[]> {
    return this.#execute(async () => {
      const scope = validateListScope(input);
      const dataCutoffAt = normalizeDateTime(input.dataCutoffAt);
      if (scope.asins.length === 0) return Object.freeze([]);
      const result = await this.#queries.query<RevisionRow>(
        `SELECT DISTINCT ON (asin) organization_id, marketplace, asin,
                revision::text AS revision, content_hash, captured_at,
                normalized_record, normalized_schema_version, parser_version
           FROM manual_alexa_voc_revisions
          WHERE organization_id = $1 AND marketplace = $2
            AND asin = ANY($3::text[]) AND captured_at <= $4::timestamptz
          ORDER BY asin, captured_at DESC, revision DESC`,
        [scope.organizationId, scope.marketplace, [...scope.asins], dataCutoffAt],
      );
      return Object.freeze(result.rows.map(mapRevision));
    });
  }

  lockScopes(input: Readonly<{
    organizationId: string;
    marketplace: "US";
    asins: readonly string[];
  }>): Promise<void> {
    return this.#execute(async () => {
      const context = this.#requireTransaction();
      const scope = validateListScope(input);
      for (const asin of scope.asins) {
        const key = scopeKey({ ...scope, asin });
        if (context.lockedScopes.has(key)) continue;
        await this.#queries.query(
          "SELECT pg_advisory_xact_lock(hashtextextended(encode($1::bytea, 'hex'), 0))",
          [Buffer.from(`manual-voc\0${key}`, "utf8")],
        );
        context.lockedScopes.add(key);
      }
    });
  }

  peekNextRevision(input: ManualAlexaVocScope): Promise<string> {
    return this.#execute(async () => {
      const scope = validateScope(input);
      this.#requireLocked(scope);
      const result = await this.#queries.query<{ latest_revision: unknown }>(
        `SELECT latest_revision::text AS latest_revision
           FROM manual_alexa_voc_heads
          WHERE organization_id = $1 AND marketplace = $2 AND asin = $3`,
        [scope.organizationId, scope.marketplace, scope.asin],
      );
      if (result.rows.length === 0) return "1";
      if (result.rows.length !== 1) deserializeFailure();
      return incrementCounter(result.rows[0]?.latest_revision);
    });
  }

  readDatabaseClock(): Promise<string> {
    return this.#execute(async () => {
      this.#requireTransaction();
      const result = await this.#queries.query<{ captured_at: unknown }>(
        "SELECT clock_timestamp() AS captured_at",
      );
      if (result.rows.length !== 1) deserializeFailure();
      return serializeDateTime(result.rows[0]?.captured_at);
    });
  }

  claimRunCreation(input: RunCreationClaimInput): Promise<RunCreationClaim> {
    return this.#execute(async () => {
      this.#requireTransaction();
      const claim = validateRunCreationClaimInput(input);
      await this.#queries.query(
        "SELECT pg_advisory_xact_lock(hashtextextended(encode($1::bytea, 'hex'), 0))",
        [Buffer.from(
          `manual-voc-run-creation\0${claim.organizationId}\0${claim.idempotencyKey}`,
          "utf8",
        )],
      );
      const result = await this.#queries.query<RunCreationRow>(
        `SELECT request_fingerprint, run_id, snapshot_id, completed_at
           FROM run_creation_idempotency
          WHERE organization_id = $1 AND idempotency_key = $2
          FOR UPDATE`,
        [claim.organizationId, claim.idempotencyKey],
      );
      if (result.rows.length === 0) {
        return this.#adaptLegacyRunCreation(claim);
      }
      if (result.rows.length !== 1) deserializeFailure();
      const existing = result.rows[0]!;
      if (existing.request_fingerprint !== claim.fingerprint) {
        return Object.freeze({
          kind: "conflict",
          code: "IDEMPOTENCY_KEY_REUSED",
        });
      }
      if (
        typeof existing.run_id === "string" &&
        typeof existing.snapshot_id === "string" &&
        existing.completed_at !== null
      ) {
        serializeDateTime(existing.completed_at);
        return Object.freeze({
          kind: "replay",
          runId: existing.run_id,
          snapshotId: existing.snapshot_id,
        });
      }
      return Object.freeze({ kind: "winner" });
    });
  }

  completeRunCreation(input: RunCreationCompleteInput): Promise<void> {
    return this.#execute(() => this.#completeRunCreation(input));
  }

  leasePublication(input: Readonly<{
    ownerId: string;
    leasedAt: string;
    leaseDurationMs: number;
  }>): Promise<ManualAlexaVocOutboxLease | null> {
    return this.#execute(() => this.#transactional(async () => {
      const ownerId = validateIdentifier(input.ownerId);
      const leasedAt = normalizeDateTime(input.leasedAt);
      if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs <= 0) {
        conflictFailure();
      }
      const leaseExpiresAt = addMilliseconds(leasedAt, input.leaseDurationMs);
      const result = await this.#queries.query<OutboxLeaseRow>(
        `WITH candidate AS (
           SELECT id
             FROM manual_alexa_voc_publication_outbox
            WHERE attempt_count < 2147483647
              AND (
                (status IN ('pending', 'failed') AND available_at <= $1::timestamptz)
                OR (status = 'leased' AND lease_expires_at <= $1::timestamptz)
              )
            ORDER BY available_at, created_at, id
            FOR UPDATE SKIP LOCKED
            LIMIT 1
         )
         UPDATE manual_alexa_voc_publication_outbox o
            SET status = 'leased', leased_by = $2, lease_expires_at = $3::timestamptz,
                lease_generation = o.lease_generation + 1,
                attempt_count = o.attempt_count + 1, updated_at = $1::timestamptz
           FROM candidate
          WHERE o.id = candidate.id
        RETURNING o.organization_id, o.marketplace, o.asin,
                  o.revision::text AS revision, o.content_hash,
                  o.generation::text AS generation,
                  o.lease_generation::text AS lease_generation,
                  o.leased_by, o.lease_expires_at`,
        [leasedAt, ownerId, leaseExpiresAt],
      );
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1) deserializeFailure();
      return mapOutboxLease(result.rows[0]);
    }));
  }

  markPublicationApplied(
    input: ManualAlexaVocOutboxLease & Readonly<{ appliedAt: string }>,
  ): Promise<void> {
    return this.#execute(() => this.#transactional(async () => {
      const lease = validateOutboxLease(input);
      const appliedAt = normalizeDateTime(input.appliedAt);
      const result = await this.#queries.query(
        `UPDATE manual_alexa_voc_publication_outbox
            SET status = 'applied', leased_by = NULL, lease_expires_at = NULL,
                last_error_json = NULL, applied_at = $1::timestamptz,
                updated_at = $1::timestamptz
          WHERE organization_id = $2 AND marketplace = $3 AND asin = $4
            AND revision = $5::bigint AND content_hash = $6
            AND generation = $7::bigint AND status = 'leased'
            AND leased_by = $8 AND lease_expires_at = $9::timestamptz
            AND lease_generation = $10::bigint
            AND $1::timestamptz <= lease_expires_at
            AND clock_timestamp() <= lease_expires_at`,
        [
          appliedAt,
          lease.organizationId,
          lease.marketplace,
          lease.asin,
          lease.revision,
          lease.contentHash,
          lease.generation,
          lease.leaseOwner,
          lease.leaseExpiresAt,
          lease.leaseGeneration,
        ],
      );
      if (result.rowCount !== 1) conflictFailure();
    }));
  }

  markPublicationFailed(
    input: ManualAlexaVocOutboxLease & Readonly<{
      failedAt: string;
      nextAttemptAt: string;
      errorCode: string;
    }>,
  ): Promise<void> {
    return this.#execute(() => this.#transactional(async () => {
      const lease = validateOutboxLease(input);
      const failedAt = normalizeDateTime(input.failedAt);
      const nextAttemptAt = normalizeDateTime(input.nextAttemptAt);
      if (nextAttemptAt < failedAt) conflictFailure();
      const errorCode = validateIdentifier(input.errorCode);
      const result = await this.#queries.query(
        `UPDATE manual_alexa_voc_publication_outbox
            SET status = 'failed', available_at = $1::timestamptz,
                leased_by = NULL, lease_expires_at = NULL,
                last_error_json = $2::jsonb, applied_at = NULL,
                updated_at = $3::timestamptz
          WHERE organization_id = $4 AND marketplace = $5 AND asin = $6
            AND revision = $7::bigint AND content_hash = $8
            AND generation = $9::bigint AND status = 'leased'
            AND leased_by = $10 AND lease_expires_at = $11::timestamptz
            AND lease_generation = $12::bigint
            AND $3::timestamptz <= lease_expires_at
            AND clock_timestamp() <= lease_expires_at`,
        [
          nextAttemptAt,
          JSON.stringify({ code: errorCode }),
          failedAt,
          lease.organizationId,
          lease.marketplace,
          lease.asin,
          lease.revision,
          lease.contentHash,
          lease.generation,
          lease.leaseOwner,
          lease.leaseExpiresAt,
          lease.leaseGeneration,
        ],
      );
      if (result.rowCount !== 1) conflictFailure();
    }));
  }

  reconcilePublication(input: Readonly<{ reconciledAt: string }>): Promise<number> {
    return this.#execute(() => this.#transactional(async () => {
      const reconciledAt = normalizeDateTime(input.reconciledAt);
      const requeued = await this.#queries.query(
        `UPDATE manual_alexa_voc_publication_outbox
            SET status = 'pending', available_at = $1::timestamptz,
                leased_by = NULL, lease_expires_at = NULL,
                applied_at = NULL, updated_at = $1::timestamptz
          WHERE (status = 'failed' AND available_at <= $1::timestamptz)
             OR (status = 'leased' AND lease_expires_at <= $1::timestamptz)`,
        [reconciledAt],
      );
      const repaired = await this.#queries.query<{ id: string }>(
        `INSERT INTO manual_alexa_voc_publication_outbox (
           id, organization_id, marketplace, asin, revision, content_hash,
           captured_at, generation, status, available_at, lease_generation,
           attempt_count, created_at, updated_at
         )
         SELECT 'manual-voc-' || md5(jsonb_build_array(h.organization_id,
                  h.marketplace, h.asin, h.latest_revision::text,
                  h.latest_content_hash)::text),
                h.organization_id, h.marketplace, h.asin, h.latest_revision,
                h.latest_content_hash, h.latest_captured_at, h.generation,
                'pending', $1::timestamptz, 0, 0,
                $1::timestamptz, $1::timestamptz
           FROM manual_alexa_voc_heads h
          WHERE NOT EXISTS (
            SELECT 1 FROM manual_alexa_voc_publication_outbox o
             WHERE o.organization_id = h.organization_id
               AND o.marketplace = h.marketplace AND o.asin = h.asin
               AND o.revision = h.latest_revision
               AND o.content_hash = h.latest_content_hash
          )
         ON CONFLICT (organization_id, marketplace, asin, revision, content_hash)
         DO NOTHING
         RETURNING id`,
        [reconciledAt],
      );
      return (requeued.rowCount ?? 0) + repaired.rows.length;
    }));
  }

  readRawEnvelope(
    input: ManualAlexaVocScope & Readonly<{ revision: string }>,
  ): Promise<ManualAlexaVocRawEnvelopeRecord | null> {
    return this.#execute(async () => {
      const scope = validateScope(input);
      const revision = validateCounter(input.revision);
      const result = await this.#queries.query<RawEnvelopeRow>(
        `${rawEnvelopeSelect}
          WHERE organization_id = $1 AND marketplace = $2 AND asin = $3
            AND revision = $4::bigint AND raw_report_alg_version IS NOT NULL`,
        [scope.organizationId, scope.marketplace, scope.asin, revision],
      );
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1) deserializeFailure();
      return mapRawEnvelope(result.rows[0]);
    });
  }

  listRawEnvelopesForRewrap(
    input: Parameters<ManualAlexaVocRepository["listRawEnvelopesForRewrap"]>[0],
  ): Promise<readonly ManualAlexaVocRawEnvelopeRecord[]> {
    return this.#execute(async () => {
      const organizationId = validateOrganizationId(input.organizationId);
      const activeKeyId = validateIdentifier(input.activeKeyId);
      const limit = validateLimit(input.limit);
      const result = await this.#queries.query<RawEnvelopeRow>(
        `${rawEnvelopeSelect}
          WHERE organization_id = $1 AND raw_report_alg_version IS NOT NULL
            AND raw_report_key_id <> $2
          ORDER BY captured_at, marketplace, asin, revision
          LIMIT $3`,
        [organizationId, activeKeyId, limit],
      );
      return Object.freeze(result.rows.map(mapRawEnvelope));
    });
  }

  rewrapRawEnvelope(
    input: Parameters<ManualAlexaVocRepository["rewrapRawEnvelope"]>[0],
  ): Promise<boolean> {
    return this.#execute(async () => {
      this.#requireTransaction();
      const scope = validateScope(input.record);
      const revision = validateCounter(input.record.revision);
      const actorUserId = validateIdentifier(input.actorUserId);
      const occurredAt = normalizeDateTime(input.occurredAt);
      const rewrapped = validateRaw(input.rewrapped);
      await this.#requireActiveActor(scope.organizationId, actorUserId);
      const selected = await this.#queries.query<RawEnvelopeRow>(
        `${rawEnvelopeSelect}
          WHERE organization_id = $1 AND marketplace = $2 AND asin = $3
            AND revision = $4::bigint AND raw_report_alg_version IS NOT NULL
          FOR UPDATE`,
        [scope.organizationId, scope.marketplace, scope.asin, revision],
      );
      if (selected.rows.length === 0) return false;
      if (selected.rows.length !== 1) deserializeFailure();
      const current = mapRawEnvelope(selected.rows[0]);
      if (current.raw.keyId === rewrapped.keyId) return false;
      if (
        !isDeepStrictEqual(current, input.record) ||
        !isRewrapOnly(current.raw, rewrapped)
      ) conflictFailure();
      const updated = await this.#queries.query(
        `UPDATE manual_alexa_voc_revisions
            SET raw_report_key_id = $1, raw_report_wrapped_dek = $2
          WHERE organization_id = $3 AND marketplace = $4 AND asin = $5
            AND revision = $6::bigint AND raw_report_key_id = $7
            AND raw_report_wrapped_dek = $8`,
        [
          rewrapped.keyId,
          Buffer.from(rewrapped.wrappedDek),
          scope.organizationId,
          scope.marketplace,
          scope.asin,
          revision,
          current.raw.keyId,
          Buffer.from(current.raw.wrappedDek),
        ],
      );
      if (updated.rowCount !== 1) conflictFailure();
      await this.#queries.query(
        `INSERT INTO manual_alexa_voc_access_audit (
           id, organization_id, actor_user_id, marketplace, asin,
           revision, purpose, result, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6::bigint,
                   'key-rewrap', 'allowed', $7::timestamptz)`,
        [
          randomUUID(),
          scope.organizationId,
          actorUserId,
          scope.marketplace,
          scope.asin,
          revision,
          occurredAt,
        ],
      );
      return true;
    });
  }

  recordRawAccess(
    input: Parameters<ManualAlexaVocRepository["recordRawAccess"]>[0],
  ): Promise<void> {
    return this.#execute(async () => {
      this.#requireTransaction();
      const scope = validateScope(input);
      const id = validateEntityId(input.id);
      const revision = validateCounter(input.revision);
      const actorUserId = validateIdentifier(input.actorUserId);
      const occurredAt = normalizeDateTime(input.occurredAt);
      if (!rawAccessPurposes.has(input.purpose)) conflictFailure();
      const result = rawAccessResults.get(input.result);
      if (!result) conflictFailure();
      await this.#requireActiveActor(scope.organizationId, actorUserId);
      const revisionExists = await this.#queries.query(
        `SELECT 1 FROM manual_alexa_voc_revisions
          WHERE organization_id = $1 AND marketplace = $2 AND asin = $3
            AND revision = $4::bigint`,
        [scope.organizationId, scope.marketplace, scope.asin, revision],
      );
      await this.#queries.query(
        `INSERT INTO manual_alexa_voc_access_audit (
           id, organization_id, actor_user_id, marketplace, asin,
           revision, purpose, result, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6::bigint, $7, $8, $9::timestamptz)`,
        [
          id,
          scope.organizationId,
          actorUserId,
          scope.marketplace,
          scope.asin,
          revisionExists.rows.length === 1 ? revision : null,
          input.purpose,
          result,
          occurredAt,
        ],
      );
    });
  }

  listRawAccessAudit(
    input: Parameters<ManualAlexaVocRepository["listRawAccessAudit"]>[0],
  ): Promise<readonly ManualAlexaVocRawAccessAuditEvent[]> {
    return this.#execute(async () => {
      const organizationId = validateOrganizationId(input.organizationId);
      const requestedByUserId = validateIdentifier(input.requestedByUserId);
      const limit = validateLimit(input.limit);
      await this.#requireActiveAdmin(organizationId, requestedByUserId);
      const result = await this.#queries.query<RawAccessAuditRow>(
        `SELECT id, organization_id, actor_user_id, marketplace, asin,
                revision::text AS revision, purpose, result, created_at
           FROM manual_alexa_voc_access_audit
          WHERE organization_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT $2`,
        [organizationId, limit],
      );
      return Object.freeze(result.rows.map(mapRawAccessAudit));
    });
  }

  clearExpiredRaw(
    input: Parameters<ManualAlexaVocRepository["clearExpiredRaw"]>[0],
  ): Promise<number> {
    return this.#execute(async () => {
      this.#requireTransaction();
      const organizationId = validateOrganizationId(input.organizationId);
      const actorUserId = validateIdentifier(input.actorUserId);
      const before = normalizeDateTime(input.before);
      const clearedAt = normalizeDateTime(input.clearedAt);
      const limit = validateLimit(input.limit ?? 100);
      await this.#requireActiveActor(organizationId, actorUserId);
      const cleared = await this.#queries.query<RawRevisionRow>(
        `WITH expired AS (
           SELECT organization_id, marketplace, asin, revision
             FROM manual_alexa_voc_revisions
            WHERE organization_id = $1 AND captured_at < $2::timestamptz
              AND raw_report_alg_version IS NOT NULL
            ORDER BY captured_at, marketplace, asin, revision
            LIMIT $3
            FOR UPDATE
         )
         UPDATE manual_alexa_voc_revisions r
            SET raw_report_alg_version = NULL, raw_report_key_id = NULL,
                raw_report_wrapped_dek = NULL, raw_report_nonce = NULL,
                raw_report_ciphertext = NULL, raw_report_tag = NULL,
                raw_report_aad_sha256 = NULL
           FROM expired e
          WHERE r.organization_id = e.organization_id
            AND r.marketplace = e.marketplace AND r.asin = e.asin
            AND r.revision = e.revision
        RETURNING r.marketplace, r.asin, r.revision::text AS revision`,
        [organizationId, before, limit],
      );
      for (const row of cleared.rows) {
        const scope = validateScope({
          organizationId,
          marketplace: row.marketplace as "US",
          asin: String(row.asin),
        });
        const revision = validateCounter(row.revision);
        await this.#queries.query(
          `INSERT INTO manual_alexa_voc_access_audit (
             id, organization_id, actor_user_id, marketplace, asin,
             revision, purpose, result, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6::bigint,
                     'delete-policy', 'allowed', $7::timestamptz)`,
          [
            randomUUID(),
            organizationId,
            actorUserId,
            scope.marketplace,
            scope.asin,
            revision,
            clearedAt,
          ],
        );
      }
      return cleared.rows.length;
    });
  }

  async #put(input: PutManualAlexaVocInput): Promise<ManualAlexaVocWriteResult> {
    try {
      return await this.#putAttempt(input);
    } catch (error) {
      if (isFirstWriteRevisionOrHeadConflict(error)) {
        throw new ManualAlexaVocFirstWriteRetryError({ cause: error });
      }
      throw error;
    }
  }

  async #putAttempt(
    input: PutManualAlexaVocInput,
  ): Promise<ManualAlexaVocWriteResult> {
    const validated = validatePutInput(input);
    this.#requireLocked(validated);
    await this.#requireActiveActor(validated.organizationId, validated.createdBy);
    const headResult = await this.#queries.query<HeadRow>(
      `SELECT latest_revision::text AS latest_revision,
              latest_content_hash, latest_captured_at,
              generation::text AS generation
         FROM manual_alexa_voc_heads
        WHERE organization_id = $1 AND marketplace = $2 AND asin = $3
        FOR UPDATE`,
      [validated.organizationId, validated.marketplace, validated.asin],
    );
    if (headResult.rows.length > 1) deserializeFailure();
    const head = headResult.rows[0];

    if (head && head.latest_content_hash === validated.contentHash) {
      const revision = validateCounter(head.latest_revision);
      const generation = validateCounter(head.generation);
      const revisionResult = await this.#queries.query<RevisionRow>(
        `SELECT organization_id, marketplace, asin, revision::text AS revision,
                content_hash, captured_at, normalized_record,
                normalized_schema_version, parser_version
           FROM manual_alexa_voc_revisions
          WHERE organization_id = $1 AND marketplace = $2 AND asin = $3
            AND revision = $4::bigint`,
        [
          validated.organizationId,
          validated.marketplace,
          validated.asin,
          revision,
        ],
      );
      if (revisionResult.rows.length !== 1) deserializeFailure();
      const record = mapRevision(revisionResult.rows[0]);
      const status = await this.#repairOutbox(record, generation);
      return Object.freeze({
        record,
        idempotent: true,
        publication: Object.freeze({ status, generation }),
      });
    }

    const nextRevision = head ? incrementCounter(head.latest_revision) : "1";
    if (validated.expectedRevision !== nextRevision) conflictFailure();
    const generation = head ? incrementCounter(head.generation) : "1";
    const capturedAt = await this.#readClock();
    await this.#queries.query(
      `INSERT INTO manual_alexa_voc_revisions (
         organization_id, marketplace, asin, revision, content_hash,
         captured_at, normalized_record, normalized_schema_version,
         parser_version, raw_report_sha256, raw_report_alg_version,
         raw_report_key_id, raw_report_wrapped_dek, raw_report_nonce,
         raw_report_ciphertext, raw_report_tag, raw_report_aad_sha256,
         raw_report_plaintext_bytes, created_by, created_at
       ) VALUES ($1, $2, $3, $4::bigint, $5, $6::timestamptz, $7::jsonb,
                 $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
                 $18, $19, $6::timestamptz)`,
      [
        validated.organizationId,
        validated.marketplace,
        validated.asin,
        nextRevision,
        validated.contentHash,
        capturedAt,
        JSON.stringify(validated.normalizedRecord),
        validated.normalizedSchemaVersion,
        validated.parserVersion,
        validated.raw.plaintextSha256,
        validated.raw.algVersion,
        validated.raw.keyId,
        Buffer.from(validated.raw.wrappedDek),
        Buffer.from(validated.raw.nonce),
        Buffer.from(validated.raw.ciphertext),
        Buffer.from(validated.raw.tag),
        validated.raw.aadSha256,
        validated.raw.plaintextBytes,
        validated.createdBy,
      ],
    );

    if (head) {
      const previousCapturedAt = serializeDateTime(head.latest_captured_at);
      const update = await this.#queries.query(
        `UPDATE manual_alexa_voc_heads
            SET latest_revision = $1::bigint, latest_content_hash = $2,
                latest_captured_at = $3::timestamptz,
                generation = $4::bigint, updated_at = $3::timestamptz
          WHERE organization_id = $5 AND marketplace = $6 AND asin = $7
            AND latest_revision = $8::bigint AND latest_content_hash = $9
            AND latest_captured_at = $10::timestamptz`,
        [
          nextRevision,
          validated.contentHash,
          capturedAt,
          generation,
          validated.organizationId,
          validated.marketplace,
          validated.asin,
          validateCounter(head.latest_revision),
          validateSha256(head.latest_content_hash),
          previousCapturedAt,
        ],
      );
      if (update.rowCount !== 1) conflictFailure();
    } else {
      await this.#queries.query(
        `INSERT INTO manual_alexa_voc_heads (
           organization_id, marketplace, asin, latest_revision,
           latest_content_hash, latest_captured_at, generation, updated_at
         ) VALUES ($1, $2, $3, $4::bigint, $5, $6::timestamptz,
                   $7::bigint, $6::timestamptz)`,
        [
          validated.organizationId,
          validated.marketplace,
          validated.asin,
          nextRevision,
          validated.contentHash,
          capturedAt,
          generation,
        ],
      );
    }
    await this.#insertOutbox({
      organizationId: validated.organizationId,
      marketplace: validated.marketplace,
      asin: validated.asin,
      revision: nextRevision,
      contentHash: validated.contentHash,
      capturedAt,
      generation,
    });
    await this.#queries.query(
      `INSERT INTO manual_alexa_voc_access_audit (
         id, organization_id, actor_user_id, marketplace, asin,
         revision, purpose, result, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6::bigint,
                 'create', 'allowed', $7::timestamptz)`,
      [
        randomUUID(),
        validated.organizationId,
        validated.createdBy,
        validated.marketplace,
        validated.asin,
        nextRevision,
        capturedAt,
      ],
    );
    return Object.freeze({
      record: Object.freeze({
        organizationId: validated.organizationId,
        marketplace: validated.marketplace,
        asin: validated.asin,
        revision: nextRevision,
        contentHash: validated.contentHash,
        capturedAt,
        normalizedRecord: validated.normalizedRecord,
        normalizedSchemaVersion: validated.normalizedSchemaVersion,
        parserVersion: validated.parserVersion,
      }),
      idempotent: false,
      publication: Object.freeze({ status: "pending", generation }),
    });
  }

  async #repairOutbox(
    record: ManualAlexaVocRevision,
    generation: string,
  ): Promise<"pending" | "deduplicated"> {
    const inserted = await this.#queries.query(
      `INSERT INTO manual_alexa_voc_publication_outbox (
         id, organization_id, marketplace, asin, revision, content_hash,
         captured_at, generation, status, available_at, lease_generation,
         attempt_count, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5::bigint, $6, $7::timestamptz,
                 $8::bigint, 'pending', $7::timestamptz, 0, 0,
                 $7::timestamptz, $7::timestamptz)
       ON CONFLICT (organization_id, marketplace, asin, revision, content_hash)
       DO NOTHING`,
      [
        randomUUID(),
        record.organizationId,
        record.marketplace,
        record.asin,
        record.revision,
        record.contentHash,
        record.capturedAt,
        generation,
      ],
    );
    if (inserted.rowCount === 1) return "pending";
    const existing = await this.#queries.query<OutboxStatusRow>(
      `SELECT status FROM manual_alexa_voc_publication_outbox
        WHERE organization_id = $1 AND marketplace = $2 AND asin = $3
          AND revision = $4::bigint AND content_hash = $5
        FOR UPDATE`,
      [
        record.organizationId,
        record.marketplace,
        record.asin,
        record.revision,
        record.contentHash,
      ],
    );
    if (existing.rows.length !== 1 || typeof existing.rows[0]?.status !== "string") {
      deserializeFailure();
    }
    if (existing.rows[0]!.status !== "failed") return "deduplicated";
    const repaired = await this.#queries.query(
      `UPDATE manual_alexa_voc_publication_outbox
          SET status = 'pending', available_at = $1::timestamptz,
              leased_by = NULL, lease_expires_at = NULL,
              last_error_json = NULL,
              applied_at = NULL, updated_at = $1::timestamptz
        WHERE organization_id = $2 AND marketplace = $3 AND asin = $4
          AND revision = $5::bigint AND content_hash = $6 AND status = 'failed'`,
      [
        record.capturedAt,
        record.organizationId,
        record.marketplace,
        record.asin,
        record.revision,
        record.contentHash,
      ],
    );
    return repaired.rowCount === 1 ? "pending" : "deduplicated";
  }

  #insertOutbox(input: Readonly<{
    organizationId: string;
    marketplace: "US";
    asin: string;
    revision: string;
    contentHash: string;
    capturedAt: string;
    generation: string;
  }>): Promise<QueryResult<QueryResultRow>> {
    return this.#queries.query(
      `INSERT INTO manual_alexa_voc_publication_outbox (
         id, organization_id, marketplace, asin, revision, content_hash,
         captured_at, generation, status, available_at, lease_generation,
         attempt_count, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5::bigint, $6, $7::timestamptz,
                 $8::bigint, 'pending', $7::timestamptz, 0, 0,
                 $7::timestamptz, $7::timestamptz)`,
      [
        randomUUID(),
        input.organizationId,
        input.marketplace,
        input.asin,
        input.revision,
        input.contentHash,
        input.capturedAt,
        input.generation,
      ],
    );
  }

  async #completeRunCreation(input: RunCreationCompleteInput): Promise<void> {
    this.#requireTransaction();
    const claim = validateRunCreationClaimInput(input);
    const completedAt = normalizeDateTime(input.completedAt);
    const runId = validateIdentifier(input.runId);
    const snapshotId = validateIdentifier(input.snapshotId);
    const target = await this.#queries.query<{ project_id: unknown }>(
      `SELECT r.project_id
         FROM analysis_runs r
         JOIN projects p ON p.id = r.project_id
         JOIN data_snapshots s ON s.run_id = r.id
        WHERE p.organization_id = $1 AND r.id = $2 AND s.id = $3`,
      [claim.organizationId, runId, snapshotId],
    );
    if (target.rows.length !== 1 || typeof target.rows[0]?.project_id !== "string") {
      conflictFailure();
    }
    const existing = await this.#queries.query<RunCreationRow>(
      `SELECT request_fingerprint, project_id, run_id, snapshot_id, completed_at
         FROM run_creation_idempotency
        WHERE organization_id = $1 AND idempotency_key = $2
        FOR UPDATE`,
      [claim.organizationId, claim.idempotencyKey],
    );
    if (existing.rows.length > 1) deserializeFailure();
    const row = existing.rows[0];
    if (row) {
      if (row.request_fingerprint !== claim.fingerprint) conflictFailure();
      if (row.completed_at !== null) {
        if (
          row.run_id !== runId ||
          row.snapshot_id !== snapshotId ||
          serializeDateTime(row.completed_at) !== completedAt
        ) conflictFailure();
        return;
      }
      const updated = await this.#queries.query(
        `UPDATE run_creation_idempotency
            SET run_id = $1, snapshot_id = $2, completed_at = $3::timestamptz
          WHERE organization_id = $4 AND idempotency_key = $5
            AND request_fingerprint = $6 AND completed_at IS NULL`,
        [
          runId,
          snapshotId,
          completedAt,
          claim.organizationId,
          claim.idempotencyKey,
          claim.fingerprint,
        ],
      );
      if (updated.rowCount !== 1) conflictFailure();
      return;
    }
    await this.#queries.query(
      `INSERT INTO run_creation_idempotency (
         organization_id, idempotency_key, request_fingerprint, project_id,
         run_id, snapshot_id, created_at, completed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $7::timestamptz)`,
      [
        claim.organizationId,
        claim.idempotencyKey,
        claim.fingerprint,
        target.rows[0]!.project_id,
        runId,
        snapshotId,
        completedAt,
      ],
    );
  }

  async #adaptLegacyRunCreation(
    claim: RunCreationClaimInput,
  ): Promise<RunCreationClaim> {
    const result = await this.#queries.query<LegacyRunCreationRow>(
      `SELECT r.id AS run_id, r.project_id, r.mode,
              r.created_at AS run_created_at, p.marketplace, p.asins_json,
              s.id AS snapshot_id, s.created_at AS snapshot_created_at
         FROM analysis_runs r
         JOIN projects p ON p.id = r.project_id
         LEFT JOIN data_snapshots s
           ON s.run_id = r.id AND s.snapshot_kind = 'voc'
        WHERE p.organization_id = $1 AND r.idempotency_key = $2
        ORDER BY r.created_at, r.id, s.created_at, s.id
        FOR UPDATE OF r`,
      [claim.organizationId, claim.idempotencyKey],
    );
    if (result.rows.length === 0) return Object.freeze({ kind: "winner" });
    const runIds = new Set(result.rows.map((row) => String(row.run_id)));
    const row = result.rows[0];
    if (
      result.rows.length !== 1 ||
      runIds.size !== 1 ||
      !row ||
      typeof row.run_id !== "string" ||
      typeof row.project_id !== "string" ||
      (row.mode !== "existing-data" && row.mode !== "collect-missing") ||
      row.marketplace !== "US" ||
      !Array.isArray(row.asins_json) ||
      row.asins_json.length === 0 ||
      typeof row.snapshot_id !== "string" ||
      row.run_created_at === null ||
      row.run_created_at === undefined ||
      row.snapshot_created_at === null ||
      row.snapshot_created_at === undefined
    ) {
      return Object.freeze({
        kind: "conflict",
        code: "IDEMPOTENCY_KEY_REUSED",
      });
    }
    let asins: string[];
    try {
      asins = row.asins_json.map((asin) => AsinSchema.parse(asin));
    } catch {
      deserializeFailure();
    }
    const reconstructed = createRunCreationFingerprint({
      organizationId: claim.organizationId,
      projectId: row.project_id,
      marketplace: "US",
      asins: asins!,
      mode: row.mode,
    });
    if (reconstructed !== claim.fingerprint) {
      return Object.freeze({
        kind: "conflict",
        code: "IDEMPOTENCY_KEY_REUSED",
      });
    }
    const createdAt = serializeDateTime(row.run_created_at);
    const completedAt = serializeDateTime(row.snapshot_created_at);
    await this.#queries.query(
      `INSERT INTO run_creation_idempotency (
         organization_id, idempotency_key, request_fingerprint, project_id,
         run_id, snapshot_id, created_at, completed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz)`,
      [
        claim.organizationId,
        claim.idempotencyKey,
        claim.fingerprint,
        row.project_id,
        row.run_id,
        row.snapshot_id,
        createdAt,
        completedAt,
      ],
    );
    return Object.freeze({
      kind: "replay",
      runId: row.run_id,
      snapshotId: row.snapshot_id,
    });
  }

  async #readClock(): Promise<string> {
    const result = await this.#queries.query<{ captured_at: unknown }>(
      "SELECT clock_timestamp() AS captured_at",
    );
    if (result.rows.length !== 1) deserializeFailure();
    return serializeDateTime(result.rows[0]?.captured_at);
  }

  async #requireActiveActor(
    organizationId: string,
    actorUserId: string,
  ): Promise<void> {
    const result = await this.#queries.query<{ status: unknown }>(
      `SELECT status FROM users
        WHERE id = $1 AND organization_id = $2`,
      [actorUserId, organizationId],
    );
    if (result.rows.length !== 1 || result.rows[0]?.status !== "active") {
      throw new ManualAlexaVocRepositoryError("permission");
    }
  }

  async #requireActiveAdmin(
    organizationId: string,
    actorUserId: string,
  ): Promise<void> {
    const result = await this.#queries.query<{ status: unknown; role: unknown }>(
      `SELECT status, role FROM users
        WHERE id = $1 AND organization_id = $2`,
      [actorUserId, organizationId],
    );
    if (
      result.rows.length !== 1 ||
      result.rows[0]?.status !== "active" ||
      result.rows[0]?.role !== "admin"
    ) {
      throw new ManualAlexaVocRepositoryError("permission");
    }
  }

  #requireTransaction(): ManualAlexaVocTransactionContext {
    const context = this.#transactionContext.getStore();
    if (!context) conflictFailure();
    return context;
  }

  #requireLocked(scope: ManualAlexaVocScope): void {
    const context = this.#requireTransaction();
    if (!context.lockedScopes.has(scopeKey(scope))) conflictFailure();
  }

  #transactional<Result>(operation: () => Promise<Result>): Promise<Result> {
    return this.#transactionContext.getStore() ? operation() : this.transaction(operation);
  }

  async #execute<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ManualAlexaVocFirstWriteRetryError) throw error;
      throw mapRepositoryError(error);
    }
  }
}

function validateOrganizationId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 200 ||
    value.trim() !== value
  ) conflictFailure();
  return value;
}

function validateIdentifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 200 ||
    value.trim() !== value
  ) conflictFailure();
  return value;
}

function validateEntityId(value: unknown): string {
  try {
    return EntityIdSchema.parse(value);
  } catch {
    return conflictFailure();
  }
}

function validateScope(input: ManualAlexaVocScope): ManualAlexaVocScope {
  try {
    if (input.marketplace !== "US") conflictFailure();
    return Object.freeze({
      organizationId: validateOrganizationId(input.organizationId),
      marketplace: "US" as const,
      asin: AsinSchema.parse(input.asin.trim().toUpperCase()),
    });
  } catch (error) {
    if (error instanceof ManualAlexaVocRepositoryError) throw error;
    return conflictFailure();
  }
}

function validateListScope(input: Readonly<{
  organizationId: string;
  marketplace: "US";
  asins: readonly string[];
}>): Readonly<{
  organizationId: string;
  marketplace: "US";
  asins: readonly string[];
}> {
  if (!Array.isArray(input.asins)) conflictFailure();
  const organizationId = validateOrganizationId(input.organizationId);
  if (input.marketplace !== "US") conflictFailure();
  try {
    const asins = [...new Set(input.asins.map((asin) =>
      AsinSchema.parse(asin.trim().toUpperCase()),
    ))].sort();
    return Object.freeze({
      organizationId,
      marketplace: "US" as const,
      asins: Object.freeze(asins),
    });
  } catch {
    return conflictFailure();
  }
}

function validateCounter(value: unknown): string {
  if (typeof value !== "string" || !decimalPattern.test(value)) conflictFailure();
  if (BigInt(value) > maximumCounter) conflictFailure();
  return value;
}

function incrementCounter(value: unknown): string {
  const numeric = BigInt(validateCounter(value));
  if (numeric >= maximumCounter) conflictFailure();
  return (numeric + BigInt(1)).toString();
}

function validateSha256(value: unknown): string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) conflictFailure();
  return value;
}

function normalizeDateTime(value: unknown): string {
  try {
    return new Date(DateTimeSchema.parse(value)).toISOString();
  } catch {
    return conflictFailure();
  }
}

function serializeDateTime(value: unknown): string {
  try {
    if (value instanceof Date) {
      if (!Number.isFinite(value.getTime())) throw new Error("invalid date");
      return value.toISOString();
    }
    return new Date(DateTimeSchema.parse(value)).toISOString();
  } catch {
    return deserializeFailure();
  }
}

function validateLimit(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 1_000) {
    conflictFailure();
  }
  return Number(value);
}

function validateRaw(
  raw: ManualAlexaVocRawEnvelopeRecord["raw"],
): ManualAlexaVocRawEnvelopeRecord["raw"] {
  if (
    raw.algVersion !== "AES-256-GCM/v1" ||
    typeof raw.keyId !== "string" ||
    raw.keyId.length < 1 ||
    raw.keyId.length > 200 ||
    !(raw.wrappedDek instanceof Uint8Array) ||
    raw.wrappedDek.byteLength !== 60 ||
    !(raw.nonce instanceof Uint8Array) ||
    raw.nonce.byteLength !== 12 ||
    !(raw.ciphertext instanceof Uint8Array) ||
    raw.ciphertext.byteLength < 1 ||
    raw.ciphertext.byteLength > 131_072 ||
    !(raw.tag instanceof Uint8Array) ||
    raw.tag.byteLength !== 16 ||
    !Number.isSafeInteger(raw.plaintextBytes) ||
    raw.plaintextBytes !== raw.ciphertext.byteLength
  ) conflictFailure();
  validateSha256(raw.aadSha256);
  validateSha256(raw.plaintextSha256);
  return raw;
}

function mapRawEnvelope(
  row: RawEnvelopeRow | undefined,
): ManualAlexaVocRawEnvelopeRecord {
  try {
    if (!row) throw new Error("missing row");
    const scope = validateScope({
      organizationId: String(row.organization_id),
      marketplace: String(row.marketplace) as "US",
      asin: String(row.asin),
    });
    if (
      row.normalized_schema_version !== "alexa-voc-record/v2" ||
      row.parser_version !== "deterministic-alexa-parser/v3"
    ) throw new Error("invalid metadata");
    return Object.freeze({
      ...scope,
      revision: validateCounter(String(row.revision)),
      contentHash: validateSha256(String(row.content_hash)),
      capturedAt: serializeDateTime(row.captured_at),
      normalizedSchemaVersion: "alexa-voc-record/v2" as const,
      parserVersion: "deterministic-alexa-parser/v3" as const,
      raw: Object.freeze(validateRaw({
        algVersion: String(row.raw_report_alg_version) as "AES-256-GCM/v1",
        keyId: String(row.raw_report_key_id),
        wrappedDek: Buffer.from(row.raw_report_wrapped_dek as Uint8Array),
        nonce: Buffer.from(row.raw_report_nonce as Uint8Array),
        ciphertext: Buffer.from(row.raw_report_ciphertext as Uint8Array),
        tag: Buffer.from(row.raw_report_tag as Uint8Array),
        aadSha256: String(row.raw_report_aad_sha256),
        plaintextBytes: Number(row.raw_report_plaintext_bytes),
        plaintextSha256: String(row.raw_report_sha256),
      })),
    });
  } catch {
    return deserializeFailure();
  }
}

function isRewrapOnly(
  before: ManualAlexaVocRawEnvelopeRecord["raw"],
  after: ManualAlexaVocRawEnvelopeRecord["raw"],
): boolean {
  return (
    before.algVersion === after.algVersion &&
    before.keyId !== after.keyId &&
    before.wrappedDek.byteLength === after.wrappedDek.byteLength &&
    isDeepStrictEqual(before.nonce, after.nonce) &&
    isDeepStrictEqual(before.ciphertext, after.ciphertext) &&
    isDeepStrictEqual(before.tag, after.tag) &&
    before.aadSha256 === after.aadSha256 &&
    before.plaintextBytes === after.plaintextBytes &&
    before.plaintextSha256 === after.plaintextSha256
  );
}

function mapRawAccessAudit(
  row: RawAccessAuditRow | undefined,
): ManualAlexaVocRawAccessAuditEvent {
  try {
    if (!row) throw new Error("missing row");
    const scope = validateScope({
      organizationId: String(row.organization_id),
      marketplace: String(row.marketplace) as "US",
      asin: String(row.asin),
    });
    const purpose = String(row.purpose);
    const result = storedRawAccessResults.get(row.result);
    if (!storedRawAccessPurposes.has(purpose) || !result) {
      throw new Error("invalid audit event");
    }
    return Object.freeze({
      ...scope,
      id: validateEntityId(String(row.id)),
      revision: row.revision === null
        ? null
        : validateCounter(String(row.revision)),
      actorUserId: validateIdentifier(String(row.actor_user_id)),
      purpose: purpose as ManualAlexaVocRawAccessAuditEvent["purpose"],
      result: result as ManualAlexaVocRawAccessAuditEvent["result"],
      occurredAt: serializeDateTime(row.created_at),
    });
  } catch {
    return deserializeFailure();
  }
}

function validatePutInput(input: PutManualAlexaVocInput): PutManualAlexaVocInput {
  const scope = validateScope(input);
  try {
    const normalizedRecord = ManualAlexaVocNormalizedRecordSchema.parse(
      input.normalizedRecord,
    );
    if (
      normalizedRecord.asin !== scope.asin ||
      input.normalizedSchemaVersion !== "alexa-voc-record/v2" ||
      input.parserVersion !== "deterministic-alexa-parser/v3" ||
      typeof input.createdBy !== "string" ||
      input.createdBy.length < 1 ||
      input.createdBy.length > 200 ||
      input.raw.algVersion !== "AES-256-GCM/v1"
    ) conflictFailure();
    validateRaw(input.raw);
    return Object.freeze({
      ...scope,
      createdBy: input.createdBy,
      expectedRevision: validateCounter(input.expectedRevision),
      normalizedRecord,
      normalizedSchemaVersion: input.normalizedSchemaVersion,
      parserVersion: input.parserVersion,
      contentHash: validateSha256(input.contentHash),
      raw: input.raw,
    });
  } catch (error) {
    if (error instanceof ManualAlexaVocRepositoryError) throw error;
    return conflictFailure();
  }
}

function validateOutboxLease(
  input: ManualAlexaVocOutboxLease,
): ManualAlexaVocOutboxLease {
  const scope = validateScope(input);
  return Object.freeze({
    ...scope,
    revision: validateCounter(input.revision),
    contentHash: validateSha256(input.contentHash),
    generation: validateCounter(input.generation),
    leaseGeneration: validateCounter(input.leaseGeneration),
    leaseOwner: validateIdentifier(input.leaseOwner),
    leaseExpiresAt: normalizeDateTime(input.leaseExpiresAt),
  });
}

function validateRunCreationClaimInput(
  input: RunCreationClaimInput,
): RunCreationClaimInput {
  if (
    typeof input.idempotencyKey !== "string" ||
    input.idempotencyKey.length < 1 ||
    input.idempotencyKey.length > 200
  ) conflictFailure();
  return Object.freeze({
    organizationId: validateOrganizationId(input.organizationId),
    idempotencyKey: input.idempotencyKey,
    fingerprint: validateSha256(input.fingerprint),
  });
}

function mapRevision(row: RevisionRow | undefined): ManualAlexaVocRevision {
  try {
    if (!row) throw new Error("missing row");
    const scope = validateScope({
      organizationId: String(row.organization_id),
      marketplace: String(row.marketplace) as "US",
      asin: String(row.asin),
    });
    if (
      row.normalized_schema_version !== "alexa-voc-record/v2" ||
      row.parser_version !== "deterministic-alexa-parser/v3"
    ) throw new Error("invalid metadata");
    const candidate = typeof row.normalized_record === "string"
      ? JSON.parse(row.normalized_record)
      : row.normalized_record;
    const normalizedRecord: ManualAlexaVocNormalizedRecord =
      ManualAlexaVocNormalizedRecordSchema.parse(candidate);
    if (normalizedRecord.asin !== scope.asin) throw new Error("ASIN mismatch");
    return Object.freeze({
      ...scope,
      revision: validateCounter(row.revision),
      contentHash: validateSha256(row.content_hash),
      capturedAt: serializeDateTime(row.captured_at),
      normalizedRecord,
      normalizedSchemaVersion: "alexa-voc-record/v2" as const,
      parserVersion: "deterministic-alexa-parser/v3" as const,
    });
  } catch {
    return deserializeFailure();
  }
}

function mapOutboxLease(
  row: OutboxLeaseRow | undefined,
): ManualAlexaVocOutboxLease {
  try {
    if (!row) throw new Error("missing row");
    return validateOutboxLease({
      organizationId: String(row.organization_id),
      marketplace: String(row.marketplace) as "US",
      asin: String(row.asin),
      revision: String(row.revision),
      contentHash: String(row.content_hash),
      generation: String(row.generation),
      leaseGeneration: String(row.lease_generation),
      leaseOwner: String(row.leased_by),
      leaseExpiresAt: serializeDateTime(row.lease_expires_at),
    });
  } catch {
    return deserializeFailure();
  }
}

function scopeKey(input: ManualAlexaVocScope): string {
  return `${input.organizationId}\0${input.marketplace}\0${input.asin}`;
}

function addMilliseconds(timestamp: string, durationMs: number): string {
  return new Date(new Date(timestamp).getTime() + durationMs).toISOString();
}

function conflictFailure(): never {
  throw new ManualAlexaVocRepositoryError("conflict");
}

function deserializeFailure(): never {
  throw new ManualAlexaVocRepositoryError("deserialize");
}

function postgresErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isPostgresDriverError(error: unknown): boolean {
  const code = postgresErrorCode(error);
  return Boolean(
    code && (/^[0-9A-Z]{5}$/.test(code) || code.startsWith("ECONN")),
  );
}

class ManualAlexaVocFirstWriteRetryError extends Error {
  constructor(options?: ErrorOptions) {
    super("Manual Alexa VOC first-write revision state changed", options);
    this.name = "ManualAlexaVocFirstWriteRetryError";
  }
}

function isFirstWriteRevisionOrHeadConflict(error: unknown): boolean {
  return postgresErrorCode(error) === "23505" && [
    "manual_alexa_voc_revisions_pkey",
    "manual_alexa_voc_heads_pkey",
  ].includes(String((error as { constraint?: unknown }).constraint));
}

function mapRepositoryError(error: unknown): Error {
  if (error instanceof ManualAlexaVocRepositoryError) return error;
  const code = postgresErrorCode(error);
  if (code === "57014") {
    return new ManualAlexaVocRepositoryError("timeout", { cause: error });
  }
  if (code === "42501") {
    return new ManualAlexaVocRepositoryError("permission", { cause: error });
  }
  if (
    code?.startsWith("ECONN") ||
    code?.startsWith("08") ||
    code === "57P01" ||
    code === "57P02" ||
    code === "57P03"
  ) {
    return new ManualAlexaVocRepositoryError("connection", { cause: error });
  }
  if (
    code === "23505" &&
    [
      "manual_alexa_voc_revisions_pkey",
      "manual_alexa_voc_heads_pkey",
    ].includes(String((error as { constraint?: unknown }).constraint))
  ) {
    return new ManualAlexaVocRepositoryError("conflict", { cause: error });
  }
  if (
    code === "42P01" ||
    code === "42703" ||
    code?.startsWith("23")
  ) {
    return new ManualAlexaVocRepositoryError("schema", { cause: error });
  }
  return new ManualAlexaVocRepositoryError("connection", { cause: error });
}
