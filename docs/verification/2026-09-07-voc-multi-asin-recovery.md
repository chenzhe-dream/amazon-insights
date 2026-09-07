# VOC multi-ASIN recovery verification

Status: implemented, freshly verified, independently approved and accepted by OpenSpec joint re-review at code HEAD `45c1d7d`. The additional Important from `5bc0bb4` is cleared. No merge or release activation is authorized by these results.

## OpenSpec joint-review follow-up

- OpenSpec independently repeated the eight-file suite at `5bc0bb4`: 115/115 passed, `duration_ms 64419.6535`; same source/build fingerprint and static-check results. No checkout changes beyond the pre-existing `test-results/` were reported.
- Important: A permanent provider failure is durably terminal, then B exhausts transient provider retries and its failure-terminal write encounters a temporary DB failure. The real failure/claim path creates a new logical cycle for B. Runtime selection only skips success/current-job terminals, so A's older failure is selected again. OpenSpec's natural in-memory fixture variant on both adapters observed calls A=2/B=4 instead of A=1/B=4. The coordinator also verified the reducer/current-job-only selection interaction in source.
- Fix requirement: preserve completed permanent failures within the automatic recovery chain, while retaining B's bounded retry and the user's legitimate explicit new submission/re-execution path. A global historical-failure skip is not acceptable. Formal two-adapter regression and explicit-retry positive coverage are required before re-review.
- Sole-implementer follow-up brief: `.superpowers/sdd/voc-recovery-sibling-fix-brief.md`. Correction committed as `45c1d7d2cff8b65936246da4bc0b7c61f8a20f86`; implementation evidence is appended to the task report. Independent re-review and subsequent OpenSpec joint re-review approved the correction. The formal runtime remains untouched.

## Sibling-retry correction: locked-code verification

Code HEAD: `45c1d7d2cff8b65936246da4bc0b7c61f8a20f86`. Existing `retryCycleStartAttempt`, trusted same-stage job identity and the bounded `[start, current]` attempt interval now identify completed failures belonging to the same automatic recovery chain. Runtime selection and the pure reducer agree; an explicit new enqueue starts a different retry chain. The PostgreSQL candidate only maps the already existing field into the internal recovery fact. No schema/public API/global retry changes.

- Formal natural RED in both adapters: A=2/B=4 where A=1/B=4 is required, 0/2 passed before the production correction. Focused GREEN: 2/2. Both tests subsequently use the real same-input enqueue entry to authorize a fresh chain: A then succeeds on its second total call, B remains at four with its original terminal/revision; A's old failure is preserved. Full implementer covering run: 63/63.
- Coordinator independently reran the same eight-file command recorded below on locked `45c1d7d`: **117/117 passed**, zero failed/cancelled/skipped, `duration_ms 68032.2019`, exit 0. This includes the two new mixed-state/explicit-retry cases, not just the earlier 115.
- Fresh production build: exit 0. Source and built artifact fingerprint agree exactly: **`65585e96660f932000d940926bbb5496c2ea9df7f887e58695c30f7734ad7020`**. This supersedes the earlier fingerprints in this historical report. No artifact was activated.
- Fresh changed-file ESLint (`--max-warnings 0`): exit 0. Compiler API: **343 global diagnostics; zero in the same eight changed TypeScript files**. The six pre-edit extended audit-contract failures remain separate debt, not part of a claimed full-repository pass.
- HEAD/diff checks confirm the source is committed and the original `codex/fix-voc-import-status-20260907` branch still points to `23f9f4a`. Pending coordinator documents and the pre-existing `test-results/` are preserved. Known SQLite, PostgreSQL concurrent-query and build notices remain visible; no warning suppression or unrelated repair.
- Independent task re-review: spec compliant, task quality Approved; the completed-sibling Important is cleared. Whole-branch gate `23f9f4a..45c1d7d`: Ready to merge Yes, no Critical/Important; the documented PostgreSQL warning remains a Minor. Reviewer checked both adapters' copy-versus-reset retry-chain SQL and the existing fenced finalizer, and inspected regression assertions without rerunning the suites. Prior approval of `215f71f` did not cover this subsequently discovered scenario.

## Final OpenSpec joint acceptance

The existing `[OpenSpec] 同步流水线稳定化 指令窗口` task (`01a023cf-9b63-7f22-bbad-ebbdd57d0c00`) returned **Approved** for code HEAD `45c1d7d2cff8b65936246da4bc0b7c61f8a20f86`, clearing the completed-permanent-sibling Important with no new Critical/Important findings.

OpenSpec freshly executed:

```powershell
node --conditions=react-server --import tsx --test --test-reporter=spec --test-name-pattern='permanent-sibling-final-attempt' tests/agent/alexa-voc-multi-asin-recovery.test.ts
```

Result: SQLite and isolated real PostgreSQL **2/2 PASS**, zero failed/cancelled/skipped, `duration_ms 7623.6322`, exit 0. It verified automatic A=1/B=4, preserved failure/no A revision, correct final per-input statuses, and the real explicit enqueue subsequently allowing A's second total call without re-executing B. It did not rerun the other 115 cases or claim a new full-suite/build/lint/compiler run.

OpenSpec and its original read-only reviewer checked the production/test increment and matching same-stage retry-chain bounds. Source and existing build fingerprints were independently recomputed and matched `65585e96660f932000d940926bbb5496c2ea9df7f887e58695c30f7734ad7020`; diff check passed and the original repair branch remained at `23f9f4a`. No handoff source/index/HEAD edits or formal environment changes were made by that task. Only the documented coordinator report/ledger updates remained for the final documentation-only commit.

Delivery is code acceptance and preservation of the isolated branch, not activation. Known PG warning, six pre-edit audit-contract failures, 343 whole-project TypeScript diagnostics and the cancellation/expiry coverage limits remain disclosed; no full-repository clean-bill-of-health is claimed.

Base: `23f9f4a3cb24896e94c94cba0108301c8c1250b4`; design-only dispatch commit: `9b1f690ad7506c5691eda62032708cfa5e6663a6`. Branch: `codex/fix-voc-multi-asin-recovery-20260907` in the existing `fix-voc-import-status-20260907` isolated worktree. The old repair branch remains at base.

## Earlier terminal-association implementation verification

Code HEAD: `215f71fdaf019c9ebb486fe0884e8bc61af0bc5b` (initial implementation plus terminal-association review fix). The coordinator repeated the eight-file command below on this locked HEAD: **115/115 passed**, zero failed/skipped/cancelled, `duration_ms 64840.1407`.

- Fresh production build and changed-file ESLint (`--max-warnings 0`): exit 0.
- Source and built artifact fingerprint: **`6450c27e60a8ecb88e8e34df5f6ac5a3e098cf5a1a7c2b2cfb18763fe87539bc`**, exact match. This supersedes the intermediate fingerprints below.
- Fresh compiler-API comparison: **343 global diagnostics, zero in the eight changed TypeScript files**, unchanged baseline count.
- Fresh HEAD and diff checks confirm `215f71f` and no source edits; only coordinator documents and the pre-existing untracked `test-results/` remain outside the implementation commits.
- The follow-up validates terminal job/audit provenance while preserving a real cross-project/run same-fingerprint success written through the existing repository. Corruption checks include a B-shaped terminal retaining A's complete joined audit source, wrong job, wrong source organization/ASIN, and null audit for success.
- Final independent task re-review and whole-branch review passed; no formal-state mutation, release activation or merge is authorized by these results.

## Earlier independent review and handoff boundary

- Task re-review of `eed1f3d..215f71f`: spec compliant and task quality Approved. The Important terminal-association finding below is cleared; valid historical success across runs/projects/cycles in the same organization remains supported.
- Whole-branch read-only review of `23f9f4a..215f71f`: Ready to merge Yes; no Critical or Important findings. The reviewer consumed the full branch package and checked the relevant claim generation, terminal persistence and finalization context. The reviewer did not rerun tests; the coordinator's fresh locked-HEAD results are recorded above.
- One non-blocking Minor remains: concurrent `client.query()` calls while mapping PostgreSQL audits in unchanged `server/db/postgres/agent-run-store.ts:579,778`. The new regression path exposes this deprecation warning; baseline reproduction of the warning has not been established. Track a focused serialization/batching follow-up rather than suppressing it or expanding this repair.
- Test boundaries remain explicit: cancellation fixtures use durable fenced cancellation audits, not a live user cancellation signal; expiry fixtures omit failure settlement and wait for a real lease to expire, not a real process kill/restart. Providers are audited fakes; the formal database and service are untouched.
- Preserve this branch and its evidence for the existing `[OpenSpec] 同步流水线稳定化 指令窗口` task (`01a023cf-9b63-7f22-bbad-ebbdd57d0c00`) to conduct read-only joint review. Do not edit the same worktree concurrently, merge, push, deploy, restart services or replay old inputs as part of the handoff.

## Initial locked implementation verification

Implementation: `eed1f3d2c5fd4885d52c83095a8e23823d3b25a2`. Detailed RED/GREEN and fixture boundaries: `docs/verification/2026-09-07-voc-multi-asin-recovery-task-report.md`.

The coordinator freshly ran the complete scoped command on this committed implementation:

```powershell
node --conditions=react-server --import tsx --test --test-reporter=spec tests/agent/alexa-voc-multi-asin-recovery.test.ts tests/agent/alexa-voc-normalization-worker.test.ts tests/agent/alexa-voc-normalization-attempts-contract.test.ts tests/agent/manual-alexa-voc-sqlite-repository.test.ts tests/agent/postgres-manual-alexa-voc-store-unit.test.ts tests/agent/postgres-manual-alexa-voc-store.test.ts tests/agent/postgres-job-repository.test.ts tests/agent/worker-loop.test.ts
```

Result: **115/115 passed**, zero failed/skipped/cancelled, `duration_ms 63127.4994`. This includes the final new-input ordering and cross-logical-cycle last-attempt corrections, not just their earlier intermediate versions. Both real SQLite and isolated PostgreSQL are covered.

Additional coordinator gates:

- `npm run build`: exit 0. Source fingerprint and `dist/build-fingerprint.json` agree: `5139ca0dc758713fa60a8b475d1bbfc964880acc0d0bfe1391dd62ade42b4859`. No server was started or artifact activated.
- `node node_modules/eslint/bin/eslint.js` on all eight changed TypeScript files, with `--max-warnings 0`: exit 0, no diagnostics.
- Compiler API with `noEmit: true, incremental: false`, comparing exact changed files against dispatch base: **343 total diagnostics, zero in changed files**. The whole repository is not TypeScript-clean; its pre-edit count was also 343.
- `git diff --check`: clean. Original branch `codex/fix-voc-import-status-20260907` still resolves to `23f9f4a3cb24896e94c94cba0108301c8c1250b4`.
- Warnings retained: expected Node experimental SQLite warning; newly exposed PG concurrent-query deprecation in unchanged audit mapping; existing build chunk-size and route-classification notices. None were suppressed.

The implementation agent also reran `agent-run-repository.test.ts`: 25/30 passed with the same five pre-edit failures documented below. The separately verified service baseline adds one historical failure. These are not silently included in the 115 scoped passes, and no full-suite pass or release readiness is claimed.

## Independent task review

Range `9b1f690..eed1f3d`: Needs fixes; no Critical, one Important, one Minor.

- Important: recovery checks copied terminal snapshot/run/ASIN/fingerprint fields, but does not validate the terminal's referenced job and audit associations. Independent FKs alone do not stop a B terminal referring to A's audit. The scoped fix must reject wrong-audit/wrong-stage terminal provenance before treating it as completion.
- Coordinator verification: the existing terminal writer does validate these relationships at insertion, but the new recovery boundary's explicit corrupted-evidence requirement still needs enforcement. Successful fingerprint replay intentionally permits an audit/source snapshot from another run/project within the same organization and exact ASIN/marketplace/fingerprint; the fix must preserve that legitimate historical provenance rather than requiring every source audit to belong to the target run/job.
- Minor retained: newly exposed PostgreSQL concurrent-query warning in unchanged audit mapping. No suppression or unrelated repair.
- Review limitations: live user cancellation and actual process-kill/restart were not exercised. Audit-seeded cancellation and lost-settlement/real-expiry tests are the disclosed scope, not evidence of those broader operations.
- The finding was dispatched to the sole implementer. The initial locked-implementation section describes `eed1f3d`; final `215f71f` evidence is recorded separately above.
- Follow-up `215f71f` adds the missing associations and regression checks. Implementer covering run: 75/75; final strengthened corruption checks: 2/2. Coordinator then independently reran the complete 115 cases and static/build gates on `215f71f`, as recorded in Final implementation verification. Independent task re-review and whole-branch review subsequently approved the correction.

## Pre-implementation baseline

At `9b1f690`, before production edits:

```text
node --conditions=react-server --import tsx --test --test-reporter=spec tests/agent/alexa-voc-normalization-worker.test.ts tests/agent/alexa-voc-normalization-attempts-contract.test.ts tests/agent/manual-alexa-voc-sqlite-repository.test.ts tests/agent/postgres-manual-alexa-voc-store-unit.test.ts
34 tests; 34 passed; no skips/cancellations.

node --conditions=react-server --import tsx --test --test-reporter=spec tests/agent/postgres-job-repository.test.ts tests/agent/agent-run-repository.test.ts tests/agent/worker-loop.test.ts
60 tests; 55 passed; 5 failed; no skips/cancellations.
```

The second run used an isolated PostgreSQL test container and temporary SQLite databases. PostgreSQL job and generic worker tests passed. Five existing failures are in `tests/agent/agent-run-repository.test.ts`:

| Test | Baseline failure |
| --- | --- |
| lease-expiry successor inherits the trusted cycle and recovers a pending AgentRun claim | line 701: missing expected `AgentRunConflictError` rejection |
| model ledger mutations atomically reject a stale AgentRun claim | `ModelBudgetExecutionAuthorityLostError`, code `BUDGET_EXECUTION_AUTHORITY_LOST` |
| one active JobAttempt audit finalizes once and survives restart | line 1575: SQLite `UNIQUE constraint failed: agent_runs.id` instead of expected conflict class |
| begin rejects relationship, tenant, canonical-ID, and fingerprint drift | line 2139: SQLite `UNIQUE constraint failed: agent_runs.id` instead of expected conflict class |
| job attempt usage preserves request identity and conservative partial accounting | line 2670: invalid/missing `agentRunId` |

These are pre-implementation observations, not new failures caused by the repair. Do not claim the broad suite is fully green, and do not silently rewrite unrelated audit-contract tests. Node also emitted its expected experimental SQLite API warning.

Additional pre-edit audited-execution/normalization-budget baseline:

```text
node --conditions=react-server --import tsx --test --test-reporter=spec tests/agent/agent-run-service.test.ts tests/agent/alexa-voc-agent-run-budget-contract.test.ts
25 tests; 24 passed; 1 failed; no skips/cancellations.
```

The existing failure is `successful audit survives restart, replays without provider, and conflicts on drift` at `tests/agent/agent-run-service.test.ts:384`: missing expected `/execution identity|conflict/i` rejection. Other replay/cancellation/budget and normalization contract cases passed. This is a sixth observed pre-edit baseline failure in this follow-up's extended runs, separate from the previous repair's four snapshot-contract assertions.

A pre-edit compiler-API diagnostic pass found 343 total TypeScript diagnostics. The broad VOC/job/audit filename filter found eight existing diagnostics: four implicit-any bindings in `server/security/alexa-voc-normalization-input-cipher.ts:170,200`; missing `agentRunId` at `agent-run-repository.test.ts:2670` and `postgres-agent-run-repository.test.ts:377,576`; and the old `manual-alexa-voc-import-feedback.test.ts:167` extra `disposition` property. Planned modified production paths had no diagnostics. Compare exact changed files at the final gate, not total counts alone.

## Evidence boundary

The implementer has now reported the first natural RED run of `tests/agent/alexa-voc-multi-asin-recovery.test.ts`: 2 tests, 0 passed, 2 failed. Both used encrypted inputs, real normalization runtime, audited fake provider and transaction-preserving injection at B's cumulative-publication boundary. SQLite reached real `failJob` and failed at the existing `sqlite-repository.ts:6208` multiple-row guard; PostgreSQL reached real `failJob` and failed at `job-store.ts:508`. The exact command/output and subsequent GREEN evidence belong in the task report and still require review.

The prior joint-review fixture manually injected a failed-at-limit job and compared the baseline queue SELECT. It did not execute a complete baseline implementation or natural failure/recovery cycle. The new regression must use actual normalization execution and real worker/repository transitions with an isolated fake provider.

No formal DB writes, live Provider calls, user-browser control, old-run replay, service restart, artifact activation, merge, push or deployment are authorized by this verification.

## Implementation review checkpoints

- Migration 0006 makes an initialized publication policy immutable within its publication cycle. In particular, a running publication attempt cannot become cancelled, and a non-retryable failed publication attempt must have genuinely exhausted publication attempts. Do not falsify counters or classify budget/cancellation as success to bypass this constraint.
- Regression coverage must include A publication failure, a same-cycle successor replaying A, and B subsequently encountering budget/cancellation. A fresh successor on its last permitted execution attempt is distinct from reclaiming an already exhausted execution lease.
- Publication-only recovery must not grant model authority to newly submitted siblings. Later legitimate input must retain its own bounded enqueue/execution path.
- A pure recovery decision may be used by queue/status reads. Any missing failure-terminal reconciliation belongs only in a trusted, fenced failure/expired-claim transaction and must roll back if settlement fails.
- The expired-lease fixture simulates loss of failure settlement followed by actual lease expiry; it is not evidence of killing and restarting a real worker process.

## Intermediate coordinator checks (not final HEAD)

- `npm run build`: passed on the in-progress source. Existing Vite chunk-size and vinext route-classification notices remain; no service was started. The then-current source and `dist/build-fingerprint.json` matched `51a78f1c5cb1956fd441e00ed8b4440a523cf04b67a095518cff1d6c11f116c4`. This fingerprint must be superseded after any further source edit.
- Compiler-API check: 345 diagnostics versus pre-edit 343. Exact changed-file filtering found two new typing errors: possibly undefined `preparedLease` captured in runtime mapping, and test cleanup calling `close` through `RuntimeAgentRepository`. Both were returned to the implementer; final verification must show they are removed.
- Independent seven-suite compatibility run: 85 tests, 84 passed, one new failure in `postgres-manual-alexa-voc-store.test.ts:538` (`normalization queue replaces exhausted work but reuses at-max durable recovery`). A no-audit exhausted old job with a failure terminal was incorrectly reclaimed as completion-only after a replacement had been queued. Returned to the implementer; this is not one of the six pre-edit audit-contract failures. The command covered normalization worker/attempts, SQLite manual store, PostgreSQL manual store unit/integration, PostgreSQL jobs, and generic worker loop.
- After fixing that regression, the coordinator repeated the same seven-file command: **85/85 passed**, zero failures/skips/cancellations, 45.2 seconds. A subsequent exact-changed-file compiler pass returned to **343 total diagnostics, zero in all eight changed TypeScript files**.
- Coordinator recovery-suite run: **28/28 passed**, zero failures/skips/cancellations, 50.5 seconds. The implementer subsequently strengthened the new-input ordering case and adjusted publication-policy retention; therefore the final evidence must cover that final ordering change rather than attributing this intermediate run to the eventual HEAD.
- The 28-case run also exposed a PostgreSQL concurrent-client-query deprecation warning. A focused read confirms unchanged `server/db/postgres/agent-run-store.ts:579` maps audits using `Promise.all`, while `#mapAgentRun` at line 778 queries snapshot links. The file has no diff from the dispatch base. This is an observed warning in the new regression path, not proof that the old baseline test run emitted it. It was not suppressed.
