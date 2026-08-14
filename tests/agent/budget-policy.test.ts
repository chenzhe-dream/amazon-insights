import assert from "node:assert/strict";
import test from "node:test";

import {
  BudgetExceededError,
  assertBudgetAvailable,
  type BudgetCheck,
} from "../../server/runtime/budget-policy";

const baseCheck: BudgetCheck = {
  limits: {
    call: { maxTokens: 1_000, maxCostUsd: 1 },
    run: { maxTokens: 10_000, maxCostUsd: 10 },
    daily: { maxTokens: 100_000, maxCostUsd: 100 },
  },
  usage: {
    call: { tokens: 0, costUsd: 0 },
    run: { tokens: 1_000, costUsd: 1 },
    daily: { tokens: 10_000, costUsd: 10 },
  },
  projected: { tokens: 500, costUsd: 0.5 },
};

test("budget allows a request below every externally supplied limit", () => {
  assert.doesNotThrow(() => assertBudgetAvailable(baseCheck));
});

for (const scope of ["call", "run", "daily"] as const) {
  test(`${scope} token exhaustion rejects before a model request`, () => {
    const check = structuredClone(baseCheck);
    check.usage[scope].tokens =
      check.limits[scope].maxTokens - check.projected.tokens + 1;

    assert.throws(
      () => assertBudgetAvailable(check),
      (error: unknown) =>
        error instanceof BudgetExceededError &&
        error.scope === scope &&
        error.metric === "tokens",
    );
  });

  test(`${scope} cost exhaustion rejects before a model request`, () => {
    const check = structuredClone(baseCheck);
    check.usage[scope].costUsd =
      check.limits[scope].maxCostUsd - check.projected.costUsd + 0.01;

    assert.throws(
      () => assertBudgetAvailable(check),
      (error: unknown) =>
        error instanceof BudgetExceededError &&
        error.scope === scope &&
        error.metric === "costUsd",
    );
  });
}

test("budget rejects non-finite, negative, or internally inconsistent values", () => {
  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const check = structuredClone(baseCheck);
    check.projected.tokens = invalid;
    assert.throws(() => assertBudgetAvailable(check), /budget/i);
  }

  const inconsistent = structuredClone(baseCheck);
  inconsistent.usage.run.tokens = 11_000;
  assert.throws(() => assertBudgetAvailable(inconsistent), BudgetExceededError);
});

test("budget token values must be non-negative safe integers", () => {
  for (const invalid of [0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const projected = structuredClone(baseCheck);
    projected.projected.tokens = invalid;
    assert.throws(() => assertBudgetAvailable(projected), /budget/i);

    const usage = structuredClone(baseCheck);
    usage.usage.run.tokens = invalid;
    assert.throws(() => assertBudgetAvailable(usage), /budget/i);

    const limit = structuredClone(baseCheck);
    limit.limits.daily.maxTokens = invalid;
    assert.throws(() => assertBudgetAvailable(limit), /budget/i);
  }
});

test("a zero hard limit is exhausted rather than treated as invalid configuration", () => {
  const check = structuredClone(baseCheck);
  check.limits.call.maxTokens = 0;
  assert.throws(
    () => assertBudgetAvailable(check),
    (error: unknown) =>
      error instanceof BudgetExceededError && error.scope === "call",
  );
});
