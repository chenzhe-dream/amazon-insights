import type { QueryResultRow } from "pg";

import {
  ModelBudgetDataError,
  ModelBudgetExecutionAuthorityLostError,
  type ModelBudgetAmount,
  type ModelBudgetExecutionAuthority,
  type ModelBudgetLedgerRepository,
  type ModelBudgetLimit,
  type ModelBudgetReservationRecord,
  ModelBudgetReservationConflictError,
  ModelBudgetReservationNotFoundError,
  ModelBudgetStateConflictError,
  type ModelBudgetSubject,
  ModelBudgetSubjectNotFoundError,
  type ModelBudgetUsage,
  type ModelBudgetUsageSnapshot,
  type ReserveModelBudgetInput,
  type ReserveModelBudgetResult,
  type SettleModelBudgetInput,
  type TransitionModelBudgetInput,
} from "../model-budget-repository";
import { BudgetExceededError, type BudgetScope } from "../../runtime/budget-policy";
import { PostgresQueryContext } from "./query-context";

interface BudgetRow extends QueryResultRow {
  id: string;
  idempotency_key: string;
  request_fingerprint: string;
  run_id: string;
  project_id: string;
  organization_id: string;
  utc_day: string | Date;
  state: ModelBudgetReservationRecord["state"];
  projected_input_tokens: string | number;
  projected_output_tokens: string | number;
  projected_cost_micros: string | number;
  actual_input_tokens: string | number | null;
  actual_output_tokens: string | number | null;
  actual_cost_micros: string | number | null;
  lease_expires_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  dispatched_at: Date | string | null;
  settled_at: Date | string | null;
  released_at: Date | string | null;
  job_attempt_id: string | null;
  request_ordinal: number | null;
  attempt_kind: ReserveModelBudgetInput["attemptKind"] | null;
  transient_retry_count: number | null;
  format_repair: boolean | null;
  response_id: string | null;
}

export interface PostgresModelBudgetStoreOptions {
  readonly nowProvider?: () => Date;
}

export class PostgresModelBudgetStore implements ModelBudgetLedgerRepository {
  readonly #queries: PostgresQueryContext;
  readonly #nowProvider: () => Date;

  constructor(
    queries: PostgresQueryContext,
    options: PostgresModelBudgetStoreOptions = {},
  ) {
    this.#queries = queries;
    this.#nowProvider = options.nowProvider ?? (() => new Date());
  }

  resolveModelBudgetSubject(input: {
    runId: string;
    projectId: string;
  }): Promise<ModelBudgetSubject> {
    return this.#execute(async () => {
      assertSubjectInput(input.runId, input.projectId);
      return await this.#resolveSubject(input.runId, input.projectId);
    });
  }

  reserveModelBudget(
    input: ReserveModelBudgetInput,
  ): Promise<ReserveModelBudgetResult> {
    return this.#execute(async () => {
      assertReserveInput(input);
      return await this.#queries.transaction(async () => {
        const freshNow = this.#transactionNow();
        await this.#assertExecutionAuthority(input.executionAuthority, freshNow, {
          runId: input.runId,
          jobAttemptId: input.jobAttemptId,
        });
        const subject = await this.#resolveSubject(input.runId, input.projectId);
        await this.#queries.query(
          "LOCK TABLE model_budget_reservations IN SHARE ROW EXCLUSIVE MODE",
        );
        await this.#releaseExpired(freshNow);
        const existing = await this.#queries.query<BudgetRow>(
          `SELECT * FROM model_budget_reservations
            WHERE run_id = $1 AND idempotency_key = $2`,
          [input.runId, input.idempotencyKey],
        );
        if (existing.rows[0]) {
          const reservation = mapReservation(existing.rows[0]);
          if (!sameReservationParameters(reservation, existing.rows[0], input)) {
            throw new ModelBudgetReservationConflictError();
          }
          return { reservation, created: false };
        }
        if (input.leaseExpiresAt <= freshNow) {
          throw new TypeError("Model budget reservation lease expired before admission");
        }
        if (input.jobAttemptId !== undefined) {
          const provenance = await this.#queries.query(
            `SELECT 1
               FROM job_attempts ja
               JOIN run_stages rs ON rs.id = ja.stage_id
              WHERE ja.id = $1 AND rs.run_id = $2`,
            [input.jobAttemptId, input.runId],
          );
          if (provenance.rowCount !== 1) {
            throw new ModelBudgetReservationConflictError();
          }
        }

        const utcDay = freshNow.slice(0, 10);
        const usage = await this.#usage(
          input.runId,
          subject.organizationId,
          utcDay,
        );
        const projected = toUsage(input.projected);
        assertBudgetAvailable(
          "call",
          { tokens: 0, costMicros: 0 },
          projected,
          input.limits.call,
        );
        assertBudgetAvailable("run", usage.run, projected, input.limits.run);
        assertBudgetAvailable(
          "daily",
          usage.organizationUtcDay,
          projected,
          input.limits.organizationUtcDay,
        );

        const inserted = await this.#queries.query<BudgetRow>(
          `INSERT INTO model_budget_reservations (
             id, idempotency_key, request_fingerprint, run_id, project_id,
             organization_id, utc_day, state, projected_input_tokens,
             projected_output_tokens, projected_cost_micros,
             actual_input_tokens, actual_output_tokens, actual_cost_micros,
             lease_expires_at, created_at, updated_at, dispatched_at,
             settled_at, released_at, job_attempt_id, request_ordinal,
             attempt_kind, transient_retry_count, format_repair, response_id
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7::date, 'reserved', $8, $9, $10,
             NULL, NULL, NULL, $11, $12, $12, NULL, NULL, NULL, $13, $14,
             $15, $16, $17, NULL
           )
           RETURNING *`,
          [
            input.id,
            input.idempotencyKey,
            input.requestFingerprint,
            input.runId,
            input.projectId,
            subject.organizationId,
            utcDay,
            input.projected.inputTokens,
            input.projected.outputTokens,
            input.projected.costMicros,
            input.leaseExpiresAt,
            input.reservedAt,
            input.jobAttemptId ?? null,
            input.requestOrdinal ?? null,
            input.attemptKind ?? null,
            input.transientRetryCount ?? null,
            input.formatRepair ?? null,
          ],
        );
        const row = inserted.rows[0];
        if (!row) throw new ModelBudgetDataError();
        return { reservation: mapReservation(row), created: true };
      });
    });
  }

  getModelBudgetUsage(input: {
    runId: string;
    projectId: string;
    asOf: string;
  }): Promise<ModelBudgetUsageSnapshot> {
    return this.#execute(async () => {
      assertTimestamp(input.asOf, "asOf");
      assertSubjectInput(input.runId, input.projectId);
      return await this.#queries.transaction(async () => {
        const subject = await this.#resolveSubject(input.runId, input.projectId);
        await this.#queries.query(
          "LOCK TABLE model_budget_reservations IN SHARE ROW EXCLUSIVE MODE",
        );
        await this.#releaseExpired(input.asOf);
        return await this.#usage(
          input.runId,
          subject.organizationId,
          input.asOf.slice(0, 10),
        );
      });
    });
  }

  dispatchModelBudget(input: TransitionModelBudgetInput) {
    return this.#execute(async () => {
      assertTransitionInput(input);
      return await this.#queries.transaction(async () => {
        const freshNow = this.#transactionNow();
        await this.#assertExecutionAuthority(input.executionAuthority, freshNow, {
          reservationId: input.reservationId,
        });
        const updated = await this.#queries.query<BudgetRow>(
          `UPDATE model_budget_reservations
              SET state = 'dispatched', lease_expires_at = NULL,
                  dispatched_at = $1, updated_at = $1
            WHERE id = $2 AND state = 'reserved' AND lease_expires_at > $3
            RETURNING *`,
          [input.transitionedAt, input.reservationId, freshNow],
        );
        if (updated.rows[0]) {
          return { reservation: mapReservation(updated.rows[0]), transitioned: true };
        }
        const expired = await this.#queries.query<BudgetRow>(
          `UPDATE model_budget_reservations
              SET state = 'released', lease_expires_at = NULL,
                  released_at = $1, updated_at = $1
            WHERE id = $2 AND state = 'reserved' AND lease_expires_at <= $3
            RETURNING *`,
          [input.transitionedAt, input.reservationId, freshNow],
        );
        if (expired.rows[0]) {
          return { reservation: mapReservation(expired.rows[0]), transitioned: false };
        }
        const current = await this.#requireReservation(input.reservationId);
        if (current.state === "dispatched") {
          return { reservation: current, transitioned: false };
        }
        throw new ModelBudgetStateConflictError();
      });
    });
  }

  releaseModelBudget(input: TransitionModelBudgetInput) {
    return this.#execute(async () => {
      assertTransitionInput(input);
      return await this.#queries.transaction(async () => {
        const freshNow = this.#transactionNow();
        await this.#assertExecutionAuthority(input.executionAuthority, freshNow, {
          reservationId: input.reservationId,
        });
        const updated = await this.#queries.query<BudgetRow>(
          `UPDATE model_budget_reservations
              SET state = 'released', lease_expires_at = NULL,
                  released_at = $1, updated_at = $1
            WHERE id = $2 AND state = 'reserved'
            RETURNING *`,
          [input.transitionedAt, input.reservationId],
        );
        if (updated.rows[0]) {
          return { reservation: mapReservation(updated.rows[0]), transitioned: true };
        }
        const current = await this.#requireReservation(input.reservationId);
        if (current.state === "released") {
          return { reservation: current, transitioned: false };
        }
        throw new ModelBudgetStateConflictError();
      });
    });
  }

  settleModelBudget(input: SettleModelBudgetInput) {
    return this.#execute(async () => {
      assertTransitionInput(input);
      assertBudgetAmount(input.actual, "actual");
      if (
        input.responseId !== undefined &&
        (typeof input.responseId !== "string" ||
          input.responseId.trim().length === 0 ||
          input.responseId.length > 500)
      ) {
        throw new TypeError("Invalid model response ID");
      }
      return await this.#queries.transaction(async () => {
        const freshNow = this.#transactionNow();
        await this.#assertExecutionAuthority(input.executionAuthority, freshNow, {
          reservationId: input.reservationId,
        });
        await this.#releaseExpired(freshNow);
        const updated = await this.#queries.query<BudgetRow>(
          `UPDATE model_budget_reservations
              SET state = 'settled', actual_input_tokens = $1,
                  actual_output_tokens = $2, actual_cost_micros = $3,
                  response_id = $4, lease_expires_at = NULL,
                  settled_at = $5, updated_at = $5
            WHERE id = $6 AND state IN ('reserved', 'dispatched')
            RETURNING *`,
          [
            input.actual.inputTokens,
            input.actual.outputTokens,
            input.actual.costMicros,
            input.responseId ?? null,
            input.transitionedAt,
            input.reservationId,
          ],
        );
        if (updated.rows[0]) {
          return { reservation: mapReservation(updated.rows[0]), transitioned: true };
        }
        const row = await this.#findReservationRow(input.reservationId);
        if (!row) throw new ModelBudgetReservationNotFoundError();
        const current = mapReservation(row);
        if (current.state === "settled") {
          if (
            sameAmount(current.actual, input.actual) &&
            row.response_id === (input.responseId ?? null)
          ) {
            return { reservation: current, transitioned: false };
          }
          throw new ModelBudgetReservationConflictError();
        }
        throw new ModelBudgetStateConflictError();
      });
    });
  }

  async #resolveSubject(runId: string, projectId: string) {
    const result = await this.#queries.query<{ organization_id: string }>(
      `SELECT p.organization_id
         FROM analysis_runs r
         JOIN projects p ON p.id = r.project_id
        WHERE r.id = $1 AND p.id = $2`,
      [runId, projectId],
    );
    if (!result.rows[0]) throw new ModelBudgetSubjectNotFoundError();
    return { runId, projectId, organizationId: result.rows[0].organization_id };
  }

  async #assertExecutionAuthority(
    authority: ModelBudgetExecutionAuthority | undefined,
    asOf: string,
    subject: {
      runId?: string;
      jobAttemptId?: string;
      reservationId?: string;
    },
  ) {
    if (authority === undefined) return;
    const parameters = [
      authority.agentRunId,
      authority.jobAttemptId,
      authority.organizationId,
      authority.claimToken,
      authority.leaseOwnerId,
      authority.leaseGeneration,
      asOf,
    ];
    const authorityPredicate = `ar.id = $1 AND ar.job_attempt_id = $2
      AND p.organization_id = $3 AND ar.validation_status = 'pending'
      AND ar.execution_claim_token = $4
      AND ar.execution_claim_owner_id = $5
      AND ar.execution_claim_generation = $6
      AND ja.status = 'running' AND ja.leased_by = $5
      AND ja.lease_generation = $6 AND ja.lease_expires_at > $7`;
    const result =
      subject.reservationId === undefined
        ? await this.#queries.query<{ agent_run_id: string }>(
            `SELECT ar.id AS agent_run_id
               FROM agent_runs ar
               JOIN job_attempts ja ON ja.id = ar.job_attempt_id
               JOIN run_stages rs ON rs.id = ja.stage_id
               JOIN analysis_runs r ON r.id = rs.run_id
               JOIN projects p ON p.id = r.project_id
              WHERE ${authorityPredicate}
                AND ($8::text IS NULL OR ar.run_id = $8)
                AND ($9::text IS NULL OR ar.job_attempt_id = $9)
              FOR UPDATE OF ar, ja`,
            [...parameters, subject.runId ?? null, subject.jobAttemptId ?? null],
          )
        : await this.#queries.query<{ agent_run_id: string }>(
            `SELECT ar.id AS agent_run_id
               FROM agent_runs ar
               JOIN job_attempts ja ON ja.id = ar.job_attempt_id
               JOIN run_stages rs ON rs.id = ja.stage_id
               JOIN analysis_runs r ON r.id = rs.run_id
               JOIN projects p ON p.id = r.project_id
               JOIN model_budget_reservations reservation
                 ON reservation.id = $8
                AND reservation.job_attempt_id = ar.job_attempt_id
                AND reservation.run_id = ar.run_id
                AND reservation.organization_id = p.organization_id
              WHERE ${authorityPredicate}
              FOR UPDATE OF ar, ja, reservation`,
            [...parameters, subject.reservationId],
          );
    if (result.rows[0]?.agent_run_id !== authority.agentRunId) {
      throw new ModelBudgetExecutionAuthorityLostError();
    }
  }

  async #releaseExpired(asOf: string) {
    await this.#queries.query(
      `UPDATE model_budget_reservations
          SET state = 'released', lease_expires_at = NULL,
              released_at = $1, updated_at = $1
        WHERE state = 'reserved' AND lease_expires_at <= $1`,
      [asOf],
    );
  }

  async #usage(runId: string, organizationId: string, utcDay: string) {
    const run = await this.#queries.query<BudgetRow>(
      `SELECT * FROM model_budget_reservations
        WHERE run_id = $1 AND state <> 'released'`,
      [runId],
    );
    const organization = await this.#queries.query<BudgetRow>(
      `SELECT * FROM model_budget_reservations
        WHERE organization_id = $1 AND utc_day = $2::date
          AND state <> 'released'`,
      [organizationId, utcDay],
    );
    return {
      run: sumUsage(run.rows),
      organizationUtcDay: sumUsage(organization.rows),
    };
  }

  async #findReservationRow(id: string) {
    const result = await this.#queries.query<BudgetRow>(
      "SELECT * FROM model_budget_reservations WHERE id = $1",
      [id],
    );
    return result.rows[0] ?? null;
  }

  async #requireReservation(id: string) {
    const row = await this.#findReservationRow(id);
    if (!row) throw new ModelBudgetReservationNotFoundError();
    return mapReservation(row);
  }

  #transactionNow() {
    const value = this.#nowProvider();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new TypeError("Invalid PostgreSQL model budget clock");
    }
    return new Date(value.getTime()).toISOString();
  }

  async #execute<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof BudgetExceededError ||
        error instanceof ModelBudgetDataError ||
        error instanceof ModelBudgetExecutionAuthorityLostError ||
        error instanceof ModelBudgetReservationConflictError ||
        error instanceof ModelBudgetReservationNotFoundError ||
        error instanceof ModelBudgetStateConflictError ||
        error instanceof ModelBudgetSubjectNotFoundError ||
        error instanceof TypeError
      ) {
        throw error;
      }
      const code = postgresErrorCode(error);
      if (code === "23503" || code === "23505") {
        throw new ModelBudgetReservationConflictError();
      }
      throw new ModelBudgetDataError();
    }
  }
}

function assertReserveInput(input: ReserveModelBudgetInput) {
  assertIdentifier(input.id, "budget reservation ID");
  assertIdentifier(input.idempotencyKey, "budget idempotency key");
  if (!/^[0-9a-f]{64}$/.test(input.requestFingerprint)) {
    throw new TypeError("Invalid model request fingerprint");
  }
  assertSubjectInput(input.runId, input.projectId);
  assertTimestamp(input.reservedAt, "reservedAt");
  assertTimestamp(input.leaseExpiresAt, "leaseExpiresAt");
  if (input.leaseExpiresAt <= input.reservedAt) {
    throw new TypeError("Invalid budget reservation lease");
  }
  assertBudgetAmount(input.projected, "projected");
  assertBudgetLimit(input.limits.call, "call");
  assertBudgetLimit(input.limits.run, "run");
  assertBudgetLimit(input.limits.organizationUtcDay, "organizationUtcDay");
  assertAttemptProvenance(input);
  assertExecutionAuthority(input.executionAuthority, input.jobAttemptId);
}

function assertTransitionInput(input: TransitionModelBudgetInput) {
  if (!input.reservationId || input.reservationId.length > 200) {
    throw new ModelBudgetReservationNotFoundError();
  }
  assertTimestamp(input.transitionedAt, "transitionedAt");
  assertExecutionAuthority(input.executionAuthority);
}

function assertAttemptProvenance(input: ReserveModelBudgetInput) {
  const values = [
    input.jobAttemptId,
    input.requestOrdinal,
    input.attemptKind,
    input.transientRetryCount,
    input.formatRepair,
  ];
  if (values.every((value) => value === undefined)) return;
  if (values.some((value) => value === undefined)) {
    throw new TypeError("Incomplete model request attempt provenance");
  }
  assertIdentifier(input.jobAttemptId!, "model request job attempt ID");
  if (
    !Number.isSafeInteger(input.requestOrdinal) ||
    input.requestOrdinal! < 0 ||
    input.requestOrdinal! > 3 ||
    !Number.isSafeInteger(input.transientRetryCount) ||
    input.transientRetryCount! < 0 ||
    input.transientRetryCount! > 2 ||
    typeof input.formatRepair !== "boolean"
  ) {
    throw new TypeError("Invalid model request attempt identity");
  }
  const consistent =
    (input.attemptKind === "initial" &&
      input.requestOrdinal === 0 &&
      input.transientRetryCount === 0 &&
      !input.formatRepair) ||
    (input.attemptKind === "format-repair" && input.formatRepair) ||
    (input.attemptKind === "transient-retry" && input.transientRetryCount! > 0);
  if (!consistent) throw new TypeError("Invalid model request attempt identity");
}

function assertExecutionAuthority(
  authority: ModelBudgetExecutionAuthority | undefined,
  jobAttemptId?: string,
) {
  if (authority === undefined) return;
  for (const value of [
    authority.agentRunId,
    authority.organizationId,
    authority.jobAttemptId,
    authority.leaseOwnerId,
    authority.claimToken,
  ]) {
    assertIdentifier(value, "model budget execution authority");
  }
  if (
    !Number.isSafeInteger(authority.leaseGeneration) ||
    authority.leaseGeneration <= 0 ||
    (jobAttemptId !== undefined && authority.jobAttemptId !== jobAttemptId)
  ) {
    throw new TypeError("Invalid model budget execution authority");
  }
}

function assertSubjectInput(runId: string, projectId: string) {
  if (!runId || !projectId || runId.length > 200 || projectId.length > 200) {
    throw new ModelBudgetSubjectNotFoundError();
  }
}

function assertIdentifier(value: string, label: string) {
  if (typeof value !== "string" || value.length < 1 || value.length > 200) {
    throw new TypeError(`Invalid ${label}`);
  }
}

function assertTimestamp(value: string, label: string) {
  if (
    typeof value !== "string" ||
    !Number.isFinite(new Date(value).getTime()) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError(`Invalid budget timestamp for ${label}`);
  }
}

function assertBudgetInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Invalid budget value for ${label}`);
  }
}

function assertBudgetAmount(amount: ModelBudgetAmount, label: string) {
  assertBudgetInteger(amount.inputTokens, `${label}.inputTokens`);
  assertBudgetInteger(amount.outputTokens, `${label}.outputTokens`);
  assertBudgetInteger(amount.costMicros, `${label}.costMicros`);
  const tokens = amount.inputTokens + amount.outputTokens;
  if (!Number.isSafeInteger(tokens) || (label === "projected" && tokens === 0)) {
    throw new TypeError(`Invalid budget value for ${label}.tokens`);
  }
}

function assertBudgetLimit(limit: ModelBudgetLimit, label: string) {
  assertBudgetInteger(limit.maxTokens, `${label}.maxTokens`);
  assertBudgetInteger(limit.maxCostMicros, `${label}.maxCostMicros`);
}

function assertBudgetAvailable(
  scope: BudgetScope,
  usage: ModelBudgetUsage,
  projected: ModelBudgetUsage,
  limit: ModelBudgetLimit,
) {
  if (BigInt(usage.tokens) + BigInt(projected.tokens) > BigInt(limit.maxTokens)) {
    throw new BudgetExceededError(
      scope,
      "tokens",
      usage.tokens,
      projected.tokens,
      limit.maxTokens,
    );
  }
  if (
    BigInt(usage.costMicros) + BigInt(projected.costMicros) >
    BigInt(limit.maxCostMicros)
  ) {
    throw new BudgetExceededError(
      scope,
      "costMicros",
      usage.costMicros,
      projected.costMicros,
      limit.maxCostMicros,
    );
  }
}

function toUsage(amount: ModelBudgetAmount): ModelBudgetUsage {
  return {
    tokens: amount.inputTokens + amount.outputTokens,
    costMicros: amount.costMicros,
  };
}

function sumUsage(rows: readonly BudgetRow[]): ModelBudgetUsage {
  let tokens = BigInt(0);
  let costMicros = BigInt(0);
  for (const row of rows) {
    const settled = row.state === "settled";
    const input = safeStoredInteger(
      settled ? row.actual_input_tokens : row.projected_input_tokens,
    );
    const output = safeStoredInteger(
      settled ? row.actual_output_tokens : row.projected_output_tokens,
    );
    const cost = safeStoredInteger(
      settled ? row.actual_cost_micros : row.projected_cost_micros,
    );
    tokens += BigInt(input) + BigInt(output);
    costMicros += BigInt(cost);
  }
  if (
    tokens > BigInt(Number.MAX_SAFE_INTEGER) ||
    costMicros > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new ModelBudgetDataError();
  }
  return { tokens: Number(tokens), costMicros: Number(costMicros) };
}

function safeStoredInteger(value: string | number | null) {
  if (value === null) throw new ModelBudgetDataError();
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ModelBudgetDataError();
  }
  return parsed;
}

function mapReservation(row: BudgetRow): ModelBudgetReservationRecord {
  const actual =
    row.actual_input_tokens === null ||
    row.actual_output_tokens === null ||
    row.actual_cost_micros === null
      ? null
      : {
          inputTokens: safeStoredInteger(row.actual_input_tokens),
          outputTokens: safeStoredInteger(row.actual_output_tokens),
          costMicros: safeStoredInteger(row.actual_cost_micros),
        };
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    runId: row.run_id,
    projectId: row.project_id,
    organizationId: row.organization_id,
    utcDay: mapUtcDay(row.utc_day),
    state: row.state,
    projected: {
      inputTokens: safeStoredInteger(row.projected_input_tokens),
      outputTokens: safeStoredInteger(row.projected_output_tokens),
      costMicros: safeStoredInteger(row.projected_cost_micros),
    },
    actual,
    leaseExpiresAt:
      row.lease_expires_at === null ? null : mapTimestamp(row.lease_expires_at),
    createdAt: mapTimestamp(row.created_at),
    updatedAt: mapTimestamp(row.updated_at),
    dispatchedAt:
      row.dispatched_at === null ? null : mapTimestamp(row.dispatched_at),
    settledAt: row.settled_at === null ? null : mapTimestamp(row.settled_at),
    releasedAt:
      row.released_at === null ? null : mapTimestamp(row.released_at),
  };
}

function sameReservationParameters(
  reservation: ModelBudgetReservationRecord,
  row: BudgetRow,
  input: ReserveModelBudgetInput,
) {
  return (
    reservation.runId === input.runId &&
    reservation.projectId === input.projectId &&
    reservation.requestFingerprint === input.requestFingerprint &&
    reservation.projected.inputTokens === input.projected.inputTokens &&
    reservation.projected.outputTokens === input.projected.outputTokens &&
    reservation.projected.costMicros === input.projected.costMicros &&
    row.job_attempt_id === (input.jobAttemptId ?? null) &&
    row.request_ordinal === (input.requestOrdinal ?? null) &&
    row.attempt_kind === (input.attemptKind ?? null) &&
    row.transient_retry_count === (input.transientRetryCount ?? null) &&
    row.format_repair === (input.formatRepair ?? null)
  );
}

function sameAmount(left: ModelBudgetAmount | null, right: ModelBudgetAmount) {
  return (
    left !== null &&
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.costMicros === right.costMicros
  );
}

function mapTimestamp(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new ModelBudgetDataError();
  return date.toISOString();
}

function mapUtcDay(value: Date | string) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  throw new ModelBudgetDataError();
}

function postgresErrorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}
