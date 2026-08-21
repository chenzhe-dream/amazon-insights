# VOC Positioning Durable Cycle and Pricing Corrections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make repository-authoritative cycle recovery correct across every terminal crash window and make positive model prices impossible to underflow or round down to free.

**Architecture:** SQLite classifies a trusted logical cycle from immutable AgentRun terminal metadata plus exact report existence before applying retry limits. Pending/succeeded work stays in-cycle, retryable terminal failure receives a new cycle, and permanent/budget/cancelled outcomes settle. Runtime prices use bounded fixed-decimal text and model accounting uses exact BigInt decimal ceiling.

**Tech Stack:** TypeScript, Node.js worker_threads, node:test, SQLite migration/repository, Zod, existing WorkerLoop/AuditedSkillRunner.

## Global Constraints

- Implement only OpenSpec 8.3; leave 8.4 and 8.5 unchecked.
- Add no dependency; do not change `package-lock.json`.
- Modify only forward migration 0006; migrations 0001-0005 and generated VOC data remain byte-identical.
- Reuse existing WorkerLoop, AuditedSkillRunner, provider retry/repair, budgets, cancellation and fencing.
- Use fake providers only; no network, browser, React, Codex, Cursor or MCP dependency.
- Produce one fourth follow-up commit; do not amend, rebase, push, merge or stash.

---

### Task 1: Prove durable-state misclassification RED

**Files:**
- Modify: `tests/agent/voc-positioning-execution-service.test.ts`
- Modify: `tests/agent/helpers/voc-positioning-crash-worker.ts`

**Interfaces:**
- Consumes: real `JobAttemptWorkerLoop`, file-backed SQLite and fake model provider.
- Produces: isolated failing assertions for each crash/retry disposition.

- [ ] **Step 1: Add terminal-failure-before-failJob crash RED**

  Make the isolated worker exhaust all three transient provider calls, persist
  `AgentRun(validation_status='failed', classification='upstream-temporary')`,
  and stop before `failJob`. Close/reopen after lease expiry; assert the next
  Worker creates a different cycle, calls its provider once, publishes one
  report and succeeds.

- [ ] **Step 2: Add graceful-stop and heartbeat-loss coverage for the same window**

  Abort/stop after the failed AgentRun is durable but before Worker settlement.
  Separately lose the heartbeat lease after the same durable terminal write.
  Assert stop is bounded, then close/reopen and require the same new-cycle
  recovery behavior. This proves the state machine is termination-mode neutral.

- [ ] **Step 3: Add final-attempt crash-gap RED**

  Seed `maxAttempts: 1`. For both before-report and after-report isolated crash
  points, expire the lease and assert provider calls `1`, reports `1`, version
  `1`, stage `succeeded`, with no extra physical model attempt.

- [ ] **Step 4: Add report-only Worker retry RED**

  Run a Worker whose publication repository throws before insert, allow normal
  `failJob`, close/reopen, and run the next Worker. Repeat with a proxy that
  commits the real insert then throws. In each case assert provider calls `1`,
  report rows `1`, version `1`, exact same cycle and succeeded stage.

- [ ] **Step 5: Verify RED**

  Run `npx tsx --conditions=react-server --test tests/agent/voc-positioning-execution-service.test.ts`.
  Expected failures: same-cycle failed conflict, final-attempt lease exhaustion,
  and report-only retry dispatching a second provider/new cycle.

### Task 2: Implement the repository durable cycle state machine

**Files:**
- Modify: `server/db/migrations/0006_agent_run_logical_lineage.sql`
- Modify: `server/db/sqlite-repository.ts`
- Modify: `tests/agent/repository.test.ts`
- Modify: `tests/agent/agent-run-repository.test.ts`
- Modify: `tests/agent/analysis-report-repository.test.ts`

**Interfaces:**
- Produces: internal disposition `recover | retry-new-cycle | settle` derived only from same-stage/same-cycle durable rows.
- Consumes: immutable AgentRun terminal metadata, report-by-AgentRun existence and current JobAttempt lease.

- [ ] **Step 1: Add one-AgentRun-per-cycle migration invariant**

  Add a partial unique index on `(stage_id, logical_execution_cycle_id)` where
  cycle is non-null. Change `beginAgentRun` lookup to use the trusted cycle and
  compare the calculated full lineage before reuse or claim rotation.

- [ ] **Step 2: Classify durable cycle inside claim transaction**

  Parse terminal metadata with `AgentRunTerminalMetadataSchema`. Pending or
  absent and passed/succeeded return `recover`; retryable failed returns
  `retry-new-cycle`; budget/cancel/permanent/contract return `settle` with fixed
  stage/attempt status and safe persisted error.

- [ ] **Step 3: Apply disposition before max-attempt logic**

  Below max, recovery inserts a same-cycle successor and retry inserts a new
  cycle. At max, recovery rotates owner/expiry/generation on the existing row;
  retry settles exhausted. Settle never creates a successor. Preserve the
  immediate transaction and active-cycle unique index.

- [ ] **Step 4: Make `failJob` report-aware**

  Under the active lease transaction, durable passed/succeeded overrides an
  ordinary handler failure into queued report-only recovery even if Worker has
  reached `maxAttempts`. Do not use error message or exception name.

- [ ] **Step 5: Run repository and Worker GREEN tests**

  Run repository, AgentRun, report, Worker and VOC execution focused suites.
  Assert old owner/generation and wrong cycle still reject and concurrent claims
  create at most one active authority.

### Task 3: Prove and fix exact pricing

**Files:**
- Modify: `tests/agent/voc-positioning-runtime.test.ts`
- Modify: `tests/agent/model-request-accounting.test.ts`
- Modify: `server/config.ts`
- Modify: `server/runtime/model-request-accounting.ts`

**Interfaces:**
- Produces: canonical price grammar `0..999999999` with at most six fractional digits and exact `calculateModelCostMicros`.
- Consumes: non-negative safe integer token counts and finite non-negative numeric prices.

- [ ] **Step 1: Add pricing RED tables**

  Reject `0.` plus 400 zeros plus `1`, seven fractional digits, leading-zero and
  billion-unit forms. Accept explicit `0`, `0.000001`, and `999999999` when the
  configured token projection remains safe. Assert the minimum positive price
  with one token costs one micro-unit.

- [ ] **Step 2: Add accounting RED boundaries**

  Assert exact ceiling for mixed decimal prices, positive subnormal numeric
  prices never cost zero for positive tokens, the largest safe exact cost is
  accepted, and the next value throws an accounting error.

- [ ] **Step 3: Implement bounded fixed-decimal configuration**

  Validate text before conversion with no whitespace, exponent or excess
  precision. Explicit textual zero is allowed; every accepted nonzero text must
  convert to a positive finite number.

- [ ] **Step 4: Implement BigInt decimal ceiling**

  Convert each canonical numeric decimal/exponent representation to coefficient
  and scale, align both token-price terms, perform one ceiling division, and
  reject a result above `Number.MAX_SAFE_INTEGER`.

- [ ] **Step 5: Run pricing GREEN tests**

  Run `voc-positioning-runtime.test.ts` and
  `model-request-accounting.test.ts`, then the SkillRunner/budget suites that
  consume the function.

### Task 4: Requalify and commit

**Files:**
- Modify: `openspec/changes/build-standalone-agent-workflow/tasks.md`

**Interfaces:**
- Consumes: every original/follow-up OpenSpec 8.3 invariant.
- Produces: checked 8.3 only after fresh evidence and one clean fourth follow-up commit.

- [ ] **Step 1: Run all focused and full gates**

  Run focused migration/repository/worker/crash/config/composition tests,
  `npm run test:agent`, `npm run skills:validate`, `npm run lint`, repository
  strict OpenSpec validation and `npm test`.

- [ ] **Step 2: Compare TypeScript diagnostic identities**

  In an ordinary temporary clone at baseline
  `b0fca9d49ca12d428b86a017af422e5d466f13c3`, run
  `npx tsc --noEmit --incremental false` and compare normalized
  `(file,line,column,TS code)` sets with the feature; require no feature-only or
  baseline-only identity.

- [ ] **Step 3: Verify protected state**

  Run `git diff --check`; require zero diff for `package-lock.json`, migrations
  0001-0005 and all three generated VOC files; confirm 8.4/8.5 unchecked.

- [ ] **Step 4: Recheck, commit and verify clean**

  Only after all gates pass, change only 8.3 to `[x]`, stage exact reviewed
  files, create one new non-amend commit, rerun status/protected checks, and
  stop on the feature branch for dual read-only review.
