# Realtime VOC Task 7 RED evidence

- Recorded at: 2026-08-31 (Asia/Shanghai)
- Command: `npx tsx --conditions=react-server --test tests/agent/voc-data-source.test.ts tests/agent/manual-alexa-voc-legacy-source.test.ts`
- Exit code: `1`
- Result: `12` tests discovered, `3` passed, `9` failed.

Expected failure evidence:

1. `ERR_MODULE_NOT_FOUND` for `server/data/legacy-manual-alexa-voc-source`, proving the owner-gated server-only legacy source did not yet exist.
2. New DB-first reader cases failed in the old synchronous reader at `readAlexaSource` with `Cannot read properties of undefined (reading 'meta')`, proving the old constructor still interpreted the new `{ manualVoc, legacySource }` dependencies as static module data.
3. Repository error, organization isolation, exact capturedAt, and successful-miss-only fallback assertions therefore remained red before production implementation.

This RED run is separate from the pre-existing baseline failure caused by tests reading the user's current uncommitted `app/rufus-voc-data.ts` generated-data WIP.
