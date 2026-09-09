# VOC Queue Deadline Implementation Plan

> **For agentic workers:** Use executing-plans with root-owned edits and read-only independent reviewers. Steps are tracked below.

**Goal:** Prevent duplicate predecessor starvation and durably end expired VOC waits without model dispatch or result loss.

**Architecture:** Shared expiry predicate/error policy, transactional store operations, independent service runtime, deadline-aware claim and public Chinese status.

**Tech Stack:** TypeScript, node:test, SQLite, PostgreSQL/pg, existing React UI.

## Global constraints

Default queue timeout 300000 ms; accepted config 1000–3600000 ms; sweeper interval 5000 ms; batch 100. Model timeout unchanged. Preserve all data and constraints. No external Provider calls in tests. Source: fix-voc-import-status-20260907; formal root changes only after gates pass.

### Task 1: Durable queue safety (test first)

Files: `server/db/repository.ts`, `server/db/postgres/job-store.ts`, `server/db/postgres-repository.ts`, `server/db/sqlite-repository.ts`, new `server/domain/voc/queue-deadline.ts`; `tests/agent/job-repository.test.ts`, `tests/agent/postgres-job-repository.test.ts`.

- [x] Add fixture reproducing failed attempt 1 with null scheduling marker and existing attempt 2; assert claim never inserts duplicate and fresh jobs proceed.
- [x] Add expiry fixture at exact cutoff; assert attempt/stage failed, error QUEUE_TIMEOUT, retryable false, unchanged attempts count, no later claim. Add before-cutoff/cancelled/other-stage/durable-output exclusions.
- [x] Run both store suites and capture expected RED.
- [x] Add `ExpireVocQueueInput { checkedAt: string; timeoutMs: number; limit?: number; runId?: string }`, `expireVocQueue(input): Promise<number>`, and optional `ClaimJobInput.queueTimeoutMs`. Shared SQL predicate is parameterized per dialect, shared validation produces cutoff and bounded batch.
- [x] Store claim adds newer-attempt exclusion for VOC positioning and cancelled parent exclusion. Other stages retain existing recovery semantics, including normalization publication for older input. With a deadline, add an atomic expired-wait exclusion. Expiry locks selected eligible rows, updates only latest still-waiting rows, refreshes stage/run status, never inserts attempts or touches AgentRun/report data.
- [x] Run GREEN store suites plus lifecycle/recovery regression and inspect diff. Three unrelated lifecycle-route fixture failures reproduced unchanged on clean e1b0e83 baseline.

### Task 2: Independent runtime, configuration and status

Files: `server/runtime/voc-queue-deadline-runtime.ts` (independent config loader), `server/agent-service.ts`, `server/runtime/voc-positioning-runtime.ts`, `server/runtime/worker-loop.ts`, `shared/agent-contracts.ts`, `server/services/analysis-run-service.ts`, `app/lib/voc-run-browser.ts`, `.env.example`; corresponding runtime/config/lifecycle/browser tests.

- [x] Add failing tests for default/invalid timeout, independent sweep calls and safe stop, Chinese QUEUE_TIMEOUT projection, and no auto-retry.
- [x] Implement runtime with injected repository/clock/logger; single awaited sweep per loop, abortable sleep, safe draining stop, safe warnings. Start after listening but before missing model config early return; stop before closing repository. Stop drains in-flight database work; it cannot promise a hard deadline if the database itself never responds.
- [x] Pass same configured deadline to positioning worker/claim; preserve other stages. Public QUEUE_TIMEOUT code and safe mapping use fixed Chinese message, not arbitrary stored errors.
- [x] Run targeted runtime/lifecycle/UI tests and both store suites; verify disabled-model runtime expiry using fixture service.

### Task 3: Review, integrated verification, controlled activation

- [x] Review preservation/cancellation/lineage/race invariants independently and resolve actual findings with regression tests.
- [x] Run traffic regression, affected server suites, build and diff checks; report existing unrelated baseline failures separately.
- [x] Commit only owned source/tests/docs; record fresh source identity: `2e5a29de2d051b565de910ea6314ffb9cc6f187e`.
- [x] Back up formal config/state/generated files; inspect live pending/eligible tasks and data identities without leaking secrets. Apply only the tested approved timeout/cancellation operations; never fabricate authentication or manually rewrite status.
- [x] FF integrate without generated-file overlap, verify, then invoke existing `manage-formal-stack.ps1 -ProjectRoot <formal-root> -PublishCode`. Integrated six-suite regression: 84/84 passed; manager exit 0.
- [x] Verify exact current/applied artifact, Web/Agent source identity, no new active jobs or unexpected data changes; record results. Artifact `375091a47271e25c260e4daca823da4c7430c327f8bde487652aea7111f3920b` applied at 2026-09-09T12:54:25.106Z; post-release audit active 0, preserved data/hash checks pass.

Self-review: each design requirement maps to a task. SQLite/PostgreSQL signatures and error code are shared. No schema change or new Provider call is planned.
