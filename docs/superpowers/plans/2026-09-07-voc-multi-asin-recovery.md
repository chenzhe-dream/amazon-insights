# VOC Multi-ASIN Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover multi-ASIN normalization publication failures without rejecting valid audit siblings, repeating completed model work or exceeding retry authority.

**Architecture:** Keep the current batch job and fingerprinted audited execution. Add a small normalization-only recovery decision boundary used by both database adapters; evaluate relevant input identities and their durable states before aggregating a job action. Preserve other stages' existing single-audit handling and align the normalization queue/status paths with actual claim eligibility.

**Tech Stack:** Node.js >=22.13.0, TypeScript, node:test/tsx, SQLite, PostgreSQL, existing audited SkillRunner and fake provider.

## Global Constraints

- Base is `23f9f4a3cb24896e94c94cba0108301c8c1250b4`; original branch remains locked. Work on `codex/fix-voc-multi-asin-recovery-20260907` in the existing isolated worktree.
- Scope batch recovery to `alexa-voc-normalization`; every other stage retains its single-audit contract.
- Bind recovery to organization/project/run/stage, snapshot and execution fingerprint; never select an arbitrary first/latest audit as batch authority.
- Successful durable inputs must not invoke the model again. A successful sibling cannot authorize fresh model execution after retry, cancellation or budget limits.
- Retain lease fencing, retry backoff and bounded publication attempts. Missing/exhausted input results must not remain permanently pending or be mislabeled successful.
- PostgreSQL and SQLite failure settlement, claims, normalization queue reuse and status must agree.
- Do not split ASINs into separate jobs, change schema/UI, clear history, relax global limits or perform unrelated refactoring.
- No live Provider, formal DB, old-input replay, restart, artifact activation, merge, push or deployment. Preserve all unrelated files and the integration tree's generated-data changes.
- Run real isolated repository/worker tests; do not manufacture failed job states as the sole natural-path evidence.

## File structure

- New focused helper, if needed: `server/domain/voc/alexa-voc-recovery.ts` for the shared normalization-only identity/state decision; no database connections or provider calls.
- `server/db/postgres/job-store.ts` and `server/db/sqlite-repository.ts`: normalize persisted facts and route only normalization recovery through the shared decision.
- `server/db/postgres/manual-alexa-voc-store.ts` and SQLite's matching store methods: align queue/status eligibility where the regression proves disagreement.
- `server/runtime/alexa-voc-normalization-runtime.ts` / `server/services/alexa-voc-normalization-worker-handler.ts`: only the scoped recovery selection/settlement needed to prevent mixed-item model overrun; reuse existing audited service and publication functions.
- New `tests/agent/alexa-voc-multi-asin-recovery.test.ts` plus `tests/agent/helpers/alexa-voc-multi-asin-recovery-harness.ts` for the natural production-normalization path. Use `helpers/postgres-test-container.ts` for real PostgreSQL.
- Existing normalization, agent-run and job/worker suites for compatibility. The positioning-service harness is only a pattern reference, not evidence for this normalization chain.

### Task 1: Natural-path multi-ASIN recovery and scoped parity

**Files:** The production/helper/test paths in File structure; task report `docs/verification/2026-09-07-voc-multi-asin-recovery-task-report.md`.

**Interfaces:** Preserve public repository and API signatures unless a minimal internal fact type is needed. Existing boundaries are `JobAttemptWorkerLoop`, `createAlexaVocNormalizationJobHandler`, `AlexaVocNormalizationExecutionService`, `AuditedSkillRunner`, `commitNormalizationAndWake`, repository `failJob` / `claimNextJob`, and normalization input/terminal methods. Do not add test-only production methods.

- [ ] **Step 1: Build a natural-path failing regression before production edits.**

  Use the actual normalization runtime path with encrypted test inputs, registered normalization skill, audited fake provider and real repository. Wrap the exact B cumulative-publication write in a test-only repository proxy; retain nested transaction behavior. Bind injected failure to B's input/audit identity, not to an unexplained call ordinal. First capture the expected failure from the existing multiple-audit guard.

  Acceptance assertions for a harness result are concrete:

  ```ts
  assert.equal(result.auditCycleIds.size, 1);
  assert.equal(result.auditFingerprints.size, 2);
  assert.deepEqual(result.providerCalls, { A: 1, B: 1 });
  assert.equal(result.initialFailureWasPersisted, true);
  assert.equal(result.recoveryClaimed, true);
  assert.deepEqual(result.terminalStatuses, { A: "success", B: "success" });
  assert.deepEqual(result.revisions, { A: "1", B: "1" });
  assert.equal(result.duplicatePublications, 0);
  ```

  Run: `node --conditions=react-server --import tsx --test --test-reporter=spec tests/agent/alexa-voc-multi-asin-recovery.test.ts`.

- [ ] **Step 2: Implement normalization-only per-input recovery.**

  Load exact stage/cycle audit identities and the relevant normalization input/terminal evidence. Validate all participating records, including fingerprints and scope, before reducing them. Reuse existing per-input success replay and failure classification. Keep the ordinary single-audit path intact. Do not replace the multiple-row guard with a first-row selection or broad `some(passed)` shortcut.

  The decision must distinguish these complete cases: successful input terminal; successful durable normalization lacking publication; pending audit; transient failed audit; permanent/cancel/budget outcome; input without an audit. Aggregate a recovery action only after these are resolved. At the execution limit, only the exact durable input's permitted completion/reconciliation may run; a missing sibling must not gain model-call authority. If this requires a scoped runtime guard or terminal settlement, implement it in the normalization boundary rather than changing global attempt limits.

- [ ] **Step 3: Add discriminating regression cases and make them pass.**

  Run the Step 1 command after each focused change. Cover both database adapters and both `failJob` and expired-lease entry points. Add tests for publication failure before commit and retry after already-committed publication, execution-limit durable recovery, bounded publication exhaustion, success plus never-started sibling at the limit, mixed pending/permanent failures, cancellation/budget and malformed/duplicate identity rejection. Assert provider call counts and exact per-snapshot terminal status, not only batch job success. Do not alter the four pre-existing snapshot content-hash conflict assertions.

- [ ] **Step 4: Verify compatibility before commit.**

  Run:

  ```powershell
  node --conditions=react-server --import tsx --test --test-reporter=spec tests/agent/alexa-voc-normalization-worker.test.ts tests/agent/alexa-voc-normalization-attempts-contract.test.ts tests/agent/manual-alexa-voc-sqlite-repository.test.ts tests/agent/postgres-manual-alexa-voc-store-unit.test.ts tests/agent/postgres-manual-alexa-voc-store.test.ts tests/agent/postgres-job-repository.test.ts tests/agent/agent-run-repository.test.ts tests/agent/worker-loop.test.ts
  git diff --check
  ```

  Run changed-file ESLint. Baseline focused 34/34 passes; expected Node experimental SQLite warning is recorded separately. Report any other baseline failure by exact test and verify it on the unchanged base before categorizing it.

- [ ] **Step 5: Self-review, record evidence and commit only owned files.**

  The task report must include the initial RED command/output, natural state transitions, GREEN commands/counts, real PG evidence, source/test file list and limitations. Preserve root-owned progress/final report, all historical task reports and existing untracked `test-results/`. Return DONE or a concrete concern; never claim unexecuted tests. Commit as one or more narrowly scoped fixes/tests.

## Coordinator verification and handoff

- [ ] Independently review Task 1 against the approved design and verify no cross-input authorization, lease or budget regressions.
- [ ] Re-run targeted recovery plus broader regressions in isolated processes; run production build, changed-file lint and affected-file TypeScript comparison. Keep known baseline debt explicit.
- [ ] Run final whole-branch review from `23f9f4a` to the final implementation HEAD, address all blocking findings, and update progress and `docs/verification/2026-09-07-voc-multi-asin-recovery.md`.
- [ ] Lock the final tested HEAD and send the report to `[OpenSpec] 同步流水线稳定化 指令窗口`. Do not merge or activate a formal artifact.
