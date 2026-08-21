import type { QueryResultRow } from "pg";

import {
  ResourceGovernorAdmissionError,
  type AcquirePermitInput,
  type ConcurrencyControlRepository,
  type RecordPhysicalAttemptInput,
  type ResourcePermit,
} from "../concurrency-control-repository";
import {
  type ConcurrencyPolicy,
  type ConcurrencyProfileName,
  type GovernedResource,
} from "../../concurrency/concurrency-policy";
import type { PostgresQueryContext } from "./query-context";

const admissionLockId = "731553996872021106";
const maxRetryableAdmissionAttempts = 4;

interface PolicyRow extends QueryResultRow {
  readonly policy_version: string;
  readonly profile: ConcurrencyProfileName;
  readonly whole_job_limit: number;
  readonly seller_sprite_concurrency: number;
  readonly sif_concurrency: number;
  readonly sorftime_concurrency: number;
  readonly model_concurrency: number;
  readonly image_concurrency: number;
  readonly seller_sprite_rolling_max_attempts: number;
  readonly seller_sprite_rolling_window_ms: number;
}

interface PermitRow extends QueryResultRow {
  readonly permit_id: string;
  readonly organization_id: string;
  readonly resource: GovernedResource;
  readonly job_id: string;
  readonly attempt_kind: ResourcePermit["attemptKind"];
  readonly owner_id: string;
  readonly lease_generation: number;
  readonly policy_version: string;
  readonly acquired_at: Date | string;
  readonly lease_expires_at: Date | string;
}

export class PostgresConcurrencyControlStore implements ConcurrencyControlRepository {
  constructor(
    private readonly queries: PostgresQueryContext,
    private readonly ids: Readonly<{ permitId(): string }>,
  ) {}

  async getEffectivePolicy(organizationId: string): Promise<ConcurrencyPolicy> {
    const row = await this.readEffectivePolicyRow(organizationId);
    return mapPolicyRow(row);
  }

  async acquirePermit(input: AcquirePermitInput): Promise<ResourcePermit> {
    assertText(input.organizationId, "organizationId");
    assertText(input.jobId, "jobId");
    assertText(input.ownerId, "ownerId");
    assertPositiveInteger(input.leaseMs, "leaseMs");
    const maxWaitMs = input.maxWaitMs ?? 5_000;
    assertNonNegativeInteger(maxWaitMs, "maxWaitMs");
    const started = Date.now();
    let attempt = 0;
    while (true) {
      const acquiredAt = input.acquiredAt ?? new Date().toISOString();
      const permit = await retryAdmission(() =>
        this.tryAcquirePermit(input, acquiredAt),
      );
      if (permit) return permit;
      if (maxWaitMs === 0 || Date.now() - started >= maxWaitMs) {
        throw new ResourceGovernorAdmissionError();
      }
      await delay(Math.min(50, Math.max(1, maxWaitMs - (Date.now() - started))));
      attempt += 1;
      if (attempt > 1_000) throw new ResourceGovernorAdmissionError();
    }
  }

  async heartbeatPermit(input: {
    permitId: string;
    ownerId: string;
    leaseGeneration: number;
    leaseMs: number;
    heartbeatAt?: string;
  }): Promise<boolean> {
    assertText(input.permitId, "permitId");
    assertText(input.ownerId, "ownerId");
    assertPositiveInteger(input.leaseGeneration, "leaseGeneration");
    assertPositiveInteger(input.leaseMs, "leaseMs");
    const heartbeatAt = input.heartbeatAt ?? new Date().toISOString();
    const result = await this.queries.query(
      `UPDATE concurrency_resource_permits
       SET lease_expires_at = $4::timestamptz + ($5::text || ' milliseconds')::interval
       WHERE permit_id = $1
         AND owner_id = $2
         AND lease_generation = $3
         AND released_at IS NULL
         AND lease_expires_at > $4::timestamptz`,
      [
        input.permitId,
        input.ownerId,
        input.leaseGeneration,
        heartbeatAt,
        input.leaseMs,
      ],
    );
    return result.rowCount === 1;
  }

  async releasePermit(input: {
    permitId: string;
    ownerId: string;
    leaseGeneration: number;
    releasedAt?: string;
  }): Promise<boolean> {
    assertText(input.permitId, "permitId");
    assertText(input.ownerId, "ownerId");
    assertPositiveInteger(input.leaseGeneration, "leaseGeneration");
    const releasedAt = input.releasedAt ?? new Date().toISOString();
    const result = await this.queries.query(
      `UPDATE concurrency_resource_permits
       SET released_at = $4
       WHERE permit_id = $1
         AND owner_id = $2
         AND lease_generation = $3
         AND released_at IS NULL
         AND lease_expires_at > $4::timestamptz`,
      [
        input.permitId,
        input.ownerId,
        input.leaseGeneration,
        releasedAt,
      ],
    );
    return result.rowCount === 1;
  }

  async recordPhysicalAttempt(input: RecordPhysicalAttemptInput): Promise<void> {
    assertText(input.organizationId, "organizationId");
    assertText(input.jobId, "jobId");
    const recordedAt = input.recordedAt ?? new Date().toISOString();
    await retryAdmission(async () =>
      this.queries.transaction(async () => {
        await this.queries.query("SELECT pg_advisory_xact_lock($1::bigint)", [
          admissionLockId,
        ]);
        const policy = await this.readEffectivePolicyRow(input.organizationId);
        if (input.resource === "sellerSprite") {
          const count = await this.queries.query<{ count: number }>(
            `SELECT count(*)::integer AS count
             FROM concurrency_physical_attempts
             WHERE organization_id = $1
               AND resource = 'sellerSprite'
               AND recorded_at > $2::timestamptz - ($3::text || ' milliseconds')::interval
               AND recorded_at <= $2::timestamptz`,
            [
              input.organizationId,
              recordedAt,
              policy.seller_sprite_rolling_window_ms,
            ],
          );
          if ((count.rows[0]?.count ?? 0) >= policy.seller_sprite_rolling_max_attempts) {
            throw new ResourceGovernorAdmissionError();
          }
        }
        await this.queries.query(
          `INSERT INTO concurrency_physical_attempts (
             organization_id, resource, job_id, attempt_kind, policy_version, recorded_at
           )
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            input.organizationId,
            input.resource,
            input.jobId,
            input.attemptKind,
            policy.policy_version,
            recordedAt,
          ],
        );
      }),
    );
  }

  private async tryAcquirePermit(
    input: AcquirePermitInput,
    acquiredAt: string,
  ): Promise<ResourcePermit | null> {
    return await this.queries.transaction(async () => {
      await this.queries.query("SELECT pg_advisory_xact_lock($1::bigint)", [
        admissionLockId,
      ]);
      const policy = await this.readEffectivePolicyRow(input.organizationId);
      const active = await this.queries.query<{ count: number }>(
        `SELECT count(*)::integer AS count
         FROM concurrency_resource_permits
         WHERE organization_id = $1
           AND resource = $2
           AND released_at IS NULL
           AND lease_expires_at > $3::timestamptz`,
        [input.organizationId, input.resource, acquiredAt],
      );
      if ((active.rows[0]?.count ?? 0) >= limitFor(policy, input.resource)) {
        return null;
      }
      const result = await this.queries.query<PermitRow>(
        `INSERT INTO concurrency_resource_permits (
           permit_id, organization_id, resource, job_id, attempt_kind, owner_id,
           lease_generation, policy_version, acquired_at, lease_expires_at
         )
         VALUES (
           $1, $2, $3, $4, $5, $6,
           1, $7, $8, $8::timestamptz + ($9::text || ' milliseconds')::interval
         )
         RETURNING
           permit_id,
           organization_id,
           resource,
           job_id,
           attempt_kind,
           owner_id,
           lease_generation,
           policy_version,
           acquired_at,
           lease_expires_at`,
        [
          this.ids.permitId(),
          input.organizationId,
          input.resource,
          input.jobId,
          input.attemptKind,
          input.ownerId,
          policy.policy_version,
          acquiredAt,
          input.leaseMs,
        ],
      );
      return mapPermitRow(result.rows[0]!);
    });
  }

  private async readEffectivePolicyRow(organizationId: string): Promise<PolicyRow> {
    const result = await this.queries.query<PolicyRow>(
      `SELECT
         policy.policy_version,
         policy.profile,
         policy.whole_job_limit,
         policy.seller_sprite_concurrency,
         policy.sif_concurrency,
         policy.sorftime_concurrency,
         policy.model_concurrency,
         policy.image_concurrency,
         policy.seller_sprite_rolling_max_attempts,
         policy.seller_sprite_rolling_window_ms
       FROM concurrency_policy_current current_policy
       JOIN concurrency_policy_versions policy
         ON policy.policy_version = current_policy.policy_version
       WHERE current_policy.organization_id IN ($1, '*')
       ORDER BY CASE WHEN current_policy.organization_id = $1 THEN 0 ELSE 1 END
       LIMIT 1`,
      [organizationId],
    );
    const row = result.rows[0];
    if (!row) throw new ResourceGovernorAdmissionError();
    return row;
  }
}

function mapPolicyRow(row: PolicyRow): ConcurrencyPolicy {
  return Object.freeze({
    version: row.policy_version,
    profile: row.profile,
    limits: Object.freeze({
      wholeJob: row.whole_job_limit,
      sellerSprite: row.seller_sprite_concurrency,
      sif: row.sif_concurrency,
      sorftime: row.sorftime_concurrency,
      model: row.model_concurrency,
      image: row.image_concurrency,
    }),
    sellerSpriteRolling: Object.freeze({
      maxAttempts: row.seller_sprite_rolling_max_attempts,
      windowMs: row.seller_sprite_rolling_window_ms,
    }),
  });
}

function mapPermitRow(row: PermitRow): ResourcePermit {
  return Object.freeze({
    permitId: row.permit_id,
    organizationId: row.organization_id,
    resource: row.resource,
    jobId: row.job_id,
    attemptKind: row.attempt_kind,
    ownerId: row.owner_id,
    leaseGeneration: row.lease_generation,
    policyVersion: row.policy_version,
    acquiredAt: iso(row.acquired_at),
    leaseExpiresAt: iso(row.lease_expires_at),
  });
}

function limitFor(policy: PolicyRow, resource: GovernedResource): number {
  switch (resource) {
    case "wholeJob":
      return policy.whole_job_limit;
    case "sellerSprite":
      return policy.seller_sprite_concurrency;
    case "sif":
      return policy.sif_concurrency;
    case "sorftime":
      return policy.sorftime_concurrency;
    case "model":
      return policy.model_concurrency;
    case "image":
      return policy.image_concurrency;
  }
}

async function retryAdmission<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetryableAdmissionAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ResourceGovernorAdmissionError) throw error;
      if (!isRetryableTransactionError(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

function isRetryableTransactionError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : null;
  return code === "40001" || code === "40P01";
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function assertText(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`Invalid concurrency ${name}`);
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Invalid concurrency ${name}`);
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Invalid concurrency ${name}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
