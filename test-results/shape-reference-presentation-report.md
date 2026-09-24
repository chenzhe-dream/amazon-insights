# Shape reference presentation task report

The isolated `app/market-shape-reference/` namespace exports `MarketShapeReferenceView` with controlled `report`, `assignments`, `selectedAsins`, `onAssignment`, `onSelected`, and `disabled` props. The parent supplies persisted Sorftime evidence; this namespace contains no provider request, model call, or browser storage write.

The view uses the original seven-region order, the original multi-select filter component and CSS classes, sortable and resizable TOP columns, controlled sample removal/restore and bulk shape editing, visible monthly volume and amount values with hover, category volume/estimated-amount and TOP3 monopoly charts, 10-dollar price bands, margin thresholds and entry conclusion. The original pure listing-age, shape-sales, shape-price, brand-price and five-dimension synthesis analyzers were copied into `conclusions/` and compared against the reference snapshot on identical complete input. A missing period blocks only dependent rich conclusions; basic tables keep missing cells unknown. Sorftime current product metrics are labeled as recent 30 days; category amount trend is explicitly labeled an estimate.

Verification:

- `npx tsx --test tests/agent/market-shape-reference-rules.test.ts tests/agent/market-shape-reference-view.test.tsx tests/agent/market-shape-reference-conclusions.test.ts` — passed (16 tests).
- `npx tsc --noEmit --incremental false` — passed.
- `npx eslint app/market-shape-reference tests/agent/market-shape-reference-conclusions.test.ts tests/agent/market-shape-reference-rules.test.ts tests/agent/market-shape-reference-view.test.tsx` — passed with warnings only, inherited from copied reference analyzers and an image element.

Remaining integration checks belong to the main task: render the v4 adapter with persisted source data in a browser at desktop and mobile widths; inspect the actual entry point, image loading, category trend provenance, sample changes, and saved-revision restore. The isolated view does not initiate a TOP 50–300 source requery; the parent query controls pool capacity. Original local-storage column width persistence was deliberately omitted; widths reset when the view remounts.
