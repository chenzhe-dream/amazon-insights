import { randomUUID } from "node:crypto";

import type {
  ModelBudgetAmount,
  ModelBudgetLedgerRepository,
  ModelBudgetLimits,
  ModelBudgetReservationRecord,
} from "../db/model-budget-repository";

export interface ModelBudgetLimitProvider {
  getLimits(): ModelBudgetLimits | Promise<ModelBudgetLimits>;
}

export interface ReserveModelRequestInput {
  idempotencyKey: string;
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
    const now = this.#now();
    const leaseExpiresAt = new Date(
      now.getTime() + this.#reservationLeaseMs,
    );
    if (!Number.isFinite(leaseExpiresAt.getTime())) {
      throw new TypeError("Invalid model budget reservation lease expiry");
    }
    const limits = await this.#limitProvider.getLimits();
    const result = await this.#repository.reserveModelBudget({
      id: this.#createId(),
      idempotencyKey: input.idempotencyKey,
      runId: input.runId,
      projectId: input.projectId,
      utcDay: now.toISOString().slice(0, 10),
      projected: input.projected,
      limits,
      reservedAt: now.toISOString(),
      leaseExpiresAt: leaseExpiresAt.toISOString(),
    });
    return result.reservation;
  }

  dispatch(reservationId: string): Promise<ModelBudgetReservationRecord> {
    return this.#repository.dispatchModelBudget({
      reservationId,
      transitionedAt: this.#now().toISOString(),
    });
  }

  release(reservationId: string): Promise<ModelBudgetReservationRecord> {
    return this.#repository.releaseModelBudget({
      reservationId,
      transitionedAt: this.#now().toISOString(),
    });
  }

  settle(
    reservationId: string,
    actual: ModelBudgetAmount,
  ): Promise<ModelBudgetReservationRecord> {
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
