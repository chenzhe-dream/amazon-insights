# Xiyou Twelve-Month Parent Orders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the existing variant section with the approved two-column annual order cards and per-parent detail dialog, using Xiyou child monthly order aggregation.

**Architecture:** Keep the existing strict variant contract unchanged. Add a separate versioned order snapshot, pure annual projection, server-side bounded collector/cache, and authorized read-only runtime integration; render the annual view from validated snapshots only.

**Tech Stack:** TypeScript, Zod 4, React 19, Node 22+, existing MCP SDK, node:test/tsx and offline headless Playwright; no new dependencies.

## Global Constraints

- Work only in `C:/Users/EDY/Amazon-Product-Opportunity-Insights/.worktrees/fix-voc-import-status-20260907`, branch `codex/feat-xydc-parent-orders-12m-20260908`; development checkpoint `c7c8875`.
- Use the recent 12 complete UTC calendar months fixed at collection start. September 2026 means `2025-09` through `2026-08`. Never default to last 30 days.
- Total, share, sort and trend use the same window and ALL unique current children. Previewing three children must not change the denominator.
- Raw zero means undisclosed, not proven zero orders. Missing months/failed children must not be filled with zero or extrapolated. An incomplete family has no complete annual total/share chart.
- Preserve the old variant cache contract and use `AGENT_DATA_ROOT/xydc-orders/` for new versioned snapshots. Bind country, parent, complete child set and window on read and write.
- Credentials and provider bodies never enter browser payloads, logs, Git or snapshots. GET/rendering must not call a Provider.
- Collect sequentially: request starts at least 2000 ms apart, 15000 ms per request, 300000 ms total phase. Outer cancellation wins. Retry 429 once only when supplied Retry-After is at most 30000 ms and remaining budget permits. Stop remaining calls on auth/quota failures.
- Desktop two columns, mobile one; ordinary Amazon links. Details are a dialog opened by the card button, not a permanently visible lower module.
- Do not change VOC, auth policy, core sync success rules, generated `app/*-data.ts`, formal services, shared business data, main, GitHub, or parallel worktrees.
- Use offline fixtures, scratch data roots and headless test browsers only. No real-provider call is required for implementation acceptance.
- Spec: `docs/superpowers/specs/2026-09-08-xydc-parent-orders-12m-design.md`. Prototype: `docs/superpowers/specs/assets/xydc-parent-orders-12m-prototype.png` (layout only; chart proportions computed from values).

## Baseline and test invocation

Validated at checkpoint: 18 UI/browser tests + 43 server/client/cache tests pass.

```powershell
node node_modules/tsx/dist/cli.mjs --test tests/agent/xydc-variant-section.test.tsx
node node_modules/tsx/dist/cli.mjs --conditions=react-server --test tests/scripts/xydc-mcp-client.test.ts tests/scripts/xydc-variant-sync.test.ts tests/agent/runtime-analysis-data.test.ts
```

Do not run the current UI test under `--conditions=react-server` on Windows: its `node -e` fixture transport exceeds command-line length for large fixtures. Keep the two commands separate. During UI changes replace that argument transport with stdin if it is still used; preserve all meaningful assertions.

## File structure and interfaces

New modules:

- `shared/xydc-order-contract.ts`: strict versioned wire/cache schema; no Node-only dependencies.
- `shared/xydc-order-summary.ts`: UTC window, identity matching, completeness, sums, annual ordering; no IO.
- `scripts/lib/xydc-order-cache.ts`: validated cache paths, reads, freshness and atomic writes.
- `scripts/lib/xydc-order-sync.ts`: raw monthly response projection and bounded sequential collection with injected clock/request/cache for tests.
- `app/xydc-order-card.tsx`: annual metrics/share/table, Chinese pending/failure/source labels.
- `app/xydc-order-detail.tsx`: per-family chart and all-child table inside the existing accessible dialog boundary.
- `tests/scripts/xydc-order-summary.test.ts`, `tests/scripts/xydc-order-sync.test.ts`, `tests/agent/xydc-order-runtime.test.ts`, `tests/agent/xydc-order-section.test.tsx`.

Keep helpers local unless reused by these named modules. Existing cache atomic-write utilities can be reused if doing so does not alter old variant behavior; otherwise a small order-specific writer may follow the existing pattern. Do not create a generic provider framework.

Target contract (Zod schema validates these types, including cross-field identity and unique months/children):

```ts
export type XydcOrderWindow = { startMonth: string; endMonth: string; months: string[] };
export type XydcOrderReason = 'NOT_CONFIGURED' | 'AUTH_FAILED' | 'QUOTA_EXCEEDED' |
  'RATE_LIMITED' | 'TIMEOUT' | 'CANCELLED' | 'BUDGET_EXHAUSTED' | 'RPC_ERROR' |
  'SCHEMA_INVALID' | 'NOT_FOUND' | 'PARTIAL_DATA';
export type XydcOrderChild = {
  asin: string;
  trends: { date: string; orders: number }[];
  fetchedAt: string;
  reasonCode: XydcOrderReason | null;
};
export type XydcOrderSnapshot = {
  version: 1; source: 'xydc'; aggregation: 'children';
  country: string; parentAsin: string; childAsins: string[];
  window: XydcOrderWindow; children: XydcOrderChild[];
  sourceUpdatedAt: string | null; fetchedAt: string;
  cacheState: 'fresh' | 'stale'; reasonCode: XydcOrderReason | null;
};
export type XydcOrderSummary = {
  complete: boolean; total: number | null; returnedChildren: number;
  expectedChildren: number; undisclosedChildMonths: number;
  rows: { asin: string; complete: boolean; total: number | null;
    share: number | null; missingMonths: string[]; undisclosedMonths: number }[];
  months: { date: string; total: number | null;
    values: { asin: string; orders: number | null }[] }[];
};
```

Public functions defined by Task 1:

```ts
getXydcOrderWindow(now: Date): XydcOrderWindow;
matchesXydcOrderSnapshot(snapshot: XydcOrderSnapshot, family: XydcVariantFamily,
  window: XydcOrderWindow): boolean;
summarizeXydcOrders(snapshot: XydcOrderSnapshot): XydcOrderSummary;
```

Changes to these signatures require updating all plan references and consumers, not silently inventing a second model.

### Task 1: Annual contract, identity and aggregation

**Files:** Create `shared/xydc-order-contract.ts`, `shared/xydc-order-summary.ts`, `tests/scripts/xydc-order-summary.test.ts`. Do not modify runtime/UI/provider files in this task.

**Consumes:** Existing `XydcVariantFamily` for matching. **Produces:** the schemas/types/functions listed above.

- [ ] Write failing behavior tests first using `node:assert/strict` and `node:test`. Fixed window must be exactly 12 consecutive months, valid ISO calendar months, unique children and month keys, finite nonnegative safe integer orders, and sanitized finite timestamps. Reject extra top-level/cache fields, invalid ASINs, country/path tricks, duplicate children, duplicate month entries and trends outside the requested window.

```ts
test('pins twelve completed UTC months, never the current month', () => {
  assert.deepEqual(getXydcOrderWindow(new Date('2026-09-08T00:00:00Z')), {
    startMonth: '2025-09', endMonth: '2026-08',
    months: ['2025-09','2025-10','2025-11','2025-12','2026-01','2026-02',
      '2026-03','2026-04','2026-05','2026-06','2026-07','2026-08'],
  });
});
```

- [ ] RED: `node node_modules/tsx/dist/cli.mjs --test tests/scripts/xydc-order-summary.test.ts`; verify failure is the missing new behavior, not a typo or environment issue.
- [ ] Implement the schema and pure functions. Generate month keys from UTC year/month arithmetic, validate before arithmetic. Aggregate with `Map` by ASIN and month. Missing response/month makes annual row total `null`; any incomplete child makes family total and ALL annual shares `null`. Raw zero stays in source records, increments undisclosed count, and contributes no disclosed count; zero-only annual rows have `share: null`, not a claimed 0%. Positive complete rows sort by annual total descending and ASIN tie-break; unknown rows go last. Monthly family total is `null` if any child lacks that month. Do not average monthly shares.

Core arithmetic:

```ts
const complete = rows.length === snapshot.childAsins.length && rows.every(row => row.complete);
const sum = rows.reduce((value, row) => value + (row.total ?? 0), 0);
const total = complete ? sum : null;
const withShares = rows.map(row => ({ ...row,
  share: total !== null && total > 0 && row.total !== null && row.total > 0
    ? row.total / total * 100 : null,
}));
```

- [ ] Test the real historical values as an explicitly labelled fixture, not application seed data:

```ts
const historicalValues = {
  B07R56PTMS: [400,400,400,500,400,300,300,200,100,400,300,300],
  B0834KGXN1: [100,100,100,100,100,100,100,100,50,100,100,100],
  B0831DV4D9: [50,50,100,50,100,50,50,0,0,0,100,100],
  B0831FMFVW: [50,50,0,0,0,0,0,0,0,0,0,0],
};
// Build a version:1 fixture using the window above and these exact child rows.
// Assertions: total 5900, child totals [4000,1150,650,100], 13 undisclosed
// child-months; first share 4000/5900*100, not any monthly average.
```

- [ ] Additional tests: December/January boundaries, UTC offset date near month boundary, shuffled trend order, changed parent/country/childset/window rejection, failed child with partial trends, absent child, missing month, all raw0, no children, top-three denominator with four rows. Make identity matching set-based, order-independent, and reject empty families.
- [ ] GREEN: same focused test command plus existing `tests/scripts/xydc-variant-sync.test.ts`; commit only these three task files after self-review.

### Task 2: Worker collection, independent cache and authorized runtime transport

**Files:** Create `scripts/lib/xydc-order-cache.ts`, `scripts/lib/xydc-order-sync.ts`, `tests/scripts/xydc-order-sync.test.ts`, `tests/agent/xydc-order-runtime.test.ts`; modify `scripts/lib/xydc-mcp-client.ts`, `scripts/build-xydc-variant-data.ts`, `app/lib/runtime-analysis-data.ts`, `app/lib/runtime-analysis-data-server.ts`, `tests/scripts/xydc-mcp-client.test.ts`, `tests/agent/runtime-analysis-data.test.ts` only as necessary.

**Consumes:** Task 1 contracts and identity/window/summary functions, validated variant families. **Produces:** persisted snapshots and optional `variantOrders: { families: XydcOrderSnapshot[] }` runtime member defaulting to `{ families: [] }` for historic payload compatibility.

Interfaces:

```ts
syncXydcOrderFamilies(input: {
  families: readonly XydcVariantFamily[]; token: string; now: Date;
  dataRoot: string; force?: boolean; signal?: AbortSignal;
  callTool?: (input: { toolName: 'get_asin_order_trends';
    args: Record<string, unknown>; signal: AbortSignal }) => Promise<unknown>;
}): Promise<XydcOrderSnapshot[]>;
```

Clock/delay/cache can be supplied as a separate small dependency object for deterministic timeout and cache tests. Do not read the real environment or real Provider from fixture tests.

- [ ] Write tests then RED focused commands. Cover one family / shared children dedupe, cache hit makes no request, partial resumes only missing child histories, changed window refetch, force refresh and failed refresh stale fallback, all-child coverage including fourth child. Use real filesystem cache in a scratch directory; inject only network and time boundaries.
- [ ] Extend the MCP allowlist only with `get_asin_order_trends`. Preserve existing callers and redacted error behavior. Add bounded safe metadata for order-specific 429/auth/quota handling without broadening old variant reason enums or retaining upstream message/body. Recognize documented structural HTTP/RPC status/Retry-After fields; unknown errors become `RPC_ERROR`, not guesses from arbitrary body prose.
- [ ] Project the actual observed response (already unwrapped by `callXydcTool`) and validate exact identity before using it:

```ts
const rawMonthlyExample = { status: 200, cost_credits: 2, data: {
  asin: 'B07R56PTMS', country: 'US', dateRangeNotice: 'provider availability notice',
  trends: [{ date: '2025-09', orders: 400 }, { date: '2025-10', orders: 400 }],
} };
const monthlyArgs = { asin: 'B07R56PTMS', country: 'US',
  start_month: '2025-09', end_month: '2026-08' };
```

The shown response intentionally contains only two months to test partial coverage; the complete historical fixture belongs in tests. Do not store `cost_credits`, `dateRangeNotice`, auth headers or the whole Provider body in snapshots. Keep `sourceUpdatedAt: null` when upstream provides no source-update timestamp.

- [ ] Store validated family snapshots at paths under `xydc-orders/v1/COUNTRY/` bound to parent/window/full-childset (safe filename or deterministic hash). A reader must validate content even when its filename matches. Freshness is complete, same identity/window, age in `[0, 86400000]` ms and no failed refresh; future timestamps must not extend freshness. Atomic write follows existing exclusive temporary-file, fsync, bounded Windows rename retry and temporary-only cleanup.
- [ ] Rate scheduler uses a single phase start/window and a global child identity map. Before every request/delay/retry check signal and remaining 300000 ms; pass a bounded signal into transport. Starts separated by 2000 ms; timeout per call 15000 ms or remaining phase budget, whichever is shorter. Never allow an injected request ignoring cancellation to hang the phase. On timeout preserve checked old same-window snapshot as stale, or mark unreturned children with the precise safe reason.
- [ ] A 429 with retry wait <=30000 ms gets one retry if remaining budget can cover the wait and next request; absent/invalid delay means no retry. Auth/quota errors stop later calls; other individual failures continue independent children while within budget. Cache complete children independently in the family record so a second run fills only missing children; do not refresh `fetchedAt` for reused records. On failed forced refresh prefer an intact validated same-window complete snapshot and label it stale with the failure reason.
- [ ] Integrate into `scripts/build-xydc-variant-data.ts` after variant collection so existing optional enrichment entrypoint still controls this nonblocking stage. Respect test fixture mode: no real network when `NODE_ENV=test` with an existing fixture lacking orders; return explicit unavailable/pending orders. Extend fixtures to key per ASIN when testing actual orders. A failure here must not change the core sync success contract.
- [ ] Add runtime field without changing `variants` schema. Read only snapshots matching authorized input-derived variant families and the current UTC window. A user requesting one input must not receive unrelated family snapshots, paths or raw bodies. Allow an injected `now` in read helper for boundary tests. Missing/old order caches return `families: []`, not a 500. No runtime import may trigger collection.
- [ ] GREEN commands:

```powershell
node node_modules/tsx/dist/cli.mjs --conditions=react-server --test tests/scripts/xydc-order-summary.test.ts tests/scripts/xydc-order-sync.test.ts tests/scripts/xydc-mcp-client.test.ts tests/scripts/xydc-variant-sync.test.ts tests/agent/xydc-order-runtime.test.ts tests/agent/runtime-analysis-data.test.ts
```

- [ ] Commit scoped files and report exact tests, TDD failure/pass evidence, safe error mappings, and any incomplete contract requirement.

### Task 3: Two-column cards and per-family detail dialog

**Files:** Create `app/xydc-order-card.tsx`, `app/xydc-order-detail.tsx`, `tests/agent/xydc-order-section.test.tsx`; modify `app/xydc-variant-section.tsx`, its scoped styles in `app/comparison-layout.css`, `app/page.tsx` runtime prop wiring, and `tests/agent/xydc-variant-section.test.tsx` to reflect intentionally replaced layout. Retain unaffected grouping/source/error/link assertions.

**Consumes:** `variantOrders.families` plus existing products/variant families; Task 1 validated annual summary. **Produces:** approved cards and an accessible detail dialog; no new endpoint or fetch effect.

- [ ] Write failing SSR/browser tests for title/window/source, 5900 sample, annual shares, two-column desktop geometry, one-column 390px layout, top-three denominator, empty/partial/stale states, and the dialog being absent until the corresponding button is clicked.

```ts
assert.match(html, /父体订单量份额与12个月趋势/);
assert.match(html, /2025-09/);
assert.match(html, /2026-08/);
assert.match(html, /5,900/);
assert.match(html, /67\.80%/);
assert.doesNotMatch(html, /近30天/);
await page.getByRole('button', { name: '查看全部 4 个子体与月度趋势' }).click();
assert.equal(await page.getByRole('dialog').count(), 1);
assert.equal(await page.getByRole('dialog').locator('[data-order-month]').count(), 12);
await page.keyboard.press('Escape');
assert.equal(await page.getByRole('dialog').count(), 0);
```

- [ ] RED: `node node_modules/tsx/dist/cli.mjs --test tests/agent/xydc-order-section.test.tsx`.
- [ ] Wire the optional `orderFamilies` prop from runtime to `XydcVariantSection` without breaking historic snapshots. Resolve each grouped family only by exact country/parent/full childset/window. Preserve input competitor order and representative product. Missing snapshot is a pending order card while product/variant information remains available.
- [ ] Render title, fixed window, source and aggregation label visibly. Use `getXydcOrderWindow` consistently for pending state; do not default to30 days. Format complete positive sums using grouped numbers plus `+`. Render incomplete rows as `—`, undisclosed raw0 rows as `未披露`; a complete all-unreported family shows `暂无可披露订单数据`. Failure labels in Chinese; source/collection/cache timestamps not collapsed into a fake recent timestamp.
- [ ] The card contains parent thumbnail/header and ordinary ASIN links, annual total, response coverage, percentage bar, stable ASIN-color legend, and a three-row table (variant/ASIN, annual orders/share, current price, listing date). Use complete annual totals for sorting; all shares derive from the full parent denominator. No rating/review-based order allocation. Expose the number of undisclosed child-months.
- [ ] CSS layout baseline:

```css
.xydc-order-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; }
.xydc-order-card { min-width:0; border:1px solid #dce5f2; border-radius:12px; background:#fff; }
.xydc-order-share { display:flex; overflow:hidden; border-radius:6px; }
.xydc-order-share > span { min-width:0; }
@media(max-width:900px) { .xydc-order-grid { grid-template-columns:minmax(0,1fr); } }
```

Use shared typography and spacing from surrounding page. Ensure readable text and no document-wide horizontal overflow. Narrow detail tables may scroll inside their own labeled region, not the page.
- [ ] Keep one detail dialog for the selected parent. Reuse current escape/close/backdrop/focus handling and portal boundary, improve focus return/trap only where required for this dialog. It shows the same 12-month stacked chart with ALL child series and an all-child annual table. Plot widths/heights come from values, stable ASIN colors survive sort/order; null months are missing gaps, not zero bars. Use accessible textual chart description and per-month values/tooltips; SVG/basic CSS is sufficient, no chart dependency.
- [ ] Browser tests block all non-loopback requests and mutations. Test two distinct parents, ensuring changing dialog never shows the previous parent's numbers; click close and Escape, check focus return, no extra modal on default render, 12 months, chart/color identity after sort, mobile geometry, and ordinary link href/target/rel. Save screenshots in untracked `test-results/`, not generated business files.
- [ ] GREEN commands:

```powershell
node node_modules/tsx/dist/cli.mjs --test tests/agent/xydc-variant-section.test.tsx tests/agent/xydc-order-section.test.tsx
node node_modules/tsx/dist/cli.mjs --conditions=react-server --test tests/scripts/xydc-order-summary.test.ts tests/scripts/xydc-order-sync.test.ts tests/agent/xydc-order-runtime.test.ts tests/agent/runtime-analysis-data.test.ts
```

- [ ] Commit only task files, screenshots remain untracked. Report exact screenshot paths and test outcomes.

## Final branch verification and delivery

- [ ] Run all named focused suites with appropriate separate React conditions, `git diff --check`, and lint on changed TS/TSX files. Run build in this isolated tree only; do not use shared formal runtime env or generated-data sync commands. Compare whole-repo TypeScript errors with baseline if needed; do not claim a historically failing typecheck is green.
- [ ] Inspect generated desktop/mobile/dialog screenshots. Check spec coverage, identity separation, stale/partial labeling, deadline/cancellation, future timestamps and no provider on GET. Resolve task-review and whole-branch review findings with focused regression tests.
- [ ] Record final commits, tests and limitations; do not trigger a real paid sync, restart formal services, cherry-pick into another task, merge main or push GitHub without the user's next confirmation.
- [ ] Implementation decision: use fresh task implementers with independent task review while the controller manages baseline, integration evidence and scope. If user requests inline execution instead, use executing-plans with the same TDD gates.
