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

## Review fix: fail-closed storage errors and post-write rollback

The review fix is based on Task 8 commit
`ecbb26ebf47cd6d8581d75d2ff6887aa3e4e9833` and is a separate, non-amended
commit.

Review RED was observed before the fix:

1. A representative transaction-store failure escaped the analysis-run route
   as HTTP 500 instead of the required typed 503.
2. Real SQLite and PostgreSQL transactions did roll database rows back after
   injected post-write failures, but non-manual run/stage/job/snapshot and
   idempotency-completion errors escaped without the stable service boundary.

Review GREEN behavior:

- `createRunWithVocSnapshot` preserves existing typed lifecycle errors and
  `IDEMPOTENCY_KEY_REUSED`; trusted snapshot subject/cutoff/content conflicts
  remain 409. Every other run-creation storage/connection/permission/schema/
  transaction error becomes stable 503 `INFRASTRUCTURE_ERROR` with message
  `Analysis run storage is unavailable` and no database detail.
- Snapshot repository data/integrity failures no longer collapse into a false
  409 business conflict; they reach the run service's fail-closed 503 boundary.
- Tests inject faults only through test-owned repository decorators, after the
  real `run`, `stage`, `job`, `snapshot`, and idempotency `completion` writes.
  No production fault switch or unsafe runtime hook was added.
- For every fault phase in both real SQLite and real PostgreSQL transactions,
  `runs=0`, `stages=0`, `jobs=0`, `snapshots=0`, and idempotency
  claim/completion rows `=0` after failure. The pre-existing manual VOC head
  tuple remains byte-for-byte unchanged. Retrying the same key succeeds with
  exactly one run, three stages, two initial jobs, one snapshot, and one
  completed idempotency binding.

## Final verification

Focused plan plus snapshot regression:

```powershell
npx tsx --conditions=react-server --test tests/agent/contracts.test.ts tests/agent/analysis-run-lifecycle.test.ts tests/agent/manual-alexa-voc-run-atomicity.test.ts tests/agent/postgres-analysis-run-lifecycle-store.test.ts tests/agent/voc-data-snapshot-service.test.ts
```

Result: exit 0; 70 passed, 0 failed.

Dual-database repository, route, migration, and provenance regression:

```powershell
npx tsx --conditions=react-server --test tests/agent/manual-alexa-voc-sqlite-repository.test.ts tests/agent/postgres-manual-alexa-voc-store.test.ts tests/agent/sqlite-migrations.test.ts tests/agent/postgres-migrations.test.ts tests/agent/manual-alexa-voc-routes.test.ts tests/agent/postgres-data-snapshot-repository.test.ts tests/agent/data-snapshot-repository.test.ts
```

Result: exit 0; 101 passed, 0 failed.

Targeted lint:

```powershell
npx eslint server/services/analysis-run-service.ts server/services/voc-data-snapshot-service.ts tests/agent/analysis-run-lifecycle.test.ts tests/agent/manual-alexa-voc-run-atomicity.test.ts
```

Result: exit 0; no errors or warnings.

Repository TypeScript status:

```powershell
npx tsc --noEmit --incremental false --pretty false
```

The repository-wide command remains non-zero with 303 pre-existing unrelated
diagnostics in the existing app/runtime/test WIP. The two modified production
files and the atomicity test have zero diagnostics. The existing lifecycle
route test file still has its same 10 repository-fixture diagnostics; the new
typed-503 route test introduces none. The command used `--incremental false`,
so it did not modify `tsconfig.tsbuildinfo`.

## Preserved user WIP

The pre-existing `.superpowers/sdd/task-3-report.md`, generated `app/*-data.ts`
and related app data changes, `data/alexa-publication-*`, and untracked
`data/projects/*.json` files were not edited for Task 8 and are excluded from
staging. The branch was already 70 commits ahead of its upstream at start; no
history rewrite, amend, push, clean, stash, reset, or broad add was performed.

The review-start and review-end protected-WIP manifests both contain exactly
37 paths. Every per-file SHA-256 is identical. The canonical sorted
`status|path|sha256` manifest hash is
`5e4d7280d88acdb82e54269e279cf277f0a48b8e8ba17c884ebc3cac3b344305`.
The protected manifest is:

```text
M .superpowers/sdd/task-3-report.md
M app/competitor-data.ts
M app/listing-image-remarks.ts
M app/rufus-voc-data.ts
M app/sif-keyword-analysis-data.ts
M app/sif-keyword-enrichment-data.ts
M app/sif-listing-traffic-raw-data.ts
M app/sif-monthly-traffic-trend-raw-data.ts
M app/sorftime-category-trend-data.ts
M app/sorftime-child-sales-data.ts
M app/sorftime-fba-fee-data.ts
M app/sorftime-listing-content-data.ts
M app/sorftime-price-strategy-data.ts
M app/sorftime-rating-data.ts
M app/sorftime-review-analysis-data.ts
M app/sorftime-sales-trend-data.ts
M app/variant-data.ts
?? data/alexa-publication-snapshots/generation-1-45b8fe32670ea8d83c5a1774a9878230ba5a54e461ceef6cb0399ccfcf6471f6.ts
?? data/alexa-publication-snapshots/generation-2-96725ffd0d8acad926266220472de1c25ec779d51f7cbcdc08ca0bd219ec0c0d.ts
?? data/alexa-publication-state.json
?? data/projects/34020241-202f-43b0-ac11-3d6ec44c033c.json
?? data/projects/3655cd71-3843-49b7-8866-ec672e2e124d.json
?? data/projects/3d276dc8-d86c-4f28-8537-e9a81a1fd481.json
?? data/projects/3ff97b52-5ce7-46af-8a1a-053e16da10fe.json
?? data/projects/4d49aafa-029d-41b2-a101-c8891048f857.json
?? data/projects/610145a7-9729-493b-9e51-27b2dd87507c.json
?? data/projects/6fd7f9e2-26ec-4d67-a39f-23ca2a44bc72.json
?? data/projects/7249c16c-db24-425e-9000-854ba6c869ca.json
?? data/projects/737bfbc7-bb86-4a8b-b421-e0ca19186334.json
?? data/projects/782c6b53-44d8-428e-9d15-6370ba017131.json
?? data/projects/9839ffce-cf26-4c8e-ad08-cc99af3d60fa.json
?? data/projects/a0478af8-27d4-4970-a6db-2a90eda4a54b.json
?? data/projects/a081d838-ffcb-4e36-b4ad-e38937f7336a.json
?? data/projects/cc5777f3-54d0-441e-a489-ba5236f02719.json
?? data/projects/d13fe609-1c4d-4f48-b4d6-afee7aceb5de.json
?? data/projects/d47d71a0-c00c-4632-a9c8-855e55bbbbdb.json
?? data/projects/deae416a-8726-4afd-a6d3-71fe2b016c03.json
```

The review fix commit diff contains none of these paths.

## Commit

The Task 8 paths are committed with message:
`feat: atomically snapshot manual voc runs`.

The review fix is committed separately with message:
`fix: fail closed on atomic run storage errors`.
