# VOC import client repair report

## Result

Client import identity and polling behavior were repaired without changing server code or contacting production/provider surfaces.

- The selected ASIN remains the request target; full-width primary-title parentheses are recognized and comparison ASIN labels are excluded from mismatch detection.
- Polling validates project, run, ASIN, fingerprint, and exact revision. Status success remains visibly `applying` until the matching committed record is readable and accepted.
- Network, non-2xx, malformed status, and discovery errors use fixed bounded copy. Pending polling continues automatically; explicit retries restart only GET status reads and never resubmit the import POST.
- Initial discovery success is converted to a pending client observation so it cannot stop an existing/read-lag poll or claim UI completion before exact-record application.
- Both discovery and per-record results pass through the same abort-aware delivery guard. An aborted deferred operation cannot invoke state updates or `onImported`.
- Pending UI names the target, distinguishes processing from applying, reports elapsed waiting, keeps any pre-existing revision/capture time distinct, and uses a native indeterminate `<progress>` without fake percentages.

## TDD evidence

Initial Task 1 RED:

`node_modules/.bin/tsx --conditions=react-server --test tests/alexa-voc-import-validation.test.ts tests/agent/alexa-voc-normalization-status-client.test.ts`

Observed failures: missing poll-step API and full-width primary header falling through to a comparison ASIN.

Independent-review RED:

`node_modules/.bin/tsx --conditions=react-server --test tests/agent/alexa-voc-normalization-status-client.test.ts`

Observed failure: missing abort-aware result delivery, discovery normalization, and recoverable discovery API.

Final focused GREEN:

`node_modules/.bin/tsx --conditions=react-server --test tests/agent/alexa-voc-normalization-status-client.test.ts tests/agent/manual-alexa-voc-import-feedback.test.ts tests/agent/manual-alexa-voc-client-store.test.ts tests/alexa-voc-import-validation.test.ts`

Result: 54 passed, 0 failed, 0 skipped.

Targeted lint:

`node_modules/.bin/eslint app/alexa-voc-import-panel.tsx app/lib/alexa-voc-normalization-status-client.ts tests/agent/alexa-voc-normalization-status-client.test.ts tests/agent/manual-alexa-voc-import-feedback.test.ts`

Result: exit 0, no errors.

`git diff --check`: exit 0; only existing Windows line-ending warnings were emitted.

## Mounted panel follow-up

The production `AlexaVocImportPanel` was mounted through an isolated Vite server and headless Playwright Chromium with every `/api/*` request intercepted locally and non-loopback traffic blocked.

RED command:

`node_modules/.bin/tsx --conditions=react-server --test tests/agent/alexa-voc-import-panel-browser.test.ts`

Observed RED: 0 passed and 4 failed because the production-panel harness did not yet exist.

GREEN command:

`node_modules/.bin/tsx --conditions=react-server --test tests/agent/alexa-voc-import-panel-browser.test.ts`

Result: 4 passed, 0 failed, 0 skipped. The mounted tests cover visible discovery failure plus GET-only retry, native valueless progress and existing-version copy, success/list-read lag through exact application, an explicitly deferred old-scope response released after scope switch, visible terminal failure, and card-specific draft preservation without implicit POST.

Fixture screenshot: `test-results/voc-client-applying.png` (untracked test artifact, applying state with existing revision visible).

Final stale-scope discrimination rerun:

`node_modules/.bin/tsx --conditions=react-server --test tests/agent/alexa-voc-import-panel-browser.test.ts`

Result: 4 passed, 0 failed, 0 skipped. The stale-scope case now route-discriminates normalization status from the record list, holds a valid exact old-scope LIST record, removes the abort signal only for that controlled fixture fetch, switches project/run, releases the valid response, and waits for fulfillment plus two animation frames before asserting zero `onImported` calls and no old applying/success state.

Final compiler follow-up: the root compiler gate identified one new test-only `TS2345` because the `beforeGoto` callback returned Playwright's `Disposable` from `addInitScript` instead of `void`. The callback now awaits `addInitScript` inside an async block. A fresh mounted run passed 4/4, targeted ESLint exited 0, and a full `tsc --noEmit --incremental false --pretty false` diagnostic capture contained no diagnostics for `tests/agent/alexa-voc-import-panel-browser.test.ts`. Unrelated whole-repository TypeScript diagnostics remain outside this client-test correction.

Follow-up lint command:

`node_modules/.bin/eslint app/alexa-voc-import-panel.tsx tests/agent/alexa-voc-import-panel-browser.test.ts tests/agent/helpers/alexa-voc-import-panel-browser-harness.tsx`

## Limitations

- Whole-branch build and combined server/client verification are owned by the coordinating task.
- Server queue, terminal derivation, publication repair, and production recovery remain separate from this client report.
- The screenshot verifies rendered behavior and text only. The small harness imports global styles but not every page-scoped presentation stylesheet, so it is not visual-regression evidence.
- No live request, provider operation, user-browser attachment, restart, deployment, or push was performed. Browser activity was limited to the isolated local headless fixture harness.
