# VOC Positioning Publication Retry Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound report-only recovery with durable backoff while preserving one provider execution, one report identity and existing lease fencing.

**Architecture:** The same JobAttempt and logical execution cycle carry a separate persisted publication cycle, retry count, immutable policy and next-eligible timestamp. SQLite decides report-only retry from durable AgentRun/report facts under the active lease; exhaustion becomes stable failed, while explicit manual retry starts a new publication cycle without dispatching the provider.

**Tech Stack:** TypeScript, Node.js `node:test`, real `JobAttemptWorkerLoop`, file-backed SQLite, migration 0006, existing audited Skill runtime and fake providers.

## Global Constraints

- Implement only OpenSpec 8.3; keep 8.4 and 8.5 unchecked.
- Add no dependency and do not change `package-lock.json`.
- Modify only forward migration 0006; migrations 0001-0005 and generated VOC data remain byte-identical.
- Preserve AuditedSkillRunner, budget, provider retry/repair, cancellation and lease/claim fencing semantics.
- Use no real network, browser, React, Codex, Cursor or MCP dependency.
- Produce one fifth non-amend follow-up commit; do not rebase, push, merge or stash.

---

### Task 1: Persistent publication failure tracer bullet

**Files:**
- Modify: `tests/agent/voc-positioning-execution-service.test.ts`

**Interfaces:**
- Consumes: real Worker `start()`/`stop()`, file SQLite and a report repository that always fails before insert.
- Produces: observable bounded publication attempts and stable terminal stage behavior.

- [x] **Step 1: Write one persistent-failure RED for `maxAttempts=1`**

  Start a real Worker with a successful fake provider and an always-failing
  `publishVocPositioningReport`. Resolve the probe either when the repository
  returns a non-retryable failure or when eight publication calls prove the hot
  loop. Assert the terminal path wins, provider calls equal one, publication
  calls are bounded, and poll sleep occurs between eligible attempts.

- [x] **Step 2: Run the RED in isolation**

  Run `npx tsx --conditions=react-server --test --test-name-pattern "persistent report publication" tests/agent/voc-positioning-execution-service.test.ts`.
  Expected: publication reaches the hot-loop guard and the stage is not stably failed.

- [x] **Step 3: Repeat the same public behavior with normal physical max attempts**

  Table the test over physical limits `1` and `3`; do not inspect private
  repository helpers or infer failure from error strings.

### Task 2: Durable publication retry state

**Files:**
- Modify: `server/db/migrations/0006_agent_run_logical_lineage.sql`
- Modify: `server/db/repository.ts`
- Modify: `server/db/sqlite-repository.ts`
- Modify: `server/runtime/worker-loop.ts`
- Modify: `tests/agent/repository.test.ts`
- Modify: `tests/agent/agent-run-repository.test.ts`

**Interfaces:**
- Produces: public `JobAttemptRecord` publication-cycle fields and optional `FailJobInput.reportPublicationRetryPolicy` supplied by the trusted Worker.
- Consumes: durable passed AgentRun, exact report existence, active lease generation and validated Worker retry limits.

- [x] **Step 1: Add 0006 columns and closed migration invariants**

  Add publication cycle/count/policy/retry-time columns with legacy defaults.
  Add insert/update triggers that require an all-or-none positive policy,
  monotonic counters within a cycle, and a closed reset when the cycle advances.

- [x] **Step 2: Persist one report failure under the active lease**

  In `failJob`, select report-only only from durable facts. Seed or reuse the
  persisted policy, increment its independent count, and calculate a future
  deterministic exponential deadline. Do not OR this with physical retryability.

- [x] **Step 3: Make exhaustion stable**

  When publication count reaches its persisted maximum, set JobAttempt/stage
  failed and non-retryable with a fixed safe summary. Return the persisted job
  state so Worker observability follows the transactional decision.

- [x] **Step 4: Claim only eligible report recovery on the same JobAttempt**

  Require publication deadline `<= claimedAt`, clear it only after the lease is
  acquired, and reclaim the same row for report-only/completion-only regardless
  of physical attempt number. Add two-connection and close/reopen tests.

- [x] **Step 5: Run focused GREEN**

  Re-run the persistent Worker test and repository migration/claim suites.
  Require one provider call, finite publication calls, observed poll sleeps and
  durable count/policy after reopening the database.

### Task 3: Success, uncertain commit and manual publication cycle

**Files:**
- Modify: `server/db/sqlite-repository.ts`
- Modify: `tests/agent/voc-positioning-execution-service.test.ts`
- Modify: `tests/agent/analysis-run-lifecycle.test.ts`

**Interfaces:**
- Consumes: the Task 2 publication state.
- Produces: provider-free manual recovery and exact report convergence.

- [x] **Step 1: Add transient-once and after-commit tests**

  Run a single Worker loop whose repository fails before insert once and then
  succeeds; repeat for commit-then-response failure. Assert provider `1`, report
  row/version `1`, bounded publication count and succeeded stage.

- [x] **Step 2: Add manual recovery RED after publication exhaustion**

  Exhaust the publication budget, call the existing authorized `retryStage`,
  then run a healthy Worker. Assert the publication cycle increments, its budget
  resets, the logical execution cycle remains identical, provider stays at one,
  and the exact report completes.

- [x] **Step 3: Implement the trusted manual publication reset**

  In `retryFailedRunStage`, recognize the latest failed JobAttempt only through
  its same-cycle successful AgentRun and durable publication state. Requeue that
  row with publication cycle plus one; otherwise retain the existing new logical
  cycle path for ordinary retry/rerun.

- [x] **Step 4: Re-run lifecycle, crash and fencing suites**

  Confirm stale downstream handling, old-owner rejection, concurrent claims,
  ordinary manual retry and succeeded rerun behavior are unchanged.

### Task 4: Trusted abort authority and takeover

**Files:**
- Create: `server/runtime/execution-abort.ts`
- Modify: `server/runtime/worker-loop.ts`
- Modify: `server/runtime/skill-runner.ts`
- Modify: `server/runtime/agent-run-service.ts`
- Modify: `server/runtime/model-budget-coordinator.ts`
- Modify: `server/db/model-budget-repository.ts`
- Modify: `server/db/sqlite-repository.ts`
- Modify: `tests/agent/voc-positioning-execution-service.test.ts`
- Modify: `tests/agent/voc-positioning-service-entry.test.ts`
- Modify: `tests/agent/skill-runner-persistent-budget.test.ts`

**Interfaces:**
- Produces: branded trusted abort reasons `run-cancelled | worker-stopping | lease-lost` and a typed infrastructure interruption.
- Consumes: current Worker lease and ModelBudget execution authority.

- [x] **Step 1: Add live-provider stop and heartbeat RED tests**

  Hold the fake provider until its signal aborts. For graceful stop and a forced
  heartbeat renewal failure, close/reopen SQLite and run a healthy Worker.
  Assert the replacement succeeds and no stage or AgentRun becomes cancelled.

- [x] **Step 2: Add the trusted abort reason module**

  Create reasons only through a server factory backed by object identity, never
  from strings in request/model data. Worker stop and lease loss pass distinct
  reasons; explicit run cancellation uses `run-cancelled`.

- [x] **Step 3: Abort infrastructure work without settling its JobAttempt**

  During `stop`, abort the current handler with a branded infrastructure reason,
  skip Worker settlement, and let lease expiry establish successor authority.
  Keep stop bounded and idempotent; old-owner settlement remains fenced.

- [x] **Step 4: Persist only retryable infrastructure, never user cancellation**

  Map an infrastructure abort to typed interruption/upstream-temporary terminal
  state, never to cancelled metadata. The successor creates the allowed new
  cycle; old dispatched budget settlement and publication stay lease fenced.

- [x] **Step 5: Prove ignored abort is fenced and user cancellation is distinct**

  Let an old provider return after a successor claim and require its budget
  settle/finalize/publish to fail. Separately abort with branded `run-cancelled`
  and require the established cancelled terminal metadata and stage contract.

- [x] **Step 6: Run abort, budget, Worker and composition GREEN suites**

  Require bounded shutdown, heartbeat recovery, explicit cancellation and all
  existing retry/budget/fencing tests to pass without logging reason payloads.

### Task 5: Requalify and commit

**Files:**
- Modify: `openspec/changes/build-standalone-agent-workflow/tasks.md`

**Interfaces:**
- Produces: only 8.3 checked after all evidence and one fifth follow-up commit.

- [x] **Step 1: Run all gates**

  Run focused publication/migration/worker/config/composition tests,
  `npm run test:agent`, `npm run skills:validate`, `npm run lint`, strict
  OpenSpec validation and `npm test`.

- [x] **Step 2: Compare TypeScript diagnostic identities**

  Run `npx tsc --noEmit --incremental false` in this feature and an ordinary
  temporary baseline clone at `b0fca9d49ca12d428b86a017af422e5d466f13c3`.
  Normalize `(file,line,column,TS code)` and require zero set difference.

- [ ] **Step 3: Verify protected paths and completion metadata**

  Require `git diff --check`, zero diff for package lock, actual migration files
  0001-0005 and all three generated VOC files. Check only 8.3, stage exact files,
  make one non-amend commit, and require clean status on the feature branch.
