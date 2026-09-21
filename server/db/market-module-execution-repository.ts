import type { LocalAdmission } from './concurrency-control-repository';
import type { MarketAnalysisScope, MarketJsonValue } from "../../shared/market-analysis-contracts";

export const MARKET_MODULE_KINDS = ["overview", "shape-price", "keywords", "customer-themes"] as const;
export const MARKET_STEP_KINDS = ["collect-product-month", "collect-overview-month", "collect-keyword-page", "collect-keyword-trend", "collect-keyword-aba", "collect-customer-themes", "prepare-members", "prepare-keyword-pool", "prepare-model-batches", "reconcile", "model-batch", "rules", "report"] as const;
export type MarketModuleKind = typeof MARKET_MODULE_KINDS[number];
export type MarketStepKind = typeof MARKET_STEP_KINDS[number];
export type MarketExecutionActor = { organizationId: string; userId: string };
export type MarketStepInputRef = { kind: "input" | "source" | "step-output"; id: string };
export type MarketStepDefinition = { stepKey: string; kind: MarketStepKind; subject: MarketJsonValue; input: MarketJsonValue; inputRefs: MarketStepInputRef[] };
export type MarketExecutionVersions = { source: string; rule: string; mapping: string; planner: string; model: string | null; prompt: string | null; configuration: string | null };
export type CreateMarketModuleRunInput = { actor: MarketExecutionActor; scope: MarketAnalysisScope; moduleKind: MarketModuleKind; params: MarketJsonValue; versions: MarketExecutionVersions; collectionRevision: string; idempotencyKey: string; initialSteps: MarketStepDefinition[] };
export type MarketModuleRun = { id: string; scope: MarketAnalysisScope; moduleKind: MarketModuleKind; params: MarketJsonValue; versions: MarketExecutionVersions; collectionRevision: string; requestFingerprint: string; status: "queued" | "running" | "partial" | "succeeded" | "failed" | "cancelled"; createdBy: string; createdAt: string; planRevision: number; latestReportAttemptId: string | null };
export type MarketExecutionStep = MarketStepDefinition & { id: string; inputHash: string; status: "queued" | "running" | "succeeded" | "empty" | "failed" | "cancelled"; attemptCount: number; retryRound: number; latestAttemptId: string | null; nextAttemptAt?: string | null };
export type MarketExecutionAttempt = { id: string; stepId: string; attemptNumber: number; retryRound: number; leaseGeneration: number; status: "running" | "succeeded" | "empty" | "failed" | "cancelled" | "interrupted"; output: MarketJsonValue | null; error: MarketJsonValue | null };
export type MarketModuleRunView = { run: MarketModuleRun; steps: MarketExecutionStep[]; attempts: MarketExecutionAttempt[] };
export type MarketStepClaim = { organizationId: string; studyId: string; moduleRunId: string; stepId: string; attemptId: string; createdBy: string; leaseOwnerId: string; leaseGeneration: number; inputHash: string; leaseUntil: string; step: MarketStepDefinition };
export const MARKET_STEP_ERROR_CODES = ["upstream-temporary", "timeout", "interrupted", "authentication", "local-admission", "governance", "invalid-data", "scope-mismatch", "cancelled", "internal"] as const;
export type MarketStepError = { code: typeof MARKET_STEP_ERROR_CODES[number]; retryable: boolean; admission?: LocalAdmission };
export type MarketStepOutcome = { status: "succeeded" | "empty"; output: MarketJsonValue } | { status: "failed"; error: MarketStepError; diagnostic?: MarketJsonValue };
/** Source/input values are T4/T1 factory inputs, validated again by the shared T10 store. */
export type MarketStepSettlement = { claim: MarketStepClaim; outcome: MarketStepOutcome; sources?: MarketJsonValue[]; inputs?: MarketJsonValue[]; children?: MarketStepDefinition[] };
export type MarketStepSettlementReceipt = { status: "committed" | "already-committed" | "lease-lost"; attemptId: string; sourceIds: string[]; inputIds: string[]; childStepIds: string[] };
export type MarketRetryFailedSteps = { actor: MarketExecutionActor; moduleRunId: string; steps: { stepId: string; failedAttemptId: string }[]; idempotencyKey: string };
export type MarketRetryReceipt = { moduleRunId: string; stepIds: string[] };
export type MarketCancelRun = { actor: MarketExecutionActor; moduleRunId: string; idempotencyKey: string };
export type MarketCancelReceipt = { moduleRunId: string; cancelled: true };

export interface MarketModuleExecutionRepository {
  createModuleRun(input: CreateMarketModuleRunInput): Promise<{ run: MarketModuleRun; created: boolean }>;
  findModuleRun(input: { actor: MarketExecutionActor; moduleRunId: string }): Promise<MarketModuleRunView | null>;
  claimStep(input: { leaseOwnerId: string; leaseMs: number; moduleRunId?: string; kinds?: MarketStepKind[];
    moduleKindsByStepKind?: Partial<Record<MarketStepKind, MarketModuleKind[]>>;
    flowVersionsByStepKind?: Partial<Record<MarketStepKind,string[]>> }): Promise<MarketStepClaim | null>;
  renewStep(input: { claim: MarketStepClaim; leaseMs: number }): Promise<boolean>;
  settleAndEnqueue(input: MarketStepSettlement): Promise<MarketStepSettlementReceipt>;
  retryFailedSteps(input: MarketRetryFailedSteps): Promise<MarketRetryReceipt>;
  cancelModuleRun(input: MarketCancelRun): Promise<MarketCancelReceipt>;
}
export class MarketExecutionConflictError extends Error {
  constructor() { super("Market step request, scope or current execution state conflicts"); }
}
