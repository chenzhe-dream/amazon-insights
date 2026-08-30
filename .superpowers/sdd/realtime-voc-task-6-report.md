# Realtime Manual Alexa VOC Task 6 Report

## Scope

- Implemented the Agent service import/list API and the Web thin proxies only.
- Reused the real pure parser `processAlexaVocText(rawText, asin, options)` and removed parsing duplication from the legacy pipeline.
- Kept the existing shared contract route: `POST /v1/manual-alexa-voc/import`; the list route is `GET /v1/manual-alexa-voc`.
- Did not change reader/page code, use a live database/provider/browser, or load a real encryption key.

## RED evidence

The implementation was driven through focused failing tests before each production slice:

1. Service import tests failed with `ERR_MODULE_NOT_FOUND` for `manual-alexa-voc-service.ts`.
2. Service list isolation test failed because a fake repository returned cross-organization and unrequested-ASIN rows.
3. Invalid normalized metadata test initially surfaced a raw `ZodError` instead of the typed service validation error.
4. Pure-parser reuse test failed because the pipeline exported a separate function identity.
5. Agent route tests returned 404 before the manual Alexa VOC routes were registered.
6. Web proxy tests failed because the list proxy did not exist and the import route still used the legacy filesystem pipeline.

Each failure was confirmed as missing/incorrect Task 6 behavior before the minimal production change.

## GREEN evidence

Focused verification command:

```text
npx tsx --conditions=react-server --test tests/agent/manual-alexa-voc-service.test.ts tests/agent/manual-alexa-voc-routes.test.ts tests/agent/alexa-voc-mutation-routes.test.ts tests/alexa-voc-import-validation.test.ts
```

Result: **31 tests passed, 0 failed**.

The focused suites cover the real parser fixture, canonical write projection, revision/timestamp propagation, deterministic hashes, encrypted raw storage, list isolation, proxy behavior, and error mapping. All storage/encryption doubles are isolated fakes.

## Zero-write validation

The service tests assert that no transaction, repository write, or encryption occurs for:

- invalid ASIN or non-US marketplace;
- missing/both `text` and `rawText`;
- malformed seven-dimension normalized metadata;
- report-ASIN mismatch;
- fewer than three filled VOC dimensions;
- raw UTF-8 content over 128 KiB.

The exact 128 KiB UTF-8 boundary is accepted and 128 KiB + 1 byte is rejected.

## Authentication and proxy

- Agent routes run behind the existing internal proxy-token, trusted-Origin, and Cookie/session authorization hooks; member and admin principals are accepted.
- The Web import proxy authorizes through `createAgentServiceClient` before reading the request body.
- The Web proxy accepts exactly one of `text` or `rawText`, defaults compatibility requests to marketplace `US`, and forwards the canonical contract body.
- Both Web routes use `createAgentServiceClient`; no handwritten `fetch` is present.
- The GET proxy reconstructs a clean bounded query and forwards only marketplace and unique ASIN values.

## Redaction and failure semantics

- Import/list responses are projected through strict public response schemas and do not include raw VOC text, ciphertext, raw/content hashes, organization ownership, or actor metadata.
- Missing storage configuration returns safe `CONFIGURATION_ERROR` 503.
- Typed repository/infrastructure failure returns a distinct safe `INFRASTRUCTURE_ERROR` 503.
- Unexpected errors remain delegated to the global redacted error handler.

## TypeScript verification

The repository-wide `npx tsc --noEmit` is currently blocked by pre-existing errors in protected generated app-data files and unrelated sync/publication/Cloudflare code. Filtering that same compiler output for the Task 6 paths produced no Task 6 TypeScript errors. The compiler-generated `tsconfig.tsbuildinfo` change was restored and is not dirty.

## Protected WIP audit

- Protected roots checked: 36.
- Actual protected files after directory expansion: 37.
- Missing protected paths: 0.
- Sorted path-plus-content SHA-256 manifest: `6aa7d631a6e3e864e64ca9624dac209077dd8cba62138f6969442d299cea27d2`.
- None of the protected generated app-data, project/publication data, or Task 3 report paths were staged, restored, deleted, or edited by Task 6.

## Commit discipline

- Only the explicit Task 6 implementation/test paths and this report are staged.
- No `git add ./`, amend, push, WIP cleanup, reader, or page changes are included.

## Independent review remediation

The follow-up review against commit `047a38d` was addressed with a second TDD cycle:

- **Auth-before-body RED:** a direct Agent import carrying a trusted proxy token and Origin but a missing or invalid Cookie plus malformed JSON returned `400`, proving Fastify parsed the body before the session `preHandler`.
- **Auth-before-body GREEN:** manual Alexa VOC paths now run the shared session/role authentication function in `onRequest`, while every non-manual route retains the original `preHandler` ordering. Both missing and invalid sessions return safe `401 AUTHENTICATION_REQUIRED` before JSON parsing and before any service call.
- **List validation RED:** direct invalid list input leaked a raw `ZodError`.
- **List validation GREEN:** the service boundary now maps invalid list input to `ManualAlexaVocServiceError` with kind `validation`, before repository access.
- **Canonical hash characterization:** the real fixture already met the required composition. The test now independently computes the canonical hash from exactly marketplace, ASIN, normalized schema version, parser version, normalized record, and raw-report SHA-256, then also asserts the fixture's fixed raw and content digests. This coverage addition was directly GREEN because no production hash correction was required.

The focused Task 6 command now reports **33 passed, 0 failed**. The combined Task 6 plus authentication, session, password, service-security, and concurrency route regression command reports **69 passed, 0 failed** and confirms the general Agent body-limit route still returns `413` after the manual-only hook scope. A TypeScript run using a temporary build-info file remains non-zero for the previously documented repository-wide errors but reports zero error lines for the four review-remediation source/test paths. The unrelated connector credential test returns the same `500` with both the original `preHandler` and the temporary global `onRequest` A/B configurations; it is therefore recorded as a pre-existing baseline failure and was not changed under Task 6 scope.
