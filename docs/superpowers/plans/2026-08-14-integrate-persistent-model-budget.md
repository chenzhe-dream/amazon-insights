# Persistent Model Budget Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fence every `SkillRunner` provider request with the persistent call/run/organization UTC-day budget ledger and settle integer token/cost usage before any retry or format repair decision.

**Architecture:** `SkillRunner.run` accepts a separate, strictly validated server execution context and requires an injected persistent budget coordinator. A focused request-accounting module produces canonical SHA-256 fingerprints, deterministic job-attempt ordinals, and conservative integer cost micros. The existing SQLite reservation ledger remains the source of truth and its dispatch CAS is the sole authority to cross the provider boundary.

**Tech Stack:** TypeScript 5.9, Node 22 test runner, Zod 4, Node `crypto`, SQLite `DatabaseSync`, existing `ModelBudgetCoordinator` and `SkillRunner`.

## Global Constraints

- Work only on `feat/integrate-persistent-budget` in `C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\feat-integrate-persistent-budget` from exact baseline `6ae6c3e9e0cc66fb6e5f7ab1e09dc558a126e726`.
- Do not modify the main worktree, stash, push, merge, amend, or rebase.
- Do not implement OpenSpec 7.3, VOC, login, PostgreSQL, UI, or agent-run/output persistence.
- Every provider request, including transient retry and format repair, gets a distinct stable ordinal, reservation, idempotency key, and fingerprint.
- Persistent admission and settlement use nonnegative safe-integer cost micros only; projected tokens must be positive.
- `BudgetExceededError` propagates unchanged to `WorkerLoop`.

---

### Task 1: Canonical request identity and integer model accounting

**Files:**
- Create: `server/runtime/model-request-accounting.ts`
- Create: `tests/agent/model-request-accounting.test.ts`

**Interfaces:**
- Produces: `calculateModelCostMicros(inputTokens, outputTokens, pricing): number`.
- Produces: `createModelRequestIdempotencyKey({ runId, jobAttemptId, ordinal }): string`.
- Produces: `createModelRequestFingerprint(identity): string`, where identity includes Skill provenance, provider/model/config, canonical parsed-input hash, snapshot IDs, output-contract identity, and retry/repair ordinal identity.

- [ ] **Step 1: Write failing accounting and canonicalization tests**

  Cover key-order stability; array-order preservation; rejection of `undefined`, sparse arrays, non-finite numbers, bigint, functions, symbols, cyclic and non-plain objects; semantic changes in Skill/model/config/input/snapshot/output contract/ordinal; stable idempotency across restart; distinct ordinals; ceil rounding; invalid/overflowing counts and prices; and actual usage above projection.

- [ ] **Step 2: Run RED**

  Run: `npx tsx --conditions=react-server --test tests/agent/model-request-accounting.test.ts`

  Expected: FAIL because `server/runtime/model-request-accounting.ts` does not exist.

- [ ] **Step 3: Implement minimal primitives**

  Canonicalize only JSON values using recursively sorted object keys and preserved array order. Hash the canonical parsed input separately, then hash a versioned canonical identity envelope. Calculate micros as `ceil(inputTokens * inputUsdPerMillionTokens + outputTokens * outputUsdPerMillionTokens)` after strict finite/safe-integer checks, rejecting unsafe totals.

- [ ] **Step 4: Run GREEN and refactor**

  Run: `npx tsx --conditions=react-server --test tests/agent/model-request-accounting.test.ts`

  Expected: PASS with zero failures.

### Task 2: Strict server-owned limit configuration

**Files:**
- Modify: `server/runtime/model-budget-coordinator.ts`
- Modify: `tests/agent/model-budget-coordinator.test.ts`

**Interfaces:**
- Produces: `StaticModelBudgetLimitProvider`, accepting `unknown` once at construction, rejecting unknown/missing keys and every negative, fractional, non-finite, or unsafe integer.

- [ ] **Step 1: Write failing strict provider tests**

  Assert exact `call`, `run`, and `organizationUtcDay` shapes; immutable cloned returns; zero limits allowed; and all invalid values rejected before reservation persistence.

- [ ] **Step 2: Run RED**

  Run: `npx tsx --conditions=react-server --test tests/agent/model-budget-coordinator.test.ts`

  Expected: FAIL because the static provider export does not exist.

- [ ] **Step 3: Implement the provider**

  Parse limits with strict Zod objects and safe-integer nonnegative fields, freeze the stored copy, and return a fresh clone from `getLimits` without exposing configuration to browser contracts.

- [ ] **Step 4: Run GREEN**

  Run: `npx tsx --conditions=react-server --test tests/agent/model-budget-coordinator.test.ts`

  Expected: PASS with zero failures.

### Task 3: Fence and settle every SkillRunner provider boundary

**Files:**
- Modify: `server/runtime/skill-runner.ts`
- Modify: `tests/agent/skill-runner.test.ts`
- Create: `tests/agent/skill-runner-persistent-budget.test.ts`

**Interfaces:**
- Produces: strict `SkillExecutionContext` with `runId`, `projectId`, and `jobAttemptId` UUIDv4 fields.
- Changes: `SkillRunner` requires `budgetCoordinator`; `run(request, executionContext)` has no caller-supplied budget field.
- Consumes: Task 1 accounting and identity functions; existing coordinator `reserve`, `dispatch`, `release`, and `settle` methods.

- [ ] **Step 1: Write RED API and boundary-order tests**

  Remove `budget` from request fixtures and add a compile/runtime rejection check for legacy `request.budget`. Record coordinator/provider events to prove each request orders `reserve`, optional `release`, `dispatch`, provider, then `settle`; prove settlement precedes output validation/retry/repair; prove settlement failure prevents later provider calls; and prove IDs/context never enter prompt, input, or ordinary logs.

- [ ] **Step 2: Write RED persistent behavior tests**

  With real SQLite and two connections, cover every call/run/daily token and cost scope, restart blocking from reserved/dispatched/settled usage, same-job dispatch CAS with one provider call, stable replay keys/fingerprints, distinct retry/repair rows, conservative dispatched rows for errors without usage, pre-dispatch abort release, usage-bearing success/transient/invalid-output settlement, and actual-over-projection accounting.

- [ ] **Step 3: Run RED**

  Run: `npx tsx --conditions=react-server --test tests/agent/skill-runner.test.ts tests/agent/skill-runner-persistent-budget.test.ts`

  Expected: FAIL because the old in-memory `request.budget` path remains and no persistent coordinator is used.

- [ ] **Step 4: Implement provider-boundary fencing**

  Validate the server context, load the Skill, validate/canonicalize parsed input, compute the request identity for the current ordinal, reserve projected tokens/micros, release only an abort-visible still-reserved reservation, dispatch, and allow provider entry only on `transitioned === true`. Normalize replay/expired/state failures to deterministic safe runtime errors without IDs or secrets.

- [ ] **Step 5: Implement immediate settlement**

  Validate usage and calculate actual micros for successful responses and `ModelProviderError` values carrying usage. Settle before output safety/schema checks or retry/repair decisions. Accumulate the settled safe-integer totals for `SkillRunRecord`, deriving `estimatedCostUsd` from micros. Leave dispatched projection untouched for provider errors without usage and never release after dispatch.

- [ ] **Step 6: Run GREEN and refactor**

  Run: `npx tsx --conditions=react-server --test tests/agent/model-request-accounting.test.ts tests/agent/model-budget-coordinator.test.ts tests/agent/skill-runner.test.ts tests/agent/skill-runner-persistent-budget.test.ts`

  Expected: PASS with zero failures.

### Task 4: WorkerLoop propagation and OpenSpec completion

**Files:**
- Modify: `tests/agent/worker-loop.test.ts`
- Modify: `openspec/changes/build-standalone-agent-workflow/tasks.md`

**Interfaces:**
- Consumes: Task 3 `SkillRunner` and unchanged `BudgetExceededError` propagation.

- [ ] **Step 1: Write RED WorkerLoop integration test**

  Run a real budget-exhausted `SkillRunner` from a claimed JobAttempt handler and assert provider count zero, stage `budget-exceeded`, non-retryable attempt, correct scope/metric persistence, and no automatic retry.

- [ ] **Step 2: Run RED/GREEN**

  Run: `npx tsx --conditions=react-server --test tests/agent/worker-loop.test.ts`

  Expected before integration: FAIL; expected after Task 3 wiring: PASS.

- [ ] **Step 3: Run focused regression and create implementation commit**

  Run: `npx tsx --conditions=react-server --test tests/agent/model-request-accounting.test.ts tests/agent/model-budget-coordinator.test.ts tests/agent/model-budget-repository.test.ts tests/agent/skill-runner.test.ts tests/agent/skill-runner-persistent-budget.test.ts tests/agent/worker-loop.test.ts`

  Expected: PASS with zero failures.

  Commit: `feat(agent): fence skill model requests with persistent budgets`

- [ ] **Step 4: Check only OpenSpec 6.4**

  Change `- [ ] 6.4` to `- [x] 6.4`; confirm `7.3` remains unchecked and no other checkbox changes.

- [ ] **Step 5: Run full verification and create validation commit**

  Run `npm run test:agent`, `npm run skills:validate`, `npm run lint`, the repository-supported OpenSpec strict command, `npm test`, `git diff --check`, `git status --short`, `git log --oneline 6ae6c3e9..HEAD`, and compare `git diff --name-status 6ae6c3e9..HEAD` against the assigned scope.

  Commit: `test(agent): verify persistent skill budget integration`

## Self-review

- Spec coverage maps all 6.4B requirements to Tasks 1–4; 7.3 persistence remains explicitly excluded.
- No placeholders or deferred implementation steps remain.
- Type names and method signatures are consistent across tasks.
