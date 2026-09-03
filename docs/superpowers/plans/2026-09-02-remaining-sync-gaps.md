# Remaining Sync Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish verified data from partial stages, expose the three omitted projectable stages with exact bounded causes, prevent false child-sales empties, and retry failed image slots only in later jobs.

**Architecture:** Generated exports remain the projection source and PostgreSQL remains the authoritative stage-output store. A closed partial-output branch carries filtered data plus itemized safe gaps; the browser reads data from both `done` and `partial`. Provider adapters and requests stay unchanged; only already-proven parser results and allowlisted diagnostics are propagated.

**Tech Stack:** Node.js 22, TypeScript/TSX, Zod, React/Vinext, PostgreSQL sync repository, Node test runner.

## Global Constraints

- Base design commit: `4751d32` on `codex/fix-remaining-sync-gaps-20260902`.
- Scope is only: partial success publication; `child_sales`, `price_strategy`, `image_remarks` projectability; bounded cause fidelity; child-sales verified-empty correctness; later-job image retry.
- Do not handle Alexa VOC variants/aliases, guess Provider fields, change Provider requests, call real Providers, issue business POST requests, deploy, restart services, or touch production PostgreSQL/credentials.
- Do not rewrite generated business-data files. Tests use injected readers or isolated fixtures.
- Preserve image concurrency `4`, timeout `120_000` ms, resource-governor admission, and one queue pass per job.
- Every production edit follows observed RED, minimal GREEN, then a dedicated commit.

---

### Task A: Publish partial data, add three projectable stages, and preserve bounded causes

**Files:**
- Modify: `shared/agent-contracts.ts`
- Modify: `server/db/sync-job-repository.ts`
- Modify: `server/db/postgres/sync-job-store.ts`
- Modify: `server/services/sync-publication-status-service.ts`
- Modify: `scripts/lib/provider-diagnostics.mjs`
- Modify: `scripts/lib/sync-stage-output.mjs`
- Modify: `scripts/run-asin-sync-job.mjs`
- Modify: `app/lib/runtime-analysis-data.ts`
- Modify: `app/lib/runtime-analysis-data-server.ts`
- Modify: `app/lib/stage-output-browser.ts`
- Modify: `app/lib/stage-output-view.ts`
- Modify: `app/listing-images-section.tsx`
- Modify: `app/stage-output-gap-card.tsx`
- Modify: `app/page.tsx`
- Test: `tests/scripts/sync-stage-output.test.mjs`
- Test: `tests/scripts/asin-sync-job-postconditions.test.mjs`
- Test: `tests/scripts/provider-bounded-diagnostics.test.mjs`
- Test: `tests/agent/stage-output-contract.test.ts`
- Test: `tests/agent/stage-output-browser.test.ts`
- Test: `tests/agent/sync-stage-output-persistence.test.ts`
- Test: `tests/agent/sync-publication-reconciliation.test.ts`
- Test: `tests/agent/runtime-analysis-data.test.ts`
- Test: `tests/agent/stage-output-gap-card.test.tsx`
- Test: `tests/agent/asin-sync-session.test.ts`

**Interfaces:**
- Extend every closed projectable-stage set/path/publication allowlist from seven to ten with `child_sales`, `price_strategy`, `image_remarks`.
- Fixed new data keys: `child_sales.rowsByAsin`; `price_strategy.strategyByAsin`; `image_remarks.remarksByAsin` and `image_remarks.outcomesByAsin`.
- `partial` contains both `data` and `gap`; `done` remains data-only; `failed` remains gap-only.
- `gap.items` is sorted/deduplicated, maximum 32, and contains only `asin`, fixed `causeCode`, and optional allowlisted `operation`, `boundary`, fixed-field type/presence `shape`.
- Preserve `SIF_KEYWORD_SCHEMA_INVALID`, `MCP_SCHEMA`, and exact transport causes; synthesize `UPSTREAM_EMPTY` only when no stronger safe cause exists.

- [ ] **Step 1: Write contract/projection RED tests.** Extend exhaustive stage loops to ten stages. Add a partial fixture with two ready ASINs and one `MCP_SCHEMA` gap item; assert fixed projection keys, requested-scope filtering, canonical item order, persistence of both JSON branches, browser acceptance, and cause-sensitive hash. Reject raw text, unknown cause/operation/boundary/shape keys, more than 32 items, `failed + data`, and `done + gap`.

```ts
const partial = {
  ...base, stage: "reviews", stageStatus: "partial",
  data: { analysisByAsin: {
    B000000001: { status: "ready" }, B000000002: { status: "ready" },
  }, ratingByAsin: {} },
  gap: { state: "partial", reasonCode: "MCP_SCHEMA", items: [{
    asin: "B000000003", causeCode: "MCP_SCHEMA",
    operation: "product_reviews", boundary: "tool-content",
  }] },
};
assert.equal(LocalDataStageOutputResponseSchema.safeParse(partial).success, true);
```

- [ ] **Step 2: Run contract/projection RED.**

Run: `node --test tests/scripts/sync-stage-output.test.mjs tests/scripts/asin-sync-job-postconditions.test.mjs tests/scripts/provider-bounded-diagnostics.test.mjs`

Run: `npx tsx --conditions=react-server --test tests/agent/stage-output-contract.test.ts tests/agent/stage-output-browser.test.ts tests/agent/sync-stage-output-persistence.test.ts tests/agent/sync-publication-reconciliation.test.ts`

Expected: FAIL because partial is gap-only, the three ids are not projectable, and runner reconciliation discards causes.

- [ ] **Step 3: Implement the closed contract and projection.** Update shared schema, repository types/validators/parser, PostgreSQL `data_json` + `gap_json` handling, browser hash, publication allowlist, route regexp, projector source map, and final publication reconciliation together. No migration: stage id is text and both JSON columns exist. For `done|partial`, filter projection records to requested ASINs proven ready. Hash `{stage,data,gap}` for partial.

```ts
type StageOutputDraft =
  | Base & { stageStatus: "done"; data: StageData; gap?: never }
  | Base & { stageStatus: "partial"; data: StageData; gap: StageOutputGap }
  | Base & { stageStatus: "failed"; data?: never; gap: StageOutputGap };
```

- [ ] **Step 4: Preserve causes without adapter changes.** Pass existing sanitized diagnostics into stage finalization/projector; read `SIF_KEYWORD_SCHEMA_INVALID` only from the strict keyword result; retain `MCP_SCHEMA` operation/boundary/shape; add `UPSTREAM_EMPTY` only for unexplained missing ASINs. Never copy message/body/URL/header/credential/unknown key/value.

- [ ] **Step 5: Write page/read RED tests.** Assert `buildStageOutputView()` consumes `data` from `done|partial`; all three new maps overlay only returned ASINs; comparison rows use dynamic child-sales/price maps; `ListingImagesSection` receives dynamic remark/outcome resolvers; gap cards display the failed ASIN and exact safe cause while successful data remains visible.

- [ ] **Step 6: Run page/read RED.**

Run: `npx tsx --conditions=react-server --test tests/agent/runtime-analysis-data.test.ts tests/agent/stage-output-gap-card.test.tsx tests/agent/asin-sync-session.test.ts`

Expected: FAIL because the view reads only `done` and the page uses compile-time child-sales/price/image exports.

- [ ] **Step 7: Wire the read model/UI and run GREEN.** Add `childSalesByAsin`, `priceStrategyByAsin`, `imageRemarksByAsin`, `imageRemarkOutcomesByAsin` to runtime fallbacks/view; use them in the table/image section; add labels/cards for the three stages. Static exports remain fallbacks.

Run the commands from Steps 2 and 6.

Expected: all selected tests PASS; 2-ready/1-schema-failure publishes two records plus one exact bounded gap; all ten stages generate/read hashes.

- [ ] **Step 8: Commit.**

Commit: `fix(sync): publish bounded partial stage outputs`

### Task B: Make child-sales verified-empty require a recognized empty container

**Files:**
- Modify: `scripts/build-sorftime-child-sales.mjs`
- Modify: `scripts/lib/scoped-sorftime-evidence.mjs`
- Modify: `scripts/lib/scoped-sorftime-fallbacks.mjs`
- Create: `tests/scripts/sorftime-child-sales-parse.test.mjs`
- Test: `tests/scripts/scoped-sorftime-module-fallback.test.mjs`
- Test: `tests/scripts/asin-data-status.test.mjs`

**Interfaces:**
- Export `parseVariationRows(raw)` returning `{ containerRecognized, rawRowCount, validSalesRowCount, rows }`.
- Set `verifiedEmpty` only when `containerRecognized === true && rawRowCount === 0`.
- `rawRowCount > 0 && validSalesRowCount === 0` is a schema gap, never a verified empty.

- [ ] **Step 1: Write parser RED tests.** Cover `{data: []}` as verified empty; valid rows as ready; nonempty rows with invalid/missing sales as schema gap; missing/null/unknown containers as unverified. Assert only counts/types, not raw row values, reach diagnostics.

```js
assert.deepEqual(parseVariationRows({ data: [] }), {
  containerRecognized: true, rawRowCount: 0, validSalesRowCount: 0, rows: [],
});
const invalid = parseVariationRows({ data: [{ Asin: "B000000001", SalesAmount: "bad" }] });
assert.equal(invalid.rawRowCount, 1);
assert.equal(invalid.validSalesRowCount, 0);
```

- [ ] **Step 2: Run RED.**

Run: `node --test tests/scripts/sorftime-child-sales-parse.test.mjs tests/scripts/scoped-sorftime-module-fallback.test.mjs`

Expected: FAIL because the builder filters invalid rows and computes `verifiedEmpty` from `normalRows.length === 0`.

- [ ] **Step 3: Implement minimal semantics.** Use the pure parser in direct fetch and same-job evidence normalization; carry only container/count metadata; require a recognized zero-row container for empty. Keep current aliases; do not accept new wrappers or guess an adapter.

- [ ] **Step 4: Run GREEN and commit.**

Run: `node --test tests/scripts/sorftime-child-sales-parse.test.mjs tests/scripts/scoped-sorftime-module-fallback.test.mjs tests/scripts/asin-data-status.test.mjs`

Expected: all selected tests PASS; malformed nonempty child rows cannot display “confirmed no child sales.”

Commit: `fix(sync): reject false child sales empties`

### Task C: Requeue failed image slots in later jobs and run final gates

**Files:**
- Modify: `scripts/lib/image-remark-outcome.mjs`
- Modify: `scripts/lib/image-remark-queue.mjs`
- Modify: `scripts/build-listing-image-remarks.mjs`
- Test: `tests/scripts/image-remarks-concurrency.test.mjs`
- Test: `tests/scripts/build-listing-image-remarks-source.test.mjs`
- Test: `tests/scripts/asin-sync-job-postconditions.test.mjs`

**Interfaces:**
- Persist only fixed `status`, fixed `reason`, and `attemptJobId` for `connector-failed|timeout`; ready drops attempt identity and remains reusable.
- `shouldQueueImageRemarkSlot({ outcome, force, jobId })`: ready skips unless forced; failed/timeout skip in the same valid job and queue in a different valid job; invalid/missing job id fails closed.
- Do not add inner retries or alter concurrency, timeout, or governor behavior. `upstream-empty` behavior is unchanged.

- [ ] **Step 1: Write queue RED tests.** Assert ready reuse, same-job failed/timeout skip, later-job failed/timeout queue, invalid job id fail-closed, force override, and unchanged `4`/`120_000` limits.

- [ ] **Step 2: Run RED.**

Run: `node --test tests/scripts/image-remarks-concurrency.test.mjs`

Expected: FAIL because current terminal-cache logic permanently skips failed/timeout and stores no job identity.

- [ ] **Step 3: Implement job-aware outcomes.** Read `AGENT_SYNC_JOB_ID`, pass it to selection, attach it only to failed/timeout outcomes, preserve it through atomic metadata merge, and remove it on ready.

- [ ] **Step 4: Add isolated two-job coverage.** Run fixture job A to persist failed/timeout slots; rerun A and assert zero requests; run job B and assert exactly those slots submit once while a ready sibling stays cached. Assert endpoint/key/body/URL/arbitrary error is absent from metadata.

- [ ] **Step 5: Run image GREEN.**

Run: `node --test tests/scripts/image-remarks-concurrency.test.mjs tests/scripts/build-listing-image-remarks-source.test.mjs tests/scripts/asin-sync-job-postconditions.test.mjs`

Expected: all selected tests PASS; only a later job retries failed/timeout slots under existing bounds.

- [ ] **Step 6: Run all affected tests.**

Run: `node --test tests/scripts/sync-stage-output.test.mjs tests/scripts/provider-bounded-diagnostics.test.mjs tests/scripts/asin-sync-job-postconditions.test.mjs tests/scripts/scoped-sorftime-module-fallback.test.mjs tests/scripts/sorftime-child-sales-parse.test.mjs tests/scripts/asin-data-status.test.mjs tests/scripts/image-remarks-concurrency.test.mjs tests/scripts/build-listing-image-remarks-source.test.mjs`

Run: `npx tsx --conditions=react-server --test tests/agent/stage-output-contract.test.ts tests/agent/stage-output-browser.test.ts tests/agent/sync-stage-output-persistence.test.ts tests/agent/sync-publication-reconciliation.test.ts tests/agent/runtime-analysis-data.test.ts tests/agent/stage-output-gap-card.test.tsx tests/agent/asin-sync-session.test.ts`

Expected: all affected tests PASS without real Provider/network calls.

- [ ] **Step 7: Run changed lint, one build, and diff/scope gates.**

Run: `npx eslint shared/agent-contracts.ts server/db/sync-job-repository.ts server/db/postgres/sync-job-store.ts server/services/sync-publication-status-service.ts app/lib/runtime-analysis-data.ts app/lib/runtime-analysis-data-server.ts app/lib/stage-output-browser.ts app/lib/stage-output-view.ts app/listing-images-section.tsx app/stage-output-gap-card.tsx app/page.tsx tests/agent/stage-output-contract.test.ts tests/agent/stage-output-browser.test.ts tests/agent/sync-stage-output-persistence.test.ts tests/agent/sync-publication-reconciliation.test.ts tests/agent/runtime-analysis-data.test.ts tests/agent/stage-output-gap-card.test.tsx tests/agent/asin-sync-session.test.ts`

Run: `npm run build`

Run: `git diff --check 4751d32..HEAD`

Run: `git status --short`

Expected: ESLint/build/diff-check exit `0`; no generated business data, credentials, runtime files, Provider request changes, VOC variant work, deployment changes, or uncommitted edits.

- [ ] **Step 8: Commit.**

Commit: `fix(sync): retry failed image slots in later jobs`

---

## Self-Review Result

- Task A covers partial publication, all three omitted projectable stages, bounded cause fidelity, persistence/hash, and page reading.
- Task B covers child-sales false-empty semantics without changing Provider shapes.
- Task C covers only failed/timeout later-job image retry plus final gates.
- Stage ids, data keys, gap shape, RED/GREEN commands, and commit boundaries are consistent; unrelated architecture and live operations remain excluded.
