## Why

The six-ASIN acceptance job proved that a successful Sorftime catalog fallback can be followed by five connector-failed modules because the already-fetched response is projected down and discarded before downstream stages run. The same loss leaves only the catalog main image, so image remarks see a zero-image gallery, while environment-backed connector credentials cannot be replaced from the primary-admin UI.

## What Changes

- Persist a bounded, job-scoped Sorftime evidence record from the catalog fallback and consume it only when job, marketplace, ASIN, fetch time, operation, and provenance match.
- Materialize every static gallery image from the retained product-detail response before image remarks; reactivate pending image remarks exactly once when a gallery becomes ready and isolate per-image failures.
- Let the five affected modules use same-job Sorftime evidence when their normal execution has no usable result, while keeping successful normal-provider results first and distinguishing verified empty from connector failure.
- Restore the six sealed pre-switch lighting-ASIN results only for the seven proven catalog/SIF/Sorftime exports, using manifest-SHA verification and record-level missing-only merges that preserve canonical collisions and missing-result semantics.
- Let a primary administrator explicitly switch an environment-backed SIF, Sorftime, or SellerSprite credential to a managed credential with confirmation and one-time secret entry; never return or log the secret and probe after save.
- Show truthful upstream-empty and analysis-pending reasons, including the exact server configuration path when an environment credential remains active.

## Capabilities

### New Capabilities

- `scoped-sync-fallback`: Covers bounded same-job Sorftime evidence reuse, gallery-to-image-remarks activation, truthful progress reasons, and safe environment-to-managed credential switching.

### Modified Capabilities

None.

## Impact

Affected areas are the Sorftime catalog/listing/module builders, sync runner and progress projection, image remarks queue and listing image UI, a bounded generated-result recovery tool, connector credential route/service and concurrency admin panel, plus fixture-only tests. No database migration, generic provider platform, live provider calls, deployment, or changes to the administrator-center/read-only-history slices are included.
