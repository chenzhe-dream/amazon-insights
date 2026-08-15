# VOC Positioning 8.3 Review Corrections Plan

**Goal:** Make VOC positioning production-reachable, recover terminal work
across physical JobAttempts without another provider call, and make every
publishable conclusion structurally fail-closed.

**Scope:** OpenSpec 8.3 only. Keep 8.4/8.5, UI, live collection, login,
PostgreSQL, browser and external agent environments out of scope. Add no
dependency and do not modify migrations 0001-0005 or generated VOC data.

## Task 1: Preserve adversarial RED evidence

- Add isolated tests for unsafe prose, Unicode/digit/synonym variants, safety
  role downgrade and unrelated evidence substitution.
- Add a formal composition-root test reaching a succeeded stage and immutable
  report with a fake provider, then prove bounded stop.
- Add file-backed SQLite close/reopen WorkerLoop tests for terminal-before-
  report and report-before-job-completion crashes. Expire the lease, claim a new
  attempt and assert provider calls 1, report rows 1, stage succeeded.
- Add drift, stale-owner, wrong-lineage, tenant/actor and publication-failure
  tests. Each failure must be isolated from digest/hash staleness.

## Task 2: Close the output contract

- Replace model-authored conclusion/action/checklist/validation prose with
  closed enums and exact theme/evidence refs.
- Persist exact fixed decision-boundary states.
- Derive the protected safety/P0 role matrix and require evidence per protected
  referenced theme.
- Update full/partial fixtures and Skill references; turn Task 1 contract tests
  GREEN.

## Task 3: Recover stable terminal lineage

- Add forward migration 0006 for a nullable immutable lineage key and partial
  uniqueness, with clean-upgrade, bad-row and concurrency tests.
- Compute lineage from complete prepared execution identity except physical
  attempt id; retain attempt fingerprints and request usage ledger semantics.
- Validate current lease first, then return only an exact terminal predecessor.
  Never rotate a pending predecessor across attempts.
- Publish using current retry lease plus exact predecessor lineage. Classify
  operational publication failures as retryable temporary infrastructure.
- Turn both real crash-gap tests GREEN; retain old-owner and drift rejection.

## Task 4: Compose the production runtime

- Parse complete provider/model/budget/worker configuration with fixed
  fail-closed errors.
- Compose registry, provider, budget coordinator, runners, service, trusted
  prepare and WorkerLoop.
- Start and bounded-stop it from `server/index.ts` before repository close.
- Turn formal composition and ordinary Node import/execute tests GREEN.

## Task 5: Requalify and follow-up commit

- Run focused tests, full Agent tests, Skill validation, lint, strict OpenSpec,
  rendered tests, TypeScript diagnostic identity against a plain baseline
  clone, diff checks and protected-path zero-diff checks.
- Only after all gates pass, check only 8.3 and create one follow-up atomic
  commit. Do not amend, rebase, push, merge or stash.
- Confirm clean status and stop for two independent read-only reviews.
