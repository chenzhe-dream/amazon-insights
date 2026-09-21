## Context
Approved baseline: C:/Users/EDY/.codex/project-notes/amazon-insights/ui-parity-20260914/reference/app. User explicitly confirmed frontend original, backend current. The reference includes collector calls and calculations which MUST NOT be transplanted.

## Goals / Non-Goals
Restore query/loading/result/expanded-report presentation. Keep factual backend scope, unknown values, source boundaries and reports. Do not rewrite backend, claim unsupported near-30-day/site/sample capabilities, invent metrics, or remove new functionality.

## Decisions
Follow-up approved on 2026-09-16: use the standalone original preview as the visual baseline, including analysis results. Separate the original into (1) read-only reference source inventory, (2) pure presentation components/view models in app, (3) documented analytical methodology and its existing governed equivalents, and (4) provider/API implementations retained on the current server. This is a separation by responsibility, not a file-copy rollback. Record every original dimension as mapped, missing-data, or missing-capability; preserve the original analytical intent without importing uncontrolled client scoring or silently dropping sections. Where the current backend lacks a result, preserve the original section with an explicit unavailable state. Do not calculate a new business conclusion in a chart adapter.

For overview restore the original report order: market overview, keyword demand/trend, sales trend, product/brand/seller concentration, seller type, A+/video, seller origin, product demand, listing age/trend, rating count/value and price. Group current saved results by those presentation sections. Keep semantic period, sample basis, source identifiers and missing values intact. Pure view helpers may select, order and format saved facts; they cannot rerun provider operations or analysis. Place source/task/version diagnostics in accessible disclosure controls, and show failures and missing data visibly.

For shape, keyword and theme modules retain current task owner components and commands, extract or reuse dedicated result views, and align original headings, report cards, charts and tables. Preserve shared favorites, copy, paging, manual classification, revisions, retry, saved restoration and HTTP-safe request IDs. Do not modify server, worker, shared contracts, collectors, database or the reference archive. Synthetic preview transport must never enter app code.

Delivery is local verified implementation first. Formal publishing is separate from frontend separation and must use the existing formal release gate; previous release evidence is not evidence for this follow-up.

Keep existing client helpers and task owners. Make result-row report action use the existing overview study/run commands, bound to the selected result scope; loading a saved task or collapsing/reopening the same report must remain read-only. Keep task management and history in compact disclosure sections. Arrange saved overview metrics as sample/head/new-product cards; head fields absent in backend remain unknown. Present existing synthesis and distribution outputs with original report block hierarchy and scoped CSS. Shape/keyword/theme work restores reference structure while retaining manual edits, pagination, copy, retries and revisions. Existing shared favorites remain available in a compact toolbar.

## Risks / Trade-offs
Exact visual parity is limited by absent backend data. Layout should match the reference, but unreturned metrics and unsupported queries remain honest. Restored tasks may have a different scope from edited filters; retain mismatch warning. UI tests use intercepted backend fixtures, not live providers.

## Migration Plan
No migrations. Snapshot changed frontend files; run targeted red/green, typecheck and build. Compare screenshots at desktop/mobile and inspect source-only changes. Publish only with idle formal-manager gates and verify runtime identity.
