# VOC Import Status Repair Implementation Plan

> Required execution: subagent-driven-development, TDD, independent review and verification-before-completion.

**Goal:** Correct stuck VOC import status and make target identity and progress understandable.
**Architecture:** Preserve immutable per-ASIN encrypted inputs, durable revisions and publication retry; repair existing queue predicates/status derivation and isolate a testable client polling controller.
**Tech Stack:** TypeScript, React, node:test, PostgreSQL test containers.

## Global Constraints

- Work only in fix-voc-import-status-20260907 from d9d9d6e; preserve other worktrees and production.
- Selected ASIN is authoritative; primary text ASIN produces a confirmation advisory, never automatic retargeting.
- Progress must reflect observed states, without invented queue position or percentage.
- Do not replay production submissions, call live providers, restart/deploy/push, change authentication or generated app datasets.
- Persist-before-publication and exact fingerprint/project/run/ASIN isolation remain intact.
- Test with fixtures and isolated PostgreSQL; report any unresolved original publication cause honestly.

## Task 1: Client identity advisory and truthful import progress

Files: app/alexa-voc-import-validation.ts, app/alexa-voc-import-panel.tsx, app/lib/manual-alexa-voc-import-feedback.ts, app/lib/alexa-voc-normalization-status-client.ts; focused new helper/tests if necessary; tests/alexa-voc-import-validation.test.ts and relevant tests/agent/*import-feedback*/*normalization-status-client*.

1. Write failing behavior tests for full-width primary ASIN headers, mismatch confirmation, comparison ASIN exclusion; pending polling network/non-2xx/malformed errors, exact-revision read lag, context isolation and retry.
2. Run tests red. Implement minimal advisory and polling corrections with bounded recoverable errors, never stopping pending state invisibly.
3. Add target ASIN, processing/applying/success/failure, elapsed waiting and an accessible indeterminate progress indicator; show existing version/capture timestamp distinct from a new result. Preserve request-bound target/draft. Do not automatically resubmit on status retry.
4. Run affected tests green and targeted lint. Use behavioral tests, not only source regex. Record test commands/results and commit only owned files.
5. Independent task review, fix Important/Critical findings.

## Task 2: Server queue/status and publication repair

Files: server/db/postgres/manual-alexa-voc-store.ts, server/db/sqlite-repository.ts (mandatory behavioral parity), server/runtime/alexa-voc-normalization-runtime.ts and the verified publication dependency only as required; tests/agent/postgres-manual-alexa-voc-store*.test.ts, tests/agent/manual-alexa-voc-sqlite-repository.test.ts, normalization worker/attempt tests and a focused real-PG publication regression.

1. Reproduce superseded failed-attempt reuse and missing-terminal failure status with isolated database tests. Inspect job-store claim rules before choosing the reuse predicate.
2. Exclude unclaimable/superseded/exhausted failed attempts; preserve queued/running/live-retry reuse and concurrency. New submissions must have a claimable attempt. Do not blindly filter attempt_number >= max_attempts: worker recovery can legally reuse a durable result for report-only/completion-only recovery at that limit, without another provider call.
3. Derive truthful failed status without misclassifying active retry or a different/new fingerprint. Both PG and SQLite must consider the latest effective retry, not an arbitrary historical failed/retryable attempt. Test a terminal failure followed by superseded retryable history and final exhaustion, as well as missing-terminal exhaustion and a newly queued fingerprint.
4. Reproduce initial cumulative publication using isolated PostgreSQL: valid new B07 plus an old CD record with negatives: []. JS accepts empty dimensions but PG migration 0020 rejects them. Add a forward migration aligning snapshot acceptance with the existing shared schema (empty is valid, malformed/non-string/oversize is not), without mutating old migrations or inventing missing text. Verify SQLite parity and preserve all provenance, hash, identity, durable revision and replay checks.
5. Run red/green regression, scoped integration suite, targeted lint and record evidence. Commit owned files; independent review and fixes.

## Task 3: Verification and OpenSpec handoff

1. Run combined client/server focused regressions, real PostgreSQL integration and production build in this worktree. No formal stack restart or provider POST.
2. Inspect new-build progress UI with isolated fixtures if available; verify failure, pending and completion states.
3. Run git diff --check and whole-branch independent review. Resolve Important/Critical findings and rerun impacted checks.
4. Record final commit, tested counts, root-cause status, known limitations and production recovery requirements in docs/verification/2026-09-07-voc-import-status.md.
5. Send tested HEAD and evidence to the OpenSpec window for integration/release review. Do not deploy unilaterally.
