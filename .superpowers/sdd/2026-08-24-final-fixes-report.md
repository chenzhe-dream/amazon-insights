# Final review Important fixes report

## Scope and safety

- Baseline: `602a35697fa6db234e8ea7e0551ed4e08361d959`.
- Fixed only the three Important findings from `.superpowers/sdd/2026-08-24-final-review.md`.
- Did not modify or stage the 15 protected generated application files, `.superpowers/sdd/task-3-report.md`, or the six untracked project JSON files.
- Did not run a production build, provider/MCP call, browser scrape, POST, deployment, or AI image analysis.

## Important 1 — deterministic listing-image fixture seam

Root cause: `tests/agent/listing-images-section.test.tsx` imported and mutated generated singleton data. The component had no way for the test to supply a deterministic listing record or an independent empty AI-remark result.

Implementation:

- Added optional `listingByAsin` and `resolveImageRemark` inputs to `ListingImagesSection`; production defaults remain `sorftimeListingContentData` and `getListingImageRemark`.
- Replaced generated-data imports, singleton mutation, and protected ASIN lookups in the test with local MCP-shaped fixtures copied from committed MCP output.

RED:

```text
$ npx tsx --test tests/agent/listing-images-section.test.tsx
tests 3
pass 0
fail 3

Expected two injected Sorftime images, but the component read eight images from the generated singleton.
Expected the injected SellerSprite fallback, but the component read the generated Sorftime gallery.
Expected no images for injected empty sources, but the component read the generated Sorftime gallery.
```

GREEN:

```text
$ npx tsx --test tests/agent/listing-images-section.test.tsx
tests 3
pass 3
fail 0
```

## Important 2 — per-ASIN/module data completeness

Root cause: `completenessPercent` counted aggregate automatic stages instead of `job.asinProgress`. Queue/build/image analysis polluted the denominator, while an aggregate `partial` stage discarded ready results from individual ASINs.

Implementation:

- The denominator is target ASINs multiplied by exactly these 10 data modules: `catalog`, `keywords`, `reviews`, `sales_trend`, `child_sales`, `price_strategy`, `fba`, `listing`, `category`, `traffic`.
- Target ASINs come from `job.asins`, falling back to `asinProgress` keys only when `asins` is absent.
- Only `status === "ready"` counts. `upstream-empty`, `timeout`, `connector-failed`, `pending`, and `manual` do not count.
- Focused projections filter the same 10-module set by focused stage ids. Queue, build, Alexa VOC, and disabled image remarks are excluded.
- Execution projection, terminal 100%, zero terminal ETA, refresh, dismiss, and restart logic were not changed.

RED:

```text
$ npx tsx --test tests/agent/asin-sync-session.test.ts
tests 31
pass 29
fail 2

29 of 30 target ASIN/data-module results are ready: actual 92, expected 97.
The terminal browser assertion could not find the exact text: 数据完整度 97%.
```

GREEN after implementation:

```text
$ npx tsx --test tests/agent/asin-sync-session.test.ts
tests 31
pass 31
fail 0
```

Final GREEN after adding the absent-`asins` and all-non-ready-status contract case:

```text
$ npx tsx --test tests/agent/asin-sync-session.test.ts
tests 32
pass 32
fail 0
```

Exact assertions include:

- Overall completeness `97%` for 29 ready outcomes out of 30.
- Focused keywords completeness `67%` for two ready ASINs and one connector failure in an aggregate partial stage.
- Fallback-to-`asinProgress` completeness `17%` for two ready outcomes out of 12, with all five non-ready statuses excluded.
- Terminal execution `100%`, `remainingSeconds === 0`, and `finishAt === null`.

## Important 3 — truthful image provenance and empty state

Root cause: gallery resolution returned URLs only. The UI therefore labeled every row as Sorftime and based readiness only on the Sorftime record, even when the displayed image was the SellerSprite catalog fallback.

Implementation:

- Gallery resolution now returns URLs plus source: `sorftime`, `sellerSpriteCatalog`, or no source.
- Sorftime gallery/main image retains priority. SellerSprite is used only for `product.image` fallback.
- Row copy is source-aware: `Sorftime MCP · 图册 N 张`, `SellerSprite MCP · 商品图 1 张`, or `MCP 暂未返回商品图`.
- Component and page-level badges use the neutral `MCP 商品图` label.
- The generic success note no longer claims Sorftime fetched a SellerSprite fallback.
- Per-image copy remains `AI 备注待后续分析`; no AI/provider path was started.

RED used the same focused component command as Important 1. The SellerSprite case rendered the Sorftime gallery and the empty case rendered generated Sorftime images, so both provenance/empty-state behaviors failed before production changes.

GREEN:

```text
$ npx tsx --test tests/agent/listing-images-section.test.tsx
tests 3
pass 3
fail 0
```

## Final verification

```text
$ npx tsx --test tests/agent/listing-images-section.test.tsx
tests 3; pass 3; fail 0

$ npx tsx --test tests/agent/asin-sync-session.test.ts
tests 32; pass 32; fail 0

$ npx eslint app/lib/sync-progress-presentation.ts app/listing-images-section.tsx tests/agent/asin-sync-session.test.ts tests/agent/listing-images-section.test.tsx
0 errors; 4 existing no-img-element warnings

$ npx eslint app/lib/sync-progress-presentation.ts app/listing-images-section.tsx app/page.tsx tests/agent/asin-sync-session.test.ts tests/agent/listing-images-section.test.tsx --rule "react-hooks/set-state-in-effect: off" --rule "react-hooks/refs: off"
0 errors; 13 existing warnings

$ git diff --check -- app/lib/sync-progress-presentation.ts app/listing-images-section.tsx app/page.tsx tests/agent/asin-sync-session.test.ts tests/agent/listing-images-section.test.tsx
exit 0

$ npx tsx --test tests/agent/listing-images-section.test.tsx
# repeated from a clean detached candidate worktree using committed generated data only
tests 3; pass 3; fail 0
```

Default ESLint on all five changed files also reports eight pre-existing `app/page.tsx` hook/ref errors at unchanged lines 2155, 2226, 3686, 3740, and 3794. This candidate changes only the import at line 57 and the image source badge at line 3167 in that file; the scoped lint above disables only those two legacy rule families and reports no candidate error.
