# VOC local rule routing repair

> Execute the user-approved repair inline in the isolated candidate; preserve other windows' changes.

**Goal:** Keep VOC normalization and durable snapshots, without implicitly enqueueing model positioning for the local-rule application.

**Architecture:** Gate the cumulative snapshot publisher with a server-owned `positioningMode: "local-rules" | "model"`. Default to local rules; explicitly wire the application and normalization worker to local rules. A model caller must opt in. Apply the same policy to direct imports, durable normalization commits, and replay publication.

**Tech Stack:** TypeScript, Node test runner, SQLite, isolated PostgreSQL test container, existing React/Next UI.

## Constraints

- Preserve existing UI/cards/history, authorization, cutoff scope, original input, normalization, snapshot persistence, saved local reports, and failure history.
- No production task cancellation, manual data repair, new model request, or unrelated VOC expansion.
- Existing model mode remains bounded by its configured queue deadline. The observed 5-minute request exhausted most of the 7-minute cycle; the remaining retry was automatically expired. This is not evidence of manual cancellation or data loss. Do not extend shared timeout budgets to fix an unwanted task.

## Tasks

- [ ] Add a regression in `tests/agent/alexa-voc-local-rule-publication.test.ts`: publish a valid snapshot with omitted/local mode and assert zero downstream job access; explicit model mode still enqueues. Run it and observe the existing unwanted wake.
- [ ] In `server/runtime/alexa-voc-normalization-runtime.ts`, carry `positioningMode` from runtime options into both commit and replay publication. Use `snapshot.created && input.positioningMode === "model"` as the wake condition. Snapshot creation remains unconditional.
- [ ] In `server/services/manual-alexa-voc-service.ts`, pass the server-owned mode through both direct/reused import publication paths. Explicitly configure local rules in `server/app.ts` and `server/agent-service.ts`.
- [ ] Extend import tests and SQLite/PostgreSQL recovery scenarios to verify local mode preserves results and replay while never creating positioning stages. Keep the existing model recovery tests in explicit model mode.
- [ ] Run normalization/import/publication/local-report and queue-safety regressions, typecheck and production build. Verify the actual project entry and waiting/ready/history UI before release.
- [ ] Review formal checkout/active jobs, commit the isolated changes, then publish through `manage-formal-stack.ps1 -PublishCode` only if idle. Keep a rollback reference. Verify online health, actual entry and no accidental model enqueue. Record any verification limits.

## Commands

```powershell
npx tsx --conditions=react-server --test tests/agent/alexa-voc-local-rule-publication.test.ts tests/agent/manual-alexa-voc-service.test.ts tests/agent/alexa-voc-normalization-worker.test.ts tests/agent/alexa-voc-publication-boundaries.test.ts
npx tsx --conditions=react-server --test tests/agent/alexa-voc-multi-asin-recovery.test.ts tests/agent/voc-queue-safety.test.ts
npx tsx --test tests/agent/voc-local-rules.test.tsx tests/agent/local-rule-reports.test.ts
npm run typecheck
npm run build
```

## Verification before release

- Regression initially reproduced the bug: omitted/local mode created positioning jobs (`true !== false`); explicit model behavior passed. After the gate all 6 publication cases passed.
- 61 normalization/import/publication/local-report tests passed; 104 SQLite/PostgreSQL recovery and queue-safety tests passed. PostgreSQL used disposable Docker test containers, not formal tables.
- Latest formal release advanced to `15dd3404` during this work. Merged it into the candidate (`975d2bb1`), preserving the other window's export/readiness changes. Re-ran 21 local-rule/browser/export tests, typecheck and production build successfully.
- Total distinct regression cases: 186. Existing worker test fixture was corrected to give queued jobs their database `startedAt: null`, without changing worker behavior.
- Actual normal member login opened the affected four-ASIN project's definition and positioning pages. Stable local readiness was confirmed after workspace loading; no model/run/import POSTs, browser errors, or incident data changes. Counts remained 9 job attempts, 9 agent audit rows, 9 snapshots, 0 model reports. Temporary test members were disabled and sessions revoked.
- The absence of a model report remains historical fact; this fix does not retry or rewrite that failed task. Local rules can use the saved four normalized inputs. No shared timeout configuration changed.
- Browser fixture verifies waiting/normalization/ready transitions and retained report frame; actual project screenshots are in ignored `test-results/voc-local-routing/`. Release verification will be appended after the managed publish.
