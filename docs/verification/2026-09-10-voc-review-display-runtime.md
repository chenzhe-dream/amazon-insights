# VOC review display runtime repair

Worktree: `C:/Users/EDY/.codex/worktrees/5b97/feat-voc-positioning-skill-execution`.
Clean native worktree fast-forwarded from `9690ab5` to implementation baseline `3c860d3`. Existing dependencies reused by junction; no installs/upgrades. No nonempty applicable AGENTS.md. No subagents, other worktree edits, service restarts, provider calls, deployment, push or database writes.

## Confirmed causes and change

- The stage-output owner lived inside `AsinSyncFunnel`. Direct VOC does not mount that reader. Generated global review data could therefore replace newer persisted job results after refresh.
- `buildVocDevelopmentSummary` and `hasVocDevelopmentData` ignored runtime reviews and imported the generated file directly. A runtime-only ready fixture reproduced `false !== true` before the fix.
- The matrix hid individual failures when no ASIN was ready, displayed raw provider errors, and used an ambiguous no-theme message.

`app/lib/voc-review-reader.ts` reads only the current job and its reviews projection through the existing authenticated proxy. It validates project/run/job/marketplace/exact ASIN set before accepting the existing hash/version-checked projection. Server-side ownership is unchanged: `server/routes/local-data.ts` passes the authenticated organization; `server/db/postgres/sync-job-store.ts` joins output/job/project/run with exact organization/project/run/job predicates. Existing cross-organization and cross-scope route tests pass.

`app/lib/use-voc-review-output.ts` owns the receipt independently of the funnel UI. A new scope token fences A→B→A, disposal aborts reads, and late successes/failures cannot publish. The hook is enabled only on VOC. The overview funnel and VOC projection reader do not issue concurrent review reads. A terminal review output stops the reader after acceptance; missing/failed reads stop after three attempts, including a terminal job with no review stage. It never starts or resumes collection. Re-entering VOC creates a fresh bounded read episode.

`app/page.tsx` consumes this projection on VOC, removes unscoped generated-review fallback, filters review records by ASIN and marketplace, and passes the same visible records to the matrix and seven-dimension summary. No trusted job pointer means an explicit unavailable/current-project message, not data from a global cache. The existing project deletion callback integration area was not touched.

`app/lib/voc-review-display.ts` distinguishes failed requests, current schema/timeout/upstream-empty gaps, explicit no-review responses, and samples with no matching dimension. Each ASIN shows sample count, Customers Say topic count, source and collection date. Failed requests do not imply a verified zero sample count. Matrix remains visible for all-failure cohorts. Current gap items, not historical diagnostic records, drive absent-ASIN status. The seven-dimension aggregation rules and percentage normalization are unchanged; its badge no longer implies that both sources necessarily exist.

## Read-only live evidence

`scripts/diagnostics/inspect-voc-review-display.mjs` queried only fixed job `2f37a6e3-5ef0-4561-a6dd-359096876b72`, inside `BEGIN READ ONLY`, with `default_transaction_read_only=on` and a statement timeout; `SHOW transaction_read_only` returned `on`. Only aggregate counts were printed, never raw reviews or credentials.

Persisted job v11, reviews output v1, timestamp `2026-09-10T03:54:39.307Z`, hash `824a1e575def5c131d816f0b6046541fd8e461fbbfba160e9f1f235db65cc57c` (matches the data window's existing artifact report):

| ASIN | Samples | Customers Say topics | Actual persisted dimensions |
| --- | ---: | ---: | --- |
| B0BHHP21DP luckystyle | 70 | 0 | profile 2, scenarios 2, motives 2; unmet/positive/negative 0 |
| B09NNDX731 addlon | 3 | 0 | all six dimensions 0 |
| B0CZRBL776 ROTTOGOON | not present in successful output | not present | current gap still MCP_SCHEMA/product_reviews |

The transform currently obtains unmet/positive/negative rows from Customers Say. Its absence explains those three empty dimensions in the persisted result; the profile/scenario/motive dimensions can also use review matches. The three addlon samples produced no matches under existing rules. Raw sample texts are not in this projection, so no stronger content-level explanation is claimed. No algorithm changes or fabricated themes were made.

The data window separately established an exact no-review upstream response for B0CZRBL776. This change does **not** rewrite v11 or reinterpret its old schema gap as repaired. Its display will follow the current persisted gap until a separately authorized scoped data repair is applied.

## Verification

- Red: runtime-only ready data was ignored by the existing summary (`false !== true`); missing new reader/display seams were also exercised before implementation.
- 37/37 pass: `node --import tsx --conditions=react-server --test tests/agent/voc-review-runtime.test.ts tests/agent/voc-review-display.test.ts tests/agent/stage-output-browser.test.ts tests/agent/stage-output-route.test.ts tests/agent/voc-legacy-characterization.test.ts`.
- 1/1 Playwright browser test passes: `node --import tsx --test tests/agent/voc-review-browser.test.ts`. Real React hook plus display/summary functions, isolated loopback Vite, intercepted GET-only fixtures: direct VOC, refresh, overview→VOC, no terminal polling, switch A→B→A, logout. Existing formal ports 31900/31901 untouched.
- Targeted TypeScript compilation of the new modules, summary, tests and harness passes. Targeted production-module ESLint passes. `git diff --check` passes.
- Full repository typecheck is not clean. The baseline has the same eight `app/page.tsx` errors (URLSearchParams/string, price strategy shape, and normalization-stage union), independently reproduced against `3c860d3`; the new modules have no reported errors. No full build success is claimed.

## Limits

Browser coverage is a fixture harness of the production reader/hook and display/summary functions, not a real authenticated full-page deployment. The full application and deletion-window integration remain for the coordinator. No formal cache, job, output or module status was rewritten. Existing successful ASIN projections are preserved; absence of matching themes is not presented as comprehensive analysis completion.
