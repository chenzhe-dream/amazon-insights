# Sorftime Catalog Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let new ASIN analysis build a truthful basic product record from bounded Sorftime data when SellerSprite catalog is unavailable, while preserving explicit unavailable fields and provider provenance.

**Architecture:** A strict Sorftime `product_detail` projector creates a catalog-compatible fallback record. The catalog stage tries SellerSprite first and invokes Sorftime fallback only for still-missing ASINs; both append through the existing atomic catalog writer, and the page distinguishes full SellerSprite records from fallback records.

**Tech Stack:** Node.js 22.13+, ESM scripts, MCP Sorftime client, TypeScript/React, node:test, PostgreSQL sync lifecycle tests.

## Global Constraints

- Current stable version is frozen; work in an independent worktree and branch.
- SellerSprite remains the preferred catalog source whenever it returns a strict valid record.
- Project only documented and bounded Sorftime fields; reject arbitrary objects and never label Sorftime data as SellerSprite.
- LQS, video/EBC badge, Buy Box seller, and every absent or unverified field remain unavailable.
- SIF remains the only keywords/traffic source; do not modify SIF parsers or traffic semantics.
- Do not weaken tenant, project identity, concurrency, readiness, provider accounting, or failure isolation gates.
- Run one focused implementation verification and one independent limited review; only Critical or direct business blockers permit rework.
- Preserve protected business WIP and keep the index limited to this task.

---

### Task 1: Strict Sorftime fallback projection

**Files:**
- Create: `scripts/lib/sorftime-catalog-fallback.mjs`
- Test: `tests/scripts/sorftime-catalog-fallback.test.mjs`

**Interfaces:**
- Consumes: one Sorftime `product_detail` response, marketplace, and ASIN.
- Produces: `buildCatalogEntryFromSorftime({ asin, marketplace, detail }): CatalogFallbackEntry` with `catalogSource: "sorftime-fallback"` and `synced: false`.

- [ ] **Step 1: Write RED fixtures for valid, partial, and invalid Sorftime data**

```js
test("projects only bounded Sorftime fields and keeps SellerSprite-only fields unavailable", () => {
  const entry = buildCatalogEntryFromSorftime({ asin: "B0TEST0001", marketplace: "US", detail: {
    asin: "B0TEST0001", title: "Magnetic Power Bank", brand: "Fixture", main_image: ["https://m.media-amazon.com/a.jpg"],
    price: 29.99, star_rating: 4.5, review_count: 120, fba_fee: 4.2, node_id: "123", online_date: "2026-01-02",
  }});
  assert.equal(entry.catalogSource, "sorftime-fallback");
  assert.equal(entry.buyBoxSeller, "暂缺（SellerSprite）");
  assert.equal(entry.synced, false);
  assert.equal(entry.title, "Magnetic Power Bank");
});

test("rejects ASIN mismatch and invalid known-field scalar types without persisting unrelated keys", () => {
  assert.throws(() => buildCatalogEntryFromSorftime({ asin: "B0TEST0001", marketplace: "US",
    detail: { asin: "B0OTHER001", title: "x" } }), /ASIN/);
  assert.throws(() => buildCatalogEntryFromSorftime({ asin: "B0TEST0001", marketplace: "US",
    detail: { asin: "B0TEST0001", title: [] } }), /schema/);
  const projected = buildCatalogEntryFromSorftime({ asin: "B0TEST0001", marketplace: "US",
    detail: { asin: "B0TEST0001", title: "x", unrelated_vendor_field: { secret: "must-not-project" } } });
  assert.equal(JSON.stringify(projected).includes("unrelated_vendor_field"), false);
  assert.equal(JSON.stringify(projected).includes("must-not-project"), false);
});
```

- [ ] **Step 2: Run RED**

Run: `node --test tests/scripts/sorftime-catalog-fallback.test.mjs`

Expected: FAIL because the projector does not exist.

- [ ] **Step 3: Implement a closed allowlist and catalog-compatible projection**

```js
const allowed = new Set(["asin", "title", "brand", "main_image", "price", "star_rating", "review_count",
  "fba_fee", "node_id", "node_name", "parent_asin", "online_date", "a_plus"]);

export function buildCatalogEntryFromSorftime({ asin, marketplace, detail }) {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) throw new TypeError("Sorftime catalog schema invalid");
  const data = Object.fromEntries(Object.entries(detail).filter(([key]) => allowed.has(key)));
  if (data.asin != null && String(data.asin).toUpperCase() !== asin) throw new TypeError("Sorftime catalog ASIN mismatch");
  const text = (value, fallback) => value == null ? fallback : typeof value === "string" ? value.trim() || fallback
    : (() => { throw new TypeError("Sorftime catalog schema invalid"); })();
  const number = value => value == null ? null : Number.isFinite(Number(value)) ? Number(value)
    : (() => { throw new TypeError("Sorftime catalog schema invalid"); })();
  const images = parseImageList(data.main_image);
  return {
    asin, marketplace, catalogSource: "sorftime-fallback", brand: text(data.brand, "品牌暂缺"),
    image: images[0] ?? "", title: text(data.title, asin), price: number(data.price), sales: null,
    rating: number(data.star_rating), reviews: number(data.review_count), rank: null, subRank: null,
    rankCategory: "类目名称暂缺", subRankCategory: text(data.node_name, "类目名称暂缺"),
    buyBoxSeller: "暂缺（SellerSprite）", fulfillment: number(data.fba_fee) == null ? "暂缺" : "FBA 费用已获取",
    packageSize: "—", packageWeight: "—", specifications: ["Sorftime 基础商品兜底"],
    launch: text(data.online_date, "—").slice(0, 10), format: "—", variants: data.parent_asin ? "存在父子体关系" : "—",
    history: [], prices: [], ranks: [], variantShare: [], variantDetails: [], sellingPoints: ["待 Listing 与评论模块补充"],
    strengths: ["Sorftime 基础数据已获取"], weaknesses: ["SellerSprite 专属字段暂缺"], unmet: ["待补充"],
    scenarios: ["待分析"], audiences: ["待分析"], keywords: [], traffic: { natural: 0, sponsored: 0, recommendation: 0 },
    synced: false,
  };
}
```

The implementation must read only the names in `allowed`; additional provider keys are ignored and never copied, logged, hashed, or persisted. Known allowlisted fields with invalid types fail closed.

- [ ] **Step 4: Run GREEN**

Run: `node --test tests/scripts/sorftime-catalog-fallback.test.mjs`

Expected: PASS with 0 failures.

### Task 2: SellerSprite-first catalog orchestration

**Files:**
- Create: `scripts/build-catalog-from-sorftime.mjs`
- Modify: `scripts/lib/catalog-sync.mjs`
- Modify: `scripts/run-asin-sync-job.mjs:565-620`
- Modify: `package.json:35-58`
- Test: `tests/scripts/asin-sync-job-postconditions.test.mjs`
- Test: `tests/agent/sync-job-production-main-resume.test.ts`

**Interfaces:**
- Produces: `npm run catalog:sorftime:sync` using `SORFTIME_ASINS` and `SORFTIME_MARKETPLACE`.
- Preserves: one catalog stage and one job/run/stage identity; no new business entity is created by fallback.

- [ ] **Step 1: Add RED orchestration tests**

```ts
test("catalog falls back to Sorftime only for ASINs still missing after SellerSprite", async () => {
  const result = await runFixture({ sellerSprite: "unavailable", sorftimeCatalog: "ready", asins: ASINS });
  assert.deepEqual(result.calls, ["catalog:sync", "catalog:sorftime:sync"]);
  assert.equal(result.job.asinProgress[ASINS[0]].catalog.status, "ready");
  assert.equal(result.catalog[ASINS[0]].catalogSource, "sorftime-fallback");
});

test("valid SellerSprite catalog never invokes fallback", async () => {
  const result = await runFixture({ sellerSprite: "ready", sorftimeCatalog: "must-not-call", asins: ASINS });
  assert.deepEqual(result.calls, ["catalog:sync"]);
  assert.equal(result.catalog[ASINS[0]].catalogSource, "sellerSprite");
});
```

- [ ] **Step 2: Run RED**

Run: `node --test tests/scripts/asin-sync-job-postconditions.test.mjs && npm exec -- tsx --conditions=react-server --test tests/agent/sync-job-production-main-resume.test.ts`

Expected: fallback assertions fail.

- [ ] **Step 3: Add the bounded fallback command**

```js
const sellerResult = providers.run({ connector: "sellerSprite", stage: "catalog", asins: catalogPending,
  label: "catalog:sync", command: "npm", args: ["run", "catalog:sync"],
  env: { SELLERSPRITE_ASINS: catalogPending.join(","), SELLERSPRITE_MARKETPLACE: marketplace } });
const stillMissing = asinsNeedingCatalogSync(catalogPending);
const fallbackResult = stillMissing.length ? providers.run({ connector: "sorftime", stage: "catalog", asins: stillMissing,
  label: "catalog:sorftime:sync", command: "npm", args: ["run", "catalog:sorftime:sync"],
  env: { SORFTIME_ASINS: stillMissing.join(","), SORFTIME_MARKETPLACE: marketplace } }) : null;
applyPersistedStagePostcondition(jobId, "catalog", catalogPending, {
  commandSucceeded: stillMissing.length === 0 || Boolean(fallbackResult?.succeeded),
  resultStatusesByAsin: readCatalogFallbackStatuses(catalogPending),
});
```

- [ ] **Step 4: Prove bounded fallback dispatch and provider accounting**

```ts
const result = await runFixture({ sellerSprite: "unavailable", sorftimeCatalog: "ready", asins: ASINS });
assert.equal(result.physicalAttempts.filter(item => item.operation === "product_detail" && item.stage === "catalog").length, ASINS.length);
assert.equal(result.physicalAttempts.filter(item => item.stage === "catalog").every(item => item.accountedExactlyOnce), true);
assert.equal(result.calls.filter(call => call === "catalog:sorftime:sync").length, 1);
```

The fallback command performs at most one governed `product_detail` dispatch per still-missing ASIN in the catalog stage, with zero retries inside the command. Other existing Sorftime stages keep their current independently governed calls; this slice does not introduce an unbounded retry or duplicate outer accounting record.

- [ ] **Step 5: Run GREEN and affected tests**

Run: `node --test tests/scripts/sorftime-catalog-fallback.test.mjs tests/scripts/asin-sync-job-postconditions.test.mjs`

Run: `npm exec -- tsx --conditions=react-server --test tests/agent/sync-job-production-main-resume.test.ts tests/agent/sync-job-dispatcher.test.ts tests/agent/sync-provider-readiness-gate.test.ts`

Expected: all pass with 0 failures.

### Task 3: Provenance display and final gates

**Files:**
- Modify: `app/page.tsx:110-160,509-550`
- Test: `tests/agent/sorftime-catalog-fallback-display.test.tsx`

- [ ] **Step 1: Add RED display test**

```tsx
test("Sorftime fallback is visible without claiming SellerSprite-only fields", () => {
  const html = renderProduct(fallbackProduct);
  assert.match(html, /Sorftime 基础数据/);
  assert.match(html, /SellerSprite 专属字段暂缺/);
  assert.doesNotMatch(html, /卖家精灵已同步/);
});
```

- [ ] **Step 2: Add `catalogSource?: "sellerSprite" | "sorftime-fallback"` to `Product`, set `catalogSource: "sellerSprite"` in `buildCatalogEntryFromSellerSprite`, and render source-specific copy**

```ts
function sellerSpriteOnlyFieldsUnavailable(product: Product) {
  return product.catalogSource === "sorftime-fallback" || !product.synced;
}
```

- [ ] **Step 3: Run final focused verification**

Run: `npm exec -- tsx --conditions=react-server --test tests/agent/sorftime-catalog-fallback-display.test.tsx tests/agent/sync-job-production-main-resume.test.ts tests/agent/sync-job-dispatcher.test.ts`

Run: `node --test tests/scripts/sorftime-catalog-fallback.test.mjs tests/scripts/asin-sync-job-postconditions.test.mjs`

Run: `npx eslint scripts/lib/sorftime-catalog-fallback.mjs scripts/build-catalog-from-sorftime.mjs scripts/lib/catalog-sync.mjs scripts/run-asin-sync-job.mjs app/page.tsx tests/scripts/sorftime-catalog-fallback.test.mjs tests/agent/sorftime-catalog-fallback-display.test.tsx && git diff --check`

Expected: all commands exit 0.

- [ ] **Step 4: Commit this slice**

```powershell
git add package.json scripts/lib/sorftime-catalog-fallback.mjs scripts/build-catalog-from-sorftime.mjs scripts/lib/catalog-sync.mjs scripts/run-asin-sync-job.mjs app/page.tsx tests/scripts/sorftime-catalog-fallback.test.mjs tests/scripts/asin-sync-job-postconditions.test.mjs tests/agent/sync-job-production-main-resume.test.ts tests/agent/sorftime-catalog-fallback-display.test.tsx
git commit -m "feat: add Sorftime catalog fallback"
```
