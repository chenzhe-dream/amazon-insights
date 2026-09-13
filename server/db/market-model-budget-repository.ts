import type { MarketModelExecutionAuthority } from '../../shared/market-execution-subject';
import type { ModelRequestAttemptIdentity } from '../runtime/model-request-accounting';
import type { ModelBudgetAmount, ModelBudgetLimits, ModelBudgetReservationRecord, ModelBudgetUsageSnapshot } from './model-budget-repository';
import type { AgentRunAttempt } from '../../shared/agent-contracts';

export type MarketBudgetSubject = Pick<MarketModelExecutionAuthority, 'organizationId' | 'studyId' | 'moduleRunId'>;
export type MarketBudgetReservationRecord = Omit<ModelBudgetReservationRecord, 'runId' | 'projectId'> &
  Pick<MarketModelExecutionAuthority, 'kind' | 'studyId' | 'moduleRunId' | 'stepId' | 'attemptId' | 'agentRunId'>;
export interface ReserveMarketModelBudgetInput {
  id: string;
  idempotencyKey: string;
  requestFingerprint: string;
  projected: ModelBudgetAmount;
  limits: ModelBudgetLimits;
  reservedAt: string;
  leaseExpiresAt: string;
  request: Readonly<ModelRequestAttemptIdentity>;
  authority: Readonly<MarketModelExecutionAuthority>;
}
export interface TransitionMarketModelBudgetInput {
  reservationId: string;
  transitionedAt: string;
  authority: Readonly<MarketModelExecutionAuthority>;
}
export interface SettleMarketModelBudgetInput extends TransitionMarketModelBudgetInput {
  actual: ModelBudgetAmount;
  responseId?: string;
}
export interface MarketBudgetTransitionResult {
  reservation: MarketBudgetReservationRecord;
  transitioned: boolean;
}

/** PostgreSQL implementations must use the legacy organization's same day ledger and lock. */
export interface MarketModelBudgetRepository {
  resolveSubject(authority: Readonly<MarketModelExecutionAuthority>): Promise<MarketBudgetSubject>;
  reserve(input: ReserveMarketModelBudgetInput): Promise<{ reservation: MarketBudgetReservationRecord; created: boolean }>;
  getUsage(input: { authority: Readonly<MarketModelExecutionAuthority>; asOf: string }): Promise<ModelBudgetUsageSnapshot>;
  dispatch(input: TransitionMarketModelBudgetInput): Promise<MarketBudgetTransitionResult>;
  release(input: TransitionMarketModelBudgetInput): Promise<MarketBudgetTransitionResult>;
  settle(input: SettleMarketModelBudgetInput): Promise<MarketBudgetTransitionResult>;
}

export interface MarketModelLedgerUsage {
  source: 'request-ledger';
  reservationCount: number;
  usageCompleteness: 'complete' | 'partial' | 'unavailable';
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostMicros: number | null;
  responseId: string | null;
  attempts: AgentRunAttempt[];
}
export interface MarketModelBudgetAuditRepository extends MarketModelBudgetRepository {
  getAgentUsage(authority: Readonly<MarketModelExecutionAuthority>): Promise<MarketModelLedgerUsage>;
}
