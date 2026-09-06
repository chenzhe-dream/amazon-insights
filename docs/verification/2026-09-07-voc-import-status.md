# VOC import status repair: verification and integration handoff

Status: implementation and scoped verification complete; whole-branch review Approved with no Critical/Important findings. Ready for OpenSpec joint review, not a deployment approval.

Verified code/test HEAD: `de67e4c2e19f89204268ee65d3e0e3b2500bac0e` (production source unchanged since `b04304b`). The final handoff commit only updates this report and the progress ledger.

## Scope and evidence

- Repair branch: `codex/fix-voc-import-status-20260907`, based on `d9d9d6e709c27f713303aad80381025d93ec63f8`.
- Worktree: `C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\fix-voc-import-status-20260907`.
- Production was inspected read-only. No input replay, provider calls, data edits, service restart, artifact activation, push or deployment was performed.
- Selected ASIN remains authoritative. A primary report ASIN mismatch is an explicit confirmation advisory, including full-width parentheses; comparison ASINs do not silently retarget a request.
- B0CDW797MM's long report is an older same-ASIN saved record, not a response cached for another ASIN. Its empty negative-feedback dimension is valid under the shared schema, but the old PostgreSQL snapshot trigger rejected it when included in cumulative publication. This could leave a durable revision saved while publication/terminal transaction rolled back.
- Queue reuse previously admitted superseded failed attempts which the worker would not claim. Missing-terminal status could remain pending after final failure. Client discovery/polling could also stop silently or complete before the matching revision became readable.

## Fresh verification ledger

- Final client after `94f4534`: 58/58 passed using `node --conditions=react-server --import tsx --test --test-reporter=spec tests/alexa-voc-import-validation.test.ts tests/agent/alexa-voc-normalization-status-client.test.ts tests/agent/manual-alexa-voc-import-feedback.test.ts tests/agent/manual-alexa-voc-client-store.test.ts tests/agent/alexa-voc-import-panel-browser.test.ts`. This includes four mounted panel lifecycle tests; no skipped/cancelled tests. The later test-only `de67e4c` correction awaits Playwright's `addInitScript` in a void-returning callback; its fresh mounted rerun passed 4/4 and targeted lint passed.
- Final post-review server run at `47ebdba`: 134 tests, 130 passed, exactly the same four baseline failures below, no skipped/cancelled tests. Command: `node --conditions=react-server --import tsx --test --test-reporter=spec tests/agent/manual-alexa-voc-sqlite-repository.test.ts tests/agent/postgres-manual-alexa-voc-store-unit.test.ts tests/agent/postgres-manual-alexa-voc-store.test.ts tests/agent/postgres-migrations.test.ts tests/agent/alexa-voc-normalization-worker.test.ts tests/agent/manual-alexa-voc-service.test.ts tests/agent/manual-alexa-voc-routes.test.ts tests/agent/postgres-data-snapshot-repository.test.ts tests/agent/data-snapshot-repository.test.ts`. Node emitted its expected experimental SQLite API warning. Earlier initial run was 128/132 before two new PostgreSQL regressions were added.
- Existing mounted application browser regressions: 10/10 passed using `node --conditions=react-server --import tsx --test --test-reporter=spec tests/agent/primary-admin-browser.test.ts`. A test-owned headless browser and loopback Vite server exercised canonical VOC sync, same-scope workspaces, terminal runtime refresh, late old-workspace responses and historical run isolation. No user browser was attached. Specific import-panel lifecycle coverage is included in the 58-test client run above.
- Production build: `npm run build` passed (exit 0). Source fingerprint at `b04304b` matches `dist/build-fingerprint.json`: `9c2418b201bf34ea8aa8ddca89b7ddcee060c6ae2307440026f787d67b333305`. Build reports the existing large-chunk warning and vinext static route-classification limitation; neither was changed in this repair.
- New-build tutorial/feedback browser regression: `node --test --test-reporter=spec tests/agent/alexa-voc-tutorial-browser.test.mjs` passed 7/7 using a test-owned loopback production Web process and headless browser. This did not restart the formal stack.
- Mounted import-panel tests pass 4/4 and final task re-review is Approved. The stale-scope test holds a valid exact old-scope LIST response, neutralizes fixture-level abort only for that request, then releases it after project/run change and verifies no old callback or state is applied. The standalone fixture screenshot was inspected for status content (ASIN, applying revision, existing revision and indeterminate progress), not accepted as proof of full-page production styling because it omits page-scoped styles.
- Full TypeScript check (`tsc --noEmit --incremental false --pretty false`) is not green: a fresh coordinator compiler-API pass at `de67e4c` found 343 diagnostics in the repair worktree versus 361 in the previously inspected integration workspace. In the affected source/test file set, both show the same pre-existing `manual-alexa-voc-import-feedback.test.ts:167` TS2353 extra `disposition` property; no new diagnostics remain in that set. The new browser-test TS2345 introduced by the stale-scope fixture was corrected in `de67e4c`. The integration workspace retains unrelated generated-data changes, so global diagnostic totals are informational, not a clean-baseline equivalence claim. Whole-project type cleanup is outside this repair.
- Final changed-file ESLint: exit 0, no errors/warnings. Checked the three changed app TypeScript files, both repository files, and all changed TypeScript tests/harnesses; the final test-only correction also passed its targeted rerun. `git diff --check` passes; Git reports only its LF/CRLF conversion notices.

## Independent task review

- Server `8fec086..47ebdba`: spec compliant, quality Approved, no Critical/Important findings. All three initial Important findings closed: actual durable recovery eligibility, real PostgreSQL transitions and actual legacy schema upgrade.
- Server Minor retained for final review: queue/status eligibility logic is repeated across PG/SQLite. It is consistent and behaviorally tested now; future claim-rule changes must update all corresponding predicates together.
- Client `b04304b..94f4534`: final task review spec compliant, quality Approved, no Critical/Important/Minor findings. Earlier blocking lifecycle/test issues are closed.
- Final whole-branch review of `d9d9d6e709c27f713303aad80381025d93ec63f8..de67e4c2e19f89204268ee65d3e0e3b2500bac0e`: Approved; no Critical/Important findings. The server predicate-duplication Minor above remains non-blocking. Ready for OpenSpec joint integration review, not production deployment or replay.

## Existing baseline failures (not introduced by this repair)

The following four assertions failed identically on unchanged integration base `d9d9d6e` as well as the repair branch. Related source/test files were checked unchanged at the baseline before isolated reruns.

| Test file | Test name |
| --- | --- |
| `tests/agent/data-snapshot-repository.test.ts` | same semantic identity is idempotent and content drift conflicts |
| `tests/agent/data-snapshot-repository.test.ts` | different hashes racing in worker isolates close as one drift conflict |
| `tests/agent/postgres-data-snapshot-repository.test.ts` | PostgreSQL VOC snapshot semantic identity is idempotent and detects content drift |
| `tests/agent/postgres-data-snapshot-repository.test.ts` | two PostgreSQL pools serialize same-hash and different-hash snapshot races |

These tests expect different valid content hashes to conflict. Existing commit `08599a7` and migration `0023` added `content_hash` to VOC snapshot semantic identity to support cumulative snapshots, so distinct valid hashes now persist separately. Same-hash idempotency remains required. OpenSpec independently confirmed this contract history and agreed to keep old assertion maintenance separate from the present repair. The extended suite is **not fully green**; do not report otherwise.

## Production recovery and OpenSpec coordination

- No automatic replay of the old run. Snapshot `9ec06711-35cd-42a4-a146-aef1764071cd` selected B07R56PTMS but contains a report headed B0F18D9B5V. It must not be blindly requeued. Use a new isolated/manual test submission after explicitly choosing the intended target; do not restart the whole old run as a recovery shortcut.
- Integration worktree belongs to the OpenSpec window and has unrelated generated-file changes. This branch does not overwrite them.
- The running formal service was observed on an older immutable artifact (`1eb1d4e` source lineage), while the integration worktree is at `d9d9d6e`. Building source is not evidence that the running service uses it. OpenSpec owns joint integration/release review and must verify activated artifact identity separately.
- Deliver final locked HEAD plus this report to `[OpenSpec] 同步流水线稳定化 指令窗口` before any merge/release. Preserve this worktree and branch.

## Related reports

- `docs/verification/2026-09-07-voc-import-client-report.md`
- `docs/verification/2026-09-07-voc-import-server-report.md`
- `docs/superpowers/specs/2026-09-07-voc-import-status-design.md`
- `docs/superpowers/plans/2026-09-07-voc-import-status.md`
