# Alexa VOC normalization Task 3 report

## Root cause and implementation

The prior runtime still treated VOC positioning as one legacy direct-output execution and tied one physical agent run/model-request ordinal to one job attempt. It had no worker consuming Task 2 encrypted normalization snapshots, no per-ASIN durable terminal boundary, no atomic revision/snapshot/wake/finalization, and no compatibility boundary for the new combined Amazon VOC insight report.

Implemented the P0 normalization chain:

- Added the `alexa-voc-normalization` runtime, per-snapshot audited execution service, and sibling-isolating worker handler. `executionFingerprint` is the normalization snapshot fingerprint, the `agent_run.execution_fingerprint`, and the successful revision `contentHash`.
- Added SQLite/PostgreSQL 0023 contracts for multiple fingerprinted agent runs per claimed job, per-agent-run request ordinals/budget authority, cumulative snapshot identity, and durable per-snapshot success/failure terminals.
- Added repository-backed failure terminals and success terminals committed with the revision, cumulative strict VOC snapshot, and downstream wake. Finalization rechecks pending snapshots and completes the normalization job/stage in the same repository transaction; late inputs are drained or left for the queued follow-up.
- Validated job lease/generation, agent-run fingerprint/snapshot/status, actor/org/project/run scope before commit. Cumulative VOC selection now follows committed revision ordinals rather than UUID order.
- Wired the Agent Service runtime lifecycle. VOC readers exclude encrypted input snapshots and consume only strict committed cumulative VOC snapshots.
- Atomically switched formal `voc-positioning` to `amazon-voc-insight@1.0.0` with `AmazonVocInsightInput/Output@1.0.0`; strict new publication stores the combined report, while readers and the product-definition projection adapter accept legacy direct reports.
- The old `voc-listing-optimizer` was not loaded, copied, or used as a fallback.

## TDD evidence

Initial RED:

- `..\..\node_modules\.bin\tsx.cmd --conditions=react-server --test tests/agent/alexa-voc-normalization-worker.test.ts` — failed with `ERR_MODULE_NOT_FOUND` for the missing worker handler.
- Late-drain RED — expected `snapshot-a, snapshot-b`, observed only `snapshot-a`.
- `tests/agent/alexa-voc-agent-run-budget-contract.test.ts` — 0/2 before 0023/per-agent-run authority existed.
- Combined publisher/registry focused run — legacy skill/schema/direct-output expectations failed after the required formal switch.
- Final atomicity review RED: worker/budget contract batch 3/6 failed because 0023 lacked durable terminals, runtime lacked atomic finalization/latest selection, and injected late snapshot B was not executed.

GREEN:

- Worker/finalizer/budget/latest focused: 7/7 PASS.
- Core affected batch (`alexa-voc-normalization-worker`, budget contract, product projection, model accounting, skill registry, normalization contracts): 31/31 PASS.
- `manual-alexa-voc-sqlite-repository.test.ts`: 19/19 PASS, including actual durable terminal write/read.
- `repository.test.ts`: 22/22 PASS, including concurrent/fresh/legacy SQLite migrations through 0023.
- `skill-runner.test.ts`: affected suite PASS (all tests in file).
- Combined publisher focused: PASS.
- SQLite migration focused: 1/1 PASS.

## Verification

- Changed-file ESLint: PASS (exit 0).
- Task 3 source filtering of full `tsc --noEmit --incremental false`: no Task 3 source/type errors. The full repository typecheck still reports unrelated pre-existing test/application debt.
- `git diff --check`: PASS; only Git LF-to-CRLF notices.
- Production build was run once: `npm run build` PASS (exit 0), all vinext stages completed. Informational warning: a generated chunk exceeds 500 kB.
- No Docker, provider call, real POST, deploy, restart, push, or real-data mutation was performed.

## Risks and deferred work

- PostgreSQL 0023 is covered by static/fake contract inspection only; Docker integration is explicitly deferred.
- Carrying the same agent run/model reservation across a new job attempt is deferred. Task 3 scopes separate audited/budget authority to multiple per-input executions under one claimed job.
- Obsolete legacy direct-output specialized repair tests/fixtures are not a runtime fallback and were not expanded; migration of that historical test-only coverage is deferred.
- Rare races and additional recovery hardening beyond durable terminals, lease fencing, atomic no-pending finalization, and Task 2 follow-up queue behavior are deferred.

## Independent-review repair

The follow-up review found four correctness gaps, repaired as one coupled switch:

- PostgreSQL 0023 now uses the referenced tables' `TEXT` identifier type for normalization terminal foreign keys. The terminal insert no longer casts `agent_run_id` to UUID, and static/fake coverage checks the migration and query contract.
- PostgreSQL queueing now creates/locks the normalization stage before inserting a late input snapshot. The finalizer takes the same stage-row lock before enumerating snapshots and terminals, and it requires an explicit durable terminal for every input. Queue-side active/latest job reads no longer take a job lock while the stage lock is held, avoiding the stage/job lock-order inversion. SQLite retains its immediate-transaction serialization and exposes the same stage-lock contract.
- Each newly created cumulative VOC snapshot now gets an eventual positioning analysis: a queued stage consumes latest; a running stage gets one deduplicated queued successor; a succeeded stage starts a legal new retry cycle and marks succeeded product-definition output stale. An identical cumulative snapshot does not wake again.
- A committed-fingerprint replay now returns the successful source `agentRunId` plus revision provenance, skips the model, writes an explicit success terminal for the current input snapshot, and publishes/wakes the current run's cumulative snapshot in the same transaction. Repository validation requires same organization, ASIN/fingerprint-matched normalization input provenance, successful validation/terminal status, and the current normalization skill.

### Follow-up TDD evidence

RED commands and observed failures:

- `..\..\node_modules\.bin\tsx.cmd --conditions=react-server --test tests/agent/alexa-voc-agent-run-budget-contract.test.ts tests/agent/alexa-voc-normalization-worker.test.ts` — 10 tests, 6 passed / 4 failed: PostgreSQL terminal IDs were UUID, `lockNormalizationStage` was absent, replay called the model, and `wakeVocPositioning` was unavailable.
- `..\..\node_modules\.bin\tsx.cmd --conditions=react-server --test --test-name-pattern "reuses only same-organization" tests/agent/manual-alexa-voc-sqlite-repository.test.ts` — 0/1: `findCommittedNormalizationReplayByFingerprint` was absent.

GREEN and affected verification:

- The two RED commands above: 10/10 and 1/1 PASS after the minimal implementation.
- `..\..\node_modules\.bin\tsx.cmd --conditions=react-server --test tests/agent/alexa-voc-agent-run-budget-contract.test.ts tests/agent/alexa-voc-normalization-worker.test.ts tests/agent/manual-alexa-voc-sqlite-repository.test.ts tests/agent/manual-alexa-voc-service.test.ts tests/agent/postgres-manual-alexa-voc-store-unit.test.ts tests/agent/repository.test.ts` — 69/69 PASS.
- `..\..\node_modules\.bin\tsx.cmd --conditions=react-server --test --test-name-pattern "SQLite migrations are recorded once" tests/agent/sqlite-migrations.test.ts` — 1/1 PASS.
- Final repair-focused rerun (contract, worker, PostgreSQL fake queue, SQLite replay): 11/11 plus 1/1 PASS.
- Task-file filtering of `..\..\node_modules\.bin\tsc.cmd --noEmit --pretty false --incremental false`: `TASK_FILE_TSC_ERRORS=0`; unrelated repository-wide type debt remains outside this task.
- Changed-file ESLint: PASS (exit 0).
- `npm run build`: PASS (exit 0), all five vinext build stages completed; only the existing informational chunk-size warning was emitted.
- PostgreSQL Docker integration remains deferred. One overbroad local test selection was discarded after Docker-gated suites failed at the unavailable-Docker preflight; Docker was not started. Two unrelated historical SQLite migration cleanup cases in that discarded selection also hit Windows temp-directory `EPERM`.
- No provider call, real POST, deploy, restart, push, or real-data mutation was performed.

## Lock-order re-review repair

The remaining PostgreSQL deadlock edge was a lock-order mismatch: normalization queueing held the analysis run before the normalization stage, while finalization held the stage and `completeJob` later refreshed the analysis run. A concurrent late queue/finalize pair could therefore form run-to-stage versus stage-to-run wait edges.

The repository contract now exposes transaction-scoped `lockNormalizationRunAndStage`. PostgreSQL acquires `analysis_runs ... FOR UPDATE` first and the normalization `run_stages ... FOR UPDATE` row second. Queueing uses the same helper before inserting the late snapshot; finalization uses it before snapshot/terminal reads and holds both locks through `completeJob`. The queue active/latest-job reads remain non-locking, so this change does not add a job-to-stage reverse edge. SQLite keeps its immediate-transaction serialization and mirrors the run-then-stage existence contract.

TDD and verification evidence:

- RED: `..\..\node_modules\.bin\tsx.cmd --conditions=react-server --test tests/agent/alexa-voc-agent-run-budget-contract.test.ts tests/agent/postgres-manual-alexa-voc-store-unit.test.ts` — 6 tests, 4 passed / 2 failed because `lockNormalizationRunAndStage` and the explicit queue run lock were absent.
- GREEN: the same command — 6/6 PASS.
- Focused lock/runtime batch adding `alexa-voc-normalization-worker.test.ts` — 11/11 PASS. The PostgreSQL fake executor observes run lock before stage lock for both queueing and the finalizer helper and confirms queue job reads do not use `FOR UPDATE`.
- Non-Docker affected batch (`alexa-voc-agent-run-budget-contract`, normalization worker, manual Alexa VOC SQLite/service, PostgreSQL manual-store unit, repository) — 69/69 PASS.
- Changed-file ESLint — PASS (exit 0).
- Task-file filtering of `tsc --noEmit --pretty false --incremental false` — `TASK_FILE_TSC_ERRORS=0`.
- Production build was not repeated: this repair changes only repository lock ordering/naming and is covered by focused runtime, fake SQL, lint, and task-file type verification.
