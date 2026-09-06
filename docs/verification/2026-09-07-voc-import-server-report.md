# VOC import server queue, status, and publication verification

## Scope

- Queue reuse now matches claim eligibility: only the latest attempt can be reused, and a retryable failed attempt must have no scheduled successor marker.
- PostgreSQL and SQLite status reads use the latest attempt, preserve live retry as pending, report exhausted missing-terminal work as failure, and remain exact-run/latest-fingerprint scoped.
- PostgreSQL migration 0027 permits schema-valid empty VOC dimensions while enforcing 256-item and 16,384-character bounds and preserving non-string rejection.
- The stale committed-normalization PostgreSQL mock now supplies `agent_run_id` and the cutoff argument expected by the durable replay query.

## TDD evidence

RED:

- `npx tsx --conditions=react-server --test tests/agent/postgres-manual-alexa-voc-store-unit.test.ts` — 2 passed, 2 failed on the missing claim-eligibility and latest-retry SQL predicates.
- `npx tsx --conditions=react-server --test --test-name-pattern="publishes a schema-valid VOC snapshot with an empty Alexa dimension" tests/agent/postgres-manual-alexa-voc-store.test.ts` — 0 passed, 1 failed with `DataSnapshotDataError` from the PostgreSQL snapshot trigger.

GREEN:

- Focused PostgreSQL publication and stale replay fixture: 2/2 passed.
- PostgreSQL queue/status unit suite: 4/4 passed.
- Focused SQLite queue/status regressions: 2/2 passed.
- Full SQLite repository suite before the final latest-only predicate tightening: 20/20 passed.
- PostgreSQL fresh/reentrant and concurrent migration checks: 2/2 passed.
- Combined repository run before stale fixture correction: 43/44 passed; the only failure was the known missing `agent_run_id` fixture, whose focused rerun passed after correction.

The root integrator owns the final full server suite and browser/build verification.

## Review follow-up

- RED: the PostgreSQL queue unit rejected reuse SQL that did not distinguish at-max durable recovery from exhausted no-artifact work; the new SQLite durable-recovery fixture also initially created replacement work.
- `npx tsx --conditions=react-server --test tests/agent/manual-alexa-voc-sqlite-repository.test.ts tests/agent/postgres-manual-alexa-voc-store.test.ts tests/agent/postgres-manual-alexa-voc-store-unit.test.ts` — 45/45 passed.
- `npx tsx --conditions=react-server --test --test-name-pattern="migrate a fresh database once|concurrent PostgreSQL migration runners|0027 upgrades legacy empty dimensions" tests/agent/postgres-migrations.test.ts` — 3/3 passed.
- Real PostgreSQL coverage now verifies missing-terminal exhaustion, terminal failure with superseded retry history, durable at-max report-only recovery, final exhaustion, new-fingerprint pending state, tenant isolation, and exact revision provenance.
- The 0019-to-0026 fixture proves the 0020 trigger rejects cumulative publication containing a stored empty-negative legacy revision before applying 0027; after upgrade the old empty dimension and nonempty sibling publish unchanged, while non-string, 16,385-character, and 257-item dimensions remain rejected.
- Targeted ESLint completed with 0 errors and 0 warnings; `git diff --check` completed successfully.
