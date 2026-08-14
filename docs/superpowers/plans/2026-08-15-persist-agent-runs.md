# Persist Agent Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement OpenSpec task 7.3 by durably auditing each JobAttempt-level Skill execution with immutable provenance, integer-micros usage, lease-fenced completion, restart-safe recovery, and metadata-only logs.

**Architecture:** Add a versioned `AgentRunRepository` domain contract beside the existing orchestration and model-budget contracts, then implement it in `SqliteAgentRepository` behind a forward-only `0004` migration. An `AuditedSkillRunner` service owns the pending-to-terminal audit lifecycle around the existing `SkillRunner`; request-level retry/repair accounting remains in `model_budget_reservations`, while the AgentRun stores aggregate usage and safely recovers settled usage after an audit-write failure without issuing another provider request.

**Tech Stack:** TypeScript 5.9, Node 22 `node:sqlite`, Zod 4, Node test runner through `tsx`, OpenSpec CLI.

## Global Constraints

- Work only in `C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\feat-persist-agent-runs` on `feat/persist-agent-runs`; do not create another worktree.
- Preserve migrations `0001`, `0002`, and `0003`; all schema evolution is forward-only in `0004`.
- Add no dependencies and do not change `package-lock.json` or address the 21 existing audit findings.
- Keep request-level provider retry/repair usage in `model_budget_reservations`; one `AgentRun` represents one JobAttempt-level Skill execution and aggregates those requests.
- Use integer `costMicros` as the authoritative persisted cost. Any USD value is derived compatibility data, never the database authority.
- Do not implement VOC acquisition, UI, authentication, PostgreSQL, reports, connectors, or tasks 7.4/8.x.
- Ordinary logs may contain correlation IDs, schema/version, counts, hashes, redacted provider/model/response IDs, tokens, duration, cost, attempt count, and safe error classification only.
- Never persist or log provider raw text, complete prompts, complete customer input/reviews, API keys, cookies, passwords, sessions, authorization headers, or untrusted `Error`/`cause` serialization.
- Every production behavior follows RED → GREEN → REFACTOR. Do not mark OpenSpec task 7.3 complete until every gate passes.

---

## File Structure

- `shared/agent-contracts.ts`: preserve strict legacy AgentRun `1.0.0` parsing and add strict AgentRun audit `1.1.0` with stage/job correlation, integer cost micros, attempt count, and terminal-state invariants.
- `server/db/migrations/0004_agent_run_audit.sql`: add model-request JobAttempt correlation, AgentRun attempt count, normalized snapshot links, uniqueness, consistency triggers, and immutable-completion triggers.
- `server/db/agent-run-repository.ts`: SQLite-independent SkillVersion/AgentRun records, begin/finalize/list/usage/recovery contracts, results, and closed domain errors.
- `server/db/model-budget-repository.ts`: add optional backward-compatible JobAttempt/ordinal reservation provenance used by new SkillRunner reservations.
- `server/db/sqlite-repository.ts`: implement SkillVersion idempotency/drift detection, active-lease begin, snapshot/run/stage/job/tenant validation, CAS finalize, restart reads, usage aggregation, and settled-ledger recovery.
- `server/runtime/skill-runner.ts`: expose integer micros on successful provenance and attach non-serializable aggregate failure audit metadata without changing thrown error identities or retry behavior.
- `server/runtime/model-budget-coordinator.ts`: carry server-derived JobAttempt/ordinal provenance into the existing ledger.
- `server/runtime/agent-run-service.ts`: wrap SkillRunner with the pending/terminal audit lifecycle, safe error normalization, replay handling, usage recovery, and summary-only logs.
- `tests/agent/contracts.test.ts`: strict versioned shared-contract compatibility tests.
- `tests/agent/sqlite-migrations.test.ts`: forward migration, normalized FK/trigger, and immutability tests.
- `tests/agent/agent-run-repository.test.ts`: real SQLite integration tests for provenance, tenant/relationship validation, CAS, concurrency, restart, rollback, safe integers, and usage reads.
- `tests/agent/agent-run-service.test.ts`: fake-provider plus real SQLite integration tests for success/failure/replay, persistence-failure ordering, and redacted logs.
- `tests/agent/helpers/sqlite-agent-run-worker.ts`: worker-thread finalize competitor used only to exercise real cross-connection CAS behavior.
- `openspec/changes/build-standalone-agent-workflow/tasks.md`: change only task 7.3 from `[ ]` to `[x]` after all gates pass.

---

### Task 1: Version the shared AgentRun audit contract

**Files:**
- Modify: `tests/agent/contracts.test.ts`
- Modify: `shared/agent-contracts.ts`

**Interfaces:**
- Consumes: existing `EntityIdSchema`, `ApiErrorSchema`, provenance schemas, and legacy AgentRun payloads.
- Produces: `AgentRunV1Schema`, `AgentRunAuditSchema`, `AgentRunSchema`, and `AgentRun` with a strict compatibility union keyed by `schemaVersion`.

- [x] **Step 1: Write the failing compatibility and v1.1 audit tests**

Add a test that proves the existing `1.0.0` object remains accepted, while a `1.1.0` audit object requires `stageId`, `jobAttemptId`, `estimatedCostMicros`, and `attemptCount`; rejects float/unsafe costs, duplicate snapshots, unknown fields, and invalid pending/passed/failed state combinations.

```ts
const audit = {
  ...legacyAgentRun,
  schemaVersion: "1.1.0",
  stageId,
  jobAttemptId,
  model: { provider: "openai", model: "gpt-test", responseId: "resp_1" },
  inputTokens: 100,
  outputTokens: 25,
  estimatedCostMicros: 321,
  durationMs: 90,
  attemptCount: 2,
};
assert.equal(AgentRunAuditSchema.safeParse(audit).success, true);
assert.equal(AgentRunSchema.safeParse(legacyAgentRun).success, true);
assert.equal(
  AgentRunAuditSchema.safeParse({ ...audit, estimatedCostMicros: 1.5 }).success,
  false,
);
assert.equal(
  AgentRunAuditSchema.safeParse({ ...audit, snapshotIds: [snapshotId, snapshotId] }).success,
  false,
);
```

- [x] **Step 2: Run the focused contract test and verify RED**

Run: `npx tsx --conditions=react-server --test --test-name-pattern="AgentRun audit" tests/agent/contracts.test.ts`

Expected: FAIL because `AgentRunAuditSchema` is not exported and v1.1 fields/invariants do not exist.

- [x] **Step 3: Implement the strict compatibility union**

Keep the current shape as a strict literal-version `AgentRunV1Schema`. Add `AgentRunAuditSchema` with the following exact new fields and a refinement for lifecycle consistency:

```ts
export const AgentRunAuditSchema = strictObject({
  schemaVersion: z.literal("1.1.0"),
  id: EntityIdSchema,
  runId: EntityIdSchema,
  stageId: EntityIdSchema,
  jobAttemptId: EntityIdSchema,
  stage: StageNameSchema,
  status: RunStageStatusSchema,
  skill: SkillProvenanceSchema,
  snapshotIds: z.array(EntityIdSchema).min(1).refine(isUnique),
  model: ModelProvenanceSchema,
  inputSummary: InputSummarySchema,
  outputSchemaVersion: SchemaVersionSchema,
  output: StructuredResultSchema.nullable(),
  validationStatus: AgentRunValidationStatusSchema,
  error: ApiErrorSchema.nullable(),
  dataCutoffAt: DateTimeSchema,
  inputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  outputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  estimatedCostMicros: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  durationMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  attemptCount: z.number().int().min(0).max(4),
  startedAt: DateTimeSchema,
  completedAt: DateTimeSchema.nullable(),
}).superRefine(validateAgentRunLifecycle);

export const AgentRunSchema = z.discriminatedUnion("schemaVersion", [
  AgentRunV1Schema,
  AgentRunAuditSchema,
]);
```

- [x] **Step 4: Run focused contracts and the complete contract file for GREEN**

Run: `npx tsx --conditions=react-server --test tests/agent/contracts.test.ts`

Expected: all contract tests pass, including legacy `1.0.0` compatibility.

- [x] **Step 5: Commit the contract slice**

```powershell
git add shared/agent-contracts.ts tests/agent/contracts.test.ts
git commit -m "feat(agent): version durable agent run contract"
```

---

### Task 2: Add the forward SQLite audit model and domain Repository

**Files:**
- Create: `server/db/migrations/0004_agent_run_audit.sql`
- Create: `server/db/agent-run-repository.ts`
- Create: `tests/agent/agent-run-repository.test.ts`
- Create: `tests/agent/helpers/sqlite-agent-run-worker.ts`
- Modify: `server/db/model-budget-repository.ts`
- Modify: `server/db/sqlite-repository.ts`
- Modify: `tests/agent/sqlite-migrations.test.ts`
- Modify: `tests/agent/repository.test.ts`

**Interfaces:**
- Consumes: current `analysis_runs`, `run_stages`, `job_attempts`, `data_snapshots`, `skill_versions`, `agent_runs`, and `model_budget_reservations` tables plus existing lease generation semantics.
- Produces: `AgentRunRepository.registerSkillVersion`, `beginAgentRun`, `finalizeAgentRun`, `listAgentRuns`, `getAgentRunUsage`, and `getJobAttemptModelUsage` implemented by `SqliteAgentRepository` without exposing SQLite types.

- [ ] **Step 1: Write failing migration and Repository behavior tests**

Test the following behaviors against real temporary SQLite databases:

```ts
const skill = await repository.registerSkillVersion(skillInput);
assert.deepEqual(await repository.registerSkillVersion({ ...skillInput, id: randomUUID() }), skill);
await assert.rejects(
  repository.registerSkillVersion({ ...skillInput, contentHash: "f".repeat(64) }),
  SkillVersionConflictError,
);

const begun = await repository.beginAgentRun(activeLeaseBeginInput);
assert.equal(begun.created, true);
assert.equal(begun.record.validationStatus, "pending");

const passed = await repository.finalizeAgentRun({
  agentRunId: begun.record.id,
  organizationId,
  ownerId,
  leaseGeneration,
  completedAt,
  outcome: {
    validationStatus: "passed",
    responseId: "resp_1",
    output: { summary: "durable output" },
    error: null,
    inputTokens: Number.MAX_SAFE_INTEGER - 2,
    outputTokens: 1,
    estimatedCostMicros: Number.MAX_SAFE_INTEGER,
    durationMs: 42,
    attemptCount: 1,
  },
});
assert.equal(passed.transitioned, true);
```

Separate tests must reject missing, duplicate, uppercase/noncanonical, cross-run, and cross-tenant snapshot IDs; mismatched run/stage/job/SkillVersion; an inactive or expired lease; concurrent double finalize; stale lease generation; changed replay parameters; mutation/deletion of terminal rows; and injected mid-transaction failure with zero partial rows. Reopen the database and prove the completed row and usage summary survive. Use two repositories and the helper Worker only for cross-connection CAS, not for mocked behavior.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx tsx --conditions=react-server --test tests/agent/sqlite-migrations.test.ts tests/agent/agent-run-repository.test.ts`

Expected: FAIL because migration 0004, the domain contract, and Repository methods do not exist.

- [ ] **Step 3: Define the SQLite-independent domain contract**

Create records and exact method signatures:

```ts
export interface AgentRunRepository {
  registerSkillVersion(input: RegisterSkillVersionInput): Promise<SkillVersionRecord>;
  beginAgentRun(input: BeginAgentRunInput): Promise<BeginAgentRunResult>;
  finalizeAgentRun(input: FinalizeAgentRunInput): Promise<FinalizeAgentRunResult>;
  listAgentRuns(input: ListAgentRunsInput): Promise<AgentRunAuditRecord[]>;
  getAgentRunUsage(input: ListAgentRunsInput): Promise<AgentRunUsageSummary>;
  getJobAttemptModelUsage(input: JobAttemptModelUsageInput): Promise<JobAttemptModelUsage>;
}
```

Inputs contain only domain values, including `organizationId`, active lease owner/generation, and canonical IDs. Add closed errors `SkillVersionConflictError`, `AgentRunConflictError`, `AgentRunSubjectNotFoundError`, `AgentRunLeaseLostError`, and `AgentRunDataError`; none include SQL/provider/customer content.

- [ ] **Step 4: Add migration 0004 with normalized provenance and immutability**

The migration must:

```sql
ALTER TABLE agent_runs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0
  CHECK (attempt_count BETWEEN 0 AND 4);
ALTER TABLE model_budget_reservations ADD COLUMN job_attempt_id TEXT
  REFERENCES job_attempts(id) ON DELETE RESTRICT;
ALTER TABLE model_budget_reservations ADD COLUMN request_ordinal INTEGER
  CHECK (request_ordinal BETWEEN 0 AND 3);
CREATE UNIQUE INDEX agent_runs_job_attempt_idx
  ON agent_runs(job_attempt_id) WHERE job_attempt_id IS NOT NULL;
CREATE TABLE agent_run_snapshots (
  agent_run_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (agent_run_id, snapshot_id),
  UNIQUE (agent_run_id, ordinal),
  FOREIGN KEY (agent_run_id) REFERENCES agent_runs(id) ON DELETE RESTRICT,
  FOREIGN KEY (snapshot_id) REFERENCES data_snapshots(id) ON DELETE RESTRICT
) STRICT;
```

Also add indexes and triggers that reject run/stage/job mismatches, budget job/run mismatches, invalid pending/terminal shapes, updates to completed AgentRuns, and all deletes of AgentRuns. Do not edit prior migration text.

- [ ] **Step 5: Implement SQLite validation, transactions, CAS, and mapping**

Implement all methods under the existing per-path serialization and `BEGIN IMMEDIATE` conventions. `beginAgentRun` verifies the tenant through `projects.organization_id`, verifies the active non-expired lease at `startedAt`, validates all snapshot IDs before writing, inserts AgentRun plus normalized snapshot links atomically, and returns an identical existing JobAttempt row only if every immutable identity field matches. `finalizeAgentRun` performs one conditional update whose `WHERE` clause includes pending status plus current owner/generation/unexpired lease; a completed byte-for-byte replay returns `transitioned: false`, while any changed replay throws conflict.

Store JSON only through canonical safe serialization and parse every row through domain validation. Reject SQLite integers outside `Number.MAX_SAFE_INTEGER`; never coerce unsafe values.

- [ ] **Step 6: Correlate new SkillRunner budget reservations without breaking old callers**

Add nullable `jobAttemptId`/`requestOrdinal` to the budget row and optional fields to the reserve input so old direct budget tests and existing databases remain compatible. New SkillRunner calls supply both; Repository validation requires both-or-neither and validates same-run ownership when present. `getJobAttemptModelUsage` aggregates actual settled amounts and counts dispatched/settled request rows for recovery.

- [ ] **Step 7: Run focused migration/Repository tests for GREEN and refactor**

Run: `npx tsx --conditions=react-server --test tests/agent/sqlite-migrations.test.ts tests/agent/agent-run-repository.test.ts tests/agent/repository.test.ts tests/agent/model-budget-repository.test.ts tests/agent/model-budget-coordinator.test.ts`

Expected: all focused tests pass, existing migration checks expect versions 1–4, and no pre-0004 checksum changes occur.

- [ ] **Step 8: Commit the persistence slice**

```powershell
git add server/db tests/agent/sqlite-migrations.test.ts tests/agent/repository.test.ts tests/agent/agent-run-repository.test.ts tests/agent/helpers/sqlite-agent-run-worker.ts
git commit -m "feat(agent): persist lease-fenced agent run audits"
```

---

### Task 3: Wrap SkillRunner with durable auditing and safe recovery

**Files:**
- Create: `server/runtime/agent-run-service.ts`
- Create: `tests/agent/agent-run-service.test.ts`
- Modify: `server/runtime/skill-runner.ts`
- Modify: `server/runtime/model-budget-coordinator.ts`
- Modify: `tests/agent/skill-runner.test.ts`
- Modify: `tests/agent/skill-runner-persistent-budget.test.ts`

**Interfaces:**
- Consumes: `SkillRunner.run`, `SkillRegistry.load`, `AgentRunRepository`, active Worker lease context, and the existing persistent model-budget ledger.
- Produces: `AuditedSkillRunner.run(request, context)` with idempotent replay, safe failure persistence, aggregate usage, and `AgentRunLogSummary`; `getSkillRunFailureAudit(error)` exposes only non-serializable local aggregate accounting metadata.

- [ ] **Step 1: Write failing SkillRunner integer-micros and failure-audit tests**

Extend existing tests so success exposes exact `estimatedCostMicros` and retains derived `estimatedCostUsd`, while a failure after consumed transient/repair responses preserves aggregate tokens, cost, attempt count, duration, and most recent response ID through `getSkillRunFailureAudit(error)`. Prove raw provider message/cause is absent from JSON serialization and logs.

- [ ] **Step 2: Run focused SkillRunner tests and verify RED**

Run: `npx tsx --conditions=react-server --test --test-name-pattern="micros|failure audit" tests/agent/skill-runner.test.ts`

Expected: FAIL because exact micros and failure-audit accessors do not exist.

- [ ] **Step 3: Implement aggregate audit metadata without changing retry semantics**

Add `estimatedCostMicros` to `SkillRunRecordSchema` and derive USD from it. Track the latest valid response ID and accumulated settled usage across request attempts. Attach a deeply frozen failure audit to thrown object identities through a module-local `WeakMap`, then export:

```ts
export function getSkillRunFailureAudit(
  error: unknown,
): Readonly<SkillRunFailureAudit> | null;
```

Do not add provider raw output or Error/cause data to the audit. Preserve `BudgetExceededError` and `SkillRuntimeError` identities so 6.4 behavior and Worker classification remain unchanged.

- [ ] **Step 4: Write failing end-to-end audit service tests**

Using a real temporary SQLite database and fake provider, test successful persistence/reopen/replay, provider/validation failure persistence, failed output repair aggregation, a one-shot finalize failure followed by restart/retry with zero extra provider calls and recovered settled usage, successful-audit replay after simulated Worker crash, stale lease fencing, safe error JSON, and summary logs that exclude full input/output/provider text/secrets.

```ts
const first = await audited.run(request, activeContext);
assert.equal(provider.requests.length, 1);
assert.equal(first.agentRun.validationStatus, "passed");

const replay = await reopenedAudited.run(request, activeContext);
assert.equal(provider.requests.length, 1);
assert.deepEqual(replay.value, first.value);

const serializedLogs = JSON.stringify(logged);
assert.doesNotMatch(serializedLogs, /private customer review|full model conclusion|Bearer|sk-secret/);
assert.match(serializedLogs, /contentHash|recordCount|attemptCount|estimatedCostMicros/);
```

- [ ] **Step 5: Run audit service tests and verify RED**

Run: `npx tsx --conditions=react-server --test tests/agent/agent-run-service.test.ts`

Expected: FAIL because `AuditedSkillRunner` and its persistence/logging lifecycle do not exist.

- [ ] **Step 6: Implement pending → terminal execution ordering**

Implement this exact boundary:

1. Load the trusted Skill and idempotently register its manifest/hash.
2. Begin one pending AgentRun under the active JobAttempt lease.
3. If an identical terminal row already exists, parse and return the saved output or rethrow a safe persisted-failure error without calling the provider.
4. Run the existing SkillRunner. Its request-level reserve/dispatch/settle remains authoritative and unchanged.
5. On success, finalize passed with structured output, aggregate usage, response ID, and integer micros before returning to WorkerLoop.
6. On failure, normalize only a closed local classification/message, merge in-memory failure audit with settled-ledger recovery, finalize failed, emit metadata-only logs, and rethrow the original safe runtime error.
7. If audit finalization itself fails after provider settlement, throw a safe infrastructure persistence error. On replay, the settled/dispatched ledger prevents another provider dispatch; the service recovers usage and terminally records a safe failure if the output was not durably committed.

Use semantic output version parsed from the manifest schema name, `summarizeContent` for input/output hashes and counts, and `redactStringForLog` for provider/model/response IDs. Never call `JSON.stringify(error)` or inspect arbitrary `cause` values.

- [ ] **Step 7: Run focused runtime/persistence tests for GREEN and refactor**

Run: `npx tsx --conditions=react-server --test tests/agent/agent-run-service.test.ts tests/agent/skill-runner.test.ts tests/agent/skill-runner-persistent-budget.test.ts tests/agent/model-budget-coordinator.test.ts tests/agent/model-budget-repository.test.ts`

Expected: all focused tests pass with no real OpenAI calls; the existing live smoke remains skipped.

- [ ] **Step 8: Commit the runtime slice**

```powershell
git add server/runtime server/db/model-budget-repository.ts server/db/sqlite-repository.ts tests/agent/agent-run-service.test.ts tests/agent/skill-runner.test.ts tests/agent/skill-runner-persistent-budget.test.ts tests/agent/model-budget-coordinator.test.ts tests/agent/model-budget-repository.test.ts
git commit -m "feat(agent): audit SkillRunner executions durably"
```

---

### Task 4: Validate OpenSpec 7.3 and finish the branch

**Files:**
- Modify: `openspec/changes/build-standalone-agent-workflow/tasks.md`
- Update: `docs/superpowers/plans/2026-08-15-persist-agent-runs.md` checkboxes as execution evidence.

**Interfaces:**
- Consumes: all completed contract, Repository, migration, runtime, and test slices.
- Produces: strict OpenSpec 7.3 completion evidence and a clean, reviewable branch; no merge/push/rebase/amend.

- [ ] **Step 1: Run focused 7.3 tests fresh**

Run: `npx tsx --conditions=react-server --test tests/agent/contracts.test.ts tests/agent/sqlite-migrations.test.ts tests/agent/agent-run-repository.test.ts tests/agent/agent-run-service.test.ts tests/agent/skill-runner.test.ts tests/agent/skill-runner-persistent-budget.test.ts tests/agent/model-budget-repository.test.ts tests/agent/model-budget-coordinator.test.ts`

Expected: 0 failed and only the existing opt-in OpenAI smoke may be skipped.

- [ ] **Step 2: Run the complete required gates**

Run each command independently and save its exact exit status/count:

```powershell
npm run test:agent
npm run skills:validate
npm run lint
npx openspec validate build-standalone-agent-workflow --strict
npm test
npx tsc --noEmit --pretty false
git diff --check
```

Expected: every command exits 0; lint has 0 errors and no warnings beyond the stated 26-warning baseline; TypeScript introduces no diagnostics.

- [ ] **Step 3: Verify scope and lockfile invariants**

Run:

```powershell
git diff -- package-lock.json
git diff -- openspec/changes/build-standalone-agent-workflow/tasks.md
git diff --stat ad520889a182784475a20e60cd0436e788db69ed..HEAD
git status --short
```

Expected: no lockfile diff; only 7.3 changes from `[ ]` to `[x]`; no 7.4/8.x edits; changes remain limited to the planned audit files.

- [ ] **Step 4: Mark only OpenSpec task 7.3 complete after evidence is green**

Change exactly:

```md
- [x] 7.3 保存 Skill 版本、数据快照、模型、响应标识、Token、耗时和费用估算；普通日志只保存摘要元数据并通过脱敏测试
```

Re-run: `npx openspec validate build-standalone-agent-workflow --strict`

Expected: valid change with no other task status modifications.

- [ ] **Step 5: Commit validation metadata and verify clean worktree**

```powershell
git add openspec/changes/build-standalone-agent-workflow/tasks.md docs/superpowers/plans/2026-08-15-persist-agent-runs.md
git commit -m "docs(openspec): complete agent run persistence task"
git diff --check ad520889a182784475a20e60cd0436e788db69ed..HEAD
git status --short
git log --oneline ad520889a182784475a20e60cd0436e788db69ed..HEAD
```

Expected: `git status --short` is empty and the branch retains multiple clear commits for main-window review.

---

## Self-Review

- **Spec coverage:** Tasks 1–3 cover Skill/version/hash/manifest, snapshots, model/provider/response, tokens/duration/integer cost, aggregate retries, audit reads, pending terminal CAS, restart/concurrency/lease fencing, tenant/run/stage/job validation, safe failure data, persistence ordering, and summary-only logs. Task 4 covers every requested gate and limits the checkbox change to 7.3.
- **No placeholders:** The plan contains no TBD/TODO/follow-up implementation placeholders; every behavior has an exact target file, interface, command, and expected outcome.
- **Type consistency:** `estimatedCostMicros` is the authoritative integer across SkillRunner, Repository, shared v1.1 contract, SQLite, summaries, and logs. `jobAttemptId` plus `requestOrdinal` are nullable only for legacy budget rows/callers and required for new SkillRunner reservations. Lease owner/generation is explicit in both begin and finalize.
- **Failure boundary:** Budget settlement remains before AgentRun terminal persistence. If the latter fails, ledger CAS prevents another provider dispatch; the subsequent attempt recovers settled usage and records infrastructure failure rather than pretending the lost structured output succeeded.
- **Scope:** No UI/API route, VOC generation, report publishing, login, PostgreSQL, connector, or task 7.4/8.x work is included.
