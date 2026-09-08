# Xiyou Cache-First Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep legitimate yearly order snapshots visible after freshness expiry or calendar rollover, without GET-triggered collection or incorrect product/window attribution.

**Architecture:** A pure shared selector validates and ranks snapshots; a narrow server file reader discovers only canonical candidates for the authorized family. The existing annual section uses the same selector and displays each snapshot's actual period. Collection freshness and writer protection remain separate from display eligibility.

**Tech Stack:** TypeScript, Zod, React, Node fs, node:test/tsx, existing offline Playwright/Vite tests; no dependencies.

## Global Constraints

- Scope version CACHE-PRESENCE-20260909-A; only cached yearly display and its regressions.
- Work only in C:/Users/EDY/Amazon-Product-Opportunity-Insights/.worktrees/fix-voc-import-status-20260907 on codex/feat-xydc-parent-orders-12m-20260908. Preserve existing dirty docs/test-results. Do not edit formal/shared data, default parallel worktree, auth files, main or GitHub.
- Keep country, parent ASIN, complete child set and actual 12-month window strict. Future timestamps, malformed payloads and mismatched identities must never become eligible through stale fallback.
- Preserve fetchedAt/sourceUpdatedAt and original raw-zero-as-undisclosed arithmetic. No new monthly hover, pie chart, timers, Provider calls or GET writes.
- Retain existing 24-hour collector freshness, budget, locks, cancellation and newer-success protection; do not silently force collection.
- User authorized self-reviewed in-scope corrections without repeated approval. Significant scope expansion still goes to root, not unilaterally into code.

### Task 1: Persistent stale/history selection and original-module rendering

**Files:**
- Create `shared/xydc-order-display.ts`: pure selection/validation only.
- Create `scripts/lib/xydc-order-display-cache.ts`: read-only canonical family candidate discovery.
- Modify `app/lib/runtime-analysis-data-server.ts`: delegate only order display lookup.
- Modify `app/xydc-variant-section.tsx`, `app/xydc-order-card.tsx`; `app/xydc-order-detail.tsx`, `app/xydc-annual-inspection.tsx` only when required for truthful source-window labels/lifecycle.
- Modify `scripts/lib/xydc-order-cache.ts` only if failing regression proves valid last-good snapshots can be overwritten by failed/partial writes. Avoid collector redesign.
- Create `tests/scripts/xydc-order-display.test.ts`; modify `tests/agent/xydc-order-runtime.test.ts`, `tests/agent/xydc-order-section.test.tsx`; add targeted writer regression to `tests/scripts/xydc-order-sync.test.ts` if needed.
- Add evidence to `.superpowers/sdd/cache-first-task-1-report.md`. Root owns plans, ledger and final verification documents.

**Interfaces:**
- Consumes existing `XydcVariantFamily`, `XydcOrderSnapshotSchema`, `getXydcOrderWindow`, `matchesXydcOrderSnapshot`, `summarizeXydcOrders`, `xydcOrderCachePath`, `isFreshXydcOrderCache`.
- Produces `selectXydcOrderDisplaySnapshot(candidates: readonly unknown[], family: XydcVariantFamily, window: XydcOrderWindow, now: Date): XydcOrderSnapshot | null`.
- Produces `readXydcOrderDisplaySnapshot(dataRoot: string, family: XydcVariantFamily, window: XydcOrderWindow, now: Date): XydcOrderSnapshot | null`.
- Wire without changing `RuntimeAnalysisDataSnapshot.variantOrders.families` shape or project authorization. A selected stale copy may use cacheState stale in the projection; never rewrite its persisted timestamps/state on GET.

- [ ] **Step 1: Add expected-behavior tests and observe RED.** Reuse current family/order fixtures in runtime/section tests. New pure tests can use the following minimal complete fixture (with imports from the existing shared modules):

```ts
const now = new Date('2026-10-09T12:00:00.000Z');
const requested = getXydcOrderWindow(now);
const family: XydcVariantFamily = {
  inputAsin:'B000000001', country:'US', parentAsin:'B000000010', dimensions:[],
  children:[{asin:'B000000001',attributes:[],title:null,imageUrl:null,price:null,currency:null,stars:null,productPageRatings:null,listingDate:null,infoStatus:'pending'}],
  sourceUpdatedAt:null,fetchedAt:'2026-09-08T07:00:00.000Z',status:'partial',reasonCode:'PARTIAL_CHILD_INFO',cacheState:'stale'
};
const snapshot = (window: XydcOrderWindow): XydcOrderSnapshot => ({
  version:1,source:'xydc',aggregation:'children',country:'US',parentAsin:family.parentAsin,
  childAsins:['B000000001'],window,
  children:[{asin:'B000000001',trends:window.months.map(date=>({date,orders:10})),fetchedAt:'2026-09-08T07:00:00.000Z',reasonCode:null}],
  sourceUpdatedAt:null,fetchedAt:'2026-09-08T07:00:00.000Z',cacheState:'fresh',reasonCode:null
});
const prior = snapshot(getXydcOrderWindow(new Date('2026-09-08T12:00:00.000Z')));
assert.equal(selectXydcOrderDisplaySnapshot([prior],family,requested,now)?.window.endMonth,'2026-08');
assert.equal(selectXydcOrderDisplaySnapshot([prior],family,requested,now)?.fetchedAt,prior.fetchedAt);
assert.equal(selectXydcOrderDisplaySnapshot([prior],family,requested,now)?.cacheState,'stale');
const current = snapshot(requested);
assert.equal(selectXydcOrderDisplaySnapshot([prior,current],family,requested,now)?.window.endMonth,'2026-09');
assert.equal(selectXydcOrderDisplaySnapshot([{...current,children:[]} ,prior],family,requested,now)?.window.endMonth,'2026-08');
assert.equal(selectXydcOrderDisplaySnapshot([{...prior,country:'DE'}],family,requested,now),null);
assert.equal(selectXydcOrderDisplaySnapshot([{...prior,fetchedAt:'2099-01-01T00:00:00.000Z'}],family,requested,now),null);
```

Split assertions into named tests; also cover invalid/future child and source timestamps, future window, wrong child set, duplicates, current partial without history, all-zero complete snapshot, stable deterministic tie order, non-mutation. Run `node --conditions=react-server --import tsx --test tests/scripts/xydc-order-display.test.ts tests/agent/xydc-order-runtime.test.ts`; record behavior RED, not syntax/import failures alone.

- [ ] **Step 2: Implement the pure selection algorithm.** Use safe parsing and nonfuture timestamps before ranking; normalized family identity still uses the existing exact matcher. The core decision is:

```ts
const complete = valid.filter(s => summarizeXydcOrders(s).complete);
const currentComplete = complete.filter(s => s.window.endMonth === window.endMonth);
const selected = newest(currentComplete) ?? newest(complete)
  ?? newest(valid.filter(s => s.window.endMonth === window.endMonth));
return selected ? {
  ...selected,
  cacheState: selected.window.endMonth !== window.endMonth || !isFreshXydcOrderCache(selected, now) ? 'stale' : selected.cacheState,
} : null;
```

Keep the shared module browser-safe: do not import fs/cache writer/MCP; reproduce freshness using a small pure timestamp/shape helper or extract the existing pure freshness code to a shared module and re-export it from cache.ts for compatibility. `newest` ranks endMonth descending, fetchedAt descending, then stable content tie-breaker. Validation requires `matchesXydcOrderSnapshot(s,family,s.window)` and `s.window.endMonth <= window.endMonth`, parsed 12-month schema and finite timestamps <= now. No aggregate across snapshots/windows.

- [ ] **Step 3: Implement read-only cache discovery and integrate runtime.** Read only regular non-symlink files under `dataRoot/xydc-orders/v1/<validated-country>`, with parent-specific filename prefix and canonical pattern. Parse each file, recompute `xydcOrderCachePath(dataRoot,family,snapshot.window)` and require exact normalized absolute filename equality before considering content. Current-file direct lookup remains supported. ENOENT/malformed optional candidates do not prevent another valid candidate; never follow supplied paths from JSON, subdirectories, arbitrary ASINs or temporary files. Return `selectXydcOrderDisplaySnapshot(candidates,family,window,now)` and retain existing deduped authorized family grouping in runtime. GET creates no files/tasks/Provider clients.

- [ ] **Step 4: Integrate UI with actual snapshot windows.** In section `resolveOrderSnapshot`, call the same pure selector with `familyIdentity(group)`, requested window and current time. Keep `model.window` as requested window and `model.snapshot.window` as actual data period. Card, detail and annual inspection use actual snapshot window, including inspection identity. Add Chinese `历史缓存` when periods differ, `缓存数据` for expired current period, and note requested-window data is pending when history is selected. Section heading must distinguish default requested range from a history card's actual range. Do not relabel old data latest/current. Existing progress remains independent.

```tsx
const sourceWindow = snapshot?.window ?? window;
const historical = Boolean(snapshot && sourceWindow.endMonth !== window.endMonth);
// In the existing source/status region:
{historical ? <em>历史缓存 · 当前统计区间待补齐</em> : snapshot?.cacheState === 'stale' ? <em>缓存数据 · 待更新</em> : null}
```

- [ ] **Step 5: Verify full task matrix once, self-review and commit only owned files.**

Run pure+runtime+writer tests with server condition:
`node --conditions=react-server --import tsx --test tests/scripts/xydc-order-display.test.ts tests/agent/xydc-order-runtime.test.ts tests/scripts/xydc-order-summary.test.ts tests/scripts/xydc-order-sync.test.ts tests/agent/runtime-analysis-data.test.ts`

Run UI separately (no react-server):
`node --import tsx --test tests/agent/xydc-order-section.test.tsx tests/agent/xydc-variant-section.test.tsx tests/agent/xydc-variant-label.test.ts tests/agent/xydc-order-progress-ui.test.tsx tests/agent/xydc-order-poll-owner.test.ts`

Use isolated local fixtures/headless browser, no user Chrome or real Provider. Add real temporary-files runtime checks for repeated GET/no writes, old-window discovery, noncanonical filenames, mismatch, and retained complete writer data after failed/partial update. Add DOM/SSR assertions on historical source periods, actual annual totals, no data mixing, correct current-complete replacement and removal on family change. Preserve old monthly interaction exclusions and stale-response guards.

Run changed-file ESLint and `git diff --check`; report warnings truthfully. Root tracks existing global TypeScript baseline independently. Commit with `feat: preserve cached xydc annual results for display`, then report actual RED/GREEN commands, assertions, counts, changed paths and concerns. Do not run build, deployment or paid collection.
