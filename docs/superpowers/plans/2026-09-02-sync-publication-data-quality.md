# Sync Publication and Data Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Windows diagnostic-mirror replacement failures from aborting PostgreSQL-scoped sync publication, and stop invalid commerce zero values from appearing as complete data.

**Architecture:** Keep PostgreSQL authoritative. Add a scoped-only mirror degradation path after transient Windows rename retries are exhausted, while preserving strict atomic behavior for legacy/unscoped and compare-and-swap writes. Centralize positive-money and catalog-conflict validation in pure helpers consumed by generators, readiness, and presentation.

**Tech Stack:** Node.js 22, TypeScript/TSX, Node test runner, Fastify, PostgreSQL sync repository, Vinext/React.

## Global Constraints

- Base commit is exactly `377efad7ead57ff40904952a6268210f1aae099c`.
- Do not call real Provider tools, restart services, deploy, or issue real business POST requests.
- Preserve all real upstream-empty results; never synthesize category, variant, review, or seller data.
- Do not modify the GET authority order: scoped job status remains PostgreSQL-authoritative.
- Do not touch the 14 generated runtime files in the active worktree.
- Use TDD: each production change requires an observed failing test first.

---

### Task 1: Isolate scoped diagnostic-mirror replacement failures

**Files:**
- Modify: `scripts/lib/sync-job-store.mjs`
- Modify: `server/services/sync-job-worker-handler.ts`
- Test: `tests/agent/sync-job-mirror-atomic-replace.test.ts`
- Test: `tests/agent/sync-job-worker-handler-lifecycle.test.ts`

**Interfaces:**
- Consumes: existing `mutateSyncJobMirror()` and `mutateSyncJobMirrorSync()` lock/rename behavior.
- Produces: scoped diagnostic mirror writes survive exhausted Windows transient rename errors; publication mirror failure after PG progress is non-authoritative.

- [ ] Add a failing mirror test whose existing target and next value both contain `scope.organizationId`, whose rename fixture always throws `EPERM`, and assert the final JSON equals the next value with no temp file left.
- [ ] Run the new test and verify it fails with persistent `EPERM` on the current implementation.
- [ ] Add a scoped-only in-place replacement fallback inside the existing interprocess lock after `renameMirrorSync()` exhausts `EPERM/EACCES/EBUSY`; write the already-sanitized serialized payload, flush/close it, remove the temporary file, and keep unscoped plus compare-and-swap writes fail-closed.
- [ ] Re-run `tests/agent/sync-job-mirror-atomic-replace.test.ts`; verify the new scoped case and all existing unscoped atomic cases pass.
- [ ] Add failing worker lifecycle cases showing a publication-view mirror failure after successful `recordProgress` does not call DB fail, and a final diagnostic mirror failure after a successful child exit does not convert completion into failure.
- [ ] Implement the smallest best-effort boundary in `sync-job-worker-handler.ts`; catch only mirror projection errors at those two post-authoritative boundaries. Do not swallow heartbeat, recordProgress, complete, Provider, or build errors.
- [ ] Run both affected test files and commit `fix(sync): isolate scoped mirror replacement failures`.

### Task 2: Reject invalid zero commerce metrics and surface catalog conflicts

**Files:**
- Create: `scripts/lib/commerce-data-validity.mjs`
- Create: `app/lib/competitor-metric-resolution.ts`
- Modify: `scripts/build-sorftime-price-strategy.mjs`
- Modify: `scripts/lib/sorftime-fba-fee-parse.mjs`
- Modify: `scripts/build-sorftime-rating.mjs`
- Modify: `scripts/lib/asin-data-status.mjs`
- Modify: `app/page.tsx`
- Test: `tests/scripts/sorftime-fba-fee-parse.test.mjs`
- Test: `tests/scripts/asin-data-status.test.mjs`
- Create: `tests/scripts/commerce-data-validity.test.mjs`
- Create: `tests/agent/competitor-metric-resolution.test.ts`

**Interfaces:**
- Produces `positiveMoneyOrNull(value): number | null` and a pure catalog-conflict predicate for rating/review pairs.
- Produces presentation resolvers that return source, value, and conflict/missing state without parsing human-readable prose.

- [ ] Write failing pure tests: price/FBA `0`, negative, NaN and strings are invalid; positive finite numbers are valid; `0/0` conflicts only when catalog contains a positive rating or review count.
- [ ] Implement the pure validity helper and make the tests pass.
- [ ] Add failing FBA projection test asserting `fba_fee: 0` becomes `status: "empty"` with `fbaFee: null`; retain existing missing-field and positive-fee behavior.
- [ ] Update `buildSorftimeFbaRecord()` and scoped FBA fallback to use the positive-money rule; run the FBA and scoped-fallback suites.
- [ ] Add failing generator/readiness tests proving zero price cannot create/export a ready strategy, `currentPrice` and `status` survive the UI export, and stale zero records are `missing`.
- [ ] Update the price generator and readiness logic minimally; positive cached records remain compatible.
- [ ] Add failing rating conflict test with catalog `4.2/42` and Sorftime `0/0`; assert the Sorftime record is conflict/empty rather than ready. Also assert a catalog with no positive evidence may retain a genuine zero-review result.
- [ ] Update the rating generator to read the existing `refreshedCatalog` export and apply the conflict predicate.
- [ ] Add failing presentation tests: price and rating fall back to catalog with a conflict label; FBA zero renders as missing, never `$0.00`.
- [ ] Wire the pure presentation resolver into `app/page.tsx`, run affected tests, and commit `fix(data): reject invalid zero commerce metrics`.

### Task 3: Prove minimal recovery selection without Provider calls

**Files:**
- Modify only if the failing contract proves a gap: `server/db/postgres/sync-job-store.ts`
- Test: `tests/agent/sync-job-production-main-resume.test.ts`
- Test: `tests/scripts/sync-job-resume-selection.test.mjs`

**Interfaces:**
- Produces a resume selection of exactly `image_remarks` then `build` for the diagnosed failed job shape; all completed Provider stages stay excluded.

- [ ] Add a fake-runner failing test for a failed job with completed stages through traffic, partial image remarks, and pending build; assert only image remarks and build commands execute.
- [ ] If the test shows repository resume cannot select the pair, make the smallest selection change; do not generalize resume beyond terminal image/build recovery.
- [ ] Run both resume test files and commit `fix(sync): resume interrupted image publication`.

### Task 4: Review and final verification

**Files:**
- Review only the diff from `377efad` to HEAD.

- [ ] Generate a review package and obtain task-level plus whole-branch review; fix Critical/Important findings only.
- [ ] Run all affected tests once, changed-file ESLint, `npm run build`, and `git diff --check`.
- [ ] Confirm the active runtime worktree and its 14 generated files remain untouched.
- [ ] Report exact commits, test evidence, deferred upstream gaps, and the authenticated recovery command/operation without executing it.
