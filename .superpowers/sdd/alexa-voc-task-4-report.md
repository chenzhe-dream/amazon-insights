# Alexa VOC normalization Task 4 report

## Outcome

Task 4 completes the run-scoped Alexa VOC normalization status path from the Agent repository through the Web proxy and per-card UI polling. The authority tuple is `projectId + runId + asin`; each record also carries the normalization fingerprint so a stale poll cannot replace a newer submission. Manual VOC listing remains scoped to the current project, while import and polling require an exactly resolved current-project run.

No provider was called, no real data was written, and no service, Docker stack, deployment, restart, or push was performed.

## RED

- Contract/page-scope RED: the focused contract test failed because `AlexaVocNormalizationStatusQuerySchema` did not exist. The first page regression attempt also demonstrated that importing the heavy page/bridge entrypoint pulled unavailable Fastify runtime dependencies; the authority decision was therefore extracted into a pure module and the RED cases were retained there.
- Pure scope RED covered run A/current project B, unresolved scope, and the exact matching scope.
- Proxy/reducer RED failed on the intentionally missing `createAlexaVocPendingHandler` and `abortAlexaVocPollsOutsideScope` exports.
- Expected security RED established that the old `/api/alexa-voc/pending` wildcard-CORS/static-bridge response did not satisfy the protected strict status contract.

## GREEN implementation

- Added strict v1 status query/response contracts and registered `GET /v1/manual-alexa-voc/normalization-status`.
- Added service authorization for principal organization, project, marketplace, run ownership, and requested-ASIN membership before any status repository read.
- Added run-local SQLite and PostgreSQL status selectors. They choose the latest normalization snapshot for each requested ASIN and return only `{asin,fingerprint,status,revision,error}`.
- Replaced the Web pending static bridge and wildcard CORS with a typed Agent proxy that forwards the exact project/run/ASIN scope and rejects unsafe Agent responses.
- Added a pure page-scope resolver and wired `app/page.tsx` so Manual VOC lists always use the current project; import and polling are disabled until the resumed run resolves to that same project.
- Added a fingerprint-aware client reducer and panel-local per-card polling. Only pending cards poll, terminal cards stop, scope changes abort, sibling failures stay isolated, successful polling rehydrates the verified current-project record, and the existing fast-success hydration remains intact.
- Added an executable raw-field leakage allowlist gate; the status path contains no report text, ciphertext/envelope fields, or model response.
- Updated the traffic/VOC isolation fixture to use the current Task 3 run-snapshot API and current `amazon-voc-insight` output, preserving its original two isolation assertions.

## Files

- Contracts/client: `shared/agent-contracts.ts`, `app/lib/agent-service-client.ts`
- Agent authority/storage: `server/routes/manual-alexa-voc.ts`, `server/services/manual-alexa-voc-service.ts`, `server/db/manual-alexa-voc-repository.ts`, `server/db/sqlite-repository.ts`, `server/db/postgres/manual-alexa-voc-store.ts`
- Web/UI: `app/api/alexa-voc/pending/route.ts`, `app/lib/alexa-voc-page-scope.ts`, `app/manual-alexa-voc-store.ts`, `app/alexa-voc-import-panel.tsx`, `app/page.tsx`
- Regression tests: contracts, page scope, proxy, reducer, service/route, SQLite/PostgreSQL status, leakage gate, and traffic/VOC isolation under `tests/agent/`

## Verification

- Focused RED-to-GREEN checkpoints: contract/page/service `41/41`; proxy/reducer `23/23`; broader focused `68/68`.
- Final affected suite:
  `npm exec tsx -- --conditions=react-server --test tests/agent/contracts.test.ts tests/agent/alexa-voc-page-scope.test.ts tests/agent/manual-alexa-voc-client-store.test.ts tests/agent/manual-alexa-voc-import-feedback.test.ts tests/agent/alexa-voc-mutation-routes.test.ts tests/agent/manual-alexa-voc-service.test.ts tests/agent/manual-alexa-voc-routes.test.ts tests/agent/manual-alexa-voc-sqlite-repository.test.ts tests/agent/postgres-manual-alexa-voc-store-unit.test.ts tests/agent/traffic-voc-isolation.test.ts tests/agent/service-security.test.ts`
  — PASS, `111/111`.
- Changed-file ESLint with the repository's existing page hook-debt overrides — PASS, `0` errors and `9` pre-existing `app/page.tsx` warnings.
- `npx tsc --noEmit --pretty false --incremental false` — full repository still reports `330` pre-existing errors; exact Task 4 production/new-test path filter reports `0` errors.
- `npx openspec validate --all --strict` — PASS, `7/7`.
- `git diff --check` — PASS (line-ending notices only).
- `npm run build` — PASS. This was the single final production build; only the existing chunk-size advisory was emitted.

## Deferred

- PostgreSQL Docker integration remains deferred because this task explicitly forbids starting Docker; the PostgreSQL query has a focused unit regression.
- Repository-wide TypeScript debt, existing `app/page.tsx` lint warnings/hooks debt, bundle chunk-size advisory, transient network retry polish, and extreme concurrent-import UI races are outside this P0 task.
- No additional UI styling or non-Alexa module changes were made.

## Independent review backend repair

The concentrated review repair closes four backend authority gaps without touching the separately assigned UI or positioning-fixture work:

- Latest-Skill fast success now requires deterministic conformance to `matrix-format.md`: numbered attention/unmet rows, tagged positive/negative rows, exact full-width matrix columns, and a 1–5-star motive column. Older parser-shaped output goes to encrypted normalization instead of being accepted as normalized.
- The normalization fingerprint now includes the actual runtime provider identity and full model execution config. The identity is persisted with the encrypted snapshot; the worker recomputes both declared and actual fingerprints after decrypt and fails closed before provider dispatch on a mismatch.
- Same-fingerprint failures are retryable as append-only attempts. Migration `0024` changes terminal identity from snapshot to job attempt, status reads the latest attempt, SQLite/PostgreSQL expose a newer active retry as pending, and the worker includes prior failures while still permanently excluding success/current-attempt terminals.
- Strict fast success, successful fingerprint reuse, async normalization, and replay all converge on the existing cumulative VOC snapshot publisher and durable `amazon-voc-insight` wake path. Fast-path revisions use the trusted run cutoff so the snapshot is immediately visible to `listAtCutoff`.

### Repair RED/GREEN evidence

- Strict matrix RED: the adversarial `x/plain/bad/no-number/not-stars` record was accepted; GREEN: the contract suite passes `4/4`, including the latest compliant template.
- Execution identity RED: snapshot persistence returned no identity and the worker trusted the stored hash; GREEN: SQLite round-trip, model-change non-reuse, and worker mismatch/no-model-call regressions pass.
- Publisher RED: strict fast success had no cumulative publication and its revision had no cutoff override; GREEN: focused fast-path and cross-project reuse publication assertions pass.
- Retry RED: after a terminal failure, the real SQLite status returned `failure` instead of the expected `pending`; GREEN: the same snapshot creates a new job, transitions `pending -> success`, and retains two immutable terminal attempts. PostgreSQL latest-attempt and worker-selection regressions also pass.
- The first broad repair run exposed five old parser-fixture fast-success expectations. They were updated to use a current strict template where fast success is the subject; old-format behavior remains explicitly covered as pending normalization.

### Repair verification

- Backend + original Task 4 affected suite: PASS, `131/131`.
- Changed-file ESLint: PASS, no warnings or errors.
- Full `tsc` still reports repository-wide existing debt; exact repair production/test path filter: `0` errors (`TOTAL=733`, `AFFECTED=0`).
- `npx openspec validate --all --strict`: PASS, `7/7`.
- `git diff --check`: PASS (line-ending notices only).
- Final `npm run build`: PASS; only the existing chunk-size advisory was emitted.
- No Docker, provider call, real POST/data write, service start/restart, deploy, push, or unrelated worktree mutation occurred. PostgreSQL Docker integration remains deferred by the task guardrail; SQL migration/query parity has focused coverage.
