# ASIN Sync Readiness Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all twelve ASIN sync stages report independently persisted readiness, restore current Sorftime trend arrays and relay-based image analysis, and prevent zero-exit jobs from claiming completion when usable data is still missing.

**Architecture:** `scripts/lib/asin-data-status.mjs` remains the canonical persisted-data reader and exposes pure stage-readiness helpers consumed by the runner; the server and client mirror only the resulting typed fields and explicit stage mapping. Focused request helpers normalize the OpenAI-compatible relay URL/model without exposing request or response secrets, while the runner settles every executed stage from fresh persisted status rather than subprocess exit alone.

**Tech Stack:** Node.js >=22.13.0, ECMAScript modules, TypeScript 5.9, React 19, Node test runner, `tsx`, existing generated TypeScript data exports, existing npm scripts; no new package.

## Global Constraints

- Implement only the approved ASIN sync readiness repair; do not redesign the runtime, connectors, sync UI, or generated-data format.
- No runtime/Agent Service refactor, connector redesign, new UI, package dependency, migration, database change, production deployment, login, authorization, Cloudflare, PostgreSQL, concurrency, or audit change.
- Do not change the Sorftime listing request/response protocol, synthesize gallery or secondary images, add automatic Web restart behavior, or migrate generated exports into a runtime data API. The confirmed primary-image-only symptom is stale Web-bundle state, not missing persisted Sorftime images.
- The twelve readiness stages remain exactly `catalog`, `keywords`, `reviews`, `sales_trend`, `child_sales`, `price_strategy`, `fba`, `listing`, `image_remarks`, `category`, `alexa_voc`, and `traffic`; percentage arithmetic remains `ready stage count / 12`, rounded only after counting.
- Alexa VOC remains manual/missing when its existing dialog-capture predicate is false. Do not add a connector, retry, fabricated fixture, readiness override, or automatic Alexa implementation.
- A zero-exit subprocess permits a persisted-data postcondition check; it never proves readiness by itself. Empty, malformed, incomplete, or unusable persisted content remains missing and must not be synthesized as ready.
- `OPENAI_API_KEY` remains the only image-analysis secret. Model precedence is exactly `OPENAI_VISION_MODEL`, then `AGENT_VOC_MODEL`, then `gpt-4o-mini`.
- The image endpoint defaults to `https://api.openai.com/v1/chat/completions`; a configured `OPENAI_BASE_URL` must parse as HTTP(S), contain no embedded credentials or fragment, and resolve to exactly one trailing `/v1/chat/completions` path.
- Never put the base URL, authorization header, API key, model request body, or provider response into generated output, user-facing errors, tests, logs, or commit messages.
- Do not call a real Sorftime, SIF, SellerSprite, Alexa, or image model during RED/GREEN tests. The configured real model may be used only once, in the final manual three-ASIN acceptance run, without printing environment values or secrets.
- The existing modified generated exports under `app/*-data.ts`, `app/competitor-data.ts`, `app/listing-image-remarks.ts`, `app/variant-data.ts`, `docs/runbooks/agent-stack.md`, `data/*.sqlite*`, `data/projects/*`, `.superpowers/`, and any stash are user-owned WIP. Do not intentionally edit, stage, or commit them. Their pre-existing whole-tree line-ending/whitespace warnings are diagnostic only and never block this implementation.
- Generated data may change only as an uncommitted side effect of the final real acceptance run. It is validation evidence, not implementation, and every such file remains unstaged.
- After the final real sync, build one fresh production bundle and restart the controller-owned stack on Web `31900` / Agent `31901` through `scripts/start-agent-stack.mjs prod` before inspecting galleries. This manual freshness gate does not authorize a sync-policy or automatic-restart change.
- Every implementation commit stages only the exact source/test files named in its Task. Before each commit run `git diff --cached --name-only` and stop if any generated, data, runbook, `.superpowers/`, environment, or unrelated file appears.
- Whitespace gates target only the named implementation paths, their implementation commit range, or the staged index. Never repair, normalize, or restage unrelated generated WIP to make a whole-tree `git diff --check` pass; at final handoff report any remaining whole-tree warnings as pre-existing user-WIP diagnostics only.
- Do not use `reset`, `checkout`, `stash`, `clean`, `amend`, `rebase`, or `push`. Each Task ends in one normal new commit.

---

## Exact File Map

**Create:**

- `tests/scripts/sorftime-trend-parse.test.mjs` — supported trend representations and malformed-entry regression coverage.
- `tests/scripts/asin-data-status.test.mjs` — pure persisted-source predicates, stage summaries, Alexa preservation, and the observed nine-of-twelve fixture.
- `tests/agent/asin-sync-readiness.test.ts` — client mirror and explicit stage-to-field mapping arithmetic.
- `tests/scripts/asin-sync-job-postconditions.test.mjs` — zero-exit/missing, command failure, unavailable configuration, ready settlement, and import-without-running coverage.
- `scripts/lib/sorftime-listing-parse.mjs` — pure `main_image` list normalization split from the listing builder for focused tests.
- `tests/scripts/sorftime-listing-parse.test.mjs` — JSON-string multi-image, direct-array, direct-string, and malformed image-list coverage.

**Modify:**

- `scripts/lib/sorftime-trend-parse.mjs` — normalize direct arrays and `{data: string[]}` through the existing month/value parser.
- `scripts/lib/asin-data-status.mjs` — load all persisted sources once, derive independent fields, and expose canonical stage readiness.
- `app/lib/sync-server.ts` — mirror the expanded required status type returned by the ESM helper.
- `app/asin-sync-funnel.tsx` — mirror the type and map every stage ID explicitly; no visual redesign.
- `tests/agent/local-data-bridge.test.ts` — extend its existing typed readiness fixture with the four added module fields.
- `scripts/lib/image-remark-request.mjs` — pure endpoint/model selection and safe provider-response parsing beside the existing timeout helpers.
- `tests/scripts/image-remark-request.test.mjs` — endpoint, model precedence, safe errors, and existing timeout coverage.
- `scripts/build-listing-image-remarks.mjs` — consume the request helpers and canonical per-slot completeness predicate.
- `scripts/run-asin-sync-job.mjs` — settle executed stages from canonical persisted status and expose a testable helper behind a direct-execution guard.
- `scripts/build-sorftime-listing-content.mjs` — import the pure image-list parser; no connector, output-schema, or refresh-policy change.

**Read/verify only:**

- `package.json` — Node floor and exact test/sync commands.
- `C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\feat-voc-positioning-skill-execution\.env.local` — read-only `node --env-file` source for the final real acceptance and stack restart; never copy, print, modify, stage, or commit it. The current worktree intentionally has no `.env.local`, which is not a blocker.
- Existing dirty generated exports — read as pre-run evidence and allow the final acceptance run to refresh them; never implement by hand-editing them.
- `data/sync-jobs/*.json` and `data/sync-jobs/*.log` — final tracer evidence only; never stage or commit.

## Stable Interfaces

The names and shapes below are fixed across all three Tasks.

```js
export const ASIN_SYNC_STAGE_IDS = Object.freeze([
  "catalog",
  "keywords",
  "reviews",
  "sales_trend",
  "child_sales",
  "price_strategy",
  "fba",
  "listing",
  "image_remarks",
  "category",
  "alexa_voc",
  "traffic",
]);

export const STATUS_FIELD_BY_STAGE = Object.freeze({
  catalog: "inCatalog",
  keywords: "keywords",
  reviews: "reviews",
  sales_trend: "sales",
  child_sales: "childSales",
  price_strategy: "priceStrategy",
  fba: "fba",
  listing: "listing",
  image_remarks: "imageRemarks",
  category: "category",
  alexa_voc: "voc",
  traffic: "traffic",
});

export function readAsinStatusSources();
export function deriveAsinModuleStatus(asin, sources);
export function getAsinModuleStatus(asin);
export function getAsinDataStatus(asins);
export function isAsinStageReady(item, stageId);
export function evaluateAsinStageReadiness(stageId, items);
export function readAsinStageReadiness(stageId, asins);
export function hasCompleteImageRemarks(listingRecord, remarkSlots);
```

```ts
export type AsinModuleReadiness = "ready" | "missing";

export type AsinModuleStatus = {
  asin: string;
  inCatalog: boolean;
  keywords: AsinModuleReadiness;
  reviews: AsinModuleReadiness;
  sales: AsinModuleReadiness;
  childSales: AsinModuleReadiness;
  priceStrategy: AsinModuleReadiness;
  fba: AsinModuleReadiness;
  listing: AsinModuleReadiness;
  imageRemarks: AsinModuleReadiness;
  category: AsinModuleReadiness;
  traffic: AsinModuleReadiness;
  voc: AsinModuleReadiness;
};
```

```js
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_IMAGE_REMARK_MODEL = "gpt-4o-mini";
export function imageRemarkEndpoint(env = process.env);
export function imageRemarkModel(env = process.env);
export async function readImageRemarkProviderPayload(response);
```

```js
export function parseImageList(raw);
// Returns every nonblank string from a direct array or JSON-string array;
// a single direct HTTP(S) string becomes a one-item array; malformed input returns [].
```

```js
export function applyPersistedStagePostcondition(
  jobId,
  stageId,
  asins,
  {
    commandSucceeded = true,
    unavailableReason = null,
    readReadiness = readAsinStageReadiness,
    markModule = markAsinModule,
    updateStage = setStage,
    now = () => new Date().toISOString(),
  } = {},
);
// Returns { status: "done" | "failed" | "skipped", missingAsins: string[] }.
```

---

### Task 1: Sorftime Array Parser and Twelve-Stage Readiness Contract

**Files:**
- Create: `tests/scripts/sorftime-trend-parse.test.mjs`
- Create: `tests/scripts/asin-data-status.test.mjs`
- Create: `tests/agent/asin-sync-readiness.test.ts`
- Modify: `scripts/lib/sorftime-trend-parse.mjs:1-44`
- Modify: `scripts/lib/asin-data-status.mjs:1-184`
- Modify: `app/lib/sync-server.ts:7-17,51-61`
- Modify: `app/asin-sync-funnel.tsx:139-199,265-268`
- Modify: `tests/agent/local-data-bridge.test.ts:40-50`

**Interfaces:**
- Consumes: existing `readCachedDataExport(filePath, exportName)`, existing generated export names, and the existing Alexa `captureStatus: "dialog"` predicate.
- Produces: `ASIN_SYNC_STAGE_IDS`, `STATUS_FIELD_BY_STAGE`, expanded `AsinModuleStatus`, `deriveAsinModuleStatus`, `isAsinStageReady`, `evaluateAsinStageReadiness`, `readAsinStageReadiness`, and `hasCompleteImageRemarks` exactly as declared above. Task 2 consumes `hasCompleteImageRemarks`; Task 3 consumes the stage-readiness functions.

- [ ] **Step 1: Write parser RED tests.** Create `tests/scripts/sorftime-trend-parse.test.mjs` with the complete matrix below.

```js
import assert from "node:assert/strict";
import test from "node:test";

import { parseSorftimeTrend } from "../../scripts/lib/sorftime-trend-parse.mjs";

const expected = [
  { month: "2026-01", value: 12 },
  { month: "2026-02", value: 13 },
];

test("product trends normalize current arrays and legacy strings identically", () => {
  assert.deepEqual(parseSorftimeTrend({ data: ["2026年01月=12", "2026年02月=13"] }), expected);
  assert.deepEqual(parseSorftimeTrend(["2026年01月=12", "2026年02月=13"]), expected);
  assert.deepEqual(parseSorftimeTrend("2026年01月=12,2026年02月=13"), expected);
  assert.deepEqual(parseSorftimeTrend({ data: "2026年01月=12,2026年02月=13" }), expected);
  assert.deepEqual(parseSorftimeTrend({ content: "2026年01月=12,2026年02月=13" }), expected);
});

test("product trends discard malformed entries and keep valid month/value pairs", () => {
  assert.deepEqual(
    parseSorftimeTrend({ data: ["bad", "2026年01月=-1", "2026年02月=13", "2026-03=14"] }),
    [
      { month: "2026-02", value: 13 },
      { month: "2026-03", value: 14 },
    ],
  );
  assert.deepEqual(parseSorftimeTrend({ data: ["bad", "2026年01月=NaN"] }), []);
  assert.deepEqual(parseSorftimeTrend({ data: [] }), []);
  assert.deepEqual(parseSorftimeTrend(null), []);
});
```

- [ ] **Step 2: Verify parser RED.** Run:

```powershell
node --test tests/scripts/sorftime-trend-parse.test.mjs
```

Expected: FAIL in `product trends normalize current arrays and legacy strings identically`; actual for `{ data: [...] }` and the direct array is `[]`.

- [ ] **Step 3: Implement one shared trend-input normalizer.** Replace the duplicated representation selection in `scripts/lib/sorftime-trend-parse.mjs` with this exact helper and have both exported parsers map its returned parts through the existing `parseTrendPart`.

```js
function normalizeTrendParts(raw) {
  const value = typeof raw === "string" ? raw : raw?.data ?? raw?.content ?? raw;
  if (Array.isArray(value)) return value.map(item => String(item).trim());
  if (typeof value !== "string" || !value.trim()) return [];
  return value.split(",").map(part => part.trim());
}

export function parseSorftimeTrend(raw) {
  return normalizeTrendParts(raw).map(parseTrendPart).filter(Boolean);
}

export function parseSorftimeCategoryTrend(raw) {
  return normalizeTrendParts(raw).map(parseTrendPart).filter(Boolean);
}
```

- [ ] **Step 4: Verify parser GREEN.** Re-run Step 2. Expected: both tests PASS, including the old string forms and all-invalid empty result.

- [ ] **Step 5: Write canonical readiness RED tests.** Create `tests/scripts/asin-data-status.test.mjs`. Use one in-memory source snapshot so the test neither reads nor writes the dirty generated exports.

```js
import assert from "node:assert/strict";
import test from "node:test";

import {
  ASIN_SYNC_STAGE_IDS,
  deriveAsinModuleStatus,
  evaluateAsinStageReadiness,
  hasCompleteImageRemarks,
} from "../../scripts/lib/asin-data-status.mjs";

const asin = "B0C4XRN398";
const listingRecord = {
  status: "ready",
  galleryImages: ["https://img.test/1.jpg", "https://img.test/play-button.jpg", "https://img.test/2.jpg"],
};

const sources = {
  catalogAsins: [asin],
  keywords: { [asin]: { status: "ready" } },
  reviews: { [asin]: { status: "ready" } },
  sales: { [asin]: { status: "empty", volume: [], amount: [], price: [], rank: [] } },
  childSales: { [asin]: [{ asin, sales: 4 }] },
  priceStrategies: { [asin]: { anchor: "price" } },
  fbaFees: { [asin]: { status: "ready", fbaFee: 5.2 } },
  listing: { [asin]: listingRecord },
  imageRemarks: { [asin]: [{ remark: "one" }, { remark: "video" }, { remark: "" }] },
  categoryTrends: { node: { status: "ready", asins: [asin], volume: [{ month: "2026-01", value: 1 }] } },
  traffic: { [asin]: { overview: { total: 1 }, structure: { chars: { dims: ["search"] } } } },
  vocSource: "export const rufusVocData = {};",
};

test("each persisted source controls only its own stage", () => {
  const status = deriveAsinModuleStatus(asin, sources);
  assert.deepEqual(status, {
    asin,
    inCatalog: true,
    keywords: "ready",
    reviews: "ready",
    sales: "missing",
    childSales: "ready",
    priceStrategy: "ready",
    fba: "ready",
    listing: "ready",
    imageRemarks: "missing",
    category: "ready",
    traffic: "ready",
    voc: "missing",
  });
  assert.deepEqual(ASIN_SYNC_STAGE_IDS, [
    "catalog", "keywords", "reviews", "sales_trend", "child_sales", "price_strategy",
    "fba", "listing", "image_remarks", "category", "alexa_voc", "traffic",
  ]);
});

test("sales needs a usable point and image remarks need every analyzable slot", () => {
  assert.equal(hasCompleteImageRemarks(listingRecord, sources.imageRemarks[asin]), false);
  const readySources = {
    ...sources,
    sales: { [asin]: { status: "ready", volume: [{ month: "2026-01", value: 12 }], amount: [], price: [], rank: [] } },
    imageRemarks: { [asin]: [{ remark: "one" }, { remark: "video" }, { remark: "two" }] },
  };
  const status = deriveAsinModuleStatus(asin, readySources);
  assert.equal(status.sales, "ready");
  assert.equal(status.imageRemarks, "ready");
});

test("the observed pre-repair shape is nine of twelve and Alexa stays missing", () => {
  const item = deriveAsinModuleStatus(asin, sources);
  const done = ASIN_SYNC_STAGE_IDS.filter(stageId => evaluateAsinStageReadiness(stageId, [item]).ready);
  assert.deepEqual(done, [
    "catalog", "keywords", "reviews", "child_sales", "price_strategy", "fba", "listing", "category", "traffic",
  ]);
  assert.equal(done.length, 9);
  assert.deepEqual(evaluateAsinStageReadiness("alexa_voc", [item]).missingAsins, [asin]);
});
```

- [ ] **Step 6: Verify canonical readiness RED.** Run:

```powershell
node --test tests/scripts/asin-data-status.test.mjs
```

Expected: FAIL at module import because `ASIN_SYNC_STAGE_IDS`, `deriveAsinModuleStatus`, `evaluateAsinStageReadiness`, and `hasCompleteImageRemarks` are not exported yet.

- [ ] **Step 7: Expand the persisted source map and pure predicates.** In `scripts/lib/asin-data-status.mjs`, add paths/export reads for `sorftimeChildSales30d`, `sorftimePriceStrategies`, `sorftimeFbaFeeData`, and `sorftimeCategoryTrendData`; read the Alexa file as a string; and implement the stable interfaces. The readiness body must use these exact conditions.

```js
const paths = {
  keywords: path.join(root, "app", "sif-keyword-analysis-data.ts"),
  reviews: path.join(root, "app", "sorftime-review-analysis-data.ts"),
  sales: path.join(root, "app", "sorftime-sales-trend-data.ts"),
  childSales: path.join(root, "app", "sorftime-child-sales-data.ts"),
  priceStrategies: path.join(root, "app", "sorftime-price-strategy-data.ts"),
  fbaFees: path.join(root, "app", "sorftime-fba-fee-data.ts"),
  categoryTrends: path.join(root, "app", "sorftime-category-trend-data.ts"),
  voc: path.join(root, "app", "rufus-voc-data.ts"),
  catalog: path.join(root, "app", "competitor-data.ts"),
  traffic: path.join(root, "app", "sif-listing-traffic-raw-data.ts"),
  listing: path.join(root, "app", "sorftime-listing-content-data.ts"),
  imageRemarks: path.join(root, "app", "listing-image-remarks.ts"),
};

function hasUsableTrendPoint(record) {
  return record?.status === "ready" && ["volume", "amount", "price", "rank"].some(key =>
    Array.isArray(record[key]) && record[key].some(point =>
      /^\d{4}-\d{2}$/.test(String(point?.month ?? "")) && Number.isFinite(point?.value) && point.value >= 0
    )
  );
}

export function hasCompleteImageRemarks(listingRecord, remarkSlots) {
  const requiredSlots = (listingRecord?.galleryImages ?? [])
    .map((url, slotIndex) => ({ url, slotIndex }))
    .filter(item => !isVideoThumb(item.url));
  return requiredSlots.length > 0 && requiredSlots.every(
    item => Boolean(remarkSlots?.[item.slotIndex]?.remark?.trim()),
  );
}

export function readAsinStatusSources() {
  return {
    catalogAsins: readCatalogAsins(),
    keywords: readCachedDataExport(paths.keywords, "sifKeywordAnalysisData"),
    reviews: readCachedDataExport(paths.reviews, "sorftimeReviewAnalysisData"),
    sales: readCachedDataExport(paths.sales, "sorftimeSalesTrendData"),
    childSales: readCachedDataExport(paths.childSales, "sorftimeChildSales30d"),
    priceStrategies: readCachedDataExport(paths.priceStrategies, "sorftimePriceStrategies"),
    fbaFees: readCachedDataExport(paths.fbaFees, "sorftimeFbaFeeData"),
    listing: readCachedDataExport(paths.listing, "sorftimeListingContentData"),
    imageRemarks: readCachedDataExport(paths.imageRemarks, "listingImageRemarks"),
    categoryTrends: readCachedDataExport(paths.categoryTrends, "sorftimeCategoryTrendData"),
    traffic: readCachedDataExport(paths.traffic, "sifListingTrafficRawByAsin"),
    vocSource: fs.existsSync(paths.voc) ? fs.readFileSync(paths.voc, "utf8") : "",
  };
}

export function deriveAsinModuleStatus(asin, sources) {
  const listingRecord = sources.listing[asin];
  const childRows = sources.childSales[asin];
  const fbaRecord = sources.fbaFees[asin];
  const categoryReady = Object.values(sources.categoryTrends).some(
    record => record?.status === "ready" && Array.isArray(record.asins) && record.asins.includes(asin),
  );
  const trafficRecord = sources.traffic[asin];
  const vocBlock = new RegExp(`${asin}:\\s*\\{[\\s\\S]*?captureStatus:\\s*"dialog"`, "m");

  return {
    asin,
    inCatalog: sources.catalogAsins.includes(asin),
    keywords: sources.keywords[asin]?.status === "ready" ? "ready" : "missing",
    reviews: sources.reviews[asin]?.status === "ready" ? "ready" : "missing",
    sales: hasUsableTrendPoint(sources.sales[asin]) ? "ready" : "missing",
    childSales: Array.isArray(childRows) && childRows.some(row => Number.isFinite(row?.sales) && row.sales >= 0) ? "ready" : "missing",
    priceStrategy: sources.priceStrategies[asin] && typeof sources.priceStrategies[asin] === "object" ? "ready" : "missing",
    fba: fbaRecord?.status === "ready" && Number.isFinite(fbaRecord.fbaFee) && fbaRecord.fbaFee >= 0 ? "ready" : "missing",
    listing: listingRecord?.status === "ready" && analyzableGalleryImages(listingRecord).length > 0 ? "ready" : "missing",
    imageRemarks: hasCompleteImageRemarks(listingRecord, sources.imageRemarks[asin]) ? "ready" : "missing",
    category: categoryReady ? "ready" : "missing",
    traffic: trafficRecord?.overview?.total > 0 && trafficRecord?.structure?.chars?.dims?.length ? "ready" : "missing",
    voc: vocBlock.test(sources.vocSource) ? "ready" : "missing",
  };
}
```

Implement `getAsinDataStatus(asins)` by calling `readAsinStatusSources()` once and mapping through `deriveAsinModuleStatus`. `isAsinStageReady` must treat `inCatalog` as a boolean and every other mapped field as `"ready"`. `evaluateAsinStageReadiness(stageId, items)` must return `{ stageId, items, ready, missingAsins }`, remain not-ready for an empty item list, and retain the exact missing ASIN list. `readAsinStageReadiness` must perform a fresh `getAsinDataStatus(asins)` read and return that same shape. Update `hasListingGallery`, `hasImageRemarks`, `asinsNeedingMcpSync`, and `asinsNeedingAnySync` to delegate to these canonical fields; the MCP filter includes keywords, reviews, sales, child sales, price strategy, FBA, and category, while traffic/listing/image/Alexa keep their focused filters.

- [ ] **Step 8: Verify canonical readiness GREEN.** Re-run Step 6. Expected: all three tests PASS; the fixture is exactly nine ready stages, sales and image remarks remain missing, and Alexa remains missing.

- [ ] **Step 9: Write the server/client contract RED.** Create `tests/agent/asin-sync-readiness.test.ts` using the exact expanded object and update `tests/agent/local-data-bridge.test.ts` to include `childSales`, `priceStrategy`, `fba`, and `category` as `"ready"` in its existing `status` fixture.

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  SYNC_STAGE_TEMPLATE,
  idleStageStatus,
  type AsinDataStatusItem,
} from "../../app/asin-sync-funnel";

const item: AsinDataStatusItem = {
  asin: "B0C4XRN398",
  inCatalog: true,
  keywords: "ready",
  reviews: "ready",
  sales: "missing",
  childSales: "ready",
  priceStrategy: "ready",
  fba: "ready",
  listing: "ready",
  imageRemarks: "missing",
  category: "ready",
  traffic: "ready",
  voc: "missing",
};

test("idle readiness maps every stage to its own field", () => {
  const states = Object.fromEntries(SYNC_STAGE_TEMPLATE.map(stage => [stage.id, idleStageStatus(stage.id, [item])]));
  assert.deepEqual(states, {
    catalog: "done",
    keywords: "done",
    reviews: "done",
    sales_trend: "pending",
    child_sales: "done",
    price_strategy: "done",
    fba: "done",
    listing: "done",
    image_remarks: "pending",
    category: "done",
    alexa_voc: "manual",
    traffic: "done",
  });
  assert.equal(Object.values(states).filter(value => value === "done").length, 9);
  assert.equal(Math.round((9 / SYNC_STAGE_TEMPLATE.length) * 100), 75);
});
```

- [ ] **Step 10: Verify server/client contract RED.** Run:

```powershell
npx tsx --test tests/agent/asin-sync-readiness.test.ts
npx tsx --conditions=react-server --test tests/agent/local-data-bridge.test.ts
```

Expected: FAIL because `AsinDataStatusItem` and `idleStageStatus` are not exported and the client/server types do not contain the four independent fields.

- [ ] **Step 11: Mirror the expanded type and replace the sales fallback.** In `app/lib/sync-server.ts`, add required `childSales`, `priceStrategy`, `fba`, and `category` fields to `AsinModuleStatus`. In `app/asin-sync-funnel.tsx`, export `AsinDataStatusItem` and `idleStageStatus`, then use this exhaustive map with no default-to-sales path.

```ts
const STATUS_FIELD_BY_STAGE = {
  keywords: "keywords",
  reviews: "reviews",
  sales_trend: "sales",
  child_sales: "childSales",
  price_strategy: "priceStrategy",
  fba: "fba",
  listing: "listing",
  image_remarks: "imageRemarks",
  category: "category",
  alexa_voc: "voc",
  traffic: "traffic",
} as const satisfies Record<Exclude<(typeof SYNC_STAGE_TEMPLATE)[number]["id"], "catalog">, keyof AsinDataStatusItem>;

export function idleStageStatus(
  stageId: (typeof SYNC_STAGE_TEMPLATE)[number]["id"],
  items: AsinDataStatusItem[],
): "done" | "pending" | "manual" {
  if (!items.length) return "pending";
  if (stageId === "catalog") return items.every(item => item.inCatalog) ? "done" : "pending";
  const field = STATUS_FIELD_BY_STAGE[stageId];
  const ready = items.every(item => item[field] === "ready");
  if (stageId === "alexa_voc" && !ready) return "manual";
  return ready ? "done" : "pending";
}
```

Keep the existing twelve-stage template and percentage formula unchanged; only the data fields and mapping change.

- [ ] **Step 12: Verify Task 1 GREEN and types.** Run:

```powershell
node --test tests/scripts/sorftime-trend-parse.test.mjs tests/scripts/asin-data-status.test.mjs
npx tsx --test tests/agent/asin-sync-readiness.test.ts
npx tsx --conditions=react-server --test tests/agent/local-data-bridge.test.ts
npm run build
```

Expected: all focused tests PASS and the production build completes. No generated export is touched by these commands except normal ignored build output.

- [ ] **Step 13: Commit Task 1 only.** Inspect and stage the exact files below.

```powershell
git diff --check -- scripts/lib/sorftime-trend-parse.mjs scripts/lib/asin-data-status.mjs app/lib/sync-server.ts app/asin-sync-funnel.tsx tests/scripts/sorftime-trend-parse.test.mjs tests/scripts/asin-data-status.test.mjs tests/agent/asin-sync-readiness.test.ts tests/agent/local-data-bridge.test.ts
git add -- scripts/lib/sorftime-trend-parse.mjs scripts/lib/asin-data-status.mjs app/lib/sync-server.ts app/asin-sync-funnel.tsx tests/scripts/sorftime-trend-parse.test.mjs tests/scripts/asin-data-status.test.mjs tests/agent/asin-sync-readiness.test.ts tests/agent/local-data-bridge.test.ts
git diff --cached --name-only
git diff --cached --check
git commit -m "fix(sync): derive independent ASIN readiness"
```

Expected staged names: exactly the eight paths in `git add`; no generated export, data file, runbook, `.superpowers/`, environment file, or unrelated WIP.

---

### Task 2: Relay-Aware Image Endpoint, Model Selection, and Safe Failures

**Files:**
- Modify: `tests/scripts/image-remark-request.test.mjs:1-25`
- Modify: `scripts/lib/image-remark-request.mjs:1-21`
- Modify: `scripts/build-listing-image-remarks.mjs:1-75,111-200`

**Interfaces:**
- Consumes: Task 1 `hasCompleteImageRemarks(listingRecord, remarkSlots)` and the existing `OPENAI_API_KEY`, timeout, fetch, and generated-output flow.
- Produces: `imageRemarkEndpoint`, `imageRemarkModel`, and `readImageRemarkProviderPayload` exactly as declared above. Task 3 observes only the resulting canonical `image_remarks` persisted readiness.

- [ ] **Step 1: Extend the request-helper RED tests.** Replace the imports in `tests/scripts/image-remark-request.test.mjs` with all stable request exports and append these tests; retain both existing timeout tests unchanged.

```js
import {
  DEFAULT_IMAGE_REMARK_MODEL,
  DEFAULT_IMAGE_REMARK_REQUEST_TIMEOUT_MS,
  fetchImageRemarkWithTimeout,
  imageRemarkEndpoint,
  imageRemarkModel,
  imageRemarkRequestTimeoutMs,
  readImageRemarkProviderPayload,
} from "../../scripts/lib/image-remark-request.mjs";

test("image remark endpoint uses the official default and one relay v1 segment", () => {
  assert.equal(imageRemarkEndpoint({}), "https://api.openai.com/v1/chat/completions");
  assert.equal(
    imageRemarkEndpoint({ OPENAI_BASE_URL: "https://relay.example.test/" }),
    "https://relay.example.test/v1/chat/completions",
  );
  assert.equal(
    imageRemarkEndpoint({ OPENAI_BASE_URL: "https://relay.example.test/gateway/v1/v1/" }),
    "https://relay.example.test/gateway/v1/chat/completions",
  );
});

test("image remark endpoint rejects unsafe bases without echoing them", () => {
  for (const value of [
    "ftp://relay.example.test/v1",
    "https://user:secret@relay.example.test/v1",
    "https://relay.example.test/v1#secret-fragment",
    "not a url",
  ]) {
    assert.throws(
      () => imageRemarkEndpoint({ OPENAI_BASE_URL: value }),
      error => error instanceof Error && !error.message.includes(value) && !/secret/i.test(error.message),
    );
  }
});

test("image remark model precedence is vision, VOC, then fallback", () => {
  assert.equal(imageRemarkModel({ OPENAI_VISION_MODEL: " vision-model ", AGENT_VOC_MODEL: "voc-model" }), "vision-model");
  assert.equal(imageRemarkModel({ OPENAI_VISION_MODEL: " ", AGENT_VOC_MODEL: " voc-model " }), "voc-model");
  assert.equal(imageRemarkModel({}), DEFAULT_IMAGE_REMARK_MODEL);
});

test("provider failures expose only status and invalid-json summaries", async () => {
  await assert.rejects(
    readImageRemarkProviderPayload(new Response("provider secret body", { status: 502 })),
    error => error instanceof Error && /HTTP 502/.test(error.message) && !/provider secret body/.test(error.message),
  );
  await assert.rejects(
    readImageRemarkProviderPayload(new Response("not json", { status: 200 })),
    /^Error: Image analysis provider returned invalid JSON$/,
  );
});
```

- [ ] **Step 2: Verify image-helper RED.** Run:

```powershell
node --test tests/scripts/image-remark-request.test.mjs
```

Expected: FAIL at module import because the endpoint, model, provider-payload helpers, and model constant are absent.

- [ ] **Step 3: Implement safe request helpers.** Add this behavior to `scripts/lib/image-remark-request.mjs`, preserving the timeout functions.

```js
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_IMAGE_REMARK_MODEL = "gpt-4o-mini";

export function imageRemarkEndpoint(env = process.env) {
  const configured = env.OPENAI_BASE_URL?.trim() || DEFAULT_OPENAI_BASE_URL;
  let base;
  try {
    base = new URL(configured);
  } catch {
    throw new Error("OPENAI_BASE_URL is invalid");
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error("OPENAI_BASE_URL must use HTTP or HTTPS");
  }
  if (base.username || base.password) {
    throw new Error("OPENAI_BASE_URL must not contain credentials");
  }
  if (base.hash) {
    throw new Error("OPENAI_BASE_URL must not contain a fragment");
  }

  base.search = "";
  const prefix = base.pathname.replace(/\/+$/, "").replace(/(?:\/v1)+$/i, "");
  base.pathname = `${prefix}/v1/chat/completions`.replace(/\/{2,}/g, "/");
  return base.toString();
}

export function imageRemarkModel(env = process.env) {
  return env.OPENAI_VISION_MODEL?.trim() || env.AGENT_VOC_MODEL?.trim() || DEFAULT_IMAGE_REMARK_MODEL;
}

export async function readImageRemarkProviderPayload(response) {
  if (!response.ok) {
    throw new Error(`Image analysis provider returned HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error("Image analysis provider returned invalid JSON");
  }
}
```

- [ ] **Step 4: Verify helper GREEN.** Re-run Step 2. Expected: all endpoint/model/safe-error/timeout tests PASS, and no assertion prints a key, base, request body, or provider body.

- [ ] **Step 5: Wire the builder to the helpers without changing its output schema.** In `scripts/build-listing-image-remarks.mjs`, import `hasCompleteImageRemarks` instead of `filledRemarkCount`; import all three request helpers; implement `remarksComplete` as the canonical predicate; and replace the hard-coded endpoint, model, response-body error, and unsafe JSON parsing.

```js
import { hasCompleteImageRemarks } from "./lib/asin-data-status.mjs";
import {
  fetchImageRemarkWithTimeout,
  imageRemarkEndpoint,
  imageRemarkModel,
  imageRemarkRequestTimeoutMs,
  readImageRemarkProviderPayload,
} from "./lib/image-remark-request.mjs";

function remarksComplete(asin, record, remarks) {
  return hasCompleteImageRemarks(record, remarks[asin]);
}

async function analyzeWithOpenAI(imageUrl, slotIndex, asin) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;

  const response = await fetchImageRemarkWithTimeout(fetch, imageRemarkEndpoint(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: imageRemarkModel(),
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [{
        role: "user",
        content: [
          { type: "text", text: `${SKILL_PROMPT}\nASIN: ${asin} · 图片${slotIndex + 1}` },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      }],
    }),
  }, imageRemarkRequestTimeoutMs());

  const payload = await readImageRemarkProviderPayload(response);
  const raw = payload.choices?.[0]?.message?.content;
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Image analysis provider returned invalid remark JSON");
  }
  return {
    remark: String(parsed.remark ?? "").trim(),
    image_types: Array.isArray(parsed.image_types) ? parsed.image_types.map(String).slice(0, 3) : [],
    confidence: ["high", "medium", "low"].includes(parsed.confidence) ? parsed.confidence : "medium",
  };
}
```

Keep `writeRemarksFile` metadata limited to its current non-secret fields. Keep incomplete/blank results out of ready status; the existing `pendingAsins` and nonzero exit behavior remain the builder's truthful signal.

- [ ] **Step 6: Verify Task 2 GREEN without a real request.** Run:

```powershell
node --test tests/scripts/image-remark-request.test.mjs tests/scripts/asin-data-status.test.mjs
node --check scripts/build-listing-image-remarks.mjs
npm run build
```

Expected: all tests PASS, the builder parses, and the build completes. Do not run `npm run image-remarks:sync` in this step.

- [ ] **Step 7: Commit Task 2 only.** Inspect and stage exactly these three files.

```powershell
git diff --check -- scripts/lib/image-remark-request.mjs scripts/build-listing-image-remarks.mjs tests/scripts/image-remark-request.test.mjs
git add -- scripts/lib/image-remark-request.mjs scripts/build-listing-image-remarks.mjs tests/scripts/image-remark-request.test.mjs
git diff --cached --name-only
git diff --cached --check
git commit -m "fix(sync): honor image analysis relay"
```

Expected staged names: exactly the three paths in `git add`; the dirty `app/listing-image-remarks.ts` remains unstaged.

---

### Task 3: Persisted Job Postconditions and Three-ASIN Tracer

**Files:**
- Create: `scripts/lib/sorftime-listing-parse.mjs`
- Create: `tests/scripts/sorftime-listing-parse.test.mjs`
- Create: `tests/scripts/asin-sync-job-postconditions.test.mjs`
- Modify: `scripts/build-sorftime-listing-content.mjs:1-30,74-76`
- Modify: `scripts/run-asin-sync-job.mjs:1-384`
- Verify only: read-only `C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\feat-voc-positioning-skill-execution\.env.local`, dirty generated exports, `data/sync-jobs/*.json`, `data/sync-jobs/*.log`, and controller-owned stack ports `31900` / `31901`

**Interfaces:**
- Consumes: Task 1 `readAsinStageReadiness(stageId, asins)` and `isAsinStageReady(item, stageId)`, Task 2's persisted image results, the current Sorftime `product_detail.main_image` field, existing `markAsinModule`, `setStage`, command wrappers, and job store.
- Produces: pure `parseImageList(raw)`, `applyPersistedStagePostcondition` exactly as declared above, and a direct-execution guard that permits unit import without running `main()`.

- [ ] **Step 1: Write listing-image parser RED tests.** Create `tests/scripts/sorftime-listing-parse.test.mjs` with the real response representation plus legacy forms. This test is parser-only and never calls Sorftime.

```js
import assert from "node:assert/strict";
import test from "node:test";

import { parseImageList } from "../../scripts/lib/sorftime-listing-parse.mjs";

const images = [
  "https://m.media-amazon.com/images/I/one.jpg",
  "https://m.media-amazon.com/images/I/two.jpg",
  "https://m.media-amazon.com/images/I/three.jpg",
];

test("listing image parser preserves every image in a JSON-string gallery", () => {
  assert.deepEqual(parseImageList(JSON.stringify(images)), images);
});

test("listing image parser retains direct arrays and single legacy URLs", () => {
  assert.deepEqual(parseImageList(images), images);
  assert.deepEqual(parseImageList(images[0]), [images[0]]);
  assert.deepEqual(parseImageList([images[0], "", null, images[1]]), [images[0], images[1]]);
});

test("listing image parser rejects malformed and non-image scalar payloads", () => {
  assert.deepEqual(parseImageList("[broken"), []);
  assert.deepEqual(parseImageList("not-an-image"), []);
  assert.deepEqual(parseImageList(null), []);
});
```

- [ ] **Step 2: Verify listing parser RED.** Run:

```powershell
node --test tests/scripts/sorftime-listing-parse.test.mjs
```

Expected: FAIL at module import because `scripts/lib/sorftime-listing-parse.mjs` does not exist.

- [ ] **Step 3: Split only the pure parser and keep the connector unchanged.** Create `scripts/lib/sorftime-listing-parse.mjs` with the exact helper below. In `scripts/build-sorftime-listing-content.mjs`, import it and delete only the old local `parseImageList`; keep the existing `product_detail` call, `galleryImages`, `secondaryImages = galleryImages.slice(1)`, cache behavior, and output schema unchanged.

```js
export function parseImageList(raw) {
  if (Array.isArray(raw)) {
    return raw.map(item => String(item ?? "").trim()).filter(Boolean);
  }
  if (typeof raw !== "string" || !raw.trim()) return [];
  const value = raw.trim();
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map(item => String(item ?? "").trim()).filter(Boolean);
    }
  } catch {
    return /^https?:\/\//i.test(value) ? [value] : [];
  }
  return [];
}
```

```js
import { parseImageList } from "./lib/sorftime-listing-parse.mjs";
```

- [ ] **Step 4: Verify listing parser GREEN.** Run:

```powershell
node --test tests/scripts/sorftime-listing-parse.test.mjs
node --check scripts/build-sorftime-listing-content.mjs
```

Expected: all three parser tests PASS and the listing builder parses. No generated listing export changes.

- [ ] **Step 5: Write persisted-postcondition RED tests.** Create `tests/scripts/asin-sync-job-postconditions.test.mjs`. The fakes must capture updates in memory only; importing the runner must not create or mutate a sync job.

```js
import assert from "node:assert/strict";
import test from "node:test";

import { applyPersistedStagePostcondition } from "../../scripts/run-asin-sync-job.mjs";

const asin = "B0C4XRN398";
const base = {
  asin,
  inCatalog: true,
  keywords: "ready",
  reviews: "ready",
  sales: "missing",
  childSales: "ready",
  priceStrategy: "ready",
  fba: "ready",
  listing: "ready",
  imageRemarks: "missing",
  category: "ready",
  traffic: "ready",
  voc: "missing",
};

function harness(item, options = {}) {
  const modules = [];
  const stages = [];
  const result = applyPersistedStagePostcondition("job-1", options.stageId ?? "sales_trend", [asin], {
    commandSucceeded: options.commandSucceeded ?? true,
    unavailableReason: options.unavailableReason ?? null,
    readReadiness: stageId => ({
      items: [item],
      ready: stageId === "catalog" ? item.inCatalog : item[options.field ?? "sales"] === "ready",
      missingAsins: stageId === "catalog" || item[options.field ?? "sales"] === "ready" ? [] : [asin],
    }),
    markModule: (...args) => modules.push(args),
    updateStage: (...args) => stages.push(args),
    now: () => "2026-08-19T12:00:00.000Z",
  });
  return { result, modules, stages };
}

test("zero exit plus empty persisted sales fails its own stage", () => {
  const { result, modules, stages } = harness(base);
  assert.deepEqual(result, { status: "failed", missingAsins: [asin] });
  assert.deepEqual(modules, [["job-1", asin, "sales_trend", "missing"]]);
  assert.equal(stages[0][2].status, "failed");
  assert.match(stages[0][2].detail, /1\/1 个 ASIN/);
});

test("zero exit plus incomplete image remarks fails image_remarks only", () => {
  const { result, modules } = harness(base, { stageId: "image_remarks", field: "imageRemarks" });
  assert.equal(result.status, "failed");
  assert.deepEqual(modules, [["job-1", asin, "image_remarks", "missing"]]);
});

test("canonical ready data completes and records the same stage key", () => {
  const { result, modules, stages } = harness({ ...base, sales: "ready" });
  assert.deepEqual(result, { status: "done", missingAsins: [] });
  assert.deepEqual(modules, [["job-1", asin, "sales_trend", "ready"]]);
  assert.equal(stages[0][2].status, "done");
});

test("a failed command cannot become done and only explicit unavailability skips", () => {
  assert.equal(harness({ ...base, sales: "ready" }, { commandSucceeded: false }).result.status, "failed");
  assert.equal(harness(base, { unavailableReason: "图像分析未配置" }).result.status, "skipped");
});
```

- [ ] **Step 6: Verify job-postcondition RED.** Run:

```powershell
node --test tests/scripts/asin-sync-job-postconditions.test.mjs
```

Expected: FAIL because `applyPersistedStagePostcondition` is absent; if `main()` runs on import, the test also exposes that side effect and must remain RED until the guard is added.

- [ ] **Step 7: Add the direct-execution guard and settlement helper.** Import `pathToFileURL` from `node:url`, export the stable helper, and replace unconditional `main()` with the guard below.

```js
import { pathToFileURL } from "node:url";
import {
  // existing imports
  ASIN_SYNC_STAGE_IDS,
  evaluateAsinStageReadiness,
  isAsinStageReady,
  readAsinStageReadiness,
} from "./lib/asin-data-status.mjs";

export function applyPersistedStagePostcondition(
  jobId,
  stageId,
  asins,
  {
    commandSucceeded = true,
    unavailableReason = null,
    readReadiness = readAsinStageReadiness,
    markModule = markAsinModule,
    updateStage = setStage,
    now = () => new Date().toISOString(),
  } = {},
) {
  const readiness = readReadiness(stageId, asins);
  for (const item of readiness.items) {
    markModule(jobId, item.asin, stageId, isAsinStageReady(item, stageId) ? "ready" : "missing");
  }

  const completedAt = now();
  if (!commandSucceeded) {
    updateStage(jobId, stageId, {
      status: "failed",
      detail: `${stageId} 命令未成功；${readiness.missingAsins.length}/${asins.length} 个 ASIN 持久化数据未就绪`,
      completedAt,
    });
    return { status: "failed", missingAsins: readiness.missingAsins };
  }
  if (readiness.missingAsins.length) {
    const status = unavailableReason ? "skipped" : "failed";
    updateStage(jobId, stageId, {
      status,
      detail: unavailableReason ?? `${readiness.missingAsins.length}/${asins.length} 个 ASIN 的 ${stageId} 持久化数据未就绪`,
      completedAt,
    });
    return { status, missingAsins: readiness.missingAsins };
  }
  updateStage(jobId, stageId, { status: "done", completedAt });
  return { status: "done", missingAsins: [] };
}

const invokedAsScript = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;
if (invokedAsScript) main();
```

The production implementation must call the real `isAsinStageReady`; the test injection may provide fixture readiness but may not replace production behavior.

- [ ] **Step 8: Verify the helper GREEN.** Re-run Step 6. Expected: all four tests PASS and importing the runner performs no job execution.

- [ ] **Step 9: Replace optimistic completion stage by stage.** In `scripts/run-asin-sync-job.mjs`, after each zero-exit command group call `applyPersistedStagePostcondition(jobId, stageId, affectedAsins)`. Remove all unconditional ready marks and the category-to-sales proxy. Use these exact settlement boundaries:

```js
// catalog: after catalog:sync
applyPersistedStagePostcondition(jobId, "catalog", catalogPending);

// keywords: after keywords:sync
applyPersistedStagePostcondition(jobId, "keywords", mcpAsins);

// reviews: after rating:sync and review:sync
applyPersistedStagePostcondition(jobId, "reviews", mcpAsins);

// one call after each corresponding command
applyPersistedStagePostcondition(jobId, "sales_trend", mcpAsins);
applyPersistedStagePostcondition(jobId, "child_sales", mcpAsins);
applyPersistedStagePostcondition(jobId, "price_strategy", mcpAsins);
applyPersistedStagePostcondition(jobId, "fba", mcpAsins);
applyPersistedStagePostcondition(jobId, "category", mcpAsins);

// listing and traffic use their focused affected-ASIN arrays
applyPersistedStagePostcondition(jobId, "listing", listingPending.map(item => item.asin));
applyPersistedStagePostcondition(jobId, "traffic", trafficPending.map(item => item.asin));
```

Do not call `completeStage` for these executed data stages. Keep `skipped` for a stage whose affected-ASIN list was empty because its persisted data was already ready. Keep Alexa's current auto-attempt/manual fallback logic, and continue to mark missing Alexa as `manual`, never `failed`.

- [ ] **Step 10: Settle image remarks from both command and persisted results.** Replace the bespoke `hasImageRemarks` loop with one canonical call. The only explicit unavailable configuration is the absent image-analysis credential.

```js
const commandSucceeded = tryRunCommand("image-remarks:sync", "npm", ["run", "image-remarks:sync"], {
  REMARK_ASINS: imageRemarksPending.map(item => item.asin).join(","),
});
applyPersistedStagePostcondition(
  jobId,
  "image_remarks",
  imageRemarksPending.map(item => item.asin),
  {
    commandSucceeded,
    unavailableReason: openaiReady
      ? null
      : `图像分析未配置；${imageRemarksPending.length} 个 ASIN 保持缺失`,
  },
);
```

Do not include endpoint, model, key name/value, request body, provider body, or caught provider error text in the stage detail.

- [ ] **Step 11: Make the final job result truthful.** After build/restart handling, evaluate every non-Alexa stage against a fresh persisted snapshot. If any non-Alexa stage has missing ASINs, finish the job as `failed`, list only stage IDs and ASIN counts in `message`, set `needsReload: true`, and set `process.exitCode = 1`; otherwise retain `completed`, `needsReload: true`, and the current Alexa-only manual message. Use one snapshot so sibling readiness is not downgraded or proxied.

```js
const nonAlexaStageIds = ASIN_SYNC_STAGE_IDS.filter(stageId => stageId !== "alexa_voc");
const finalItems = getAsinDataStatus(asins);
const incompleteStages = nonAlexaStageIds
  .map(stageId => evaluateAsinStageReadiness(stageId, finalItems))
  .filter(result => !result.ready)
  .map(result => ({ stageId: result.stageId, missingCount: result.missingAsins.length }));
const vocStillPending = evaluateAsinStageReadiness("alexa_voc", finalItems).missingAsins;

if (incompleteStages.length) {
  patchSyncJob(jobId, {
    status: "failed",
    message: `同步结束但持久化数据未就绪：${incompleteStages.map(item => `${item.stageId} ${item.missingCount} 个 ASIN`).join("；")}`,
    completedAt: new Date().toISOString(),
    needsReload: true,
  });
  process.exitCode = 1;
} else {
  patchSyncJob(jobId, {
    status: "completed",
    message: vocStillPending.length
      ? `同步完成。${vocStillPending.length} 个 ASIN 的 Alexa VOC 仍待录入。`
      : "全部数据同步完成，页面即将刷新。",
    completedAt: new Date().toISOString(),
    needsReload: true,
  });
}
```

Use the Task 1 `{ stageId, items, ready, missingAsins }` result unchanged in this final aggregation; do not add a second readiness implementation in the runner.

- [ ] **Step 12: Verify Task 3 focused GREEN.** Run:

```powershell
node --test tests/scripts/sorftime-listing-parse.test.mjs tests/scripts/asin-sync-job-postconditions.test.mjs tests/scripts/asin-data-status.test.mjs tests/scripts/sorftime-trend-parse.test.mjs tests/scripts/image-remark-request.test.mjs tests/scripts/sync-runtime-policy.test.mjs
node --check scripts/build-sorftime-listing-content.mjs
node --check scripts/run-asin-sync-job.mjs
npx tsx --test tests/agent/asin-sync-readiness.test.ts
npx tsx --conditions=react-server --test tests/agent/local-data-bridge.test.ts
```

Expected: all focused tests PASS, both scripts parse, the existing runtime-policy source contract still passes, and no real connector/model process runs.

- [ ] **Step 13: Run the bounded regression gate.** Run:

```powershell
npm run test:agent
npm run build
npx eslint scripts/lib/asin-data-status.mjs scripts/lib/sorftime-trend-parse.mjs scripts/lib/sorftime-listing-parse.mjs scripts/lib/image-remark-request.mjs scripts/build-sorftime-listing-content.mjs scripts/build-listing-image-remarks.mjs scripts/run-asin-sync-job.mjs app/lib/sync-server.ts app/asin-sync-funnel.tsx tests/scripts/sorftime-trend-parse.test.mjs tests/scripts/sorftime-listing-parse.test.mjs tests/scripts/asin-data-status.test.mjs tests/scripts/image-remark-request.test.mjs tests/scripts/asin-sync-job-postconditions.test.mjs tests/agent/asin-sync-readiness.test.ts tests/agent/local-data-bridge.test.ts
$implementationPaths = @(
  "scripts/lib/asin-data-status.mjs", "scripts/lib/sorftime-trend-parse.mjs",
  "scripts/lib/sorftime-listing-parse.mjs", "scripts/lib/image-remark-request.mjs",
  "scripts/build-sorftime-listing-content.mjs", "scripts/build-listing-image-remarks.mjs",
  "scripts/run-asin-sync-job.mjs", "app/lib/sync-server.ts", "app/asin-sync-funnel.tsx",
  "tests/scripts/sorftime-trend-parse.test.mjs", "tests/scripts/sorftime-listing-parse.test.mjs",
  "tests/scripts/asin-data-status.test.mjs", "tests/scripts/image-remark-request.test.mjs",
  "tests/scripts/asin-sync-job-postconditions.test.mjs", "tests/agent/asin-sync-readiness.test.ts",
  "tests/agent/local-data-bridge.test.ts"
)
git diff --check HEAD~2..HEAD -- $implementationPaths
git diff --check -- $implementationPaths
git diff --cached --check
```

Expected: Agent tests PASS, build completes, focused lint reports no error, both committed Task 1–2 and uncommitted Task 3 implementation paths pass whitespace checks, and the index check prints no error. Pre-existing generated WIP warnings are outside this gate and must not be modified. Do not run `npm test` because it repeats the production build and does not add focused sync coverage beyond the explicit build plus Agent suite here.

- [ ] **Step 14: Commit Task 3 only.** Inspect and stage exactly the listing parser split, runner, and their focused tests.

```powershell
git diff --check -- scripts/lib/sorftime-listing-parse.mjs scripts/build-sorftime-listing-content.mjs scripts/run-asin-sync-job.mjs tests/scripts/sorftime-listing-parse.test.mjs tests/scripts/asin-sync-job-postconditions.test.mjs
git add -- scripts/lib/sorftime-listing-parse.mjs scripts/build-sorftime-listing-content.mjs scripts/run-asin-sync-job.mjs tests/scripts/sorftime-listing-parse.test.mjs tests/scripts/asin-sync-job-postconditions.test.mjs
git diff --cached --name-only
git diff --cached --check
git commit -m "fix(sync): verify persisted stage postconditions"
```

Expected staged names: exactly the five paths in `git add`; all generated/data/runbook/`.superpowers/` WIP remains unstaged. The listing-builder diff contains only the pure-parser import/removal and no connector, cache, output, build, or restart policy change.

- [ ] **Step 15: Capture the pre-run three-ASIN readiness trace without secrets.** Run this read-only command after all three commits.

```powershell
node --input-type=module -e "import { ASIN_SYNC_STAGE_IDS, evaluateAsinStageReadiness, getAsinDataStatus } from './scripts/lib/asin-data-status.mjs'; const asins=['B0C4XRN398','B0D2QGKQWV','B0F939J6QC']; const items=getAsinDataStatus(asins); const stages=ASIN_SYNC_STAGE_IDS.map(stageId=>{const r=evaluateAsinStageReadiness(stageId,items); return {stageId,ready:r.ready,missingCount:r.missingAsins.length};}); console.log(JSON.stringify({asins,readyCount:stages.filter(x=>x.ready).length,total:stages.length,stages},null,2));"
```

Expected before the real repair run: a truthful snapshot, normally nine ready stages for the observed dirty data; sales, image remarks, and Alexa are missing. If the user WIP has changed, record the actual counts and continue without editing generated files by hand.

- [ ] **Step 16: Run exactly one real three-ASIN acceptance job.** This is the only step allowed to use Sorftime/SIF/SellerSprite and the configured image model. Read the already-existing private environment file from the approved sibling worktree directly with Node's `--env-file`; do not copy it into this worktree, inspect it, echo any value, or stage/commit it. The absence of `.env.local` in the current worktree is expected and is not a blocker. Disable Alexa automation so the known unsupported stage stays manual. Create one local job with counts derived from canonical status, then run it synchronously and retain only provider-neutral console/job evidence.

```powershell
$env:ALEXA_AUTO = "0"
$acceptanceJobId = node --env-file="C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\feat-voc-positioning-skill-execution\.env.local" --input-type=module -e "import { asinsNeedingCatalogSync, asinsNeedingMcpSync, getAsinDataStatus } from './scripts/lib/asin-data-status.mjs'; import { createSyncJob } from './scripts/lib/sync-job-store.mjs'; const asins=['B0C4XRN398','B0D2QGKQWV','B0F939J6QC']; const status=getAsinDataStatus(asins); const job=createSyncJob({asins,marketplace:'US',mcpAsinCount:asinsNeedingMcpSync(asins).length,vocPendingCount:status.filter(x=>x.voc==='missing').length,catalogAsinCount:asinsNeedingCatalogSync(asins).length}); process.stdout.write(job.jobId);"
node --env-file="C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\feat-voc-positioning-skill-execution\.env.local" scripts/run-asin-sync-job.mjs $acceptanceJobId
Remove-Item Env:ALEXA_AUTO -ErrorAction SilentlyContinue
```

Expected success path: runner exit `0`; all eleven non-Alexa stages have usable persisted data; Alexa is `manual` for exactly the three ASINs; the idle arithmetic is `11 / 12 = 92%`. Expected truthful failure path: runner exits nonzero; every still-unusable non-Alexa stage is `failed`, never `done`; its message contains only stage ID and ASIN count; already-ready siblings remain ready; Alexa remains manual. The command output may show provider-neutral status only and must never show env-file contents, keys, authorization values, request bodies, or provider bodies. Do not repeat the real model run in this implementation pass.

- [ ] **Step 17: Build a fresh bundle and restart only the controller-owned 31900/31901 stack.** Even when `AGENT_VOC_LOCAL_FAKE=1` made the sync runner skip its build/restart stage, do not change that policy. First resolve the Web `31900` and Agent `31901` listeners with both `Get-NetTCPConnection` and `Get-Process`, then inspect their parent process records. Continue only when both listeners belong to the already-confirmed controller session that launched `scripts/start-agent-stack.mjs`; never infer ownership from port number alone.

```powershell
$stackPorts = @(31900, 31901)
$stackListeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -in $stackPorts })
$stackListeners | Select-Object LocalAddress,LocalPort,OwningProcess
$stackListeners | ForEach-Object {
  Get-Process -Id $_.OwningProcess | Select-Object Id,ProcessName,Path
  $listenerProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)"
  $listenerProcess | Select-Object ProcessId,ParentProcessId,Name,CommandLine
  Get-CimInstance Win32_Process -Filter "ProcessId=$($listenerProcess.ParentProcessId)" |
    Select-Object ProcessId,ParentProcessId,Name,CommandLine
}
```

Expected: the two listeners and their parent chain match the controller-owned `start-agent-stack.mjs` session. Stop that session by sending `Ctrl+C` through the same controller/terminal session that created it; do not call `Stop-Process`, `taskkill`, or the old `start-team-server.ps1`. After the controller finishes its child cleanup, verify both ports are free, build, then start the same production controller with the approved read-only environment and exact same ports in a new controller-owned terminal session:

```powershell
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -in @(31900, 31901) }
npm run build
$env:WEB_HOST = "127.0.0.1"
$env:WEB_PORT = "31900"
$env:AGENT_SERVICE_HOST = "127.0.0.1"
$env:AGENT_SERVICE_PORT = "31901"
$env:AGENT_SERVICE_INTERNAL_URL = "http://127.0.0.1:31901"
node --env-file="C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\feat-voc-positioning-skill-execution\.env.local" .\scripts\start-agent-stack.mjs prod
```

Expected: the pre-build port check prints no listeners, `npm run build` completes, and the new controller reports healthy Web `http://127.0.0.1:31900` and Agent `http://127.0.0.1:31901`. The environment file remains read-only and unprinted; no automatic restart code, generated-data API, or sync-policy change is added.

If either listener's ownership cannot be proven, do not stop it. Verify alternate ports `32900` / `32901` are free, then use the same controller and read-only environment in development HMR mode:

```powershell
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -in @(32900, 32901) }
$env:WEB_HOST = "127.0.0.1"
$env:WEB_PORT = "32900"
$env:AGENT_SERVICE_HOST = "127.0.0.1"
$env:AGENT_SERVICE_PORT = "32901"
$env:AGENT_SERVICE_INTERNAL_URL = "http://127.0.0.1:32901"
$env:AGENT_SERVICE_TRUSTED_ORIGINS = "http://127.0.0.1:32900,http://localhost:32900"
node --env-file="C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\feat-voc-positioning-skill-execution\.env.local" .\scripts\start-agent-stack.mjs dev
```

Expected fallback: the alternate-port check prints no listeners and the HMR controller becomes healthy without terminating or reconfiguring the unrelated `31900` / `31901` processes. Record which freshness path was used.

- [ ] **Step 18: Verify the rendered three-ASIN galleries against fresh assets.** Reload the current analysis page from the selected fresh endpoint (`http://127.0.0.1:31900` for the confirmed production restart or `http://127.0.0.1:32900` for the ownership-safe HMR fallback). For `B0C4XRN398`, `B0D2QGKQWV`, and `B0F939J6QC`, inspect the listing gallery and assert each renders more than one image. Compare against the persisted evidence (currently 8, 9, and 6 `galleryImages`, with matching `secondaryImages`) without hand-editing either export.

Expected: every ASIN renders `> 1` image. If persisted `galleryImages` still contains multiple URLs but a fresh bundle renders only the primary image, report a distinct UI-rendering defect; do not classify it as a Sorftime connector failure and do not extend this repair into automatic restart or data-API work.

- [ ] **Step 19: Trace final persisted status and protect acceptance artifacts.** Re-run the read-only command from Step 15, then inspect the job without printing environment or provider response bodies.

```powershell
node --input-type=module -e "import { readSyncJob } from './scripts/lib/sync-job-store.mjs'; const job=readSyncJob(process.argv[1]); console.log(JSON.stringify({jobId:job.jobId,status:job.status,message:job.message,stages:job.stages.map(({id,status,detail})=>({id,status,detail}))},null,2));" $acceptanceJobId
git status --short
$implementationPaths = @(
  "scripts/lib/asin-data-status.mjs", "scripts/lib/sorftime-trend-parse.mjs",
  "scripts/lib/sorftime-listing-parse.mjs", "scripts/lib/image-remark-request.mjs",
  "scripts/build-sorftime-listing-content.mjs", "scripts/build-listing-image-remarks.mjs",
  "scripts/run-asin-sync-job.mjs", "app/lib/sync-server.ts", "app/asin-sync-funnel.tsx",
  "tests/scripts/sorftime-trend-parse.test.mjs", "tests/scripts/sorftime-listing-parse.test.mjs",
  "tests/scripts/asin-data-status.test.mjs", "tests/scripts/image-remark-request.test.mjs",
  "tests/scripts/asin-sync-job-postconditions.test.mjs", "tests/agent/asin-sync-readiness.test.ts",
  "tests/agent/local-data-bridge.test.ts"
)
git diff --check HEAD~3..HEAD -- $implementationPaths
git diff --check -- $implementationPaths
git diff --cached --check
$wholeTreeWarnings = @(git diff --check 2>&1)
if ($wholeTreeWarnings.Count -gt 0) {
  Write-Host "[diagnostic only] Pre-existing generated/user-WIP whole-tree warnings:"
  $wholeTreeWarnings | ForEach-Object { Write-Host $_ }
}
$global:LASTEXITCODE = 0
```

Acceptance passes only when the trace shows either exact Alexa-only `11/12` readiness or a precise remaining non-Alexa stage/count failure, and the implementation commit range, implementation-path working diff, and staged index whitespace checks pass. The status output must still show all implementation commits cleanly separated from uncommitted generated/data/runbook/`.superpowers/` user WIP. Whole-tree warnings are reported only as nonblocking pre-existing WIP diagnostics; do not alter those files to silence them. Do not stage or commit any artifact from the real run.

---

## Plan Self-Review

- [x] **Spec coverage:** Task 1 covers current/legacy trend forms, malformed filtering, all twelve independent persisted predicates, the observed `9/12 = 75%` pre-repair state, explicit client mapping, and Alexa preservation. Task 2 covers official/relay endpoint normalization, scheme/credential/fragment rejection, exact model precedence, per-slot image completeness, and provider-safe errors. Task 3 covers JSON-string multi-image preservation, zero-exit postconditions, per-ASIN stage keys, no proxy readiness, explicit unavailable skipping, truthful final job status, one three-ASIN real tracer targeting `11/12 = 92%`, a fresh build/controlled restart, and rendered `> 1` gallery assertions for all three ASINs.
- [x] **Safety and scope:** No Task adds runtime, database, migration, dependency, connector, UI, auth, deployment, automatic restart, Sorftime protocol, synthetic image, or generated-data API implementation work. Real providers/model run only in the final single acceptance step, and all resulting generated/data files remain unstaged. Only a confirmed controller-owned `31900` / `31901` stack session may be stopped; ambiguous ownership routes to alternate-port HMR.
- [x] **Protected WIP:** Every commit names only its own source/tests. Existing generated exports, runbook, SQLite/project data, `.superpowers/`, environment files, and stash are explicitly excluded; prohibited Git operations are listed globally. Scoped path/range/index whitespace gates pass independently of whole-tree generated-WIP warnings, which are reported but never repaired.
- [x] **Placeholder scan:** Every source/test file, interface, command, expected RED/GREEN signal, provider failure behavior, acceptance branch, and commit boundary is concrete; no deferred implementation instruction remains.
- [x] **Type consistency:** The status fields are consistently `inCatalog`, `keywords`, `reviews`, `sales`, `childSales`, `priceStrategy`, `fba`, `listing`, `imageRemarks`, `category`, `traffic`, and `voc`; stage IDs and `STATUS_FIELD_BY_STAGE` match the twelve template IDs; `evaluateAsinStageReadiness` returns `stageId`, `ready`, and `missingAsins` everywhere.
- [x] **Test consistency:** Script tests use Node's runner; the client-only funnel test uses normal `tsx`, while the server bridge keeps `tsx --conditions=react-server`; all RED expectations name the absent behavior, all GREEN commands are explicit, the listing parser fixture exercises the confirmed JSON-string representation, and no focused test reaches a real provider.
- [x] **Command consistency:** Task 13 checks committed Task 1–2 with `HEAD~2..HEAD`, Task 3's working paths, and the index; final Step 19 checks the three implementation commits with `HEAD~3..HEAD` plus working paths/index and treats whole-tree warnings as diagnostics. Step 16 and both Step 17 launch paths use the same read-only absolute `--env-file`; production restarts only `31900` / `31901`, while uncertain ownership uses verified-free `32900` / `32901` HMR.
- [x] **Commit boundaries:** Task 1, Task 2, and Task 3 each end in one independently reviewable normal commit; final real acceptance creates no implementation commit.
