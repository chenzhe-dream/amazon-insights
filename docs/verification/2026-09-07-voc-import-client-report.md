# Task 1 report: client identity advisory and truthful import progress

## Scope

- Branch: `codex/fix-voc-import-status-20260907`
- Starting commit: `57620ca`
- Client-only implementation. No server, provider, production data, restart, deploy, or push actions.
- Selected ASIN remains authoritative. A primary-report mismatch changes only the confirmation copy/button; it never retargets the request.

## TDD evidence

RED command:

`node_modules/.bin/tsx --conditions=react-server --test tests/alexa-voc-import-validation.test.ts tests/agent/alexa-voc-normalization-status-client.test.ts`

Observed RED: the new poll-step export was absent; the full-width primary title fell through to a comparison ASIN. The run reported 12 passing and 3 failing tests (the third failure was an already-stale panel source assertion that still named `text` instead of the existing request-bound `selectedDraft`).

GREEN command:

`node_modules/.bin/tsx --conditions=react-server --test tests/alexa-voc-import-validation.test.ts tests/agent/alexa-voc-normalization-status-client.test.ts tests/agent/manual-alexa-voc-import-feedback.test.ts tests/agent/manual-alexa-voc-client-store.test.ts`

Result: 51 tests passed, 0 failed, 0 skipped.

Behavior coverage includes full-width primary parentheses, mismatch confirmation, comparison-ASIN exclusion, network/non-2xx/malformed status reads, GET-only recovery, status-success/read-lag applying state, exact revision/fingerprint/ASIN selection, project/run query isolation, missing status processing, explicit terminal failure, stale fingerprint protection, scope changes, accessible indeterminate progress, elapsed waiting, and distinct pre-existing revision/capture-time copy.

## Verification

`node_modules/.bin/eslint app/alexa-voc-import-validation.ts app/lib/alexa-voc-normalization-status-client.ts app/alexa-voc-import-panel.tsx tests/alexa-voc-import-validation.test.ts tests/agent/alexa-voc-normalization-status-client.test.ts tests/agent/manual-alexa-voc-import-feedback.test.ts`

Result: exit 0, no lint errors.

`git diff --check`

Result: exit 0; only repository line-ending warnings were printed.

A whole-repository `tsc --noEmit` was attempted after implementation and failed on many pre-existing/unrelated files across app, server, tests, Cloudflare globals, and repository interfaces. It was not established as a clean baseline before this task, so it is not claimed as a Task 1 regression signal. Its generated `tsconfig.tsbuildinfo` change was restored and is not included.

## Implementation and limitations

- `pollAlexaVocNormalizationOnce` validates both status and committed-record payloads and returns a small truthful phase union. Recoverable read failures expose fixed safe copy and remain in the polling loop.
- Completion requires the request-bound ASIN, fingerprint, and exact revision to be readable and accepted by `onImported`.
- The status retry control aborts/restarts only the scoped GET poll; it never resubmits the import POST.
- The UI reports target ASIN, processing/applying/failure/done transitions, elapsed seconds, and any existing revision/capture timestamp without synthetic percentage or queue position.
- Server-side terminal derivation and publication cause/recovery are intentionally outside Task 1 and remain for Task 2.
