export type BudgetScope = "call" | "run" | "daily";
export type BudgetMetric = "tokens" | "costUsd";

export interface BudgetAmount {
  tokens: number;
  costUsd: number;
}

export interface BudgetLimit {
  maxTokens: number;
  maxCostUsd: number;
}

export interface BudgetCheck {
  limits: Record<BudgetScope, BudgetLimit>;
  usage: Record<BudgetScope, BudgetAmount>;
  projected: BudgetAmount;
}

export class BudgetExceededError extends Error {
  readonly code = "BUDGET_EXCEEDED";

  constructor(
    readonly scope: BudgetScope,
    readonly metric: BudgetMetric,
    readonly used: number,
    readonly projected: number,
    readonly limit: number,
  ) {
    super(
      `${scope} ${metric} budget exceeded: ${used} used + ${projected} projected > ${limit}`,
    );
    this.name = "BudgetExceededError";
  }
}

function assertNonNegativeFinite(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`Invalid budget value for ${label}`);
  }
}

function assertValidLimit(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`Invalid budget limit for ${label}`);
  }
}

export function assertBudgetAvailable(check: BudgetCheck): void {
  assertNonNegativeFinite(check.projected.tokens, "projected.tokens");
  assertNonNegativeFinite(check.projected.costUsd, "projected.costUsd");

  for (const scope of ["call", "run", "daily"] as const) {
    const limit = check.limits[scope];
    const usage = check.usage[scope];
    assertValidLimit(limit.maxTokens, `${scope}.maxTokens`);
    assertValidLimit(limit.maxCostUsd, `${scope}.maxCostUsd`);
    assertNonNegativeFinite(usage.tokens, `${scope}.tokens`);
    assertNonNegativeFinite(usage.costUsd, `${scope}.costUsd`);

    if (usage.tokens + check.projected.tokens > limit.maxTokens) {
      throw new BudgetExceededError(
        scope,
        "tokens",
        usage.tokens,
        check.projected.tokens,
        limit.maxTokens,
      );
    }
    if (usage.costUsd + check.projected.costUsd > limit.maxCostUsd) {
      throw new BudgetExceededError(
        scope,
        "costUsd",
        usage.costUsd,
        check.projected.costUsd,
        limit.maxCostUsd,
      );
    }
  }
}
