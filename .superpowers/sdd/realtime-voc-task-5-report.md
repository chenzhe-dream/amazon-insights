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

## Review-fix follow-up (2026-08-31)

### Status and files

The Critical/Important review findings against `112ad84` are fixed in a new
follow-up commit. No amend was used. The complete follow-up file set is:

- `.superpowers/sdd/realtime-voc-task-5-report.md`
- `server/db/manual-alexa-voc-repository.ts`
- `server/db/postgres/manual-alexa-voc-store.ts`
- `server/db/sqlite-repository.ts`
- `tests/agent/manual-alexa-voc-sqlite-repository.test.ts`
- `tests/agent/postgres-manual-alexa-voc-store.test.ts`

No Web, service, provider, Chrome, migration, or live-database file was changed.

### Follow-up RED

The PostgreSQL focused suite was run before implementation and failed exactly in
the new review cases: 15 total, 9 passed, 6 failed. The failures proved that the
old implementation did not replay a real first-write `23505`, invoked the callback
only once after an exhausted collision, omitted `leaseGeneration`, and allowed two
missing-row run-creation claimants to reach incompatible completion paths.

The SQLite focused suite was also run before implementation: 15 total, 13 passed,
2 failed. Both failures proved that the canonical lease and SQLite mapper omitted
`leaseGeneration` before the fencing change.

### Follow-up GREEN

The dedicated PostgreSQL and SQLite suites now pass all 30 tests. New PostgreSQL
coverage uses two independent pool/repository connections for same- and
different-fingerprint run-creation claims. It also uses a separate, intentionally
non-cooperating SQL writer and real PostgreSQL `23505` errors for same-hash replay,
different-hash revision advancement, missing-outbox repair, complete callback
rollback/replay, and the exhausted second-conflict branch.

The runtime facade plus PostgreSQL AgentRun regression passed 8/8. A scoped
TypeScript program checked seven Task 4/5 source and test files with zero
diagnostics, and targeted ESLint passed with zero findings.

The existing runtime repository contract gate remains 1/2 because of pre-existing
diagnostics confined to `server/services/sif-traffic-snapshot-task.ts`. The
additional runtime tracer's run-creation serialization case passed, while its
unrelated interrupted-lease recovery poll failed. Neither out-of-scope service was
changed. The full worktree TypeScript gate likewise remains blocked by unrelated
existing diagnostics; the scoped Task 5 type gate is green.

### Locking, rollback, and fencing

- `claimRunCreation` now obtains a transaction-scoped advisory lock derived from
  organization and idempotency key before its `SELECT ... FOR UPDATE`. A missing-row
  winner retains that lock through completion and commit, so the loser re-reads a
  durable replay or typed fingerprint conflict instead of racing the primary key.
- Known revision/head primary-key `23505` failures become a private retry marker.
  The query context rolls the entire outer transaction back, then invokes the
  caller callback once more. A second marker becomes the typed repository conflict.
- The canonical lease now carries decimal-text `leaseGeneration`. Both stores
  increment and return it on every lease, and apply/fail CAS on publication
  generation, owner, expiry, and lease generation.
- Apply/fail require both the caller's terminal timestamp and the database clock to
  be no later than the stored expiry. Tests cover ABA with the same owner,
  replacement owners, late terminal timestamps, expired-but-not-reclaimed rows,
  and backdated terminal timestamps.

### PostgreSQL isolation and concurrency

All PostgreSQL verification used the repository's disposable `postgres:16-alpine`
test container, ephemeral loopback port, and a fresh random schema per test. The
non-cooperating writer is another connection to that isolated schema. Polling for
the blocked real `23505` insert has a five-second deadline; concurrent claim tests
also have explicit timeouts. No live database, service, environment credential,
browser, or provider was read or mutated.

### Existing WIP preservation

The pre-existing modified Task 3 report/app data files and untracked Alexa
publication/project data remain present and unstaged. No `git add .`, amend, push,
generated-file inclusion, or cleanup of user WIP was performed. Only the six files
listed above are intended for the follow-up commit.
