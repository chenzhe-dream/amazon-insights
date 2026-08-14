# Persist Agent Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement OpenSpec task 7.3 by durably auditing each JobAttempt-level Skill execution with immutable provenance, integer-micros usage, lease-fenced completion, restart-safe recovery, and metadata-only logs.

**Architecture:** Add a versioned `AgentRunRepository` domain contract beside the existing orchestration and model-budget contracts, then implement it in `SqliteAgentRepository` behind a forward-only `0004` migration. An `AuditedSkillRunner` service owns the pending-to-terminal audit lifecycle around the existing `SkillRunner`; request-level retry/repair accounting remains in `model_budget_reservations`, while the AgentRun stores a job-level execution fingerprint, exact schema digest, closed attempt trail, and completeness-qualified aggregate usage. Replay is allowed only for an identical fingerprint and revalidated saved output; audit-write recovery uses settled actual plus dispatched conservative ledger amounts without issuing another provider request.

**Tech Stack:** TypeScript 5.9, Node 22 `node:sqlite`, Zod 4, Node test runner through `tsx`, OpenSpec CLI.

**Plan provenance:** Initial reviewed plan commit `41dabb0` (`docs(plan): detail agent run persistence work`) and review correction `bda427c` (`docs(plan): tighten agent run audit invariants`); both remain in history and are never amended.

## Global Constraints

- Work only in `C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\feat-persist-agent-runs` on `feat/persist-agent-runs`; do not create another worktree.
- Preserve migrations `0001`, `0002`, and `0003`; all schema evolution is forward-only in `0004`.
- Add no dependencies and do not change `package-lock.json` or address the 21 existing audit findings.
- Keep request-level provider retry/repair usage in `model_budget_reservations`; one `AgentRun` represents one JobAttempt-level Skill execution and aggregates those requests.
- Use integer `costMicros` as the authoritative persisted cost. Any USD value is derived compatibility data, never the database authority.
- A terminal replay must match the complete job-level `executionFingerprint` and `outputSchemaDigest`, and its saved output must pass the current caller Zod schema before it can be returned.
- Usage must declare `complete`, `partial`, or `unavailable`; never represent unknown request usage as zero or describe conservative dispatched projections as complete actual usage.
- Persist retry/repair reasons only as a closed attempt kind and safe error classification; never persist upstream error text.
- Do not implement VOC acquisition, UI, authentication, PostgreSQL, reports, connectors, or tasks 7.4/8.x.
- Ordinary logs may contain correlation IDs, schema/version, counts, hashes, redacted provider/model/response IDs, tokens, duration, cost, attempt count, and safe error classification only.
- Never persist or log provider raw text, complete prompts, complete customer input/reviews, API keys, cookies, passwords, sessions, authorization headers, or untrusted `Error`/`cause` serialization.
- Every production behavior follows RED → GREEN → REFACTOR. Do not mark OpenSpec task 7.3 complete until every gate passes.

---

## File Structure

- `shared/agent-contracts.ts`: preserve strict legacy AgentRun `1.0.0` parsing and add strict AgentRun audit `1.1.0` with stage/job correlation, execution/schema fingerprints, completeness-qualified nullable usage, closed attempt metadata, and terminal-state invariants.
- `server/db/migrations/0004_agent_run_audit.sql`: add model-request JobAttempt/kind correlation, AgentRun execution/schema fingerprints, usage completeness/attempt metadata, normalized snapshot links, uniqueness, consistency triggers, and immutable-completion triggers.
- `server/db/agent-run-repository.ts`: SQLite-independent SkillVersion/AgentRun records, begin/finalize/list/usage/recovery contracts, results, and closed domain errors.
- `server/db/model-budget-repository.ts`: add optional backward-compatible JobAttempt/ordinal reservation provenance used by new SkillRunner reservations.
- `server/db/sqlite-repository.ts`: implement SkillVersion idempotency/drift detection, active-lease begin, snapshot/run/stage/job/tenant validation, CAS finalize, restart reads, usage aggregation, and settled-ledger recovery.
- `server/runtime/model-request-accounting.ts`: create the stable job-level execution fingerprint from canonical identities, normalized input hash, exact input/output schema digests, and all model/pricing parameters.
- `server/runtime/skill-runner.ts`: prepare one deeply immutable execution (loaded Skill, validated input, exact schemas/response format, instructions, model config), execute that same object without a second registry load, expose integer micros and a full closed request-attempt identity trail, and attach non-serializable aggregate failure audit metadata without changing thrown error identities or retry behavior.
- `server/runtime/model-budget-coordinator.ts`: carry server-derived JobAttempt/ordinal provenance into the existing ledger.
- `server/runtime/agent-run-service.ts`: wrap SkillRunner with the pending/terminal audit lifecycle, safe error normalization, replay handling, usage recovery, and summary-only logs.
- `tests/agent/contracts.test.ts`: strict versioned shared-contract compatibility tests.
- `tests/agent/sqlite-migrations.test.ts`: forward migration, normalized FK/trigger, and immutability tests.
- `tests/agent/agent-run-repository.test.ts`: real SQLite integration tests for provenance, tenant/relationship validation, CAS, concurrency, restart, rollback, safe integers, and usage reads.
- `tests/agent/agent-run-service.test.ts`: fake-provider plus real SQLite integration tests for success/failure/replay, fingerprint/schema drift, saved-output revalidation, usage completeness, persistence-failure ordering, and redacted logs.
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

Add a test that proves the existing `1.0.0` object remains accepted, while a `1.1.0` audit object requires `stageId`, `jobAttemptId`, `executionFingerprint`, `outputSchemaDigest`, `usageCompleteness`, closed `attempts`, and completeness-qualified nullable accounting; rejects float/unsafe costs, duplicate snapshots, unknown fields, and invalid pending/passed/failed state combinations.

```ts
const audit = {
  ...legacyAgentRun,
  schemaVersion: "1.1.0",
  stageId,
  jobAttemptId,
  executionFingerprint: "d".repeat(64),
  outputSchemaDigest: "e".repeat(64),
  model: { provider: "openai", model: "gpt-test", responseId: "resp_1" },
  inputTokens: 100,
  outputTokens: 25,
  estimatedCostMicros: 321,
  durationMs: 90,
  attemptCount: 2,
  usageCompleteness: "complete",
  attempts: [
    { ordinal: 0, kind: "initial", transientRetryCount: 0, formatRepair: false, accounting: "settled", errorClassification: "model-output" },
    { ordinal: 1, kind: "format-repair", transientRetryCount: 0, formatRepair: true, accounting: "settled", errorClassification: null },
  ],
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
  executionFingerprint: Sha256Schema,
  outputSchemaDigest: Sha256Schema,
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
  inputTokens: SafeAccountingIntegerSchema.nullable(),
  outputTokens: SafeAccountingIntegerSchema.nullable(),
  estimatedCostMicros: SafeAccountingIntegerSchema.nullable(),
  durationMs: SafeAccountingIntegerSchema.nullable(),
  attemptCount: z.number().int().min(0).max(4).nullable(),
  usageCompleteness: z.enum(["complete", "partial", "unavailable"]).nullable(),
  attempts: z.array(AgentRunAttemptSchema).max(4),
  startedAt: DateTimeSchema,
  completedAt: DateTimeSchema.nullable(),
}).superRefine(validateAgentRunLifecycle);

export const AgentRunSchema = z.discriminatedUnion("schemaVersion", [
  AgentRunV1Schema,
  AgentRunAuditSchema,
]);
```

Pending audit accounting fields are `null`, not zero. Terminal `complete` requires safe integer token/cost estimates backed entirely by settled actual ledger rows; terminal `partial` requires safe integer effective estimates built from settled actual plus conservative dispatched projections; `unavailable` requires token/cost fields to remain null. `durationMs` and `attemptCount` reflect locally known lifecycle data and may be null only when unavailable rather than fabricated.

- [x] **Step 4: Run focused contracts and the complete contract file for GREEN**

Run: `npx tsx --conditions=react-server --test tests/agent/contracts.test.ts`

Expected: all contract tests pass, including legacy `1.0.0` compatibility.

- [x] **Step 5: Commit the contract slice**

```powershell
git add shared/agent-contracts.ts tests/agent/contracts.test.ts
git commit -m "feat(agent): version durable agent run contract"
```

- [x] **Step 6: Write the review-correction RED for fingerprint and usage completeness**

Extend the v1.1 contract test so the already-implemented zero-filled pending shape fails the reviewed requirements. Require lowercase SHA-256 `executionFingerprint`/`outputSchemaDigest`, nullable pending metrics, the three-state completeness discriminator, and a strict closed attempt trail (`initial | transient-retry | format-repair`, `settled | projected`, and closed error classification only).

- [x] **Step 7: Run the review-correction contract test and verify RED**

Run: `npx tsx --conditions=react-server --test --test-name-pattern="AgentRun audit" tests/agent/contracts.test.ts`

Expected: FAIL because the first contract slice lacks execution/schema fingerprints, usage completeness, nullable pending metrics, and attempt metadata.

- [x] **Step 8: Implement the reviewed v1.1 lifecycle invariants**

Update only the new `1.1.0` branch. Keep the committed legacy `1.0.0` branch compatible. Refine pending/terminal states based on what is actually knowable; do not require zero for unknown values and do not permit `complete` when any attempt is conservatively projected. Each attempt preserves the full `ModelRequestAttemptIdentity`: `ordinal`, `kind`, `transientRetryCount`, and `formatRepair`, followed by `settled | projected | unavailable` accounting and a closed nullable error classification that includes explicit `unavailable` for crash recovery.

- [x] **Step 9: Run the complete contract file for GREEN**

Run: `npx tsx --conditions=react-server --test tests/agent/contracts.test.ts`

Expected: all contract tests pass, including legacy compatibility and reviewed v1.1 semantics.

- [x] **Step 10: Commit the reviewed contract correction**

```powershell
git add shared/agent-contracts.ts tests/agent/contracts.test.ts docs/superpowers/plans/2026-08-15-persist-agent-runs.md
git commit -m "fix(agent): qualify agent run replay and usage"
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
- Produces: `AgentRunRepository.registerSkillVersion`, fingerprint-aware `beginAgentRun`, lease-fenced `finalizeAgentRun`, `listAgentRuns`, `getAgentRunUsage`, and completeness-aware `getJobAttemptModelUsage` implemented by `SqliteAgentRepository` without exposing SQLite types.

- [x] **Step 1: Write failing migration and Repository behavior tests**

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
    usageCompleteness: "complete",
    attempts: [{ ordinal: 0, kind: "initial", accounting: "settled", errorClassification: null }],
  },
});
assert.equal(passed.transitioned, true);
```

`activeLeaseBeginInput` includes stable lowercase SHA-256 `executionFingerprint` and `outputSchemaDigest`. Separate tests must reject missing, duplicate, uppercase/noncanonical, cross-run, and cross-tenant snapshot IDs; mismatched run/stage/job/SkillVersion; an inactive or expired lease; concurrent double finalize; stale lease generation; any terminal or pending replay fingerprint/schema/identity drift; mutation/deletion of terminal rows; and injected mid-transaction failure with zero partial rows. Reopen the database and prove the completed row and usage summary survive. Use two repositories and the helper Worker only for cross-connection CAS, not for mocked behavior.

- [x] **Step 2: Run focused tests and verify RED**

Run: `npx tsx --conditions=react-server --test tests/agent/sqlite-migrations.test.ts tests/agent/agent-run-repository.test.ts`

Expected: FAIL because migration 0004, the domain contract, and Repository methods do not exist.

- [x] **Step 3: Define the SQLite-independent domain contract**

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

Inputs contain only domain values, including `organizationId`, active lease owner/generation, canonical IDs, `executionFingerprint`, and `outputSchemaDigest`. Usage results return nullable token/cost values plus `complete | partial | unavailable`; attempt results use only closed kinds/accounting/error classifications. Add closed errors `SkillVersionConflictError`, `AgentRunConflictError`, `AgentRunSubjectNotFoundError`, `AgentRunLeaseLostError`, and `AgentRunDataError`; none include SQL/provider/customer content.

- [x] **Step 4: Add migration 0004 with normalized provenance and immutability**

The migration must:

```sql
ALTER TABLE agent_runs ADD COLUMN execution_fingerprint TEXT;
ALTER TABLE agent_runs ADD COLUMN output_schema_digest TEXT;
ALTER TABLE agent_runs ADD COLUMN usage_completeness TEXT
  CHECK (usage_completeness IS NULL OR usage_completeness IN ('complete', 'partial', 'unavailable'));
ALTER TABLE agent_runs ADD COLUMN attempt_count INTEGER
  CHECK (attempt_count IS NULL OR attempt_count BETWEEN 0 AND 4);
ALTER TABLE agent_runs ADD COLUMN attempts_json TEXT CHECK (
  attempts_json IS NULL OR json_valid(attempts_json)
);
ALTER TABLE model_budget_reservations ADD COLUMN job_attempt_id TEXT
  REFERENCES job_attempts(id) ON DELETE RESTRICT;
ALTER TABLE model_budget_reservations ADD COLUMN request_ordinal INTEGER
  CHECK (request_ordinal BETWEEN 0 AND 3);
ALTER TABLE model_budget_reservations ADD COLUMN attempt_kind TEXT CHECK (
  attempt_kind IS NULL OR attempt_kind IN ('initial', 'transient-retry', 'format-repair')
);
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

Also add indexes and triggers that reject run/stage/job mismatches, budget job/run mismatches, non-SHA fingerprints, invalid pending/completeness/terminal shapes, updates to completed AgentRuns, and all deletes of AgentRuns. New repository writes require fingerprints and an attempt array; nullable columns exist only so forward migration does not rewrite or falsify legacy rows. Do not edit prior migration text.

- [x] **Step 5: Implement SQLite validation, transactions, CAS, and mapping**

Implement all methods under the existing per-path serialization and `BEGIN IMMEDIATE` conventions. `beginAgentRun` verifies the tenant through `projects.organization_id`, verifies the active non-expired lease at `startedAt`, validates all snapshot IDs before writing, inserts AgentRun plus normalized snapshot links atomically, and returns an existing JobAttempt row only if every immutable identity field including both fingerprints matches. `finalizeAgentRun` performs one conditional update whose `WHERE` clause includes pending status plus current owner/generation/unexpired lease; a completed byte-for-byte replay returns `transitioned: false`, while any changed replay throws conflict.

Store JSON only through canonical safe serialization and parse every row through domain validation. Reject SQLite integers outside `Number.MAX_SAFE_INTEGER`; never coerce unsafe values.

- [x] **Step 6: Correlate new SkillRunner budget reservations without breaking old callers**

Add nullable `jobAttemptId`/`requestOrdinal`/`attemptKind` to the budget row and optional fields to the reserve input so old direct budget tests and existing databases remain compatible. New SkillRunner calls supply all three; Repository validation requires all-or-none and validates same-run ownership when present. `getJobAttemptModelUsage` returns the ordered closed attempt kinds and computes effective input/output/cost by using settled actual for settled rows and conservative projections for dispatched rows: all settled is `complete`, any dispatched projection is `partial`, and no trustworthy rows is `unavailable`. Never convert absent usage to zero.

- [x] **Step 7: Run focused migration/Repository tests for GREEN and refactor**

Run: `npx tsx --conditions=react-server --test tests/agent/sqlite-migrations.test.ts tests/agent/agent-run-repository.test.ts tests/agent/repository.test.ts tests/agent/model-budget-repository.test.ts tests/agent/model-budget-coordinator.test.ts`

Expected: all focused tests pass, existing migration checks expect versions 1–4, and no pre-0004 checksum changes occur.

- [x] **Step 8: Commit the persistence slice**

```powershell
git add server/db tests/agent/sqlite-migrations.test.ts tests/agent/repository.test.ts tests/agent/agent-run-repository.test.ts tests/agent/helpers/sqlite-agent-run-worker.ts
git commit -m "feat(agent): persist lease-fenced agent run audits"
```

---

### Task 3: Wrap SkillRunner with durable auditing and safe recovery

**Files:**
- Create: `server/runtime/agent-run-service.ts`
- Create: `tests/agent/agent-run-service.test.ts`
- Modify: `server/runtime/model-request-accounting.ts`
- Modify: `server/runtime/skill-runner.ts`
- Modify: `server/runtime/model-budget-coordinator.ts`
- Modify: `tests/agent/skill-runner.test.ts`
- Modify: `tests/agent/skill-runner-persistent-budget.test.ts`

**Interfaces:**
- Consumes: `SkillRunner.run`, `SkillRegistry.load`, `AgentRunRepository`, active Worker lease context, and the existing persistent model-budget ledger.
- Produces: `createSkillExecutionFingerprint`, `AuditedSkillRunner.run(request, context)` with fingerprint-safe replay/current-schema revalidation, safe failure persistence, completeness-qualified ledger usage, and `AgentRunLogSummary`; `getSkillRunFailureAudit(error)` exposes only non-serializable local aggregate accounting/attempt metadata.

- [x] **Step 1: Write failing SkillRunner integer-micros and failure-audit tests**

Extend existing tests so success exposes exact `estimatedCostMicros`, retains derived `estimatedCostUsd`, and returns an ordered closed attempt trail, while a failure after consumed transient/repair responses preserves locally known aggregate tokens, cost, attempt count, duration, most recent response ID, attempt kinds, and safe classifications through `getSkillRunFailureAudit(error)`. These local numbers are inputs to audit recovery, not automatically asserted as complete ledger usage. Prove raw provider message/cause is absent from JSON serialization and logs.

- [x] **Step 2: Run focused SkillRunner tests and verify RED**

Run: `npx tsx --conditions=react-server --test --test-name-pattern="micros|failure audit" tests/agent/skill-runner.test.ts`

Expected: FAIL because exact micros and failure-audit accessors do not exist.

- [x] **Step 3: Implement aggregate audit metadata without changing retry semantics**

Add `estimatedCostMicros` and the closed attempt trail to `SkillRunRecordSchema` and derive USD from micros. Track the latest valid response ID and accumulated known usage across request attempts without converting absent provider usage to zero. Attach a deeply frozen failure audit to thrown object identities through a module-local `WeakMap`, then export:

```ts
export function getSkillRunFailureAudit(
  error: unknown,
): Readonly<SkillRunFailureAudit> | null;
```

Do not add provider raw output or Error/cause data to the audit. Preserve `BudgetExceededError` and `SkillRuntimeError` identities so 6.4 behavior and Worker classification remain unchanged.

- [x] **Step 4: Write failing end-to-end audit service tests**

Using a real temporary SQLite database and fake provider, test successful persistence/reopen/replay, provider/validation failure persistence, failed output repair aggregation, complete/partial/unavailable usage semantics, a one-shot finalize failure followed by restart/retry with zero extra provider calls and recovered settled-plus-projected usage, successful-audit replay after simulated Worker crash, stale lease fencing, safe error JSON, and summary logs that exclude full input/output/provider text/secrets. Add explicit pre-provider conflicts for changed input, ordered snapshots, data cutoff, provider/model/generation/pricing parameters, Skill version/hash/manifest schemas, input/output contract schema digests, and output contract names. Corrupt or otherwise mismatch saved output against the current output Zod schema and prove replay refuses it without a provider call.

```ts
const first = await audited.run(request, activeContext);
assert.equal(provider.requests.length, 1);
assert.equal(first.agentRun.validationStatus, "passed");
assert.equal(first.agentRun.usageCompleteness, "complete");

const replay = await reopenedAudited.run(request, activeContext);
assert.equal(provider.requests.length, 1);
assert.deepEqual(replay.value, first.value);

const serializedLogs = JSON.stringify(logged);
assert.doesNotMatch(serializedLogs, /private customer review|full model conclusion|Bearer|sk-secret/);
assert.match(serializedLogs, /contentHash|recordCount|attemptCount|estimatedCostMicros/);
```

- [x] **Step 5: Run audit service tests and verify RED**

Run: `npx tsx --conditions=react-server --test tests/agent/agent-run-service.test.ts`

Expected: FAIL because `AuditedSkillRunner` and its persistence/logging lifecycle do not exist.

- [x] **Step 6: Implement pending → terminal execution ordering**

Implement this exact boundary:

1. Load the trusted Skill and idempotently register its manifest/hash.
2. Call `SkillRunner.prepare` exactly once to load the Skill, validate/freeze input, derive the actual input/output JSON schemas and response format, capture instructions/references and model config, and return one deeply immutable `PreparedSkillExecution`. Derive normalized input content hash plus schema digests from that object and compute `executionFingerprint = SHA-256(canonical JSON)` covering run/stage/job, Skill id/version/content hash and manifest schema names, ordered snapshots, data cutoff, provider/model/every generation and pricing parameter, input contract name/schema digest/content hash, and output contract name/schema digest.
3. Begin one pending AgentRun under the active JobAttempt lease with `executionFingerprint` and `outputSchemaDigest` as immutable identity.
4. If an identical terminal row exists, require exact fingerprint/digest equality and re-parse the saved output through the current request output Zod schema before returning it. Any drift/corrupt saved output is a safe pre-provider conflict.
5. Call `SkillRunner.runPrepared` with the exact same immutable prepared object. The compatibility `SkillRunner.run` path delegates to `prepare` then `runPrepared`; the audited path never loads or hashes the Skill twice, and an explicit pre-dispatch consistency assertion rejects any mismatched prepared identity. Request-level reserve/dispatch/settle remains authoritative and unchanged.
6. Query job-attempt ledger usage before terminal persistence. Use settled actual plus dispatched conservative projection, persist `complete | partial | unavailable`, and never use locally accumulated zeroes as substitutes for unknown usage.
7. On success, finalize passed with structured output, response ID, completeness-qualified integer estimates, duration, and closed attempt metadata before returning to WorkerLoop.
8. On failure, normalize only a closed local classification/message, combine the in-memory closed attempt trail with ledger recovery, finalize failed, emit metadata-only logs, and rethrow the original safe runtime error.
9. If audit finalization itself fails after provider settlement, throw a safe infrastructure persistence error. On replay, the settled/dispatched ledger prevents another provider dispatch; the service recovers effective usage and terminally records a safe failure if the output was not durably committed.

Use semantic output version parsed from the manifest schema name, canonical JSON hashing for execution identity, `summarizeContent` for log-only input/output hashes and counts, and `redactStringForLog` for provider/model/response IDs. Never call `JSON.stringify(error)` or inspect arbitrary `cause` values.

- [x] **Step 7: Run focused runtime/persistence tests for GREEN and refactor**

Run: `npx tsx --conditions=react-server --test tests/agent/agent-run-service.test.ts tests/agent/skill-runner.test.ts tests/agent/skill-runner-persistent-budget.test.ts tests/agent/model-budget-coordinator.test.ts tests/agent/model-budget-repository.test.ts`

Expected: all focused tests pass with no real OpenAI calls; the existing live smoke remains skipped.

- [x] **Step 8: Commit the runtime slice**

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

- [x] **Step 1: Run focused 7.3 tests fresh**

Run: `npx tsx --conditions=react-server --test tests/agent/contracts.test.ts tests/agent/sqlite-migrations.test.ts tests/agent/agent-run-repository.test.ts tests/agent/agent-run-service.test.ts tests/agent/skill-runner.test.ts tests/agent/skill-runner-persistent-budget.test.ts tests/agent/model-budget-repository.test.ts tests/agent/model-budget-coordinator.test.ts`

Expected: 0 failed and only the existing opt-in OpenAI smoke may be skipped.

- [x] **Step 2: Run the complete required gates**

Run each command independently and save its exact exit status/count:

```powershell
npm run test:agent
npm run skills:validate
npm run lint
npx openspec validate build-standalone-agent-workflow --strict
npm test
git diff --check
```

Expected: these commands exit 0; lint has 0 errors and no warnings beyond the stated 26-warning baseline.

TypeScript is a differential gate because baseline `ad520889a182784475a20e60cd0436e788db69ed` has exactly 17 existing diagnostics and `tsc` is therefore expected to exit nonzero. Export the base commit to a disposable ordinary directory (not a worktree), junction the already-installed `node_modules`, run the same compiler in base and feature, normalize relative `error TS...` diagnostic lines, and require no feature-only diagnostic:

```powershell
$repoRoot = (Get-Location).Path
$baseDir = Join-Path ([IO.Path]::GetTempPath()) ("agent-run-tsc-base-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $baseDir | Out-Null
try {
  git archive ad520889a182784475a20e60cd0436e788db69ed | tar -xf - -C $baseDir
  New-Item -ItemType Junction -Path (Join-Path $baseDir 'node_modules') -Target (Join-Path $repoRoot 'node_modules') | Out-Null
  Push-Location $baseDir
  $baseRaw = (& node node_modules/typescript/bin/tsc --noEmit --pretty false 2>&1 | Out-String)
  Pop-Location
  $featureRaw = (& node node_modules/typescript/bin/tsc --noEmit --pretty false 2>&1 | Out-String)
  $baseDiagnostics = @($baseRaw -split "`r?`n" | Where-Object { $_ -match 'error TS\d+:' } | ForEach-Object { $_.Replace($baseDir, '<repo>').Replace('\\', '/') } | Sort-Object -Unique)
  $featureDiagnostics = @($featureRaw -split "`r?`n" | Where-Object { $_ -match 'error TS\d+:' } | ForEach-Object { $_.Replace($repoRoot, '<repo>').Replace('\\', '/') } | Sort-Object -Unique)
  if ($baseDiagnostics.Count -ne 17) { throw "Expected 17 base diagnostics, found $($baseDiagnostics.Count)" }
  $addedDiagnostics = @(Compare-Object $baseDiagnostics $featureDiagnostics | Where-Object SideIndicator -eq '=>')
  if ($addedDiagnostics.Count -ne 0) { $addedDiagnostics | Format-Table | Out-String | Write-Error; throw "Feature introduced TypeScript diagnostics" }
} finally {
  if ((Test-Path $baseDir) -and $baseDir.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $baseDir -Recurse -Force
  }
}
```

Expected: base diagnostic count is exactly 17; feature-only diagnostic count is 0. Neither compiler invocation is expected to exit 0 merely because known baseline diagnostics remain.

- [x] **Step 3: Verify scope and lockfile invariants**

Run:

```powershell
git diff -- package-lock.json
git diff -- openspec/changes/build-standalone-agent-workflow/tasks.md
git diff --stat ad520889a182784475a20e60cd0436e788db69ed..HEAD
git status --short
```

Expected: no lockfile diff; only 7.3 changes from `[ ]` to `[x]`; no 7.4/8.x edits; changes remain limited to the planned audit files.

- [x] **Step 4: Mark only OpenSpec task 7.3 complete after evidence is green**

Change exactly:

```md
- [x] 7.3 保存 Skill 版本、数据快照、模型、响应标识、Token、耗时和费用估算；普通日志只保存摘要元数据并通过脱敏测试
```

Re-run: `npx openspec validate build-standalone-agent-workflow --strict`

Expected: valid change with no other task status modifications.

- [x] **Step 5: Commit validation metadata and verify clean worktree**

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

- **Spec coverage:** Tasks 1–3 cover Skill/version/hash/manifest, ordered snapshots, job execution/schema fingerprints, current-schema replay validation, model/provider/response, completeness-qualified tokens/duration/integer cost estimates, closed retry reasons, audit reads, pending terminal CAS, restart/concurrency/lease fencing, tenant/run/stage/job validation, safe failure data, persistence ordering, and summary-only logs. Task 4 covers every requested gate and limits the checkbox change to 7.3.
- **No placeholders:** The plan contains no TBD/TODO/follow-up implementation placeholders; every behavior has an exact target file, interface, command, and expected outcome.
- **Type consistency:** `estimatedCostMicros` is the authoritative integer estimate across SkillRunner, Repository, shared v1.1 contract, SQLite, summaries, and logs, always qualified by `complete | partial | unavailable`. `jobAttemptId`, `requestOrdinal`, and `attemptKind` are nullable only for legacy budget rows/callers and required for new SkillRunner reservations. Lease owner/generation and both fingerprints are explicit in begin/finalize/replay identity.
- **Failure boundary:** Budget settlement remains before AgentRun terminal persistence. If the latter fails, ledger CAS prevents another provider dispatch; the subsequent attempt uses settled actual plus dispatched conservative projection, marks completeness honestly, and records infrastructure failure rather than pretending the lost structured output succeeded.
- **Replay boundary:** A terminal row is reusable only when the full job execution fingerprint and exact output schema digest match, and only after saved output revalidation through the current caller Zod schema. Any input/model/pricing/Skill/schema drift conflicts before provider dispatch.
- **TOCTOU boundary:** Fingerprinting and provider execution consume the same deeply immutable `PreparedSkillExecution`; the audited path does not independently reload the Skill or rebuild response format, and `runPrepared` verifies its prepared identity before dispatch.
- **TypeScript boundary:** Base and feature diagnostics are collected with the same compiler from an archive, not another worktree. The known 17 baseline diagnostics may remain; feature-only additions must be zero.
- **Scope:** No UI/API route, VOC generation, report publishing, login, PostgreSQL, connector, or task 7.4/8.x work is included.

---

## Independent Review Fix Cycle

OpenSpec task 7.3 was reopened after two independent reviews returned `Ready to merge: No`. The original Task 1 and plan commits remain unchanged in history. This cycle adds new commits only and keeps 7.3 unchecked until every review regression and complete gate is green.

### Verified Findings and Evidence Ledger

| Finding | Verified root cause | RED test | GREEN evidence |
|---|---|---|---|
| A1 execution claim | `AuditedSkillRunner.run` ignores `beginAgentRun.created`; every matching pending caller reaches ledger/recovery/finalize | RED: missing `AgentRunClaimLostError`/claim contract; synchronized observer test exposed no durable ownership | GREEN: 4 named claim/observer/replacement tests; A1/A2 focused 29/29 |
| A2 terminal replay semantics | `#replayTerminal` converts every non-passed terminal record into `AgentRunReplayError`, discarding budget and cancellation identity | RED: 3/3 replay assertions received `AgentRunReplayError` | GREEN: budget fields and cancelled/ordinary `WorkerTaskError` semantics restored; A1/A2 focused 29/29 |
| A3 Zod mutation TOCTOU | prepared wrappers retain mutable shared Zod references and no current JSON-schema digest is checked at dispatch, post-response validation, or replay | RED: the three direct `_def.shape` mutation tests could not import the missing `SkillPreparedExecutionConflictError` contract | GREEN: pre-dispatch, provider-await, and terminal-replay drift tests 3/3; full Task 2 suite 76/76 |
| A4 unknown duration | recovery writes `durationMs: 0`; repository outcome and completion trigger require a value | RED: 3 failures because contract/repository rejected null and recovery persisted 0; the locally timed primitive failure control already passed | GREEN: nullable contract/trigger/recovery/summary plus measured local primitive failure 4/4; full Task 2 suite 76/76 |
| A5 logger isolation | SkillRunner and AuditedSkillRunner invoke injected loggers without `try/catch` | RED: 3/3 throwing-logger paths replaced success, replay, or the original safe failure | GREEN: narrow best-effort logger boundaries preserve all three paths 3/3; full Task 2 suite 76/76 |
| B6 offset DateTime | fingerprint and repository validators require exact `toISOString`, while begin compares cutoff strings and new AnalysisRun writes retain offsets | RED: all 3 offset tests failed at fingerprint validation, non-canonical creation result, or AgentRun begin | GREEN: fingerprint/new-run/legacy-run E2E 3/3; data-focused suite 62/62 |
| B7 legacy reads | `listAgentRuns` sends every row through the v1.1 mapper | RED: v1.0 row caused `AgentRunDataError` in the v1.1 mapper | GREEN: v1.1 reader and usage ignore legacy rows; B7/B8 focused 2/2 |
| B8 legacy duplicates | `agent_runs_job_attempt_idx` applies to every non-null legacy JobAttempt | RED: real 0001–0003 database failed 0004 with duplicate `job_attempt_id` unique violation | GREEN: audit-only partial unique index permits upgrade; B7/B8 focused 2/2 |
| B9 DB immutability | snapshot links validate only run membership on INSERT; ledger provenance and response IDs lack UPDATE boundary triggers | RED: all 3 raw-SQL boundary tests reported missing exceptions | GREEN: boundary tests 3/3 plus existing model-budget repository 14/14 |
| B10 worker hygiene | finalize worker helper exposes only a result promise and test cleanup can close/delete before bounded worker exit | RED: handle-shape test failed because `worker`/`result`/`exit` were unavailable | GREEN: concurrent finalize and forced timeout cleanup both observe exits 2/2 |

### Review Task 1: Add an atomic execution claim and preserve terminal semantics

**Files:**
- Modify: `server/db/migrations/0004_agent_run_audit.sql`
- Modify: `server/db/agent-run-repository.ts`
- Modify: `server/db/sqlite-repository.ts`
- Modify: `server/runtime/agent-run-service.ts`
- Modify: `shared/agent-contracts.ts`
- Test: `tests/agent/contracts.test.ts`
- Test: `tests/agent/agent-run-repository.test.ts`
- Test: `tests/agent/agent-run-service.test.ts`

**Interfaces:**
- `BeginAgentRunInput` adds a unique per-service-invocation `claimToken`, active Worker lease identity, and bounded `claimExpiresAt`.
- `BeginAgentRunResult.claimStatus` is `acquired | observing | terminal`; `FinalizeAgentRunInput` carries the exact acquired claim token.
- AgentRun v1.1 adds a strict safe `terminalMetadata` union: succeeded/null, budget scope/metric/used/projected/limit, cancelled, or closed failed classification.
- Repository claim acquisition/rotation and finalize are synchronous SQLite CAS operations inside short `BEGIN IMMEDIATE` transactions. Service polling/sleep occurs outside repository transactions.

- [x] **Step 1: Write and run the A1 repository/service RED**

Add real two-connection tests named:

```ts
test("concurrent AuditedSkillRunner calls share one claim and one provider dispatch", ...);
test("observer after ledger settle waits for the claim owner to finalize passed", ...);
test("expired or replaced claim recovers ledger usage without provider redispatch", ...);
test("a stale execution claim cannot finalize an AgentRun", ...);
```

Run: `npx tsx --conditions=react-server --test --test-name-pattern="claim|concurrent AuditedSkillRunner|observer after ledger" tests/agent/agent-run-repository.test.ts tests/agent/agent-run-service.test.ts`

Expected RED: provider request count becomes 2 or the observer finalizes shared pending state as failed because there is no invocation claim token/CAS.

- [x] **Step 2: Implement and verify A1 GREEN**

Migration 0004 adds `execution_claim_token`, `execution_claim_owner_id`, `execution_claim_generation`, and `execution_claim_expires_at`. New audit INSERT requires all four. Existing pending with an active matching claim returns `observing`; a caller may atomically rotate the claim only after bounded expiry or when the persisted owner/generation no longer matches the currently active JobAttempt lease. Finalize predicates on Worker lease plus exact claim token. `AuditedSkillRunner` polls with bounded condition-based waits outside SQLite transactions; it never dispatches or finalizes while observing, and ledger-backed recovery starts only after the caller acquires an invalidated claim.

Run the Step 1 command. Expected GREEN: one provider call, final AgentRun passed, observer replayed, stale claim rejected, recovery never redispatches.

- [x] **Step 3: Write and run the A2 terminal replay RED**

Add tests named:

```ts
test("terminal budget replay restores BudgetExceededError fields before Worker settlement", ...);
test("terminal cancellation replay restores WorkerTaskError cancelled semantics", ...);
test("terminal ordinary failure replay restores only its closed safe classification", ...);
```

Run: `npx tsx --conditions=react-server --test --test-name-pattern="terminal budget replay|terminal cancellation replay|terminal ordinary failure" tests/agent/contracts.test.ts tests/agent/agent-run-service.test.ts tests/agent/worker-loop.test.ts`

Expected RED: replay throws `AgentRunReplayError`, so WorkerLoop settles budget/cancelled records as ordinary infrastructure failure.

- [x] **Step 4: Implement and verify A2 GREEN**

Persist `terminal_metadata_json` as the strict contract union. Budget metadata stores only the closed scope/metric and validated numeric used/projected/limit values; cancellation stores no provider text/cause; ordinary failure stores only `WorkerErrorCategory`. On terminal replay reconstruct `BudgetExceededError` or `WorkerTaskError` with a fixed safe message. Keep `AgentRunReplayError` only for unsafe/corrupt saved successful output.

Run the Step 3 command. Expected GREEN: simulated crash after AgentRun finalize but before Worker settlement produces `budget-exceeded` and `cancelled` Worker states with no raw provider/cause persistence.

- [x] **Step 5: Commit the claim/replay slice**

```powershell
git add shared/agent-contracts.ts server/db/agent-run-repository.ts server/db/migrations/0004_agent_run_audit.sql server/db/sqlite-repository.ts server/runtime/agent-run-service.ts tests/agent/contracts.test.ts tests/agent/agent-run-repository.test.ts tests/agent/agent-run-service.test.ts tests/agent/worker-loop.test.ts docs/superpowers/plans/2026-08-15-persist-agent-runs.md
git commit -m "fix(agent): claim executions and replay terminal outcomes"
```

### Review Task 2: Fence schema drift and isolate unavailable runtime metadata

**Files:**
- Modify: `server/runtime/skill-runner.ts`
- Modify: `server/runtime/agent-run-service.ts`
- Modify: `server/db/agent-run-repository.ts`
- Modify: `server/db/migrations/0004_agent_run_audit.sql`
- Modify: `server/db/sqlite-repository.ts`
- Modify: `shared/agent-contracts.ts`
- Test: `tests/agent/skill-runner.test.ts`
- Test: `tests/agent/agent-run-service.test.ts`
- Test: `tests/agent/agent-run-repository.test.ts`
- Test: `tests/agent/contracts.test.ts`

- [x] **Step 1: Write and run the A3 mutable-Zod RED**

Mutate the actual shared `inputSchema._def.shape` or `outputSchema._def.shape` after `prepare`, including one mutation while the provider promise is pending. Tests must assert:

```ts
assert.equal(provider.requests.length, 0); // drift before dispatch
await assert.rejects(running, SkillPreparedExecutionConflictError); // drift during await
```

Also mutate before terminal replay and assert no saved output is accepted by the changed schema.

Run: `npx tsx --conditions=react-server --test --test-name-pattern="mutable Zod|schema drift during provider|terminal replay schema drift" tests/agent/skill-runner.test.ts tests/agent/agent-run-service.test.ts`

Expected RED: current code dispatches with the old response format or validates with the mutated Zod schema.

- [x] **Step 2: Implement and verify A3 GREEN**

Add a single SkillRunner-owned `assertPreparedContractIdentity(prepared)` that regenerates input JSON Schema and the exact provider response JSON Schema from the current Zod objects, hashes both, and compares them to the prepared digests. Call it immediately before model dispatch, after provider settlement and before output validation, and from terminal replay before `safeParse`. On pre-dispatch drift release an un-dispatched reservation and throw a safe closed conflict; on mutation during provider await settle usage but reject the response under the changed contract.

Run the Step 1 command. Expected GREEN: pre-dispatch/replay drift yields zero provider calls; in-flight drift cannot accept the response and retains settled usage.

- [x] **Step 3: Write and run the A4 nullable-duration RED**

Add contract/repository/service tests named:

```ts
test("terminal recovery preserves unknown duration as null", ...);
test("locally timed primitive failure persists its measured duration", ...);
test("usage summary becomes null when any terminal duration is unavailable", ...);
```

Run: `npx tsx --conditions=react-server --test --test-name-pattern="unknown duration|primitive failure|duration is unavailable" tests/agent/contracts.test.ts tests/agent/agent-run-repository.test.ts tests/agent/agent-run-service.test.ts`

Expected RED: contract/trigger reject null and recovery stores fabricated zero.

- [x] **Step 4: Implement and verify A4 GREEN**

Change terminal `durationMs` to `number | null` in the domain outcome and contract refinement; migration completion permits null; recovery without a local clock writes null. Normal SkillRunner execution and locally caught errors retain measured non-negative integer duration. Log summaries preserve null instead of coercing it to zero; usage aggregation already propagates unknown via nullable safe summation.

Run the Step 3 command. Expected GREEN: recovered duration is null, local failure duration is measured, mixed summary duration is null.

- [x] **Step 5: Write and run the A5 logger RED**

Add tests named:

```ts
test("throwing SkillRunner logger cannot replace a successful result", ...);
test("throwing audit logger cannot replace success failure or replay semantics", ...);
```

Run: `npx tsx --conditions=react-server --test --test-name-pattern="throwing.*logger" tests/agent/skill-runner.test.ts tests/agent/agent-run-service.test.ts`

Expected RED: injected logger exceptions replace a successful result or the original safe error.

- [x] **Step 6: Implement and verify A5 GREEN, then commit**

Wrap both logger call sites in narrow best-effort `try/catch` blocks, matching WorkerLoop observability behavior. Do not catch persistence/provider/schema operations in those blocks.

Run the Step 5 command and the full Task 2 focused files. Expected GREEN: success returns unchanged; failure and replay preserve their original error/result.

```powershell
git add shared/agent-contracts.ts server/db/agent-run-repository.ts server/db/migrations/0004_agent_run_audit.sql server/db/sqlite-repository.ts server/runtime/skill-runner.ts server/runtime/agent-run-service.ts tests/agent/contracts.test.ts tests/agent/agent-run-repository.test.ts tests/agent/skill-runner.test.ts tests/agent/agent-run-service.test.ts docs/superpowers/plans/2026-08-15-persist-agent-runs.md
git commit -m "fix(agent): fence contract drift and unknown runtime metadata"
```

### Review Task 3: Harden DateTime compatibility, legacy migration, and DB immutability

**Files:**
- Modify: `server/runtime/model-request-accounting.ts`
- Modify: `server/db/sqlite-repository.ts`
- Modify: `server/db/migrations/0004_agent_run_audit.sql`
- Test: `tests/agent/model-request-accounting.test.ts`
- Test: `tests/agent/repository.test.ts`
- Test: `tests/agent/agent-run-repository.test.ts`
- Test: `tests/agent/sqlite-migrations.test.ts`
- Modify: `tests/agent/helpers/sqlite-agent-run-worker.ts`

- [x] **Step 1: Write and run the B6 offset DateTime RED**

Add tests named:

```ts
test("execution fingerprint canonicalizes equivalent offset cutoffs", ...);
test("new AnalysisRun canonicalizes offset cutoff to UTC", ...);
test("legacy offset run and snapshot can begin and complete an AgentRun", ...);
```

Run: `npx tsx --conditions=react-server --test --test-name-pattern="offset cutoff|offset run|canonicalizes equivalent" tests/agent/model-request-accounting.test.ts tests/agent/repository.test.ts tests/agent/agent-run-repository.test.ts`

Expected RED: fingerprint rejects `+08:00`; begin rejects or string-mismatches legal legacy offsets; new run returns the unnormalized offset.

- [x] **Step 2: Implement and verify B6 GREEN**

Canonicalize legal fingerprint cutoffs to `new Date(value).toISOString()` before hashing. Normalize new AnalysisRun `dataCutoffAt` before INSERT/return. Begin accepts any `DateTimeSchema`-legal instant, compares run/snapshot/caller instants, and persists the stored run cutoff representation so legacy offset rows remain readable; SQL consistency checks compare valid instants rather than caller string formatting.

Run the Step 1 command. Expected GREEN: equivalent instants share a fingerprint and legacy `+08:00` provenance reaches a terminal AgentRun before provider conflict.

- [x] **Step 3: Write and run the B7/B8 legacy migration RED**

Create two v1.0 `agent_runs` sharing one non-null `job_attempt_id` under migrations 0001–0003, then apply 0004. Reopen through `SqliteAgentRepository` and assert `listAgentRuns` returns only complete v1.1 audit rows and legacy rows contribute neither count nor usage.

Run: `npx tsx --conditions=react-server --test --test-name-pattern="legacy AgentRun|legacy duplicate" tests/agent/sqlite-migrations.test.ts tests/agent/agent-run-repository.test.ts`

Expected RED: 0004 unique-index creation fails on duplicates or the v1.1 mapper rejects legacy rows.

- [x] **Step 4: Implement and verify B7/B8 GREEN**

Change the unique index predicate to `job_attempt_id IS NOT NULL AND execution_fingerprint IS NOT NULL`. Scope begin lookup and audit reads to `schema_version = '1.1.0'` with non-null fingerprint/digest; document through tests that the v1.1 audit reader and usage summary intentionally ignore legacy rows.

Run the Step 3 command. Expected GREEN: duplicate legacy upgrade/reopen succeeds and audit count/usage exclude v1.0 rows.

- [x] **Step 5: Write and run the B9 DB-boundary RED**

Using raw `DatabaseSync`, assert rejection of:

```sql
INSERT INTO agent_run_snapshots ... -- extra, wrong ordinal, terminal parent
UPDATE agent_run_snapshots ...;
DELETE FROM agent_run_snapshots ...;
UPDATE model_budget_reservations SET job_attempt_id/request_ordinal/attempt_kind/transient_retry_count/format_repair/run_id = ...;
UPDATE model_budget_reservations SET response_id = ...; -- before settle or after first value
```

Run: `npx tsx --conditions=react-server --test --test-name-pattern="snapshot link boundary|budget provenance boundary|response id boundary" tests/agent/agent-run-repository.test.ts`

Expected RED: raw SQL can fork snapshot links or rewrite ledger provenance/response identity.

- [x] **Step 6: Implement and verify B9 GREEN**

INSERT links require a pending audit parent and exact `ordinal`/`snapshot_ids_json` element. Add unconditional UPDATE/DELETE rejection triggers for links. Add budget UPDATE triggers that keep run and full attempt provenance immutable, revalidate JobAttempt/run ownership, and permit response ID only as a one-time null-to-value transition in the same controlled settle update; normal state/usage/settle transitions remain green.

Run the Step 5 command plus `tests/agent/model-budget-repository.test.ts`. Expected GREEN: all tampering aborts while normal dispatch/settle continues.

- [x] **Step 7: Write and run the B10 worker-hygiene RED/GREEN**

Refactor `runFinalizeWorker` to return `{ worker, result, exit }`. Wrap barrier release/result collection in `try/finally`; in cleanup, release any waiting barrier, wait a bounded interval for every exit, terminate remaining workers, await their exit promises, and only then close repositories/remove the temporary directory. Add a forced barrier-timeout cleanup test that observes every exit without unhandled rejection.

Run: `npx tsx --conditions=react-server --test --test-name-pattern="worker connections|worker cleanup" tests/agent/agent-run-repository.test.ts`

Expected RED before helper refactor: no exit/termination handles are available. Expected GREEN: both normal and forced cleanup paths await every worker before DB deletion.

- [x] **Step 8: Run the data-focused suite and commit**

Run: `npx tsx --conditions=react-server --test tests/agent/sqlite-migrations.test.ts tests/agent/repository.test.ts tests/agent/model-budget-repository.test.ts tests/agent/agent-run-repository.test.ts tests/agent/model-request-accounting.test.ts`

```powershell
git add server/db/migrations/0004_agent_run_audit.sql server/db/sqlite-repository.ts server/runtime/model-request-accounting.ts tests/agent/sqlite-migrations.test.ts tests/agent/repository.test.ts tests/agent/model-budget-repository.test.ts tests/agent/agent-run-repository.test.ts tests/agent/model-request-accounting.test.ts tests/agent/helpers/sqlite-agent-run-worker.ts docs/superpowers/plans/2026-08-15-persist-agent-runs.md
git commit -m "fix(agent): harden audit migration boundaries"
```

### Review Task 4: Two green review rounds and final gates

- [x] **Step 1: Run review round one focused suite**

Run all changed agent test files together. Require zero failures and update the findings ledger with each exact RED failure and GREEN test name/count.

- [x] **Step 2: Run review round two complete gates independently**

Run: focused 7.3 suite; `npm run test:agent`; `npm run skills:validate`; `npm run lint`; `npx openspec validate build-standalone-agent-workflow --strict`; `npm test`; base/feature TypeScript diagnostic normalization; `git diff --check`.

Expected: agent tests have zero failures and only the opt-in live smoke skip; lint remains 0 errors/26 baseline warnings; base and feature each have exactly 17 diagnostics with zero feature-only additions.

Evidence: review round one ran all 8 changed agent test files together at 137/137. Review round two produced `test:agent` 297 pass/1 opt-in skip/0 fail, three validated Skill hashes, lint 0 errors/26 baseline warnings, strict OpenSpec valid, `npm test` 2/2 after a successful build, and base=17/feature=17 TypeScript diagnostics with normalized difference 0. The post-lint worker focused rerun remained 2/2.

- [x] **Step 3: Verify immutable scope**

Require empty diffs for `package-lock.json` and migrations 0001–0003. Confirm tasks 7.4/8.x are untouched and all changes remain within the reviewed audit files/tests/docs.

- [x] **Step 4: Mark only OpenSpec 7.3 complete and validate again**

Only after both review rounds and every gate are green, change 7.3 from `[ ]` to `[x]`, rerun strict OpenSpec validation, and record the evidence in this ledger.

- [x] **Step 5: Commit completion metadata and verify clean worktree**

```powershell
git add openspec/changes/build-standalone-agent-workflow/tasks.md docs/superpowers/plans/2026-08-15-persist-agent-runs.md
git commit -m "docs(openspec): revalidate agent run persistence"
git diff --check ad520889a182784475a20e60cd0436e788db69ed..HEAD
git status --short
```

### Review-Fix Self-Review

- **Coverage:** A1–A5 and B6–B10 each have a named failing test, minimal implementation boundary, focused GREEN command, and commit boundary.
- **Claim safety:** claim acquisition/rotation/finalize are explicit CAS contracts; observers never enter provider or finalize paths while another bounded claim is valid, and no poll/sleep occurs in a SQLite transaction.
- **Crash order:** dispatched/settled ledger rows remain authoritative. A replacement claim may recover only after the old claim or Worker lease identity is invalid; recovery never redispatches and unknown duration remains null.
- **Replay safety:** successful output still requires fingerprint identity, current schema identity, and current Zod validation. Failed terminals reconstruct only closed Worker-visible semantics.
- **Legacy safety:** migration 0004 accepts duplicate pre-audit rows; v1.1 readers ignore legacy usage rather than fabricating a v1.1 record.
- **DB boundary:** snapshot order and budget request provenance remain immutable even through raw SQL, while controlled lifecycle/settle updates continue to work.
- **Scope:** no new dependency, lockfile edit, prior migration edit, UI/VOC/PostgreSQL/API expansion, stash, amend, rebase, push, or merge.

---

## Second Independent Review Fix Cycle

The second two-reviewer pass returned `Ready to merge: No` at HEAD `2854530`. OpenSpec 7.3 is reopened and remains unchecked until all four findings, both review rounds, and every final gate are green. Existing commits stay immutable; this cycle adds new commits only.

### Second-Cycle Findings Ledger

| Finding | Verified root cause | RED evidence | GREEN evidence |
|---|---|---|---|
| C1 claim TTL takeover | `beginAgentRun` treats an expired claim timestamp as sufficient to rotate the token even when the persisted and current JobAttempt lease owner/generation are identical | `same Worker lease cannot take over an expired claim` failed: expected `observing`, actual `acquired` | repository/service/model-budget focused run: 72 pass, 0 fail; provider-in-flight, retry, settle gap, and changed-generation recovery all green |
| C2 failed replay contract order | `#replayTerminal` restores every non-passed terminal before `assertPreparedContractIdentity` | failed/budget/cancelled drift tests received restored terminal errors instead of `SkillPreparedExecutionConflictError` | all three drift tests plus passed/cancelled replay controls green; service file 20 pass, 0 fail |
| C3 preflight duration | `#persistExecutionFailure` uses `local?.durationMs ?? 0`, although failures before SkillRunner timing have no measurement | aborted/provider-mismatch/schema-drift tests each read `0` instead of `null` | all three persist `null`; locally timed primitive failure remains a positive integer; service file 20 pass, 0 fail |
| C4 terminal metadata SQL | completion checks compare `json_extract(..., '$.kind') <> value`; missing paths yield SQL NULL and bypass the abort condition | raw `{}` completion succeeded, so the rejection test reported a missing exception | malformed closed-shape and four legal-shape tests 2 pass; repository 21 pass and migration 7 pass, 0 fail |

### Review Task 5: Make JobAttempt lease identity the only claim recovery authority

**Files:**
- Modify: `server/db/agent-run-repository.ts`
- Modify: `server/db/sqlite-repository.ts`
- Modify: `server/db/migrations/0004_agent_run_audit.sql`
- Modify: `server/runtime/agent-run-service.ts`
- Modify: `server/runtime/skill-runner.ts`
- Test: `tests/agent/agent-run-repository.test.ts`
- Test: `tests/agent/agent-run-service.test.ts`
- Test: `tests/agent/skill-runner-persistent-budget.test.ts`

**Interfaces:**
- `beginAgentRun` returns `observing` for every different claim token under the same persisted/current lease owner and generation, regardless of `execution_claim_expires_at`.
- Add an explicit read-only `assertAgentRunClaim(input)` repository fence over AgentRun ID, exact claim token, organization, JobAttempt, active lease owner/generation, and `asOf`.
- `SkillRunner.runPrepared` accepts an immutable optional execution-authority callback and invokes it before reserve, dispatch, settle, and therefore before every retry/repair request. It performs no provider or ledger transition after the fence rejects.
- Claim polling remains outside SQLite transactions and terminates through terminal replay, caller abort, or JobAttempt lease expiry/change; the per-poll sleep and every provider request remain bounded.

- [x] **Step 1: Write and run C1 RED tests**

Add synchronized real-SQLite tests named:

```ts
test("same Worker lease cannot take over an expired claim during provider execution", ...);
test("retry and repair crossing claim TTL remain owned by one invocation", ...);
test("observer crossing claim TTL after ledger settle replays actual passed audit", ...);
test("new Worker lease generation recovers without provider redispatch and fences old execution", ...);
```

Use two repository connections, controlled clocks, provider/ledger/finalize barriers, and `try/finally` cleanup. Assert one provider dispatch for the in-flight and settle-gap cases; actual usage reaches the final passed AgentRun; a same-lease observer never acquires or finalizes. After a real lease owner/generation replacement, assert recovery uses the dispatched/settled ledger without provider redispatch and the old claim fails every subsequent authority/finalize check.

Run: `npx tsx --conditions=react-server --test --test-name-pattern="expired claim|crossing claim TTL|new Worker lease generation" tests/agent/agent-run-repository.test.ts tests/agent/agent-run-service.test.ts tests/agent/skill-runner-persistent-budget.test.ts`

Expected RED: same-lease observer rotates after the old TTL and can race recovery/provider accounting; no per-request exact-token authority fence exists.

- [x] **Step 2: Implement and verify C1 GREEN**

In repository code and migration triggers, remove wall-clock expiry as a valid same-lease replacement condition. A replacement update must change owner or generation and must match the currently active JobAttempt lease. Implement `assertAgentRunClaim` as a short serialized read with no polling. Thread its callback from `AuditedSkillRunner` into the prepared Skill execution and check it immediately before each budget reserve, dispatch, and settle boundary. A lost fence throws a closed safe persistence/runtime error; a dispatched request remains conservatively projected if settle is fenced. A new lease may recover that ledger row but never resend the provider call.

Run the Step 1 command plus `tests/agent/model-budget-repository.test.ts`. Expected GREEN: same-lease TTL has no authority effect, changed lease identity is the only takeover path, and accounting/audit cannot fork.

- [x] **Step 3: Commit the claim-authority slice**

```powershell
git add server/db/agent-run-repository.ts server/db/sqlite-repository.ts server/db/migrations/0004_agent_run_audit.sql server/runtime/agent-run-service.ts server/runtime/skill-runner.ts tests/agent/agent-run-repository.test.ts tests/agent/agent-run-service.test.ts tests/agent/skill-runner-persistent-budget.test.ts docs/superpowers/plans/2026-08-15-persist-agent-runs.md
git commit -m "fix(agent): fence claims by worker lease identity"
```

### Review Task 6: Validate every replay contract and preserve unknown preflight duration

**Files:**
- Modify: `server/runtime/agent-run-service.ts`
- Test: `tests/agent/agent-run-service.test.ts`

- [x] **Step 1: Write and run C2 replay-order RED**

Add tests named:

```ts
test("failed terminal replay validates current contract before restoring failure", ...);
test("budget terminal replay validates current contract before restoring budget error", ...);
test("cancelled terminal replay validates current contract before restoring cancellation", ...);
```

Pause `beginAgentRun`, mutate the real prepared input or output Zod `_def.shape`, then release begin. Assert `SkillPreparedExecutionConflictError` for all three saved terminal kinds and no restored old terminal error. Retain the existing passed replay validation test.

Run: `npx tsx --conditions=react-server --test --test-name-pattern="terminal replay validates current contract" tests/agent/agent-run-service.test.ts`

Expected RED: saved failed/budget/cancelled semantics are thrown before schema identity is checked.

- [x] **Step 2: Implement and verify C2 GREEN**

Move the single SkillRunner-owned `assertPreparedContractIdentity(prepared)` call to the first statement of `#replayTerminal`, before logging or branching on validation/terminal metadata. Do not duplicate JSON Schema generation in the service.

- [x] **Step 3: Write and run C3 nullable preflight-duration RED**

Add tests named:

```ts
test("already aborted preflight failure persists unknown duration", ...);
test("provider identity mismatch persists unknown duration", ...);
test("pre-dispatch contract drift persists unknown duration", ...);
```

Assert each AgentRun is failed with `durationMs: null`; assert the existing locally timed primitive provider failure remains a non-negative safe integer.

Run: `npx tsx --conditions=react-server --test --test-name-pattern="preflight failure persists unknown duration|identity mismatch persists unknown duration|contract drift persists unknown duration|locally timed primitive" tests/agent/agent-run-service.test.ts`

Expected RED: the three no-measurement paths persist fabricated zero.

- [x] **Step 4: Implement and verify C3 GREEN, then commit**

Persist `local?.durationMs ?? null`. Do not infer elapsed time from AgentRun creation for this slice; SkillRunner remains the authority for locally measured execution duration. Run all Task 6 tests and the full AgentRun service file.

```powershell
git add server/runtime/agent-run-service.ts tests/agent/agent-run-service.test.ts docs/superpowers/plans/2026-08-15-persist-agent-runs.md
git commit -m "fix(agent): validate replay identity before terminal semantics"
```

### Review Task 7: Enforce the strict terminal metadata union in SQLite

**Files:**
- Modify: `server/db/migrations/0004_agent_run_audit.sql`
- Test: `tests/agent/agent-run-repository.test.ts`

- [x] **Step 1: Write and run C4 raw-SQL RED**

Add tests named:

```ts
test("terminal metadata boundary transactionally rejects every malformed closed shape", ...);
test("terminal metadata boundary accepts each strict closed shape", ...);
```

From a pending AgentRun, attempt raw completion with `{}`, missing fields, wrong JSON types, invalid scope/metric/classification, negative values, non-safe integer token/micros values, non-finite `costUsd`, and extra keys. Each update must throw, leave the row pending, and roll back every terminal column. Then complete independent pending rows with legal succeeded, failed, cancelled, and budget-exceeded metadata and reopen them through the v1.1 reader.

Run: `npx tsx --conditions=react-server --test --test-name-pattern="terminal metadata boundary" tests/agent/agent-run-repository.test.ts`

Expected RED: at least `{}` reaches a terminal immutable row because SQL NULL bypasses `<>`.

- [x] **Step 2: Implement and verify C4 GREEN**

Use NULL-safe `IS NOT`, `json_type`, numeric bounds, exact `json_each` key counts, and unexpected-key rejection. Enforce:

- `succeeded`: exactly `{kind}`;
- `cancelled`: exactly `{kind}`;
- `failed`: exactly `{kind, classification}` with the shared non-cancelled closed classification enum;
- `budget-exceeded`: exactly `{kind, scope, metric, used, projected, limit}`; `tokens`/`costMicros` values are non-negative safe JSON integers and `costUsd` values are finite non-negative JSON numbers.

Run the Step 1 command plus repository lifecycle and migration tests. Expected GREEN: malformed updates roll back while repository finalization for all four legal kinds remains valid.

- [x] **Step 3: Commit the SQLite metadata slice**

```powershell
git add server/db/migrations/0004_agent_run_audit.sql tests/agent/agent-run-repository.test.ts docs/superpowers/plans/2026-08-15-persist-agent-runs.md
git commit -m "fix(agent): validate terminal metadata at sqlite boundary"
```

### Review Task 8: Re-run both review rounds and complete only 7.3

- [x] **Step 1: Run all second-cycle focused files together**

Run the AgentRun repository/service, SkillRunner persistent-budget, SkillRunner, contract, model-budget, migration, and worker-loop test files. Record exact pass/fail/skip counts in the second-cycle findings ledger.

- [x] **Step 2: Run complete gates independently**

Run `npm run test:agent`, `npm run skills:validate`, `npm run lint`, strict OpenSpec validation, `npm test`, base/feature TypeScript diagnostics, `git diff --check`, lockfile/prior-migration/scope checks. Require lint 0 errors/26 baseline warnings and base=17/feature=17/feature-only=0.

- [x] **Step 3: Mark only 7.3 complete, validate, commit, and verify clean**

Only after Steps 1–2 are green, change 7.3 to `[x]`; leave 7.4/8.x untouched. Validate strict OpenSpec again, commit completion metadata, and require an empty `git status --short`.

### Second-Cycle Self-Review

- **Recovery authority:** wall-clock claim expiry is not ownership. Only a changed active JobAttempt lease owner/generation can replace a claim; exact-token checks fence every later model-accounting boundary.
- **Accounting order:** if authority is lost after dispatch, no new request is sent and the durable dispatched projection remains recoverable; recovery never replays the provider.
- **Replay order:** current prepared input/output schema identity is checked before every saved terminal branch.
- **Unknown values:** absence of SkillRunner timing is persisted as null, never zero.
- **SQL strictness:** terminal metadata uses the same closed keys, enums, number types, and bounds as the shared Zod union, with NULL-safe rejection and transactional rollback.
- **Scope:** no dependency, lockfile, 0001–0003, UI, VOC, PostgreSQL, connector, stash, amend, rebase, push, or merge change.

### Second-Cycle Final Evidence

- Focused review files after atomic fencing: 177 pass, 0 fail, 0 skip.
- Full Agent suite after the final code commit: 309 total, 308 pass, 1 opt-in live OpenAI skip, 0 fail.
- Skills: all 3 versioned Skills validated. Lint: 0 errors and the exact 26-warning baseline.
- OpenSpec strict: valid. Application gate: vinext build succeeded and rendered HTML tests passed 2/2.
- TypeScript differential: local read-only Temp clone at detached base `ad52088`, same dependency tree and compiler arguments; normalized base=17, feature=17, feature-only=0. The absolute Temp clone was verified as standalone and removed after collection.
- Git boundary: `git diff --check` clean; package-lock and migrations 0001–0003 unchanged; no 7.4/8.x task edit; no remaining Temp target or worktree modification before the final 7.3 metadata commit.

### Atomic Claim-Fence Self-Review Addendum

The post-gate concurrency self-review found a residual TOCTOU: a read-only claim assertion immediately before model-budget reserve/dispatch/settle does not make the lease check atomic with the ledger mutation. OpenSpec 7.3 is reopened until the authority tuple is carried into each model-budget repository operation and checked inside the reserve transaction or transition SQL statement.

- [x] RED: after replacing the JobAttempt lease from another connection, `model ledger mutations atomically reject a stale AgentRun claim` reported a missing rejection because stale reserve succeeded.
- [x] GREEN: an optional closed execution-authority tuple now reaches model-budget domain inputs; SQLite validates the exact pending AgentRun claim plus active lease inside the reserve, dispatch, and settle write transactions. The test rejects all three stale mutations and leaves existing reservations unchanged.
- [x] Regression: the six affected AgentRun/model-budget/SkillRunner files pass 138/138, the final focused set passes 177/177, and recovery without redispatch remains green. All final gates were rerun after the last code commit before marking 7.3 complete again.

## Fourth Review Addendum: Release Authority and Transaction-Entry Time

The third two-reviewer pass returned `Ready to merge: No` because the atomic claim fence added in `9d87cf4` was incomplete in two distinct ways. First, reserve, dispatch, and settle carried execution authority but release did not, so a stale invocation could release an ordinal that a replacement Worker had idempotently reused. Second, every authority check ran inside the write transaction but compared lease expiry to an audit timestamp captured before repository serialization and SQLite lock acquisition. Atomic placement alone therefore did not make the authority observation fresh.

OpenSpec 7.3 is reopened and remains unchecked until both findings and every final gate are green. Existing commits remain immutable; this cycle adds new commits only.

### Review Task 9: Fence release with the exact execution authority

**Files:**
- Modify: `server/db/model-budget-repository.ts`
- Modify: `server/db/sqlite-repository.ts`
- Modify: `server/runtime/model-budget-coordinator.ts`
- Modify: `server/runtime/skill-runner.ts`
- Test: `tests/agent/agent-run-repository.test.ts`
- Test: `tests/agent/model-budget-coordinator.test.ts`
- Test: `tests/agent/skill-runner-persistent-budget.test.ts`

- [x] **Step 1: Write and run D1 RED tests**

Add tests proving that `releaseModelBudget` with stale authority rejects transactionally and leaves the reservation reserved, current authority releases its own reservation, and an authority-free 6.4 caller remains compatible. Add a SkillRunner regression in which stale abort cleanup cannot release a replacement-owned ordinal or replace the original safe cancellation with a cleanup failure. Use two SQLite connections and an idempotent replacement reserve/dispatch path to prove exactly one provider dispatch remains possible.

Expected RED: stale release succeeds because neither the release contract nor its repository transaction receives execution authority.

- [x] **Step 2: Implement D1 GREEN**

Thread the optional closed `ModelBudgetExecutionAuthority` through `SkillModelBudgetCoordinator.release`, `ModelBudgetCoordinator.release`, and `releaseModelBudget`. In the same `BEGIN IMMEDIATE` transaction as `reserved -> released`, validate the exact pending AgentRun claim, active JobAttempt owner/generation/lease, AgentRun/run/job binding, and reservation/job binding. Preserve optional authority for unaudited 6.4 callers. Treat authority loss during best-effort cleanup as a fenced no-op so it cannot replace the original cancellation or contract-conflict semantics; propagate unrelated storage failures.

- [x] **Step 3: Verify D1 GREEN and commit**

Run the named repository, coordinator, and SkillRunner tests plus their complete files. Record RED/GREEN output before creating a new code commit; do not amend any earlier commit.

### Review Task 10: Evaluate authority freshness at transaction entry

**Files:**
- Modify: `server/db/sqlite-repository.ts`
- Modify: `tests/agent/helpers/sqlite-model-budget-worker.ts`
- Test: `tests/agent/agent-run-repository.test.ts`
- Test: `tests/agent/model-budget-repository.test.ts`

- [x] **Step 1: Write and run D2 RED tests**

Add a real two-connection/worker lock-barrier dispatch test: queue an authorized dispatch behind `BEGIN IMMEDIATE`, cross the JobAttempt lease expiry while it waits, release the lock, and require authority loss, an unchanged reserved row, and zero provider-bound dispatch authority. Add deterministic repository-clock tests for reserve, settle, and release showing that transaction-entry time, not `reservedAt`/`transitionedAt`, decides authority freshness. Include an unexpired control.

Expected RED: the stale audit timestamp still authorizes mutations after the JobAttempt lease has expired.

- [x] **Step 2: Implement D2 GREEN**

Add a synchronous repository `nowProvider` option with a real `Date` default. Validate and canonicalize its value only after the per-path serializer and `BEGIN IMMEDIATE` write transaction have been acquired. Route reserve, dispatch, settle, and release authority checks through this single helper. Keep `reservedAt` and `transitionedAt` as persisted audit/state-transition timestamps; never use them as authority freshness. Do not await inside SQLite write transactions.

- [x] **Step 3: Verify D2 GREEN and commit**

Run the worker-barrier and deterministic clock tests, the complete model-budget and AgentRun repository files, and the D1 concurrency regression. Confirm lock/barrier cleanup terminates and awaits every Worker before closing databases or deleting Temp directories.

### Review Task 11: Fourth-cycle gates and OpenSpec completion

- [x] **Step 1: Run the complete focused audit/runtime set**

Run AgentRun repository/service, model-budget repository/coordinator, SkillRunner persistent-budget/core, contract, migration, and Worker-loop tests. Re-run all earlier atomic fencing, claim recovery, replay, duration, metadata, immutability, and redaction regressions.

- [x] **Step 2: Run every repository gate independently**

Run `npm run test:agent`, `npm run skills:validate`, `npm run lint`, `npx openspec validate build-standalone-agent-workflow --strict`, and `npm test`. For TypeScript, use an explicitly verified standalone local clone under the system Temp directory at detached base `ad52088`, reuse the same dependencies/compiler arguments, normalize both checkout roots and slash directions, and require base=17, feature=17, feature-only=0. Do not use tar/archive. Then run `git diff --check` and protected-file/scope checks.

- [x] **Step 3: Mark only 7.3 complete after all evidence is green**

Only after Tasks 9-11 are green, change OpenSpec 7.3 from `[ ]` to `[x]`; do not edit 7.4 or 8.x. Re-run strict OpenSpec validation, commit the completion metadata as a new commit, and require a clean worktree.

### Fourth-Cycle RED/GREEN Ledger

- D1 RED: `model ledger mutations atomically reject a stale AgentRun claim` failed with a missing release rejection; `stale authority during abort cleanup preserves cancellation and never dispatches` received `PROVIDER_ERROR` instead of `CANCELLED`.
- D1 GREEN: the same tests pass. The repository test now uses two SQLite connections, rotates the Worker lease/claim, races stale release against replacement idempotent reserve, and proves the replacement alone receives one dispatch authority. Current-authority release and the existing unaudited coordinator release lifecycle also pass.
- D2 RED: `queued model ledger mutations use repository transaction-entry time for authority` allowed mutations after its injected clock crossed lease expiry; `dispatch waiting behind a SQLite write lock rechecks authority after lease expiry` returned `transitioned: true` after waiting past expiry.
- D2 GREEN: both tests pass with a synchronous SQLite repository clock read only after `BEGIN IMMEDIATE`. Reserve, settle, and release reject after serializer delay; a real Worker blocked by another connection rejects dispatch, leaves the row reserved, and yields zero provider authority.
- Focused D1/D2 regression: AgentRun repository, model-budget repository/coordinator, SkillRunner core, and persistent-budget files pass 121/121. Feature TypeScript diagnostics remain the exact 17 known baseline entries before the final detached-base differential.
- Final gates: focused 180/180; full Agent suite 312 total with 311 pass, 1 opt-in live OpenAI skip, and 0 fail; 3 Skills valid; lint 0 errors/26 baseline warnings; OpenSpec strict valid; vinext build and rendered HTML 2/2; detached local Temp clone TypeScript base=17, feature=17, feature-only=0, base-only=0; `git diff --check` and protected-file/scope checks clean. The verified standalone Temp clone and dependency junction were removed separately before completion.

## Fifth Review Addendum: Unified Transaction Time and True SQLite Concurrency

The fourth review returned `Ready to merge: No`. The previous fix made AgentRun lease authority fresh, but it did not make the whole model-budget transaction fresh: `reservedAt` and `transitionedAt` still decide expired-row cleanup, UTC-day attribution, and reservation dispatch TTL, while authority-free 6.4 calls skip the repository clock entirely. In addition, the D1 replacement test opened two repositories in one JavaScript isolate, so the process-global per-path serializer ordered both operations before SQLite could arbitrate them.

OpenSpec 7.3 is reopened and remains unchecked until E1/E2 and every final gate are green. All prior commits remain immutable; this cycle adds new commits only.

### Review Task 12: Use one transaction-entry instant for every budget decision

**Files:**
- Modify: `server/db/sqlite-repository.ts`
- Test: `tests/agent/agent-run-repository.test.ts`
- Test: `tests/agent/model-budget-repository.test.ts`
- Test: `tests/agent/model-budget-coordinator.test.ts`

- [x] **Step 1: Write and run E1 RED tests**

Add focused tests proving:

- a dispatch queued behind an independent SQLite write lock cannot use an old `transitionedAt` after the reservation lease expires, even while the JobAttempt heartbeat keeps execution authority active;
- a queued reserve crossing UTC midnight is stored in the transaction-entry UTC day and does not consume the old daily bucket;
- a new reservation whose requested lease is already expired at transaction entry is rejected without a row or budget occupancy;
- existing expired reservations are cleaned using transaction-entry time;
- the same TTL/day rules apply without AgentRun authority;
- reserve, dispatch, settle, and release each call the repository clock exactly once per write transaction, and an invalid/throwing clock rolls the operation back without partial state.

Expected RED: queued dispatch obtains provider authority from the stale audit timestamp, queued reserve is attributed to the old day, an immediately expired row is inserted, and unaudited calls do not read the repository clock.

- [x] **Step 2: Implement E1 GREEN**

At the top of each reserve/dispatch/settle/release `BEGIN IMMEDIATE` body, read and canonicalize one synchronous `freshNow` from `nowProvider`, unconditionally. Pass that exact value to optional AgentRun authority checks and every admission/TTL/day decision in that transaction. Use `freshNow` to clean expired reservations, derive `utc_day`, and compare persisted reservation leases. Keep `reservedAt`/`transitionedAt` only as audited event timestamps.

For reserve, resolve idempotent existing rows without inventing a replacement lease, but reject a genuinely new insert when `leaseExpiresAt <= freshNow`; leave no row or usage. Preserve direct-settle compatibility while requiring an unexpired reservation for a reserved-to-settled transition. A dispatched row remains settleable because provider accounting has already crossed the durable dispatch boundary. Clock failure must abort and roll back the whole write transaction. No transaction body may await.

Remove any reader invariant that incorrectly derives `utc_day` from the audit `createdAt`; validate the stored UTC-day shape independently because transaction-entry day is now authoritative.

- [x] **Step 3: Verify E1 GREEN and commit**

Run every named E1 test, then the complete AgentRun/model-budget repository and coordinator files. Record RED/GREEN evidence before a new commit; do not amend prior commits.

### Review Task 13: Make fixed-clock tests deterministic and concurrency real

**Files:**
- Modify: `tests/agent/helpers/sqlite-model-budget-worker.ts`
- Modify: `tests/agent/agent-run-repository.test.ts`
- Modify: `tests/agent/agent-run-service.test.ts`
- Modify: `tests/agent/worker-loop.test.ts`
- Modify other fixed-time Agent repository harnesses only where budget writes require it.

- [x] **Step 1: Write and run E2 RED**

Replace the same-isolate stale-release test with worker-thread operations using independently opened SQLite connections and an explicit barrier. The workers must overlap A's stale release with B's idempotent reserve/dispatch after lease/claim replacement. Assert A is fenced, B reuses the single persisted ordinal, exactly one dispatch returns authority, and the fake provider counter is exactly one.

Expected RED for the test harness review: the old test cannot demonstrate SQLite concurrency because both repository instances share `databaseOperationTails` in one isolate.

- [x] **Step 2: Implement deterministic fixtures and bounded worker lifecycle**

Centralize fixed test clocks so repositories seeded at `2026-08-15T08:00:00.000Z` receive `nowProvider: () => new Date(testNow)`. Apply this to AgentRun repository/service, WorkerLoop, persistent-budget, and any other fixed-time harness that performs audited budget mutations. Only dedicated lock/expiry tests may use dynamically generated real timestamps.

Extend the model-budget worker helper with the minimum release/replacement workflow needed for true cross-isolate competition. Return worker/result/exit handles; coordinate barriers with bounded waits; in `finally`, release every barrier, terminate with a timeout, await all exits/results, then close databases and remove Temp directories. Do not wait or poll inside SQLite write transactions.

- [x] **Step 3: Verify E2 GREEN and commit**

Run the real-concurrency regression repeatedly together with the 987603f cancellation test and all fixed-clock AgentRun/service/WorkerLoop suites. Require deterministic completion, provider count one, no leaked workers, and no Windows database cleanup failures.

### Review Task 14: Fifth-cycle gates and OpenSpec completion

- [ ] **Step 1: Run the full focused audit/runtime set**

Run AgentRun repository/service, model-budget repository/coordinator, SkillRunner persistent-budget/core, contracts, migrations, and WorkerLoop tests. Re-run all previous review regressions.

- [ ] **Step 2: Run every repository gate independently**

Run `npm run test:agent`, `npm run skills:validate`, `npm run lint`, strict OpenSpec validation, and `npm test`. Collect TypeScript diagnostics with the established standalone local Temp clone at detached base `ad52088`, the same dependencies/compiler arguments, normalized roots/slashes, and require base=17, feature=17, feature-only=0. Do not use tar/archive. Verify `git diff --check`, protected files, scope, Temp cleanup, and worktree status.

- [ ] **Step 3: Mark only 7.3 complete after every gate is green**

Only then change 7.3 from `[ ]` to `[x]`; leave 7.4 and 8.x untouched. Re-run strict OpenSpec validation, create a new completion commit, and require a clean worktree.

### Fifth-Cycle RED/GREEN Ledger

- E1 RED: `legacy budget TTL and UTC day use one transaction-entry instant` stored the queued row under `2026-08-14` instead of `2026-08-15`; `every legacy budget write reads one clock and clock failure rolls back` observed zero clock calls; `dispatch waiting behind a SQLite write lock uses fresh reservation TTL` returned `transitioned: true` after the reservation expired.
- E1 GREEN: all three pass. Reserve now rejects a new already-expired lease, cleans existing expiry and derives `utc_day` from one transaction-entry instant; dispatch checks persisted TTL against the same instant; reserved direct-settle cannot cross expiry; reserve/dispatch/settle/release read the clock exactly once for audited and unaudited calls, and clock failures leave no partial mutation.
- E2 RED: source inspection and the previous test structure proved both repositories executed in one isolate and therefore shared `databaseOperationTails`; the existing fixed-clock coordinator suite also failed after fresh-time enforcement, demonstrating its dependency on repository default wall time rather than its injected test clock.
- E2 GREEN: the stale-release/replacement regression now starts two distinct worker threads, releases them through one barrier, and observes distinct returned thread IDs. The stale owner is fenced while the replacement reuses one ordinal, obtains exactly one dispatch authority, and increments the fake provider counter once. Three consecutive executions pass with bounded result/termination/exit cleanup. Fixed-time budget/audit/service/persistent-budget/WorkerLoop harnesses inject deterministic repository clocks; dedicated expiry tests alone use dynamic real time.
- Focused E1/E2 regression: the six directly affected repository/service/runtime test files pass 123/123; model-budget repository/coordinator alone pass 31/31; feature TypeScript output remains the exact 17 known diagnostics before the final detached-base comparison.
- Final gates: pending.
