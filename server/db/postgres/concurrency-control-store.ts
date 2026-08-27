import type { QueryResultRow } from "pg";

import {
  ResourceGovernorAdmissionError,
  type AcquirePermitInput,
  type ConcurrencyControlRepository,
  type PhysicalAttemptReceipt,
  type RecordPhysicalAttemptInput,
  type ResourcePermit,
} from "../concurrency-control-repository";
import {
  CONSERVATIVE_CONCURRENCY_PROFILE,
  type ConcurrencyPolicy,
  type ConcurrencyProfileName,
  type GovernedResource,
} from "../../concurrency/concurrency-policy";
import type { PostgresQueryContext } from "./query-context";
import type { ConcurrencyAdminResponse } from "../../../shared/agent-contracts";

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

type ConnectorAdminId = "sellerSprite" | "sif" | "sorftime";

type QuotaSnapshotInput = Readonly<{
  id: string;
  organizationId: string;
  actorUserId: string | null;
  trustedSource?: "scheduled-quota-refresh";
  remaining: number | null;
  used: number | null;
  providerTotal: number | null;
  source: ConcurrencyAdminResponse["sellerSpriteQuota"]["source"];
  status: ConcurrencyAdminResponse["sellerSpriteQuota"]["status"];
  errorCode: "ERROR_VISIT_MAX" | "MALFORMED_RESPONSE" | "UPSTREAM_UNAVAILABLE" | "REQUEST_TIMEOUT" | null;
  checkedAt: string;
  quotaAuditEventId: string;
  policyAuditEventId: string;
}>;

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
      assertAdmissionActive(input.signal);
      const acquiredAt = input.acquiredAt ?? new Date().toISOString();
      const permit = await retryAdmission(() =>
        this.tryAcquirePermit(input, acquiredAt),
        input.signal,
      );
      if (permit) {
        if (input.signal?.aborted) {
          await this.releasePermit({
            permitId: permit.permitId,
            ownerId: permit.ownerId,
            leaseGeneration: permit.leaseGeneration,
          }).catch(() => undefined);
          throw new ResourceGovernorAdmissionError();
        }
        return permit;
      }
      assertAdmissionActive(input.signal);
      if (maxWaitMs === 0 || Date.now() - started >= maxWaitMs) {
        throw new ResourceGovernorAdmissionError();
      }
      await delay(
        Math.min(50, Math.max(1, maxWaitMs - (Date.now() - started))),
        input.signal,
      );
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

  async recordPhysicalAttempt(
    input: RecordPhysicalAttemptInput,
  ): Promise<PhysicalAttemptReceipt> {
    assertAdmissionActive(input.signal);
    assertText(input.organizationId, "organizationId");
    assertText(input.jobId, "jobId");
    const recordedAt = input.recordedAt ?? new Date().toISOString();
    return await retryAdmission(async () =>
      this.queries.transaction(async () => {
        assertAdmissionActive(input.signal);
        await this.queries.query("SELECT pg_advisory_xact_lock($1::bigint)", [
          admissionLockId,
        ]);
        assertAdmissionActive(input.signal);
        const policy = await this.readAdmissionPolicyRow(
          input.organizationId,
          input.jobId,
        );
        await this.requireOpenConnectorCircuitCapacity(
          input.organizationId,
          input.resource,
          input.attemptKind,
        );
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
        assertAdmissionActive(input.signal);
        const inserted = await this.queries.query<{ id: string }>(
          `INSERT INTO concurrency_physical_attempts (
             organization_id, resource, job_id, attempt_kind, policy_version, recorded_at
           )
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [
            input.organizationId,
            input.resource,
            input.jobId,
            input.attemptKind,
            policy.policy_version,
            recordedAt,
          ],
        );
        assertAdmissionActive(input.signal);
        const attemptId = inserted.rows[0]?.id;
        if (attemptId === undefined) throw new ResourceGovernorAdmissionError();
        return Object.freeze({
          attemptId: String(attemptId),
          organizationId: input.organizationId,
          resource: input.resource,
          jobId: input.jobId,
          attemptKind: input.attemptKind,
          policyVersion: policy.policy_version,
          recordedAt,
        });
      }),
      input.signal,
    );
  }

  async cancelUndispatchedPhysicalAttempt(
    receipt: PhysicalAttemptReceipt,
  ): Promise<boolean> {
    const deleted = await this.queries.query(
      `DELETE FROM concurrency_physical_attempts
        WHERE id = $1::bigint
          AND organization_id = $2
          AND resource = $3
          AND job_id = $4
          AND attempt_kind = $5
          AND policy_version = $6
          AND recorded_at = $7::timestamptz`,
      [
        receipt.attemptId,
        receipt.organizationId,
        receipt.resource,
        receipt.jobId,
        receipt.attemptKind,
        receipt.policyVersion,
        receipt.recordedAt,
      ],
    );
    return deleted.rowCount === 1;
  }

  async readConcurrencyAdminState(input: {
    organizationId: string;
    now?: string;
  }): Promise<ConcurrencyAdminResponse> {
    assertText(input.organizationId, "organizationId");
    const now = input.now ?? new Date().toISOString();
    const [policy, queue, connectors, circuits, settings, snapshot, attempts] =
      await Promise.all([
        this.getEffectivePolicy(input.organizationId),
        this.queries.query<{
          queued: number;
          running: number;
          paused: number;
          terminal: number;
        }>(
          `SELECT
             count(*) FILTER (WHERE status = 'queued')::integer AS queued,
             count(*) FILTER (WHERE status = 'running')::integer AS running,
             count(*) FILTER (WHERE status = 'paused')::integer AS paused,
             count(*) FILTER (WHERE status IN ('completed', 'completed-with-gaps', 'failed'))::integer AS terminal
           FROM sync_jobs
           WHERE organization_id = $1`,
          [input.organizationId],
        ),
        this.queries.query<{
          connector: ConnectorAdminId;
          configured: boolean;
          health: "unknown" | "available" | "unavailable";
          last_checked_at: Date | string | null;
          last_error_json: { message?: string } | null;
        }>(
          `SELECT connector, configured, health, last_checked_at, last_error_json
           FROM connector_status
           WHERE organization_id = $1
             AND connector IN ('sellerSprite', 'sif', 'sorftime')`,
          [input.organizationId],
        ),
        this.queries.query<{
          resource: ConnectorAdminId;
          manual_hold: boolean;
          auto_paused: boolean;
          reason: ConcurrencyAdminResponse["connectors"]["sellerSprite"]["circuit"]["reason"];
          updated_at: Date | string;
        }>(
          `SELECT resource, manual_hold, auto_paused, reason, updated_at
           FROM concurrency_resource_circuits
           WHERE organization_id = $1`,
          [input.organizationId],
        ),
        this.queries.query<{ manual_total: number | null }>(
          `SELECT manual_total
           FROM seller_sprite_quota_settings
           WHERE organization_id = $1`,
          [input.organizationId],
        ),
        this.queries.query<{
          remaining: number | null;
          used_count: number | null;
          provider_total: number | null;
          configured_total: number | null;
          source: ConcurrencyAdminResponse["sellerSpriteQuota"]["source"];
          status: ConcurrencyAdminResponse["sellerSpriteQuota"]["status"];
          checked_at: Date | string;
        }>(
          `SELECT remaining, used_count, provider_total, configured_total, source, status, checked_at
           FROM seller_sprite_quota_snapshots
           WHERE organization_id = $1
           ORDER BY checked_at DESC, created_at DESC
           LIMIT 1`,
          [input.organizationId],
        ),
        this.queries.query<{ count: number }>(
          `SELECT count(*)::integer AS count
           FROM concurrency_physical_attempts
           WHERE organization_id = $1
             AND resource = 'sellerSprite'
             AND recorded_at >= date_trunc('month', $2::timestamptz)
             AND recorded_at <= $2::timestamptz`,
          [input.organizationId, now],
        ),
      ]);

    const connectorRows = new Map(
      connectors.rows.map((row) => [row.connector, row]),
    );
    const circuitRows = new Map(circuits.rows.map((row) => [row.resource, row]));
    const latestSnapshot = snapshot.rows[0] ?? null;
    const manualTotal = settings.rows[0]?.manual_total ?? null;
    const total = latestSnapshot?.provider_total ?? latestSnapshot?.configured_total ?? manualTotal;
    const checkedAt = latestSnapshot ? iso(latestSnapshot.checked_at) : null;
    const quotaStatus = deriveQuotaStatus(
      latestSnapshot?.status ?? "unknown",
      latestSnapshot?.remaining ?? null,
      total,
    );
    return {
      schemaVersion: "1.0.0",
      organizationId: input.organizationId,
      queue: queue.rows[0] ?? { queued: 0, running: 0, paused: 0, terminal: 0 },
      policy,
      connectors: {
        sellerSprite: connectorAdminState("sellerSprite", connectorRows, circuitRows),
        sif: connectorAdminState("sif", connectorRows, circuitRows),
        sorftime: connectorAdminState("sorftime", connectorRows, circuitRows),
      },
      sellerSpriteQuota: {
        total,
        totalLabel: total === null ? "总额度未知" : `${total}`,
        remaining: latestSnapshot?.remaining ?? null,
        used: latestSnapshot?.used_count ?? null,
        localObservedAttempts: attempts.rows[0]?.count ?? 0,
        source: latestSnapshot?.source ?? (manualTotal === null ? "unknown" : "configured"),
        status: quotaStatus,
        checkedAt,
        ageSeconds: checkedAt
          ? Math.max(0, Math.floor((new Date(now).getTime() - new Date(checkedAt).getTime()) / 1000))
          : null,
        warning: quotaWarning(quotaStatus),
      },
    };
  }

  async setConcurrencyProfile(input: {
    organizationId: string;
    actorUserId: string;
    profile: ConcurrencyProfileName;
    changedAt?: string;
    auditEventId: string;
  }): Promise<void> {
    assertText(input.organizationId, "organizationId");
    assertText(input.actorUserId, "actorUserId");
    const changedAt = input.changedAt ?? new Date().toISOString();
    const policyVersion = policyVersionForProfile(input.profile);
    await this.queries.transaction(async () => {
      await this.requirePrimaryScope(input.organizationId, input.actorUserId);
      await this.queries.query(
        `INSERT INTO concurrency_policy_current (organization_id, policy_version, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (organization_id)
         DO UPDATE SET policy_version = EXCLUDED.policy_version, updated_at = EXCLUDED.updated_at`,
        [input.organizationId, policyVersion, changedAt],
      );
      await this.appendAudit({
        id: input.auditEventId,
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        action: "concurrency.policy-changed",
        targetType: "concurrency-policy",
        targetId: policyVersion,
        metadata: { profile: input.profile, policyVersion },
        createdAt: changedAt,
      });
    });
  }

  async setSellerSpriteManualTotal(input: {
    organizationId: string;
    actorUserId: string;
    total: number | null;
    updatedAt?: string;
    auditEventId: string;
  }): Promise<void> {
    assertText(input.organizationId, "organizationId");
    assertText(input.actorUserId, "actorUserId");
    if (input.total !== null && (!Number.isSafeInteger(input.total) || input.total <= 0)) {
      throw new TypeError("Invalid SellerSprite quota total");
    }
    const updatedAt = input.updatedAt ?? new Date().toISOString();
    await this.queries.transaction(async () => {
      await this.requirePrimaryScope(input.organizationId, input.actorUserId);
      await this.queries.query(
        `INSERT INTO seller_sprite_quota_settings (organization_id, manual_total, updated_by, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (organization_id)
         DO UPDATE SET manual_total = EXCLUDED.manual_total,
                       updated_by = EXCLUDED.updated_by,
                       updated_at = EXCLUDED.updated_at`,
        [input.organizationId, input.total, input.actorUserId, updatedAt],
      );
      await this.appendAudit({
        id: input.auditEventId,
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        action: "seller-sprite.quota-total-updated",
        targetType: "seller-sprite-quota",
        targetId: input.organizationId,
        metadata: { total: input.total },
        createdAt: updatedAt,
      });
    });
  }

  async recordSellerSpriteQuotaSnapshot(input: QuotaSnapshotInput): Promise<void> {
    assertText(input.organizationId, "organizationId");
    if (input.actorUserId !== null) assertText(input.actorUserId, "actorUserId");
    if (input.actorUserId === null && input.trustedSource !== "scheduled-quota-refresh") {
      throw new TypeError("Null actor quota snapshots require the scheduled quota refresh trusted source");
    }
    const status = input.errorCode === "ERROR_VISIT_MAX" ? "paused" : input.status;
    await this.queries.transaction(async () => {
      if (input.actorUserId !== null) {
        await this.requirePrimaryScope(input.organizationId, input.actorUserId);
      }
      const settings = await this.queries.query<{ manual_total: number | null }>(
        `SELECT manual_total
         FROM seller_sprite_quota_settings
         WHERE organization_id = $1`,
        [input.organizationId],
      );
      const configuredTotal = settings.rows[0]?.manual_total ?? null;
      await this.queries.query(
        `INSERT INTO seller_sprite_quota_snapshots (
           id, organization_id, actor_user_id, remaining, used_count, provider_total, configured_total,
           source, status, error_code, checked_at, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
        [
          input.id,
          input.organizationId,
          input.actorUserId,
          input.remaining,
          input.used,
          input.providerTotal,
          configuredTotal,
          input.source,
          status,
          input.errorCode,
          input.checkedAt,
        ],
      );
      await this.appendAudit({
        id: input.quotaAuditEventId,
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        action: input.actorUserId === null
          ? "seller-sprite.quota-refreshed-scheduled"
          : "seller-sprite.quota-refreshed",
        targetType: "seller-sprite-quota",
        targetId: input.organizationId,
        metadata: {
          status,
          ...(input.errorCode ? { errorCode: input.errorCode } : {}),
        },
        createdAt: input.checkedAt,
      });
      const effectiveTotal = input.providerTotal ?? configuredTotal;
      if (
        (input.errorCode === "ERROR_VISIT_MAX" ||
          input.remaining === 0)
      ) {
        await this.setCircuitInsideTransaction({
          organizationId: input.organizationId,
          resource: "sellerSprite",
          actorUserId: input.actorUserId,
          autoPaused: true,
          manualHold: null,
          reason: "quota-exhausted",
          updatedAt: input.checkedAt,
        });
      } else if (
        effectiveTotal !== null &&
        input.remaining !== null &&
        input.remaining / effectiveTotal < 0.1
      ) {
        await this.queries.query(
          `INSERT INTO concurrency_policy_current (organization_id, policy_version, updated_at)
           VALUES ($1, $2, $3)
           ON CONFLICT (organization_id)
           DO UPDATE SET policy_version = EXCLUDED.policy_version,
                         updated_at = EXCLUDED.updated_at`,
          [input.organizationId, CONSERVATIVE_CONCURRENCY_PROFILE.version, input.checkedAt],
        );
        await this.appendAudit({
          id: input.policyAuditEventId,
          organizationId: input.organizationId,
          actorUserId: input.actorUserId,
          action: input.actorUserId === null
            ? "concurrency.policy-changed-scheduled"
            : "concurrency.policy-changed",
          targetType: "concurrency-policy",
          targetId: CONSERVATIVE_CONCURRENCY_PROFILE.version,
          metadata: { profile: "conservative", reason: "seller-sprite-quota-low" },
          createdAt: input.checkedAt,
        });
      }
    });
  }

  async setSellerSpriteManualPause(input: {
    organizationId: string;
    actorUserId: string;
    paused: boolean;
    updatedAt?: string;
    auditEventId: string;
  }): Promise<void> {
    assertText(input.organizationId, "organizationId");
    assertText(input.actorUserId, "actorUserId");
    const updatedAt = input.updatedAt ?? new Date().toISOString();
    await this.queries.transaction(async () => {
      await this.requirePrimaryScope(input.organizationId, input.actorUserId);
      await this.setCircuitInsideTransaction({
        organizationId: input.organizationId,
        resource: "sellerSprite",
        actorUserId: input.actorUserId,
        autoPaused: null,
        manualHold: input.paused,
        reason: input.paused ? "manual-hold" : null,
        updatedAt,
      });
      await this.appendAudit({
        id: input.auditEventId,
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        action: "concurrency.resource-pause-changed",
        targetType: "concurrency-resource",
        targetId: "sellerSprite",
        metadata: { resource: "sellerSprite", paused: input.paused },
        createdAt: updatedAt,
      });
    });
  }

  async resetConnectorCircuit(input: {
    organizationId: string;
    actorUserId: string;
    connectorId: ConnectorAdminId;
    updatedAt?: string;
    auditEventId: string;
  }): Promise<void> {
    assertText(input.organizationId, "organizationId");
    assertText(input.actorUserId, "actorUserId");
    const updatedAt = input.updatedAt ?? new Date().toISOString();
    await this.queries.transaction(async () => {
      await this.requirePrimaryScope(input.organizationId, input.actorUserId);
      const current = await this.queries.query<{ manual_hold: boolean }>(
        `SELECT manual_hold
         FROM concurrency_resource_circuits
         WHERE organization_id = $1 AND resource = $2`,
        [input.organizationId, input.connectorId],
      );
      await this.setCircuitInsideTransaction({
        organizationId: input.organizationId,
        resource: input.connectorId,
        actorUserId: input.actorUserId,
        autoPaused: false,
        manualHold: current.rows[0]?.manual_hold ?? false,
        reason: current.rows[0]?.manual_hold ? "manual-hold" : null,
        updatedAt,
      });
      await this.appendAudit({
        id: input.auditEventId,
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        action: "concurrency.circuit-reset",
        targetType: "connector",
        targetId: input.connectorId,
        metadata: { connectorId: input.connectorId, manualHoldPreserved: current.rows[0]?.manual_hold ?? false },
        createdAt: updatedAt,
      });
    });
  }

  private async tryAcquirePermit(
    input: AcquirePermitInput,
    acquiredAt: string,
  ): Promise<ResourcePermit | null> {
    return await this.queries.transaction(async () => {
      await this.queries.query("SELECT pg_advisory_xact_lock($1::bigint)", [
        admissionLockId,
      ]);
      const policy = await this.readAdmissionPolicyRow(
        input.organizationId,
        input.jobId,
      );
      await this.requireOpenConnectorCircuitCapacity(
        input.organizationId,
        input.resource,
        input.attemptKind,
      );
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

  private async readAdmissionPolicyRow(
    organizationId: string,
    jobId: string,
  ): Promise<PolicyRow> {
    const result = await this.queries.query<PolicyRow>(
      `WITH current_policy AS (
         SELECT policy.*
         FROM concurrency_policy_current current_pointer
         JOIN concurrency_policy_versions policy
           ON policy.policy_version = current_pointer.policy_version
         WHERE current_pointer.organization_id IN ($1, '*')
         ORDER BY CASE WHEN current_pointer.organization_id = $1 THEN 0 ELSE 1 END
         LIMIT 1
       ),
       job_policy AS (
         SELECT policy.*
         FROM sync_jobs job
         JOIN concurrency_policy_versions policy
           ON policy.policy_version = job.policy_version
         WHERE job.organization_id = $1
           AND job.job_id = $2
         LIMIT 1
       )
       SELECT
         COALESCE(job_policy.policy_version, current_policy.policy_version) AS policy_version,
         COALESCE(job_policy.profile, current_policy.profile) AS profile,
         LEAST(COALESCE(job_policy.whole_job_limit, current_policy.whole_job_limit), current_policy.whole_job_limit) AS whole_job_limit,
         LEAST(COALESCE(job_policy.seller_sprite_concurrency, current_policy.seller_sprite_concurrency), current_policy.seller_sprite_concurrency) AS seller_sprite_concurrency,
         LEAST(COALESCE(job_policy.sif_concurrency, current_policy.sif_concurrency), current_policy.sif_concurrency) AS sif_concurrency,
         LEAST(COALESCE(job_policy.sorftime_concurrency, current_policy.sorftime_concurrency), current_policy.sorftime_concurrency) AS sorftime_concurrency,
         LEAST(COALESCE(job_policy.model_concurrency, current_policy.model_concurrency), current_policy.model_concurrency) AS model_concurrency,
         LEAST(COALESCE(job_policy.image_concurrency, current_policy.image_concurrency), current_policy.image_concurrency) AS image_concurrency,
         LEAST(COALESCE(job_policy.seller_sprite_rolling_max_attempts, current_policy.seller_sprite_rolling_max_attempts), current_policy.seller_sprite_rolling_max_attempts) AS seller_sprite_rolling_max_attempts,
         LEAST(COALESCE(job_policy.seller_sprite_rolling_window_ms, current_policy.seller_sprite_rolling_window_ms), current_policy.seller_sprite_rolling_window_ms) AS seller_sprite_rolling_window_ms
       FROM current_policy
       LEFT JOIN job_policy ON true`,
      [organizationId, jobId],
    );
    const row = result.rows[0];
    if (!row) throw new ResourceGovernorAdmissionError();
    return row;
  }

  private async requirePrimaryScope(
    organizationId: string,
    actorUserId: string,
  ): Promise<void> {
    const result = await this.queries.query(
      `SELECT 1
       FROM users
       WHERE id = $1
         AND organization_id = $2
         AND role = 'admin'
         AND status = 'active'
         AND lower(trim(email)) = 'admin@example.com'`,
      [actorUserId, organizationId],
    );
    if (result.rowCount !== 1) {
      throw new ResourceGovernorAdmissionError();
    }
  }

  private async requireOpenConnectorCircuitCapacity(
    organizationId: string,
    resource: GovernedResource,
    attemptKind: RecordPhysicalAttemptInput["attemptKind"],
  ): Promise<void> {
    if (resource === "sellerSprite" && attemptKind === "quota-refresh") return;
    if (!isConnectorAdminResource(resource)) return;
    const result = await this.queries.query<{
      manual_hold: boolean;
      auto_paused: boolean;
    }>(
      `SELECT manual_hold, auto_paused
       FROM concurrency_resource_circuits
       WHERE organization_id = $1
         AND resource = $2`,
      [organizationId, resource],
    );
    const circuit = result.rows[0];
    if (circuit?.manual_hold || circuit?.auto_paused) {
      throw new ResourceGovernorAdmissionError();
    }
  }

  private async setCircuitInsideTransaction(input: {
    organizationId: string;
    resource: ConnectorAdminId;
    actorUserId: string | null;
    manualHold: boolean | null;
    autoPaused: boolean | null;
    reason: ConcurrencyAdminResponse["connectors"]["sellerSprite"]["circuit"]["reason"];
    updatedAt: string;
  }): Promise<void> {
    if (input.actorUserId === null) {
      await this.queries.query(
        `INSERT INTO concurrency_resource_circuits (
           organization_id, resource, manual_hold, auto_paused, reason, updated_by, updated_at
         ) VALUES ($1, $2, FALSE, TRUE, $3, NULL, $4)
         ON CONFLICT (organization_id, resource)
         DO UPDATE SET
           auto_paused = TRUE,
           reason = EXCLUDED.reason,
           updated_by = NULL,
           updated_at = EXCLUDED.updated_at
         WHERE concurrency_resource_circuits.manual_hold = FALSE`,
        [
          input.organizationId,
          input.resource,
          input.reason,
          input.updatedAt,
        ],
      );
      return;
    }
    await this.queries.query(
      `INSERT INTO concurrency_resource_circuits (
         organization_id, resource, manual_hold, auto_paused, reason, updated_by, updated_at
       ) VALUES (
         $1, $2, COALESCE($3, FALSE), COALESCE($4, FALSE), $5, $6, $7
       )
       ON CONFLICT (organization_id, resource)
       DO UPDATE SET
         manual_hold = COALESCE($3, concurrency_resource_circuits.manual_hold),
         auto_paused = COALESCE($4, concurrency_resource_circuits.auto_paused),
         reason = CASE
           WHEN COALESCE($3, concurrency_resource_circuits.manual_hold) THEN 'manual-hold'
           WHEN COALESCE($4, concurrency_resource_circuits.auto_paused) THEN $5
           ELSE NULL
         END,
         updated_by = EXCLUDED.updated_by,
         updated_at = EXCLUDED.updated_at`,
      [
        input.organizationId,
        input.resource,
        input.manualHold,
        input.autoPaused,
        input.reason,
        input.actorUserId,
        input.updatedAt,
      ],
    );
  }

  private async appendAudit(input: {
    id: string;
    organizationId: string;
    actorUserId: string | null;
    action: string;
    targetType: string;
    targetId: string;
    metadata: Record<string, unknown>;
    createdAt: string;
  }): Promise<void> {
    await this.queries.query(
      `INSERT INTO audit_events (
         id, organization_id, actor_user_id, action, target_type, target_id,
         metadata_json, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [
        input.id,
        input.organizationId,
        input.actorUserId,
        input.action,
        input.targetType,
        input.targetId,
        JSON.stringify(input.metadata),
        input.createdAt,
      ],
    );
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

function isConnectorAdminResource(resource: GovernedResource): resource is ConnectorAdminId {
  return resource === "sellerSprite" || resource === "sif" || resource === "sorftime";
}

function connectorAdminState(
  connector: ConnectorAdminId,
  connectors: Map<ConnectorAdminId, {
    configured: boolean;
    health: "unknown" | "available" | "unavailable";
    last_checked_at: Date | string | null;
    last_error_json: { message?: string } | null;
  }>,
  circuits: Map<ConnectorAdminId, {
    manual_hold: boolean;
    auto_paused: boolean;
    reason: ConcurrencyAdminResponse["connectors"]["sellerSprite"]["circuit"]["reason"];
    updated_at: Date | string;
  }>,
): ConcurrencyAdminResponse["connectors"]["sellerSprite"] {
  const row = connectors.get(connector);
  const circuit = circuits.get(connector);
  const paused = Boolean(circuit?.manual_hold || circuit?.auto_paused);
  const defaultReason = row?.configured
    ? "Connector health has not been checked"
    : `${connectorLabel(connector)} credential is not configured`;
  return {
    configured: row?.configured ?? false,
    available: !paused && row?.health === "available",
    reason: paused
      ? circuit?.reason === "quota-exhausted"
        ? "等待卖家精灵额度"
        : "Connector is paused"
      : row?.health === "available"
        ? null
        : row?.last_error_json?.message ?? defaultReason,
    checkedAt: row?.last_checked_at ? iso(row.last_checked_at) : null,
    circuit: {
      paused,
      manualHold: circuit?.manual_hold ?? false,
      reason: circuit?.reason ?? null,
      updatedAt: circuit?.updated_at ? iso(circuit.updated_at) : null,
    },
  };
}

function connectorLabel(connector: ConnectorAdminId): string {
  switch (connector) {
    case "sellerSprite":
      return "SellerSprite";
    case "sif":
      return "SIF";
    case "sorftime":
      return "Sorftime";
  }
}

function quotaWarning(
  status: ConcurrencyAdminResponse["sellerSpriteQuota"]["status"],
): string | null {
  switch (status) {
    case "warning":
      return "卖家精灵剩余额度低于 20%";
    case "conservative":
      return "卖家精灵剩余额度低于 10%，已降至保守档";
    case "paused":
      return "等待卖家精灵额度";
    case "error":
      return "卖家精灵额度暂不可确认";
    default:
      return null;
  }
}

function deriveQuotaStatus(
  stored: ConcurrencyAdminResponse["sellerSpriteQuota"]["status"],
  remaining: number | null,
  total: number | null,
): ConcurrencyAdminResponse["sellerSpriteQuota"]["status"] {
  if (stored === "paused" || stored === "error" || remaining === 0) return stored;
  if (remaining === null || total === null) return stored;
  const ratio = remaining / total;
  if (ratio < 0.1) return "conservative";
  if (ratio < 0.2) return "warning";
  return stored;
}

function policyVersionForProfile(profile: ConcurrencyProfileName): string {
  switch (profile) {
    case "conservative":
      return "conservative-v1";
    case "standard":
      return "standard-v2";
    case "fast":
      return "fast-v1";
  }
}

async function retryAdmission<Result>(
  operation: () => Promise<Result>,
  signal?: AbortSignal,
): Promise<Result> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetryableAdmissionAttempts; attempt += 1) {
    assertAdmissionActive(signal);
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

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  assertAdmissionActive(signal);
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timeout);
      reject(new ResourceGovernorAdmissionError());
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function assertAdmissionActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ResourceGovernorAdmissionError();
}
