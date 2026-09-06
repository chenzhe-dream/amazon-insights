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

## Limitations

- Whole-branch build and combined server/client verification are owned by the coordinating task.
- Server queue, terminal derivation, publication repair, and production recovery remain separate from this client report.
- No live request, provider operation, browser control, restart, deployment, or push was performed.
