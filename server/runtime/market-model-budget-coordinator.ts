import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MarketModelExecutionAuthoritySchema, type MarketModelExecutionAuthority } from '../../shared/market-execution-subject';
import type { MarketBudgetSubject, MarketModelBudgetRepository } from '../db/market-model-budget-repository';
import { ModelBudgetExecutionAuthorityLostError, type ModelBudgetAmount, type ModelBudgetLimits } from '../db/model-budget-repository';
import { StaticModelBudgetLimitProvider } from './model-budget-coordinator';

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const amountSchema = z.object({ inputTokens: count, outputTokens: count, costMicros: count }).strict()
  .refine(value => Number.isSafeInteger(value.inputTokens + value.outputTokens), 'Token total is outside the safe integer range');
const requestSchema = z.object({
  ordinal: z.number().int().min(0).max(3),
  kind: z.enum(['initial', 'transient-retry', 'format-repair']),
  transientRetryCount: z.number().int().min(0).max(2), formatRepair: z.boolean(),
}).strict().refine(value =>
  value.kind === 'initial' ? value.ordinal === 0 && value.transientRetryCount === 0 && !value.formatRepair :
  value.ordinal > 0 && value.transientRetryCount <= value.ordinal &&
    (value.kind === 'format-repair' ? value.formatRepair : value.transientRetryCount > 0),
'Invalid model request attempt identity');
export const marketBudgetReservationRequestSchema = z.object({
  idempotencyKey: z.string().min(1).max(200), requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  projected: amountSchema.refine(value => value.inputTokens + value.outputTokens > 0),
  request: requestSchema, authority: MarketModelExecutionAuthoritySchema,
}).strict();
export type ReserveMarketModelRequestInput = z.infer<typeof marketBudgetReservationRequestSchema>;
export interface MarketModelBudgetLimitProvider {
  getLimits(context: MarketBudgetSubject & { requestFingerprint: string }): ModelBudgetLimits | Promise<ModelBudgetLimits>;
}
export interface MarketModelBudgetCoordinatorDependencies {
  repository: MarketModelBudgetRepository;
  limitProvider: MarketModelBudgetLimitProvider;
  clock?: () => Date;
  createId?: () => string;
  reservationLeaseMs?: number;
}

/** Native admission API; the persistent repository shares the existing ledger. */
export class MarketModelBudgetCoordinator {
  readonly #dependencies: MarketModelBudgetCoordinatorDependencies;
  readonly #leaseMs: number;
  constructor(dependencies: MarketModelBudgetCoordinatorDependencies) {
    this.#dependencies = dependencies;
    this.#leaseMs = dependencies.reservationLeaseMs ?? 60_000;
    if (!Number.isSafeInteger(this.#leaseMs) || this.#leaseMs < 1 || this.#leaseMs > 300_000) {
      throw new TypeError('Invalid market model reservation lease');
    }
  }
  async reserve(input: ReserveMarketModelRequestInput) {
    const parsed = marketBudgetReservationRequestSchema.parse(input);
    const now = this.#now();
    const leaseExpiresAt = new Date(now.getTime() + this.#leaseMs);
    if (!Number.isFinite(leaseExpiresAt.getTime())) throw new TypeError('Invalid reservation expiry');
    const subject = await this.#dependencies.repository.resolveSubject(parsed.authority);
    if (subject.organizationId !== parsed.authority.organizationId || subject.studyId !== parsed.authority.studyId || subject.moduleRunId !== parsed.authority.moduleRunId) {
      throw new ModelBudgetExecutionAuthorityLostError();
    }
    const policy = await this.#dependencies.limitProvider.getLimits({ ...subject, requestFingerprint: parsed.requestFingerprint });
    const limits = new StaticModelBudgetLimitProvider(policy).getLimits();
    const result = await this.#dependencies.repository.reserve({ ...parsed, limits,
      id: (this.#dependencies.createId ?? randomUUID)(), reservedAt: now.toISOString(), leaseExpiresAt: leaseExpiresAt.toISOString(),
    });
    return result.reservation;
  }
  dispatch(reservationId: string, authority: Readonly<MarketModelExecutionAuthority>) {
    return this.#dependencies.repository.dispatch(this.#transition(reservationId, authority));
  }
  release(reservationId: string, authority: Readonly<MarketModelExecutionAuthority>) {
    return this.#dependencies.repository.release(this.#transition(reservationId, authority));
  }
  settle(reservationId: string, actual: ModelBudgetAmount, responseId: string | undefined, authority: Readonly<MarketModelExecutionAuthority>) {
    return this.#dependencies.repository.settle({ ...this.#transition(reservationId, authority), actual: amountSchema.parse(actual),
      ...(responseId === undefined ? {} : { responseId: z.string().min(1).max(500).parse(responseId) }),
    });
  }
  #transition(reservationId: string, authority: Readonly<MarketModelExecutionAuthority>) {
    return { reservationId: z.string().uuid().parse(reservationId), authority: MarketModelExecutionAuthoritySchema.parse(authority), transitionedAt: this.#now().toISOString() };
  }
  #now() {
    const now = (this.#dependencies.clock ?? (() => new Date()))();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('Invalid market model server clock');
    return new Date(now.getTime());
  }
}
