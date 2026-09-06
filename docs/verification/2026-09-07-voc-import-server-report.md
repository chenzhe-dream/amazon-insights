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
