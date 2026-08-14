import { randomUUID } from "node:crypto";

import { z } from "zod";

import type {
  ModelBudgetAmount,
  ModelBudgetExecutionAuthority,
  ModelBudgetLedgerRepository,
  ModelBudgetLimits,
  ModelBudgetReservationRecord,
  ModelBudgetTransitionResult,
} from "../db/model-budget-repository";
import type { ModelRequestAttemptIdentity } from "./model-request-accounting";

export interface ModelBudgetLimitContext {
  runId: string;
  projectId: string;
  organizationId: string;
  requestFingerprint: string;
}

export interface ModelBudgetLimitProvider {
  getLimits(
    context: ModelBudgetLimitContext,
  ): ModelBudgetLimits | Promise<ModelBudgetLimits>;
}

const ModelBudgetLimitSchema = z
  .object({
    maxTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    maxCostMicros: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

const ModelBudgetLimitsSchema = z
  .object({
    call: ModelBudgetLimitSchema,
    run: ModelBudgetLimitSchema,
    organizationUtcDay: ModelBudgetLimitSchema,
  })
  .strict();

export class StaticModelBudgetLimitProvider
  implements ModelBudgetLimitProvider
{
  readonly #limits: ModelBudgetLimits;

  constructor(configuration: unknown) {
    const parsed = ModelBudgetLimitsSchema.safeParse(configuration);
    if (!parsed.success) {
      throw new TypeError("Invalid server model budget limits configuration");
    }
    this.#limits = freezeLimits(parsed.data);
  }

  getLimits(context?: ModelBudgetLimitContext): ModelBudgetLimits {
    void context;
    return freezeLimits(this.#limits);
  }
}

export interface ReserveModelRequestInput {
  idempotencyKey: string;
  /**
   * Server-derived SHA-256 over agent/model configuration, a canonical request
   * hash, and request ordinal/repair-retry identity. It must never contain the
   * raw prompt, credentials, or other secrets.
   */
  requestFingerprint: string;
  runId: string;
  projectId: string;
  projected: ModelBudgetAmount;
  jobAttemptId?: string;
  request?: Readonly<ModelRequestAttemptIdentity>;
  executionAuthority?: Readonly<ModelBudgetExecutionAuthority>;
}

export interface ModelBudgetCoordinatorDependencies {
  repository: ModelBudgetLedgerRepository;
  limitProvider: ModelBudgetLimitProvider;
  clock?: () => Date;
  createId?: () => string;
  reservationLeaseMs?: number;
}

export class ModelBudgetCoordinator {
  readonly #repository: ModelBudgetLedgerRepository;
  readonly #limitProvider: ModelBudgetLimitProvider;
  readonly #clock: () => Date;
  readonly #createId: () => string;
  readonly #reservationLeaseMs: number;

  constructor(dependencies: ModelBudgetCoordinatorDependencies) {
    const leaseDuration = dependencies.reservationLeaseMs ?? 60_000;
    if (!Number.isSafeInteger(leaseDuration) || leaseDuration <= 0) {
      throw new TypeError("Invalid model budget reservation lease duration");
    }
    this.#repository = dependencies.repository;
    this.#limitProvider = dependencies.limitProvider;
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createId = dependencies.createId ?? randomUUID;
    this.#reservationLeaseMs = leaseDuration;
  }

  async reserve(
    input: ReserveModelRequestInput,
  ): Promise<ModelBudgetReservationRecord> {
    assertRequestFingerprint(input.requestFingerprint);
    assertOptionalAttemptProvenance(input);
    const now = this.#now();
    const leaseExpiresAt = new Date(
      now.getTime() + this.#reservationLeaseMs,
    );
    if (!Number.isFinite(leaseExpiresAt.getTime())) {
      throw new TypeError("Invalid model budget reservation lease expiry");
    }
    const subject = await this.#repository.resolveModelBudgetSubject({
      runId: input.runId,
      projectId: input.projectId,
    });
    const limits = await this.#limitProvider.getLimits({
      runId: subject.runId,
      projectId: subject.projectId,
      organizationId: subject.organizationId,
      requestFingerprint: input.requestFingerprint,
    });
    const result = await this.#repository.reserveModelBudget({
      id: this.#createId(),
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      runId: input.runId,
      projectId: input.projectId,
      projected: input.projected,
      limits,
      reservedAt: now.toISOString(),
      leaseExpiresAt: leaseExpiresAt.toISOString(),
      jobAttemptId: input.jobAttemptId,
      requestOrdinal: input.request?.ordinal,
      attemptKind: input.request?.kind,
      transientRetryCount: input.request?.transientRetryCount,
      formatRepair: input.request?.formatRepair,
      executionAuthority: input.executionAuthority,
    });
    return result.reservation;
  }

  dispatch(
    reservationId: string,
    executionAuthority?: Readonly<ModelBudgetExecutionAuthority>,
  ): Promise<ModelBudgetTransitionResult> {
    return this.#repository.dispatchModelBudget({
      reservationId,
      transitionedAt: this.#now().toISOString(),
      executionAuthority,
    });
  }

  release(reservationId: string): Promise<ModelBudgetTransitionResult> {
    return this.#repository.releaseModelBudget({
      reservationId,
      transitionedAt: this.#now().toISOString(),
    });
  }

  settle(
    reservationId: string,
    actual: ModelBudgetAmount,
    responseId?: string,
    executionAuthority?: Readonly<ModelBudgetExecutionAuthority>,
  ): Promise<ModelBudgetTransitionResult> {
    return this.#repository.settleModelBudget({
      reservationId,
      actual,
      responseId,
      transitionedAt: this.#now().toISOString(),
      executionAuthority,
    });
  }

  #now() {
    const now = this.#clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new TypeError("Invalid model budget server clock");
    }
    return new Date(now.getTime());
  }
}

function assertOptionalAttemptProvenance(input: ReserveModelRequestInput) {
  if ((input.jobAttemptId === undefined) !== (input.request === undefined)) {
    throw new TypeError("Incomplete model request attempt provenance");
  }
}

function assertRequestFingerprint(value: string) {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError("Invalid model request fingerprint");
  }
}

function freezeLimits(limits: ModelBudgetLimits): ModelBudgetLimits {
  return Object.freeze({
    call: Object.freeze({ ...limits.call }),
    run: Object.freeze({ ...limits.run }),
    organizationUtcDay: Object.freeze({ ...limits.organizationUtcDay }),
  });
}
