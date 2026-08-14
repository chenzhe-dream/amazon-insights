export type ModelBudgetReservationState =
  | "reserved"
  | "dispatched"
  | "settled"
  | "released";

export interface ModelBudgetAmount {
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
}

export interface ModelBudgetUsage {
  tokens: number;
  costMicros: number;
}

export interface ModelBudgetLimit {
  maxTokens: number;
  maxCostMicros: number;
}

export interface ModelBudgetLimits {
  call: ModelBudgetLimit;
  run: ModelBudgetLimit;
  organizationUtcDay: ModelBudgetLimit;
}

export interface ModelBudgetReservationRecord {
  id: string;
  idempotencyKey: string;
  requestFingerprint: string;
  runId: string;
  projectId: string;
  organizationId: string;
  utcDay: string;
  state: ModelBudgetReservationState;
  projected: ModelBudgetAmount;
  actual: ModelBudgetAmount | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  dispatchedAt: string | null;
  settledAt: string | null;
  releasedAt: string | null;
}

export interface ReserveModelBudgetInput {
  id: string;
  idempotencyKey: string;
  requestFingerprint: string;
  runId: string;
  projectId: string;
  projected: ModelBudgetAmount;
  limits: ModelBudgetLimits;
  reservedAt: string;
  leaseExpiresAt: string;
  jobAttemptId?: string;
  requestOrdinal?: number;
  attemptKind?: "initial" | "transient-retry" | "format-repair";
  transientRetryCount?: number;
  formatRepair?: boolean;
}

export interface ReserveModelBudgetResult {
  reservation: ModelBudgetReservationRecord;
  created: boolean;
}

export interface GetModelBudgetUsageInput {
  runId: string;
  projectId: string;
  asOf: string;
}

export interface ResolveModelBudgetSubjectInput {
  runId: string;
  projectId: string;
}

export interface ModelBudgetSubject {
  runId: string;
  projectId: string;
  organizationId: string;
}

export interface ModelBudgetUsageSnapshot {
  run: ModelBudgetUsage;
  organizationUtcDay: ModelBudgetUsage;
}

export interface TransitionModelBudgetInput {
  reservationId: string;
  transitionedAt: string;
}

export interface SettleModelBudgetInput extends TransitionModelBudgetInput {
  actual: ModelBudgetAmount;
}

/**
 * `transitioned` is the authority bit for the current call. In particular,
 * only a dispatch result with `transitioned: true` may cross the provider
 * boundary. An idempotent replay always returns `false`.
 */
export interface ModelBudgetTransitionResult {
  reservation: ModelBudgetReservationRecord;
  transitioned: boolean;
}

export class ModelBudgetReservationConflictError extends Error {
  readonly code = "BUDGET_RESERVATION_CONFLICT";

  constructor() {
    super("Budget reservation conflicts with an existing model request");
    this.name = "ModelBudgetReservationConflictError";
  }
}

export class ModelBudgetSubjectNotFoundError extends Error {
  readonly code = "BUDGET_SUBJECT_NOT_FOUND";

  constructor() {
    super("Budget subject was not found or is not available");
    this.name = "ModelBudgetSubjectNotFoundError";
  }
}

export class ModelBudgetDataError extends Error {
  readonly code = "BUDGET_DATA_INVALID";

  constructor() {
    super("Stored model budget usage is invalid");
    this.name = "ModelBudgetDataError";
  }
}

export class ModelBudgetReservationNotFoundError extends Error {
  readonly code = "BUDGET_RESERVATION_NOT_FOUND";

  constructor() {
    super("Budget reservation was not found or is not available");
    this.name = "ModelBudgetReservationNotFoundError";
  }
}

export class ModelBudgetStateConflictError extends Error {
  readonly code = "BUDGET_STATE_CONFLICT";

  constructor() {
    super("Budget reservation state does not allow this transition");
    this.name = "ModelBudgetStateConflictError";
  }
}

export interface ModelBudgetLedgerRepository {
  resolveModelBudgetSubject(
    input: ResolveModelBudgetSubjectInput,
  ): Promise<ModelBudgetSubject>;
  reserveModelBudget(
    input: ReserveModelBudgetInput,
  ): Promise<ReserveModelBudgetResult>;
  getModelBudgetUsage(
    input: GetModelBudgetUsageInput,
  ): Promise<ModelBudgetUsageSnapshot>;
  dispatchModelBudget(
    input: TransitionModelBudgetInput,
  ): Promise<ModelBudgetTransitionResult>;
  releaseModelBudget(
    input: TransitionModelBudgetInput,
  ): Promise<ModelBudgetTransitionResult>;
  settleModelBudget(
    input: SettleModelBudgetInput,
  ): Promise<ModelBudgetTransitionResult>;
}
