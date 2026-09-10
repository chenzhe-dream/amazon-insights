# Review percentage semantics and VOC recovery implementation plan

> **For agentic workers:** Use test-driven-development, systematic-debugging, and independent task review. User approved parallel execution of these two disjoint fixes on 2026-09-10.

**Goal:** Make Sorftime percentages honest and restore progress after a per-ASIN VOC publication failure without losing durable results.

**Architecture:** Preserve source-specific statistics with explicit metric provenance through rendering. Separate durable normalization from replayable publication and subsequent ASIN work, keeping authority and bounded retries intact.

**Tech Stack:** TypeScript, Node.js, React/vinext, PostgreSQL, node:test/tsx.

## Global constraints

- Work only in the existing isolated integration worktree; preserve production generated data and all existing user changes.
- Do not fabricate percentages, customer evidence, successful completion, or source availability.
- No production restart, deployment, data deletion, unrestricted replay, or direct status SQL writes in implementation tasks.
- Keep organization/project/run/snapshot/lease/fingerprint authorization checks and existing timeout budgets.
- Write regression tests and observe their intended failures before changing implementation.
- Use apply_patch for edits. Parent alone stages/commits to avoid shared Git index conflicts.

## Task 1: Source-specific review percentages

**Owned files:** scripts/lib/sorftime-review-transform.mjs, scripts/lib/review-analysis-aggregate.mjs, app/seller-sprite-review-analysis.ts, app/page.tsx review-rendering block, associated review-only types/readers/tests. Do not edit VOC normalization runtime.

**Interfaces:** Existing rows have label/sharePct/reason. Extend compatibly with explicit metric kind and numerator/denominator evidence. Review-sample percentage and Customers Say topic mention share must remain distinguishable through typed/runtime readers. Unknown legacy rows must be labeled unknown, not silently declared review incidence.

- [x] Reproduce with one review matching multiple topics and Customers Say entries where the same topic has mixed polarity.
- [x] Verify tests fail for missing metric provenance, misleading generic formatter, and max-relative bar scaling.
- [x] Preserve actual count/denominator for each row; format Chinese source-specific labels and accessible hover explanation. Use fixed 0–100% visual scale; never normalize all dimensions together.
- [x] Require appropriate positive/negative evidence for sentiment blocks; do not describe a repeated overall topic fraction as a positive/negative review rate. Unmet needs must be evidence-based candidates, not confirmed unmet needs from a broad word such as 'report'.
- [x] Add overlap explanation, handle unavailable denominator without invented values, and handle old cached rows conservatively without modifying stored production data.
- [x] Run relevant review scripts, display/runtime/page regression tests and report exact commands, failures before fix, passes after fix.

## Task 2: Durable VOC publication and sibling progress

**Owned files:** server/runtime/alexa-voc-normalization-runtime.ts, server/services/alexa-voc-normalization-worker-handler.ts, normalization/publication/retry-specific dependencies and tests. Do not edit review UI/transforms or generated data.

**Interfaces:** Existing execution persists a revision then publishes cumulative snapshot/wakes positioning. Handler loops snapshots and rethrows retryable errors. Preserve trustedNormalizationCommitSubject checks; replay must reuse verified durable revisions and not call the model again.

**Observed evidence:** Run 0b1f247f-620b-4475-8a68-53964fdf4be7 has input snapshots for B0CQY5RK52, B08T1N86Q5, B06VSQQ3SD. First two durable heads exist; second has succeeded model audit but missing success terminal. Third has input snapshot but no model execution. Normalization attempts 1 and 2 fail with 'Alexa VOC normalization publication failed after durable revision'. Positioning is a separate stage with upstream temporary model errors; do not attribute them to third normalization.

- [x] Reproduce failure when a new cumulative snapshot arrives while positioning already runs; identify original failure before wrapped publication error.
- [x] Add regression showing second publication failure preserves its durable revision and third eligible snapshot is processed; retries do not create duplicate revisions/model calls.
- [x] Fix actual publication/wake invariant rather than bypassing auth or merely swallowing errors. Isolate recoverable per-item publication errors from siblings while propagating global authority/infrastructure failures.
- [x] Preserve truthful pending publication state; ensure finalization and retry remain bounded and do not spin forever with queued stage but no runnable attempt.
- [x] Cover abort, cancellation, lease loss, exhausted retries and successful durable replay.
- [x] Run targeted normalization/publication tests and report exact evidence; provide safe scoped recovery method for parent (no live mutation).

## Task 3: Integration and handoff

- [x] Parent reviews both diffs and obtains independent task-quality/spec review.
- [x] Run combined regression and build/type checks proportionate to risk.
- [x] Verify recorded third-ASIN state read-only; prepare scoped recovery using existing authorized application/service path, not raw data repair.
- [x] Record completed checks and remaining production steps; do not claim live recovery or deployment without live verification.

## Progress

- Planning: approved by user; clean linked worktree at baseline f2811b6.
- Task 1: implemented and independently reviewed; parent direct SQLite/PostgreSQL insertion matrices 3/3 passed. Preserve separate metric denominators, not an artificial cross-dimension 100% normalization.
- Task 2: implemented and independently reviewed; real reversed-ASIN publication ordering and retry-ordinal collision reproduced and fixed. Final normalization/worker/authority covering suite 64/64 passed; parent authority-boundary rerun 13/13 passed.
- Task 3: parent combined queue/status/browser regression 64/64 passed, source semantics 5/5 and preprocessing/evaluation 22/22 passed; stable build passed. TypeScript baseline/current both have 336 diagnostics, with no newly introduced diagnostics. Live recovery remains unexecuted. See `docs/verification/2026-09-10-review-voc-integration.md` for full evidence and release boundary.
