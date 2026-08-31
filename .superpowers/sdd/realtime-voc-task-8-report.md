# Realtime Manual Alexa VOC Task 8 Report

## Scope and baseline

- Worktree: `C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\stabilize-resumable-sync-pipeline`
- Fixed baseline / starting HEAD: `e8272b4c21bda58c5e9ef68529b4c3cf4b3c00fe`
- Branch: `codex/stabilize-resumable-sync-pipeline`
- Repository `AGENTS.md`: none found.
- Baseline focused suite before Task 8 changes: 59 tests passed, 0 failed.
- No live server, browser, Chrome profile, provider, or production port was used.

## TDD evidence

The complete original brief is preserved in
`.superpowers/sdd/realtime-voc-task-8-brief.md`; focused RED evidence is
preserved in `.superpowers/sdd/realtime-voc-task-8-red.md`.

RED was observed before implementation:

1. The SQLite atomicity test failed with
   `TypeError: lifecycle.createRunWithVocSnapshot is not a function`.
2. The strict request contract test failed because a caller-supplied
   `dataCutoffAt` was still accepted (`true !== false`).

## Implemented behavior

- `CreateRunRequestSchema` is strict and no longer contains
  `dataCutoffAt`; route requests that inject it return a contract-safe 400
  without creating a run.
- The authenticated route calls `createRunWithVocSnapshot` with its actual
  `RequestPrincipal` and then reads the committed aggregate.
- One authoritative repository transaction now validates actor/project/org,
  claims `(organizationId, idempotencyKey)`, locks sorted ASIN scopes, reads
  the database clock once, selects Task 7 revisions at that cutoff, and
  creates the run, stages, initial jobs, VOC snapshot, and replay binding.
- The persisted fingerprint contains only project, mode, and immutable
  organization/marketplace/ordered-ASIN scope. It excludes run ID, snapshot
  ID, cutoff, and generated timestamps.
- Same-key/same-fingerprint callers replay the original run, cutoff, snapshot,
  stages, and jobs before any second clock/source read. Same-key/different-
  fingerprint callers receive 409 `IDEMPOTENCY_KEY_REUSED`.
- SQLite uses its existing write transaction serialization; PostgreSQL uses
  the org+key advisory lock. Concurrent PostgreSQL callers produce one winner
  and one replay with exactly one clock read and one source read.
- Legacy core-store rows are adapted only when one unambiguous run and one VOC
  snapshot reconstruct the same fingerprint; ambiguous or mismatched rows
  conflict instead of creating a second run.
- The shared snapshot persistence helper accepts an already-selected candidate
  so atomic run creation binds snapshot `dataCutoffAt` and `createdAt` to the
  same database clock.
- PostgreSQL transaction error classification now recognizes only actual
  five-character SQLSTATE/connection codes, preventing
  `IDEMPOTENCY_KEY_REUSED` from being misclassified as a storage outage.
- Manual repository/source failure returns 503 and rolls back; no run or
  snapshot is fabricated and no static fallback is attempted. Mismatched
  session/org principals are rejected before source work.
- Task 7 per-ASIN revision/content-hash provenance and migration 0020 snapshot
  validation remain active.

## Atomicity and replay results

- SQLite: run, exact server DB cutoff, three stages, two runnable jobs, and one
  immutable VOC snapshot commit together; sequential replay is byte-for-byte
  equal and does not call clock/source again.
- PostgreSQL import-first barrier: a revision committed before the run obtains
  the shared scope lock is selected into that run's snapshot.
- PostgreSQL run-first barrier: once the run fixes its cutoff, a blocked import
  is excluded until the next run; the first snapshot remains unchanged.
- PostgreSQL concurrent replay: two connections using the same org/key/scope
  return the same run and snapshot; a different project using that key receives
  `IDEMPOTENCY_KEY_REUSED`.
- Organization isolation: identical keys in different organizations remain
  independent; same-organization immutable-scope changes conflict.

## Final verification

Focused plan plus snapshot regression:

```powershell
npx tsx --conditions=react-server --test tests/agent/contracts.test.ts tests/agent/analysis-run-lifecycle.test.ts tests/agent/manual-alexa-voc-run-atomicity.test.ts tests/agent/postgres-analysis-run-lifecycle-store.test.ts tests/agent/voc-data-snapshot-service.test.ts
```

Result: exit 0; 67 passed, 0 failed.

Dual-database repository, route, migration, and provenance regression:

```powershell
npx tsx --conditions=react-server --test tests/agent/manual-alexa-voc-sqlite-repository.test.ts tests/agent/postgres-manual-alexa-voc-store.test.ts tests/agent/sqlite-migrations.test.ts tests/agent/postgres-migrations.test.ts tests/agent/manual-alexa-voc-routes.test.ts
```

Result: exit 0; 82 passed, 0 failed.

Targeted lint:

```powershell
npx eslint shared/agent-contracts.ts server/db/manual-alexa-voc-repository.ts server/db/sqlite-repository.ts server/db/postgres/manual-alexa-voc-store.ts server/services/analysis-run-service.ts server/services/voc-data-snapshot-service.ts server/routes/analysis-runs.ts tests/agent/contracts.test.ts tests/agent/analysis-run-lifecycle.test.ts tests/agent/manual-alexa-voc-run-atomicity.test.ts
```

Result: exit 0; no errors or warnings.

Repository TypeScript status:

```powershell
npx tsc --noEmit --incremental false --pretty false
```

The repository-wide command remains non-zero with 303 pre-existing unrelated
diagnostics in the existing app/runtime/test WIP. A diagnostic filter over all
Task 8 production paths and the new Task 8 contract/atomicity tests reports
`task_production_diagnostics=0` and `task_new_test_diagnostics=0`. No Task 8
production or newly created test file has a TypeScript diagnostic. The
generated `tsconfig.tsbuildinfo` change from the first diagnostic run was
restored and is not part of the worktree delta.

## Preserved user WIP

The pre-existing `.superpowers/sdd/task-3-report.md`, generated `app/*-data.ts`
and related app data changes, `data/alexa-publication-*`, and untracked
`data/projects/*.json` files were not edited for Task 8 and are excluded from
staging. The branch was already 70 commits ahead of its upstream at start; no
history rewrite, amend, push, clean, stash, reset, or broad add was performed.

## Commit

The Task 8 paths are committed with message:
`feat: atomically snapshot manual voc runs`.
