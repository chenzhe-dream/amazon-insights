# VOC Positioning Cycle and Optional Runtime Corrections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make logical execution cycles distinguish crash recovery from retry/rerun, close positioning stance semantics, and keep the Agent Service online when optional VOC provider configuration is unavailable.

**Architecture:** SQLite owns a non-caller-supplied cycle ID on JobAttempt and propagates it only for expired-lease recovery. AgentRun lineage hashes that cycle; pending recovery rotates claim authority to the active recovery attempt, while succeeded recovery replays and failed retry starts a new lineage. A service composition root treats the VOC Worker as an optional capability and exposes only fixed safe configuration states.

**Tech Stack:** TypeScript, Node.js, Zod, SQLite migrations/repository, existing WorkerLoop, AuditedSkillRunner, Fastify, node:test.

## Global Constraints

- Implement OpenSpec 8.3 only; keep 8.4 and 8.5 unchecked until their own work.
- Add no dependency and do not change `package-lock.json`.
- Modify only forward migration 0006; migrations 0001-0005 and generated VOC data remain byte-identical.
- Use the existing WorkerLoop, AuditedSkillRunner, provider retry/repair, budget, cancel and lease fencing paths.
- Do not perform real network collection or OpenAI calls in tests.
- Create one follow-up commit only after every gate passes; do not amend, rebase, push, merge or stash.

---

### Task 1: Prove cycle and stance failures

**Files:**
- Modify: `tests/agent/voc-positioning-execution-service.test.ts`
- Modify: `tests/agent/voc-positioning-contracts.test.ts`
- Modify: `tests/agent/helpers/voc-positioning-crash-worker.ts`

**Interfaces:**
- Consumes: existing `JobAttemptWorkerLoop`, file-backed SQLite repository and fake `ModelProvider`.
- Produces: failing tests that distinguish in-attempt provider calls from physical JobAttempt retries and contradictory stances.

- [ ] **Step 1: Add retry-exhaustion RED**

  Script the provider so calls 1-3 throw transient errors and call 4 succeeds.
  Run the real Worker twice and assert two JobAttempts, two AgentRuns, four
  provider calls, one report and a succeeded stage.

- [ ] **Step 2: Add bounded exhaustion RED**

  Use an always-transient provider with three physical attempts. Assert nine
  provider calls, three failed AgentRuns, three JobAttempts and terminal failed
  stage. Reopen SQLite between attempts so no in-memory identity can satisfy the
  test.

- [ ] **Step 3: Add rerun and concurrency RED**

  Explicitly rerun a succeeded VOC stage and assert a new AgentRun/cycle and
  immutable report version two. Run two competing workers for a retryable
  predecessor and assert exactly one new cycle/provider execution.

- [ ] **Step 4: Add full/partial stance RED**

  Mutate only `price-tier.stance` to `supported-by-voc` in the scooter and
  lighting outputs. Add table cases proving supported assertions accept only
  retain/redesign/avoid, validation assertions accept differentiate/validate,
  not-assessed accepts only validate, and an unknown competitor-imitation
  strategy is structurally rejected. Verify each parse fails for the intended
  semantic issue.

- [ ] **Step 5: Run RED tests**

  Run:
  `npx tsx --conditions=react-server --test tests/agent/voc-positioning-contracts.test.ts tests/agent/voc-positioning-execution-service.test.ts`

  Expected: the new cycle tests replay the failed terminal or never produce v2,
  and the stance mutations parse successfully before implementation.

### Task 2: Persist repository-authoritative cycles

**Files:**
- Modify: `server/db/migrations/0006_agent_run_logical_lineage.sql`
- Modify: `server/db/repository.ts`
- Modify: `server/db/agent-run-repository.ts`
- Modify: `server/db/sqlite-repository.ts`
- Modify: `server/runtime/model-request-accounting.ts`
- Modify: `server/runtime/agent-run-service.ts`
- Modify: `server/services/voc-positioning-worker-handler.ts`
- Modify: `server/services/voc-positioning-execution-service.ts`
- Test: `tests/agent/agent-run-repository.test.ts`
- Test: `tests/agent/repository.test.ts`
- Test: `tests/agent/analysis-report-repository.test.ts`

**Interfaces:**
- Produces: `JobAttemptRecord.logicalExecutionCycleId: string` and audited context `logicalExecutionCycleId: string`.
- Consumes: active Worker lease and repository-owned JobAttempt state.

- [ ] **Step 1: Extend migration 0006**

  Add validated cycle IDs to JobAttempt, backfill legacy rows, create the
  one-active-attempt-per-cycle index, add AgentRun active recovery-attempt
  provenance, and update pending claim trigger authority to use that active
  attempt. Keep completed AgentRuns immutable.

- [ ] **Step 2: Generate and transition cycles transactionally**

  Initial enqueue and manual retry/rerun generate a cycle inside the repository.
  `claimNextJob` inherits it only for expired running jobs; retryable failed jobs
  receive a new cycle. Never accept a cycle in enqueue input.

- [ ] **Step 3: Bind lineage to the cycle**

  Change `createSkillExecutionLineage(identity, cycleId)` so equal stage input
  in different cycles hashes differently. Pass the ID from the claimed
  JobAttempt through the production handler, and make `beginAgentRun`
  transactionally verify it against the active job.

- [ ] **Step 4: Recover pending and succeeded work**

  A same-cycle pending predecessor may rotate claim authority to the current
  recovery JobAttempt; a succeeded predecessor replays. Failed terminals do not
  match a new cycle. Update claim assertion/finalize and publication checks to
  use the active recovery attempt without weakening old-owner fencing.

- [ ] **Step 5: Turn repository and Worker tests GREEN**

  Run the focused repository, worker and VOC service tests. Verify close/reopen,
  lease expiry, manual rerun, concurrency and drift behavior.

### Task 3: Enforce positioning stance semantics

**Files:**
- Modify: `server/domain/voc/voc-positioning-contracts.ts`
- Modify: `tests/agent/helpers/voc-positioning-fixture.ts`
- Test: `tests/agent/voc-positioning-contracts.test.ts`

**Interfaces:**
- Consumes: closed positioning dimension, stance and strategy enums.
- Produces: one deterministic dimension/stance/strategy matrix.

- [ ] **Step 1: Encode the closed matrix**

  Require `price-tier` to use `requires-validation` plus `validate`. Require
  `not-assessed` to use `validate`, `supported-by-voc` to use
  retain/redesign/avoid, and `requires-validation` to use
  differentiate/validate. Unknown imitation strategies remain outside the
  closed enum; hero-upgrade/new-scenario intent maps to differentiate and thus
  cannot claim VOC support.

- [ ] **Step 2: Preserve protected semantics**

  Apply safety avoid/redesign only to supported assertions. Validation-only
  dimensions may cite safety evidence with `validate` while retaining priority,
  role and exact evidence protection.

- [ ] **Step 3: Update full/partial fixtures and run GREEN**

  Make both fixtures emit the exact matrix and rerun the isolated mutations.

### Task 4: Make VOC runtime an optional capability

**Files:**
- Modify: `server/config.ts`
- Create: `server/agent-service.ts`
- Modify: `server/index.ts`
- Modify: `server/app.ts`
- Modify: `server/routes/capabilities.ts`
- Modify: `tests/agent/voc-positioning-runtime.test.ts`
- Modify: `tests/agent/capabilities.test.ts`
- Test: `tests/agent/agent-service-entry.test.ts`

**Interfaces:**
- Produces: closed runtime configuration result `configured | incomplete | invalid` and `createAgentService()` with bounded `start()`/`stop()`.
- Consumes: optional fake provider injection for tests and OpenAI provider only for a valid production configuration.

- [ ] **Step 1: Add configuration RED tables**

  Omit and blank every required variable independently. Assert explicit price
  `"0"` succeeds while missing price fails. Add NaN, Infinity, exponent,
  negative, unsafe integer, invalid jitter and cost-overflow cases. Assert fixed
  messages contain no supplied value or key.

- [ ] **Step 2: Parse text before numeric conversion**

  Classify missing/blank before Zod transforms. Accept canonical decimal safe
  integers, explicit non-negative decimal prices and finite `[0,1]` jitter;
  validate projected accounting remains a safe integer.

- [ ] **Step 3: Extract formal service composition**

  Build and listen the API regardless of VOC capability state. Start the Worker
  only for valid configuration. Missing and invalid configuration keep VOC jobs
  queued and expose fixed unavailable reasons. Startup and shutdown never log
  raw configuration values.

- [ ] **Step 4: Run entry GREEN tests**

  Listen on an ephemeral port for incomplete and invalid configuration and
  assert `/health`, `/v1/capabilities`, queued VOC job and bounded shutdown.
  With complete config and fake provider, assert stage/report success.

### Task 5: Requalify OpenSpec 8.3

**Files:**
- Modify: `openspec/changes/build-standalone-agent-workflow/tasks.md`

**Interfaces:**
- Consumes: every completed correction and protected-path check.
- Produces: one clean follow-up commit with only 8.3 checked.

- [ ] **Step 1: Run focused and full gates**

  Run focused contract/service/repository/worker/config/composition tests,
  `npm run test:agent`, `npm run skills:validate`, `npm run lint`, strict
  OpenSpec validation and `npm test`.

- [ ] **Step 2: Compare TypeScript diagnostics by identity**

  Use an ordinary temporary clone at `b0fca9d49ca12d428b86a017af422e5d466f13c3`.
  Compare normalized `(file,line,column,TS code)` sets and require zero
  feature-only and baseline-only entries.

- [ ] **Step 3: Verify protected state**

  Require `git diff --check`, zero diff for package lock, migrations 0001-0005
  and generated VOC data, and confirm 8.4/8.5 remain unchecked.

- [ ] **Step 4: Check 8.3 and commit once**

  Re-check 8.3 only after every gate passes. Stage exact reviewed files, create
  a third atomic follow-up commit, verify clean status and stop for dual review.
