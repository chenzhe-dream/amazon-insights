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
