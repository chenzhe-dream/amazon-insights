# Realtime Manual Alexa VOC Task 5 Report

## Status

Task 5 PostgreSQL repository implementation is complete. The dedicated Task 5
suite is green. The exact combined brief gate remains blocked by one pre-existing
`postgres-core-repository` managed-credential assertion, and the full repository
TypeScript gate remains blocked by pre-existing worktree errors outside the Task 5
files. No Task 5 type errors were present in the full compiler output.

The commit identifier is reported in the agent handoff because this report is part
of that commit.

## Scope

- Added the production PostgreSQL `manualAlexaVoc` store for all 15 canonical Task
  4 methods.
- Added the focused `ManualAlexaVocRepositoryCapability` and included it in
  `RuntimeAgentRepository` without widening `AgentRepository`.
- Bound the store to `PostgresAgentRepository` and reused its transaction context.
- Added real PostgreSQL integration coverage plus typed executor fixtures.
- Did not modify Web, service, provider, Chrome, migration, or live-database code.

## RED

Initial command:

```text
npx tsx --conditions=react-server --test tests/agent/postgres-manual-alexa-voc-store.test.ts
```

Result: exit 1. The test loader failed with `ERR_MODULE_NOT_FOUND` for
`server/db/postgres/manual-alexa-voc-store`, proving the new repository binding did
not exist before production implementation.

A later focused RED cycle covered exhausted revision/head uniqueness conflicts:
the fixture expected `conflict` but initially received `schema`. After the minimal
constraint-name mapping, the focused test passed while an unknown constraint still
maps to `schema`.

## GREEN

Dedicated Task 5 command:

```text
npx tsx --conditions=react-server --test tests/agent/postgres-manual-alexa-voc-store.test.ts
```

Result: exit 0, 10 passed, 0 failed.

Additional facade regression:

```text
npx tsx --conditions=react-server --test tests/agent/postgres-runtime-repository.test.ts
```

The two PostgreSQL runtime-facade tests passed. A combined run with
`runtime-repository-contract.test.ts` had one unrelated compile-contract failure
caused by existing errors in `server/services/sif-traffic-snapshot-task.ts`; the
non-SQLite runtime stub test passed.

Targeted lint:

```text
npx eslint server/db/repository.ts server/db/postgres/manual-alexa-voc-store.ts server/db/postgres-repository.ts tests/agent/postgres-manual-alexa-voc-store.test.ts
```

Result: exit 0 after removing one unused test-only type import.

## Required gate blockers

The exact combined test command ran all Task 5 tests successfully but finished
20/21 on its first run and 21/22 after the added conflict fixture. The sole failure
was the existing test:

```text
PostgreSQL managed credential service rotates dynamically and tombstones environment fallback
tests/agent/postgres-core-repository.test.ts:625
actual true, expected false
```

The same core test failed when rerun alone. It constructs `PostgresCoreStore`
directly and does not pass through the new Manual VOC store or facade binding.

`npx tsc --noEmit` also exits non-zero because the dirty worktree already contains
many unrelated errors, including duplicate object keys in the modified
`app/competitor-data.ts` and existing server/test contract errors. Filtering the
complete compiler output for the four Task 5 source/test files reported zero Task
5 type errors. The generated `tsconfig.tsbuildinfo` change was restored afterward.

## PostgreSQL isolation

- Tests use `postgres:16-alpine` through the repository's test-container helper.
- The container binds only to an ephemeral loopback port and is removed with its
  volumes by the test after-hook.
- Every integration test creates a random isolated PostgreSQL schema and runs
  migrations only in that schema.
- Typed failure tests use an in-process structural query executor; they do not use
  environment database settings.
- No live database, application service, provider, browser, or credential was read
  or changed.

## Locking and concurrency

- Scope locks are acquired in canonical sorted ASIN order and include organization,
  marketplace, and ASIN.
- PostgreSQL text cannot carry a NUL byte. The logical
  `manual-voc\0organization\0marketplace\0asin` key is therefore transmitted as
  `bytea`, hex-encoded server-side, then passed to `hashtextextended` before
  `pg_advisory_xact_lock`. This preserves the unambiguous logical key while avoiding
  PostgreSQL's `invalid byte sequence for encoding UTF8: 0x00` protocol failure.
- Opposite-order two-ASIN transactions completed without deadlock.
- Independent repository connections serialized different-hash writers to
  revisions `1` and `2`; tenant isolation and one outbox record for the current head
  were verified.
- Transaction rollback, expected-revision conflict, head tuple foreign key/CAS,
  cross-organization actor rejection, and the actor composite foreign key were
  verified.

## Behavior coverage

- `clock_timestamp()` serialized to an exact UTC `Z` string.
- Revisions larger than `Number.MAX_SAFE_INTEGER` round-trip as decimal text.
- Current and cutoff reads preserve tenant/ASIN scope and do not turn typed failures
  into empty results.
- Same-head hashes are idempotent; missing and failed outbox rows are repaired.
- Different head hashes create new revisions.
- `ECONN*`/class 08, `57014`, `42501`, undefined table/column, constraint drift,
  malformed stored records, and exhausted known revision/head conflicts map to the
  required typed repository errors.
- Publication lease, fail, retry, stale-lease rejection, apply, and reconcile paths
  are covered.
- Raw-access audit, encrypted-envelope retention clearing, and run-creation
  winner/replay/conflict paths are covered.

## Existing WIP preservation

The starting worktree contained modified Task 3/app data files and untracked Alexa
publication/project data. They were neither edited nor staged by Task 5. Only the
Task 5 source, test, repository type/binding, and this report are intended for the
Task 5 commit. No `git add .`, amend, push, provider call, or Chrome operation was
used.
