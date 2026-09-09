# VOC queue timeout audit and release hold — 2026-09-09

## Scope and outcome

User authorized cancelling run `c39a954a-7dc1-49ba-be86-07387731814b`, checking the VOC timeout, then publishing the previously validated SIF repair. This audit found a separate existing VOC retry-queue defect. Release is held; no formal integration, restart, task cancellation, database write, Provider request, or data deletion was performed during this audit.

Formal source remains `fff8c3ec097ab52c5a8f74eb278a2558ac6b7981` in `integrate-xydc-variant-20260905`. Existing 15 dirty generated files remain present and unstaged. Formal Web/Agent health is OK; Web artifact remains `d8a62ee5ec5717e30f75c4b35f9c122c47844729b5397da4aa03b87b032a82f9`.

## Timeout coverage

- Current formal configuration parses successfully. `model.timeoutMs = 300000` (5 minutes), lease 120 seconds, heartbeat 30 seconds.
- `server/runtime/skill-runner.ts:1353` starts the timeout around an individual Provider call. It does not bound queued waiting or the entire analysis run.
- `server/db/postgres/job-store.ts:147` selects due queued, retryable failed, or lease-expired running attempts. It has no queued-wait deadline.
- Current attempt `3a6a1855-2fe4-4456-9781-60c79697f72a` has remained queued since `2026-09-09T05:59:05.229Z`; `started_at`, `leased_by`, and `lease_expires_at` are null; lease generation is 0. It has never reached model execution.
- This is the `voc-positioning` worker, not Alexa report normalization. Their timeout/recovery behavior must not be conflated.

## Verified blocking candidate

The exact claim predicate and ordering, evaluated as a SELECT without row locks in a read-only PostgreSQL session, returns these candidates in order:

1. Old run `78d7af51-37d4-4609-85c1-cd33cfd9b9b4`, stage `a7b56c85-da58-4cb8-98b2-2284d1daadd4`, attempt `75ccf90b-53f1-4048-a1b0-1d29cb2881fe`, number 1, failed, retryable, `retry_scheduled_at = null`, available `2026-09-03T07:47:30.290Z`.
2. The same old stage already has attempt `7620d818-9a7a-41cf-b945-e9f9374f3e46`, number 2, failed and retryable.
3. The current queued attempt above.

Both old AgentRun terminal metadata records validate as failed/upstream-temporary. The stored attempt mapping succeeds. No unfinished AgentRun was found. A database activity snapshot showed no lock wait; that snapshot alone is not proof against every possible runtime wait.

The actual `PostgresJobStore.claimNextJob` control flow was exercised with a read-only shadow query adapter: SELECTs went to a connection with `default_transaction_read_only=on`, row locks were removed, and **all writes were intercepted rather than executed**. The predecessor scheduling UPDATE was simulated only in the adapter; the subsequent INSERT was intercepted and checked with a SELECT. It would insert attempt number 2, which already exists.

Consequently:

- `server/db/migrations/postgres/0001_agent_runtime.sql:122` enforces `UNIQUE(stage_id, attempt_number)`.
- `server/db/postgres/job-store.ts:250` marks the predecessor scheduled, then unconditionally inserts `attemptNumber + 1` in that same transaction.
- The duplicate successor would produce PostgreSQL 23505. `server/db/postgres/query-context.ts:51` rolls back the transaction, restoring the predecessor scheduling marker to null.
- `server/runtime/worker-loop.ts:136` catches claim errors and repeats polling. The same earliest failed predecessor remains eligible, starving the new queued task.

No live INSERT/UPDATE or intentionally failing live claim was executed to demonstrate the constraint. The conclusion combines current database values, the read-only control-flow probe, and the verified constraint/transaction code. An independent reviewer confirmed the causal chain.

## Fresh tests

Executed on the unchanged formal source:

```text
npx --no-install tsx --conditions=react-server --test --test-name-pattern='timeout|timed out|queued when runtime config|cancel' tests/agent/skill-runner.test.ts tests/agent/voc-positioning-runtime.test.ts tests/agent/worker-loop.test.ts
```

Result: 6 tests, 6 passed, 0 failed, 0 skipped. This verifies current timeout/cancellation behavior, not a repair for the newly found starvation defect.

## Cancellation and release boundaries

- The intended normal operation is authenticated `POST /api/agent/v1/runs/c39a954a-7dc1-49ba-be86-07387731814b/cancel` with `{}`.
- Existing browser control could list the local application tab, but selecting it returned `Debugger unattached`; a new controlled tab timed out. CLI auto-connect found no debugging-enabled Chrome. No authenticated cancellation request was submitted, no session was forged, and no direct SQL cancellation was substituted. User was asked to keep the application open and accept the browser connection prompt.
- Cancelling only the current run cannot repair the earlier failed candidate. Even cancelling the old run is not an established fix: existing cancellation updates queued/running attempts, not failed/retryable attempts; current claim does not exclude a cancelled parent run.
- Candidate SIF changes do not modify this server/runtime path. Do not publish them under a claim that VOC has recovered.

## Required decision before continuing

Request authorization to repair this separate retry-queue defect and validate it before release. Preserve all existing attempts, runs, snapshots, audit records, and reports. Do not delete the existing successor, loosen unique constraints, use arbitrary higher attempt numbers, or bypass release gates.

Future repair acceptance should cover existing-successor identity/lineage, idempotent predecessor scheduling, cancellation exclusion, bounded waiting/observable claim failures, retry/budget/lease invariants, and SQLite/PostgreSQL consistency. These are recommendations, not approved implementation or completed fixes.
