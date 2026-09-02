# VOC Input Data Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Alexa normalization identity ASIN-safe and make Sorftime zero-value caches truthful without changing Provider integrations.

**Architecture:** Keep the current service, worker, script, and UI boundaries. Add small pure predicates/typed guards at the existing decision points, bind marketplace and trusted ASIN into the existing fingerprint, and gate all other gaps behind a read-only evidence inventory.

**Tech Stack:** TypeScript, React, Node.js ESM, Zod, `node:test`, local fake HTTP fixtures.

## Global Constraints

- P0 main path only; YAGNI; TDD.
- Do not call a real Provider, deploy, push, restart, or send a real POST.
- Do not modify generated data files, including `app/sorftime-rating-data.ts`, `app/sorftime-review-analysis-data.ts`, or other `app/*-data.ts` exports.
- Preserve user WIP and unrelated changes; do not expand the architecture.
- B074 `product_reviews` remains `MCP_SCHEMA` at `tool-content`; do not guess an adapter without actual response evidence.
- Base commit: `5ac4b7a016ac7ea6c69c1d13eead7e20062365d4`.

---

### Task 1: Bind Alexa validation and execution identity to the trusted ASIN

**Files:**

- Modify: `server/domain/voc/alexa-voc-normalization-contracts.ts:142-153,236-242,385-393`
- Modify: `server/services/manual-alexa-voc-service.ts:56-64,109-140,350-366`
- Modify: `server/services/alexa-voc-normalization-execution-service.ts:153-160`
- Modify: `server/services/alexa-voc-normalization-worker-handler.ts:1-8,155-174`
- Modify: `server/routes/manual-alexa-voc.ts:49-87`
- Test: `tests/agent/alexa-voc-normalization-contracts.test.ts`
- Test: `tests/agent/manual-alexa-voc-service.test.ts`
- Test: `tests/agent/manual-alexa-voc-routes.test.ts`
- Test: `tests/agent/alexa-voc-normalization-worker.test.ts`

**Interfaces:**

- Produces `AlexaVocAsinMismatchError` and `assertAlexaVocRawReportMatchesAsin(rawText: string, trustedAsin: string): void`.
- Changes `createAlexaVocNormalizationFingerprint` input to `{ marketplace: "US"; asin: string; rawReportSha256: string; executionIdentity: AlexaVocNormalizationExecutionIdentity }`.
- Produces the stable HTTP contract `422 / ALEXA_VOC_ASIN_MISMATCH` without raw report details.

- [ ] **Step 1: Write failing contract and service tests for trusted identity and pre-enqueue rejection.**

  Add fingerprint assertions proving the same raw hash/config differs across `B0NORM0001` and `B0NORM0002`, and assert every call supplies the trusted `marketplace: "US"`. Replace the current “queues ASIN-mismatched” expectation with:

  ```ts
  await assert.rejects(
    harness.service.importReport({
      principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
      request: importRequest(REPORT.replaceAll(ASIN, "B07VY9Q95Q")),
    }),
    (error: unknown) => error instanceof ManualAlexaVocServiceError && error.kind === "asin-mismatch",
  );
  assert.equal(harness.queueInput(), null);
  assert.equal(harness.normalizationEncryptionInput(), null);
  ```

  Add a same-run/two-ASIN fixture using the same explicitly mismatched text; assert both requests fail before a normalization snapshot/job exists and the injected model/Provider counter remains `0`. Preserve the separate incomplete-report case as pending normalization.

- [ ] **Step 2: Write failing route and worker-classification tests.**

  In the route test, throw `new ManualAlexaVocServiceError("asin-mismatch", "unsafe fixture detail")` and assert:

  ```ts
  assert.equal(response.statusCode, 422);
  assert.equal(response.json().error.code, "ALEXA_VOC_ASIN_MISMATCH");
  assert.doesNotMatch(response.body, /unsafe fixture detail|rawText|B07VY9Q95Q/);
  ```

  In the worker test, throw `new AlexaVocAsinMismatchError()` from the service stub and assert `onTerminal` receives `category: "schema"`, while the existing model-output, authorization, repository, and infrastructure cases retain their current classifications.

- [ ] **Step 3: Run the RED tests.**

  Run:

  ```bash
  npx tsx --conditions=react-server --test tests/agent/alexa-voc-normalization-contracts.test.ts tests/agent/manual-alexa-voc-service.test.ts tests/agent/manual-alexa-voc-routes.test.ts tests/agent/alexa-voc-normalization-worker.test.ts
  ```

  Expected: FAIL because fingerprint lacks marketplace/ASIN, mismatches are queued, the route has no mismatch code, and the worker defaults the typed input failure to persistence.

- [ ] **Step 4: Implement the minimal typed guard and fingerprint binding.**

  Define the domain error/guard around the existing regex scan, preserving reports with no explicit ASIN:

  ```ts
  export class AlexaVocAsinMismatchError extends Error {
    constructor() {
      super("Alexa report ASIN conflicts with trusted scope");
      this.name = "AlexaVocAsinMismatchError";
    }
  }

  export function assertAlexaVocRawReportMatchesAsin(rawText: string, trustedAsin: string): void {
    const asin = AsinSchema.parse(trustedAsin);
    const reportAsins = extractExplicitReportAsins(rawText);
    if (reportAsins.some(candidate => candidate !== asin)) throw new AlexaVocAsinMismatchError();
  }
  ```

  Call this guard in `importReport` after `#authorizeImport` and report-size validation but before hashing/parsing/queueing. Add `"asin-mismatch"` to `ManualAlexaVocServiceError.kind`, translate the domain error once in the service, and map it in the route to 422/`ALEXA_VOC_ASIN_MISMATCH`. Keep the renderer guard as defense in depth.

  Update every fingerprint call with trusted scope:

  ```ts
  createAlexaVocNormalizationFingerprint({
    marketplace: snapshot.marketplace,
    asin: snapshot.asin,
    rawReportSha256: snapshot.rawReportSha256,
    executionIdentity,
  });
  ```

  In `classifyTerminalFailure`, map `AlexaVocAsinMismatchError` to `schema` before the persistence default. Do not add a database category or migration.

- [ ] **Step 5: Run GREEN and commit Task 1.**

  Run the Step 3 command again. Expected: PASS; mismatch assertions show zero queue/model/Provider work, and two ASIN fingerprints differ.

  ```bash
  git add server/domain/voc/alexa-voc-normalization-contracts.ts server/services/manual-alexa-voc-service.ts server/services/alexa-voc-normalization-execution-service.ts server/services/alexa-voc-normalization-worker-handler.ts server/routes/manual-alexa-voc.ts tests/agent/alexa-voc-normalization-contracts.test.ts tests/agent/manual-alexa-voc-service.test.ts tests/agent/manual-alexa-voc-routes.test.ts tests/agent/alexa-voc-normalization-worker.test.ts
  git commit -m "fix(voc): bind Alexa normalization to trusted ASIN"
  ```

### Task 2: Invalidate Sorftime zero caches and expose truthful UI status

**Files:**

- Modify: `scripts/build-sorftime-rating.mjs:26-39,41-95`
- Modify: `scripts/build-sorftime-review-analysis.mjs:22-77,110-124`
- Modify: `app/page.tsx:552-664,3584-3590`
- Test: `tests/scripts/commerce-data-validity.test.mjs`
- Test: `tests/scripts/sorftime-review-verified-empty.test.mjs`
- Test: `tests/agent/primary-admin-page.test.ts`

**Interfaces:**

- Produces `shouldReuseSorftimeRatingRecord({ record, catalog, asin, marketplace, forceRefresh? }): boolean`.
- Produces `shouldReuseSorftimeReviewRecord({ record, ratingRecord, catalog, asin, marketplace, forceRefresh? }): boolean`.
- Keeps the existing generated record shapes and Provider APIs unchanged.

- [ ] **Step 1: Write failing cache-policy tests.**

  Add table tests showing a scoped ready rating `0/0` is rejected when catalog has `rating > 0` or `reviews > 0`, while a non-conflicting ready record is reusable. Extend the temporary review-script fixture with an existing ready-empty record and current rating evidence, then assert:

  ```js
  assert.equal(shouldReuseSorftimeReviewRecord({
    record: readyEmpty,
    ratingRecord: { ...rating, reviewCount: 941 },
    catalog: { rating: 4.4, reviews: 941 },
    asin,
    marketplace: "US",
    forceRefresh: false,
  }), false);
  ```

  Exercise both the main cache-hit path and Provider-error catch path with the local fake server: stale ready-empty must finish as `error`, not remain `ready`; current trusted zero evidence must preserve the existing zero-call test.

- [ ] **Step 2: Write the failing UI test.**

  Export `ReviewAnalysisMatrixSection` from `app/page.tsx` for the existing server-render test. Render one ready-empty record with `statusMessage: "Sorftime product_detail 已确认该 ASIN 评论数为 0"`; assert the HTML contains that message and `独立 Sorftime 数据源，不继承上方 Alexa VOC`, and does not use `暂无匹配主题` for that record.

- [ ] **Step 3: Run the RED tests.**

  Run:

  ```bash
  node --test tests/scripts/commerce-data-validity.test.mjs tests/scripts/sorftime-review-verified-empty.test.mjs
  npx tsx --conditions=react-server --test tests/agent/primary-admin-page.test.ts
  ```

  Expected: FAIL because ready cache reuse happens before the catalog check, stale ready-empty survives normal/catch paths, and the ready UI ignores `statusMessage`.

- [ ] **Step 4: Implement one evidence-aware predicate per generator and reuse it in every cache branch.**

  Rating predicate:

  ```js
  export function shouldReuseSorftimeRatingRecord({ record, catalog, asin, marketplace, forceRefresh }) {
    return record?.asin === asin && record?.marketplace === marketplace &&
      shouldUseCachedRecord(record, { forceRefresh }) &&
      !hasCatalogRatingReviewConflict(record.rating, record.reviewCount, catalog);
  }
  ```

  Use it for the no-key availability check, per-ASIN cache hit, and failed-fetch cache retention. Review predicate must reuse ordinary ready records, but require `isVerifiedEmptyReviewEvidence(ratingRecord, asin, marketplace)` and no catalog conflict whenever `record.sampledReviews === 0 && record.blocks.length === 0`. Use that predicate in the same three branches; do not alter `callSorftimeTool`, `projectSorftimeConsumerCandidate`, retry behavior, or generated output schemas.

  In the ready cell render:

  ```tsx
  <span className="ss-review-empty">
    {analysis.statusMessage ?? "暂无匹配主题"}
  </span>
  ```

  Prefix the section description with `下方为独立 Sorftime 数据源，不继承上方 Alexa VOC；`.

- [ ] **Step 5: Run GREEN and commit Task 2.**

  Run the Step 3 commands again. Expected: PASS; stale zero caches miss, verified zero remains provider-free, and rendered HTML exposes the truthful status/source.

  ```bash
  git add scripts/build-sorftime-rating.mjs scripts/build-sorftime-review-analysis.mjs app/page.tsx tests/scripts/commerce-data-validity.test.mjs tests/scripts/sorftime-review-verified-empty.test.mjs tests/agent/primary-admin-page.test.ts
  git commit -m "fix(voc): invalidate unsupported Sorftime zero caches"
  ```

### Task 3: Classify remaining gaps without changing Provider adapters

**Files:**

- Create: `docs/superpowers/reports/2026-09-02-voc-input-data-gap-inventory.md`
- Read only: `.superpowers/sdd/`, safe job/stage diagnostics, `scripts/lib/provider-diagnostics.mjs`, `server/connectors/mcp-transport.mjs`, `scripts/lib/sorftime-mcp-client.mjs`

**Interfaces:**

- Produces an inventory row shape: `ASIN | stage | operation | failureKind | causeCode | boundary | trusted evidence | local reproduction | disposition`.
- Produces only one of `fixed-by-task-1`, `fixed-by-task-2`, `external/provider-evidence-required`, or `separate-plan-required`.

- [ ] **Step 1: Build the read-only inventory from retained safe diagnostics.**

  Do not print or retain secrets or response bodies. Record B074 `product_reviews` as `schema / MCP_SCHEMA / tool-content / external/provider-evidence-required`; note that current diagnostics expose unknown shape and therefore cannot justify an adapter.

- [ ] **Step 2: Reproduce only deterministic local-code candidates with existing fake fixtures.**

  Run:

  ```bash
  node --test tests/scripts/provider-bounded-diagnostics.test.mjs tests/scripts/provider-degradation.test.mjs tests/scripts/sorftime-review-verified-empty.test.mjs tests/scripts/commerce-data-validity.test.mjs
  ```

  Expected: PASS. No command may use a real endpoint or credential. If a candidate cannot be reproduced locally without inventing a Provider body, mark it `external/provider-evidence-required`.

- [ ] **Step 3: Apply the evidence gate.**

  If the inventory proves another code defect, stop and create a separate design/plan for review; do not append conditional implementation to this task. Otherwise commit only the inventory:

  ```bash
  git add docs/superpowers/reports/2026-09-02-voc-input-data-gap-inventory.md
  git commit -m "docs(voc): classify remaining input data gaps"
  ```

## Final verification

- [ ] Run all focused tests without real Provider access:

  ```bash
  npx tsx --conditions=react-server --test tests/agent/alexa-voc-normalization-contracts.test.ts tests/agent/manual-alexa-voc-service.test.ts tests/agent/manual-alexa-voc-routes.test.ts tests/agent/alexa-voc-normalization-worker.test.ts tests/agent/primary-admin-page.test.ts
  node --test tests/scripts/commerce-data-validity.test.mjs tests/scripts/sorftime-review-verified-empty.test.mjs tests/scripts/provider-bounded-diagnostics.test.mjs tests/scripts/provider-degradation.test.mjs
  npx tsc --noEmit
  npm run build
  git diff --check 5ac4b7a016ac7ea6c69c1d13eead7e20062365d4..HEAD
  ```

  Expected: all tests, typecheck, build, and diff check PASS. Inspect `git diff --name-only` and confirm no generated data file, migration, MCP adapter, lockfile, secret, runtime data, deploy file, or unrelated WIP changed.

## Plan self-review

- **Spec coverage:** Task 1 covers Alexa pre-enqueue 422, fingerprint identity, zero-call regression, and typed worker classification. Task 2 covers rating conflict-before-cache, review ready-empty lifetime, catch-path reuse, and UI source/status truth. Task 3 enforces the evidence gate for B074 and every remaining gap.
- **Placeholder scan:** No deferred marker, unnamed error-handling instruction, or unspecified test step remains.
- **Type consistency:** Both Alexa enqueue and execution recomputation consume the same four fingerprint fields. Sorftime predicates consume current record, trusted scope, and catalog/rating evidence; generated DTOs remain unchanged.
