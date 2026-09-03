# Image Display And Overview Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display the current MCP image/price/rank results truthfully, remove stale diagnostic contamination, then run one gated AI image-analysis batch.

**Architecture:** Browser image tags use normalized CDN URLs directly. A pure projection resolves SellerSprite-first, Sorftime-second overview values. Provider diagnostics are scoped at the runner boundary before they affect readiness. AI analysis remains a separate post-deployment operation.

**Tech Stack:** Next.js, React, TypeScript, Node test runner, generated MCP TypeScript data, PostgreSQL-backed Agent service.

## Global Constraints

- Do not call SIF, Sorftime, or SellerSprite during implementation or tests.
- Do not create or resume any sync job.
- Preserve all existing generated application WIP and project JSON files outside commits.
- Never fabricate missing SellerSprite-only fields.
- Do not automatically re-enable image analysis in every future sync job in this change.
- Use TDD and commit only the task's approved files.

---

### Task 1: Direct Amazon image rendering

**Files:**
- Modify: `app/lib/amazon-image.ts`
- Modify: `tests/agent/listing-images-section.test.tsx`

**Interfaces:**
- Consumes: `normalizeAmazonImageUrl(url)` and the existing Amazon-host allowlist.
- Produces: `amazonMediaSrc(url)` returning the normalized direct URL for a valid Amazon image URL.

- [ ] Add a failing test asserting Amazon gallery, product-header, and preview image sources are direct normalized HTTPS CDN URLs and never `/api/amazon-image`.
- [ ] Run `npx tsx --test tests/agent/listing-images-section.test.tsx`; confirm the new assertion fails because the source starts with `/api/amazon-image`.
- [ ] Change `amazonMediaSrc` so a valid Amazon-host URL returns `normalized`; keep empty/invalid handling and existing non-Amazon behavior unchanged.
- [ ] Re-run the focused test and confirm all cases pass.
- [ ] Commit only these two files with `fix: render persisted Amazon images directly`.

### Task 2: Sorftime overview fallback

**Files:**
- Create: `app/lib/competitor-overview-fallback.ts`
- Modify: `app/page.tsx`
- Modify: `tests/agent/asin-sync-session.test.ts`

**Interfaces:**
- Produces: `latestReadyTrendValue(record, field): number | null` for `price` and `rank`.
- Produces: `resolveOverviewPrice(productPrice, trendRecord): { value: number | null; source: "sellerSprite" | "sorftime" | null }`.
- Produces: `resolveOverviewRank(productRank, productSubRank, trendRecord): { value: number | null; source: "sellerSprite" | "sorftime" | null }`.

- [ ] Add browser/session assertions for a placeholder product with ready Sorftime trends: current price and rank are rendered; SellerSprite-only fields remain unavailable; the overview badge reads `MCP 综合`.
- [ ] Run the targeted test and confirm it fails with `—`/old source labelling.
- [ ] Implement the pure projection and use it only in the overview price/rank rows. The newest point is the last finite, nonnegative trend point; no category label is invented for Sorftime rank.
- [ ] Re-run the targeted and full `asin-sync-session.test.ts` suite.
- [ ] Commit only the three approved files with `fix: project Sorftime fallback into overview`.

### Task 3: Scope provider diagnostics to the active invocation

**Files:**
- Modify: `scripts/run-asin-sync-job.mjs`
- Modify: `tests/agent/provider-degradation-job-scope.test.ts`
- Modify: `tests/agent/sync-job-production-main-resume.test.ts`

**Interfaces:**
- Produces: `diagnosticsForInvocation(diagnostics, { connector, stage, asins })`, returning only exact connector/stage/current-ASIN diagnostics.

- [ ] Add a failing runner test where a successful Sorftime Listing command emits historical SellerSprite/other-ASIN diagnostics; assert Listing stays ready and persisted diagnostics exclude them.
- [ ] Run the focused test and confirm the old runner marks the stage partial or persists unrelated diagnostics.
- [ ] Filter diagnostics immediately after command execution and use only the filtered list for persistence, degradation tracking, and per-ASIN status.
- [ ] Re-run provider-degradation and production-resume suites; confirm real provider-wide failure behavior remains job-local and unchanged.
- [ ] Commit only the three approved files with `fix: scope sync diagnostics to invocation`.

### Task 4: Combined review and deployment gate

**Files:**
- Update only ignored task reports under `.superpowers/sdd/`.

- [ ] Run the three focused suites, changed-file lint, scoped diff-check, and exactly one production build.
- [ ] Independently review the full range for Critical and direct business blockers.
- [ ] Verify migrations `15/15`, active jobs/stages/runs `0`, fake mode disabled, ports `31900/31901/58258` healthy, port `3000` absent, and protected WIP hashes unchanged.
- [ ] Deploy the exact reviewed SHA through the existing persistent supervisor session; do not touch PostgreSQL.
- [ ] Verify one existing image URL through the deployed page route and direct CDN source without clicking or creating a job.

### Task 5: One bounded AI image-analysis batch

**Files:**
- Generated output: `app/listing-image-remarks.ts`

- [ ] Confirm the deployed page renders all 21 current images and the configured OpenAI key is present without printing it.
- [ ] Run exactly once with `REMARK_ASINS=B01FHOWYA2,B0855B5Z6F,B08QZWDLP4 npm run image-remarks:sync`; do not use `--force`.
- [ ] If authentication, quota, timeout, or schema validation fails, stop without retry and report the bounded reason.
- [ ] If successful, verify remarks correspond only to the three requested ASINs, build once, review the generated diff, and deploy through the same health gate.
- [ ] Confirm the page shows image type and Chinese remark beneath each analyzed static image; video thumbnails retain the fixed non-analysis note.
