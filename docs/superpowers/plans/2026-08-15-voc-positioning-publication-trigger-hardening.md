# VOC Positioning Publication Trigger Hardening Plan

**Goal:** Close SQLite three-valued-logic and trigger-list holes so publication recovery is durable, bounded and not raw-SQL promotable.

**Architecture:** Keep the approved 0006 publication fields on `job_attempts`. Replace the partial trigger predicates with one closed row-state predicate using explicit `IS NULL`, `typeof(...)` and canonical UTC checks; have the update trigger observe status and retryable as well as publication fields. The repository claim query independently requires a complete, non-exhausted, due policy before reclaiming report-only work.

## Constraints

- Only 0006 may change; 0001–0005, package lock and generated VOC data stay unchanged.
- Keep 8.3 unchecked until all gates pass; 8.4/8.5 remain unchecked.
- Use raw migrated SQLite RED tests, then normal repository/Worker integration tests.
- Make one sixth non-amend commit only; no push, merge, rebase or stash.

### Task 1: Raw migrated database RED

- [ ] Add one real migration test that tries NULL-policy future retry, status-only and retryable-only promotion, exhausted promotion, malformed timestamps, partial/wrong-type/invalid policy values.
- [ ] Run it against the current 0006 and record the expected raw SQL escape.

### Task 2: Closed 0006 publication state machine

- [ ] Replace INSERT and UPDATE checks with explicit NULL/type/canonical-time predicates and include status/retryable in the UPDATE trigger list.
- [ ] Preserve legal pre-policy legacy rows and all valid repository transitions; add DELETE/cascade/index/upgrade coverage.
- [ ] Require complete policy, `count < max`, a canonical due retry timestamp and durable report-only facts in the claim path.

### Task 3: GREEN and requalification

- [ ] Run raw SQL, migration, publication, typed-abort, agent, skills, lint, OpenSpec, build test and TS identity gates.
- [ ] Recheck only 8.3, protected paths/diff check, make the sixth atomic commit and verify clean status.
