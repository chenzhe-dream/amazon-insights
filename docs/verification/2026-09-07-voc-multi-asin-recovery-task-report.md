# Task 1: multi-ASIN VOC durable recovery

Date: 2026-09-07. Implementation dispatch base: `9b1f690ad7506c5691eda62032708cfa5e6663a6`. Branch: `codex/fix-voc-multi-asin-recovery-20260907`. This report covers the implementation agent's work; coordinator review/build and locked-HEAD handoff are separate gates.

## Initial RED, before production changes

Command:

```powershell
node --conditions=react-server --import tsx --test --test-reporter=spec tests/agent/alexa-voc-multi-asin-recovery.test.ts
```

The initial two-adapter regression ran actual `createAlexaVocNormalizationRuntime`, encrypted inputs, registered normalization skill, audited fake provider and real repositories. A published; B completed its audited output and revision; a snapshot-identity-bound proxy threw on B's cumulative publication within the real nested transaction. The worker then called the real `failJob`. No SQL manufactured a failed job.

Observed RED output (relevant error/count excerpts):

```text
sqlite: AgentRunDataError: Stored agent run audit data is invalid
  #durableCycleDisposition (sqlite-repository.ts:6208)
  failJob (sqlite-repository.ts:6488)
postgres: PostgresJobStoreError: PostgreSQL job store operation failed
  #durableCycleDisposition (job-store.ts:508)
  failJob (job-store.ts:385)
tests 2
pass 0
fail 2
```

Earlier fixture-authoring corrections (project ASIN count and result schemaVersion) were not treated as the recovery RED.

## Implementation and state transitions

- A normalization-only, pure per-input reducer validates scoped audit/job/run/organization and exact linked input snapshot/fingerprint evidence before choosing recovery. Other stages retain their existing single-audit guard.
- Both databases use the reducer for failed/expired claims and failure settlement. Cancellation/budget missing terminals are inserted only inside the fenced settlement transaction; queue/status reads do not write terminals.
- Successful durable inputs are reconciled before unfinished siblings. Mixed work below the execution limit uses the existing bounded same-cycle successor, permitting a successful predecessor audit to commit only within its original stage/logical cycle and current fenced lease.
- Publication-policy jobs remain reconciliation-only at every attempt number. This preserves migration 0006's real counters/transitions. A new input submitted during publication recovery receives its own explicitly queued job and is not failed or modeled by the old publication lease.
- A single-current-lease cache binds fresh/reclaimed classification to job, owner and generation. Generation ancestry uses stage attempts within the current retry-cycle interval, including a predecessor in another logical cycle. Audit replay authorization remains exact-current-logical-cycle. A fresh legitimate last attempt can execute; a reclaimed exhausted lease cannot let A authorize unstarted B.
- Queue reuse rejects exhausted jobs without durable recovery evidence and does not absorb a newly submitted input into publication-only work. Existing snapshot hash-conflict assertions were preserved.

Discriminating RED/GREEN additions included: unstarted B improperly modeled at max1; budget incorrectly completed as success; A publication followed by B budget hitting `job attempt report publication transition is invalid`; fresh same-cycle attempt2/max2 incorrectly blocking B; new C being reused/stalled by old publication work; malformed linked-snapshot evidence accepted. Each was made failing before its scoped correction.

Final compatibility boundary RED command:

```powershell
node --conditions=react-server --import tsx --test --test-reporter=spec --test-name-pattern='transient-final-attempt' tests/agent/alexa-voc-multi-asin-recovery.test.ts
```

Both adapters initially returned B `failure` instead of `success` (2 tests, 0 pass, 2 fail). The fixture exhausts three actual fake-provider transient requests, then fails B's failure-terminal persistence so the worker naturally enters `failJob` and allocates a retry-new-cycle successor. The corrected first lease of attempt2/max2 invokes B once successfully (B total4, A total1); 2/2 GREEN. A plain transient without terminal-write failure follows the existing handler's terminal-completion behavior; this task does not redefine it.

## Coverage and verification

Final recovery command is the initial command above, now with 15 scenarios per adapter. PostgreSQL uses the actual `startPostgresTestContainer` helper, isolated schemas and migrations, not SQL mocks. Scenarios cover publication before commit, lost acknowledgement after commit, failed-job and expired-lease claims, at-limit replay, absent/pending siblings, permanent failure, budget, cancellation, publication exhaustion, valid final attempts in same/new logical cycles, and explicitly enqueued C during old publication recovery. Assertions include exact calls/revisions/terminals, claim recovery, job finality, API no-pending readback, unique cumulative snapshot counts, stale-owner rejection and malformed/duplicate identity rejection from real loaded records.

Final result: **30/30 PASS**, 0 failed/canceled/skipped, `duration_ms 54264.6452`, exit 0. This includes the final generation-predecessor correction and formatted test source.

Cancellation's four cases are **audit-seeded cancellation recovery fixtures**: real fenced begin/finalize construct a canceled durable audit before the real runner reads it. They do not test a live user cancellation signal. Expired cases simulate **lost failure settlement followed by a genuinely expired lease**; no process was killed/restarted. Pending cases fail the real audit-finalization write. The first job's maxAttempts is adjusted only as initial test setup; no failed status is injected.

Compatibility command (coordinator independently reran these seven files):

```powershell
node --conditions=react-server --import tsx --test --test-reporter=spec tests/agent/alexa-voc-normalization-worker.test.ts tests/agent/alexa-voc-normalization-attempts-contract.test.ts tests/agent/manual-alexa-voc-sqlite-repository.test.ts tests/agent/postgres-manual-alexa-voc-store-unit.test.ts tests/agent/postgres-manual-alexa-voc-store.test.ts tests/agent/postgres-job-repository.test.ts tests/agent/worker-loop.test.ts
```

Result: **85/85 PASS**, 0 failed/skipped/canceled, 45.2 seconds. This was before the final one-line generation-predecessor fix, covered by the final recovery suite. An intermediate new regression in PostgreSQL exhausted-no-audit queue recovery was fixed and this existing assertion passed in the 85-test rerun.

Additional implementation-agent command:

```powershell
node --conditions=react-server --import tsx --test --test-reporter=spec tests/agent/agent-run-repository.test.ts
```

Result: 30 tests, 25 pass, 5 fail, matching coordinator's unchanged `9b1f690` baseline exactly: lease-expiry successor missing rejection (line701); model-ledger stale claim authority lost; one active audit duplicate ID versus expected conflict (1575); begin relationship/fingerprint drift duplicate ID (2139); job-attempt usage missing agentRunId (2670). No unrelated audit contract tests were repaired. Coordinator separately established the sixth old failure in `agent-run-service.test.ts:384` (successful audit restart/drift missing conflict; audited service plus budget-contract group 24/25).

Changed-file ESLint command:

```powershell
npx eslint server/domain/voc/alexa-voc-recovery.ts server/db/postgres/job-store.ts server/db/postgres/manual-alexa-voc-store.ts server/db/sqlite-repository.ts server/runtime/alexa-voc-normalization-runtime.ts server/services/alexa-voc-normalization-worker-handler.ts tests/agent/alexa-voc-multi-asin-recovery.test.ts tests/agent/postgres-manual-alexa-voc-store-unit.test.ts
git diff --check
```

Both exit 0; ESLint emitted no diagnostics. The coordinator's intermediate production build passed (no service started), and latest TypeScript comparison returned to the unchanged baseline of 343 diagnostics, with zero exact changed-file diagnostics. Final locked-source build/comparison belongs to the coordinator.

Warnings: Node experimental SQLite warning is expected. This regression newly exposed a PostgreSQL concurrent-query deprecation warning, traced with `--trace-deprecation` to unchanged `server/db/postgres/agent-run-store.ts` Promise.all query mapping (579/778). It was not independently reproduced on the old baseline, so it is **not** called an old baseline warning. It was neither suppressed nor expanded into an unrelated repair.

## Owned files and scope

Production: `server/domain/voc/alexa-voc-recovery.ts`; `server/db/postgres/job-store.ts`; `server/db/postgres/manual-alexa-voc-store.ts`; `server/db/sqlite-repository.ts`; `server/runtime/alexa-voc-normalization-runtime.ts`; `server/services/alexa-voc-normalization-worker-handler.ts`.

Tests: `tests/agent/alexa-voc-multi-asin-recovery.test.ts`; `tests/agent/postgres-manual-alexa-voc-store-unit.test.ts`. Report: this file.

No migration, global retry limit, public repository/API signature, ordinary-stage audit semantics or UI changes. No live provider, formal database, historical input replay, service restart, artifact activation, merge, push or deployment. Coordinator-owned progress/final report, historical task reports and unrelated `test-results/` are excluded from the implementation commit.

## Review follow-up: terminal reference provenance

Review of `eed1f3d` identified that terminal values were validated but their referenced job/audit associations were not. The read-only terminal query now LEFT JOINs terminal job/stage plus source audit/job/stage, linked snapshot, organization and skill identity. Reduction rejects a wrong-stage/run job, wrong audit, fingerprint/ASIN/organization mismatch, invalid single-input linkage or non-normalization provenance. Failure with a nonnull audit must reference that terminal's exact job/run/stage/input and a failed audit; null-audit failures remain allowed.

Success provenance deliberately permits a prior run/project/logical cycle in the same organization with matching marketplace/ASIN/fingerprint. The guard checks the normalization skill ID, not today's version/hash, so immutable historical successful terminals do not become invalid after a skill upgrade. Existing new-replay selection retains its own current-version/cutoff rules unchanged.

RED and focused GREEN command:

```powershell
node --conditions=react-server --import tsx --test --test-reporter=spec --test-name-pattern='two-ASIN publication recovery' tests/agent/alexa-voc-multi-asin-recovery.test.ts
```

Before the guard, both real-database-loaded corruption fixtures failed with `AssertionError: Missing expected exception` (2 tests, 0 pass, 2 fail). After the guard, 2/2 passed. The same cases also create a second real project/run, queue the same fingerprint and write a legitimate success through `putNormalizationTerminal` referencing A's original audit; the reducer accepts completion-only, while altered source organization/ASIN are rejected. Tests do not force job failures or mutate real production data.

Follow-up full covering command:

```powershell
node --conditions=react-server --import tsx --test --test-reporter=spec tests/agent/alexa-voc-multi-asin-recovery.test.ts tests/agent/manual-alexa-voc-sqlite-repository.test.ts tests/agent/postgres-manual-alexa-voc-store.test.ts tests/agent/postgres-manual-alexa-voc-store-unit.test.ts
npx eslint server/domain/voc/alexa-voc-recovery.ts tests/agent/alexa-voc-multi-asin-recovery.test.ts
git diff --check
```

Result: **75/75 PASS**, 0 failed/canceled/skipped, `duration_ms 59527.9479`, exit 0 (30 recovery + 45 manual-store/unit cases). ESLint and diff check exit 0. The SQLite experimental warning and previously documented newly exposed PostgreSQL concurrent-query deprecation remain visible. Only the helper, recovery test and this report belong to the follow-up commit.

## Joint-review follow-up: completed failure in an automatic sibling retry

Fix base: `5bc0bb4b4f3598776a267514398263f67545079b`. The new `permanent-sibling-final-attempt` scenario makes A's fake provider permanently fail once and durably records A's failed audit/terminal. B exhausts its three transient provider calls, then the exact B failure-terminal write throws. The real worker persists failure and claims a bounded retry-new-cycle successor. No failed job status is injected.

RED command, before production changes:

```powershell
node --conditions=react-server --import tsx --test --test-reporter=spec --test-name-pattern='permanent-sibling-final-attempt' tests/agent/alexa-voc-multi-asin-recovery.test.ts
```

Both adapters reproduced the review finding: `actual { B0NORM0001: 2, B0NORM0002: 4 }`, `expected { B0NORM0001: 1, B0NORM0002: 4 }`; 2 tests, 0 pass, 2 fail, `duration_ms 7724.9025`. The same focused command after the correction and explicit-retry positive case passed 2/2, `duration_ms 7839.5299`.

The existing `retryCycleStartAttempt` is the automatic-chain boundary: SQLite and PostgreSQL automatic successors copy it, even when a transient failure creates another logical cycle; explicit normalization enqueue starts it at the new attempt number. Runtime and reducer now both accept completed failure terminals only from a trusted same-stage job with that same retry-chain start and attempt number within `[retryCycleStartAttempt, currentAttemptNumber]`. Existing terminal job/audit provenance validation precedes reduction. Success replay is unchanged. The PostgreSQL queue candidate merely maps this existing field into the internal recovery fact type; there is no database state-machine/schema or public API change.

The regression asserts A=1/B=4 after automatic recovery, exactly one original A failure terminal, no A revision, final A=failure/B=success readback and succeeded job/stage. It then calls the existing same-input queue entry, verifies a genuinely new retry-chain boundary and runs another real fixture runtime: A succeeds on its second total provider call, B remains at four calls with one terminal and revision1, A's old failure is preserved alongside the new success, and A receives its first revision. This is explicit authorization, not a blanket ban on retrying historical failures.

Full covering command:

```powershell
node --conditions=react-server --import tsx --test --test-reporter=spec tests/agent/alexa-voc-multi-asin-recovery.test.ts tests/agent/alexa-voc-normalization-worker.test.ts tests/agent/alexa-voc-normalization-attempts-contract.test.ts tests/agent/postgres-manual-alexa-voc-store.test.ts
npx eslint server/runtime/alexa-voc-normalization-runtime.ts server/domain/voc/alexa-voc-recovery.ts server/db/postgres/manual-alexa-voc-store.ts tests/agent/alexa-voc-multi-asin-recovery.test.ts
git diff --check
```

Full result: **63/63 PASS**, 0 failed/canceled/skipped, `duration_ms 64192.1182`, exit 0 (32 recovery scenarios plus 31 worker/attempt/PostgreSQL-store cases). Changed-file ESLint and diff check exit 0. The known visible SQLite experimental/PG concurrent-query warnings are not suppressed. Files changed: runtime snapshot selection/helper, pure recovery reducer and internal job fact type, PostgreSQL candidate field mapping, recovery test, and this report. No unrelated old audit tests, formal database/provider access, live service restart, global limits, UI, merge/push/deploy or parallel worktree changes.
