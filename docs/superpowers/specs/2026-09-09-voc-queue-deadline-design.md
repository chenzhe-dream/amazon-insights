# VOC queue recovery and deadline

User approval: 2026-09-09, “进行修复，直接加入超时机制把”, following the verified duplicate-predecessor diagnosis. User requests direct implementation; inline self-review and independent review replace another design approval round.

## Decision

Repair claim selection and add independent durable expiry. Provider-call timeout alone cannot cover waiting. Deleting historical attempts or adding arbitrary retry numbers is rejected because it loses evidence or bypasses retry budgets. A browser-only timeout is rejected because work could continue after the page closes.

- Both stores claim only the latest attempt of a VOC positioning stage, never a cancelled run/stage. Any later positioning attempt (including a manual retry with a new logical cycle) supersedes a failed predecessor for claim eligibility. Other stages retain existing recovery semantics: normalization may append a new ASIN while an older cycle still needs publication recovery. Preserve all existing rows and constraints.
- New `AGENT_VOC_QUEUE_TIMEOUT_MS` defaults to 300000, independent of model credentials/configuration. Valid positive safe integer range: 1000–3600000 milliseconds. Existing Provider timeout is unchanged.
- The deadline starts at `available_at`, not original creation time. It applies to latest queued VOC positioning jobs and latest failed/retryable jobs waiting for a new model retry. Do not expire a logical cycle with a pending/passed AgentRun, or a report-publication retry policy: already computed results and in-flight durable recovery are protected.
- At the deadline (inclusive), a bounded transaction marks eligible attempts and their stage failed with public code `QUEUE_TIMEOUT`, disables automatic retry, clears leases, records completion, and refreshes run status. No Provider call, synthetic result, audit deletion, or source-data mutation. Explicit retry starts a fresh waiting interval through the existing API.
- Claim and expiry use the same predicate/cutoff. Claim must not dispatch an expired eligible attempt in the interval before the sweeper. PostgreSQL row locks and SQLite immediate transactions serialize updates against claim/cancel/retry.
- An independent non-overlapping runtime checks every 5 seconds, before model configuration is required, with bounded batches. It stops with the Agent Service. Failure is logged with safe metadata, not secrets/raw SQL. If the database is unavailable, no claim of durable expiry is made.
- API projection preserves QUEUE_TIMEOUT, UI shows “VOC 排队超时，已停止自动重试，请稍后手动重试。” without an English duplicate. Existing report history and manual retry remain available.

## Scope and release

Implementation stays in the existing isolated SIF source worktree; root owns edits. OpenSpec window confirmed no overlapping writers. Preserve its unrelated WIP and the formal root's 15 generated files. No new cloud deployment, schema migration, provider spending, or authentication bypass.

After unit/integration/regression tests and independent review, use the existing controlled LAN release manager. Pre-release operations must inspect all claim-eligible historical rows, not just queued/running counts; apply the tested expiry path only to eligible expired VOC waits so old failures are not silently sent to the model. Preserve snapshots/reports/audits and record before/after identities. If cancellation/authentication or release gates cannot be satisfied, stop and report that boundary.

## Acceptance

Dual-store regression for existing successor and unrelated fresh job; cross-cycle retries; cancelled parent exclusion; deadline before/equal/after; no automatic retry after expiry; explicit retry resets interval; no expiry of other stages/running/durable-output jobs; claim-expiry race; independent runtime with unavailable model; safe shutdown; Chinese API/UI round trip; fresh SIF regression. Use isolated Docker PostgreSQL fixtures, never the formal database for test seeding.

Self-review: thresholds, cutoff, eligible retry types, terminal code, preserved data and release scope are explicit; no monthly/traffic/VOC-content behavior changes included.

Regression-driven correction: `alexa-voc-multi-asin-recovery.test.ts` new-input-during-publication legitimately requires both older and newer normalization jobs to finish. Initial global latest-only filtering failed this existing test on both stores. Scope the superseded-predecessor repair to the diagnosed VOC positioning stage; do not abandon normalization publication work. Re-run the full normalization recovery matrix before release.
