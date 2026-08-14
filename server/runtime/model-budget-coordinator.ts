import { randomUUID } from "node:crypto";

import type {
  ModelBudgetAmount,
  ModelBudgetLedgerRepository,
  ModelBudgetLimits,
  ModelBudgetReservationRecord,
  ModelBudgetTransitionResult,
} from "../db/model-budget-repository";

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
    });
    return result.reservation;
  }

  dispatch(reservationId: string): Promise<ModelBudgetTransitionResult> {
    return this.#repository.dispatchModelBudget({
      reservationId,
      transitionedAt: this.#now().toISOString(),
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
  ): Promise<ModelBudgetTransitionResult> {
    return this.#repository.settleModelBudget({
      reservationId,
      actual,
      transitionedAt: this.#now().toISOString(),
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

function assertRequestFingerprint(value: string) {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError("Invalid model request fingerprint");
  }
}
