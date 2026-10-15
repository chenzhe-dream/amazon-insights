# Remaining market gaps implementation plan

**Goal:** Complete confirmed omissions before further real-category acquisition; validate with synthetic sources and update only 32900.

**Architecture:** Field-level chapter evidence guards shared across categories; immutable saved evidence remains untouched. Separate existing report compatibility from new business conclusions. Verify scheduler/cache behavior before changing concurrency.

**Constraints:** No 31900 deployment. No real collection during repair. Preserve sample counts, unknown values, manual classifications and historical source identities. No read-side writes.

- [x] O-03: Add failing projection cases for missing concentration/distribution shares, partial Top3, incomplete trend windows and product-count versus sales-share confusion.
- [x] O-03: Introduce reusable per-chapter evidence checks; retain usable facts, list missing fields, and prohibit unsupported conclusions.
- [x] H-01: Inspect existing report generation/storage boundaries; preserve historical source data and distinguish frozen output from current derivation. Add persistence or version support where the current requirement needs it.
- [x] Scheduler: Inspect actual worker advancement and existing virtual cost fixtures; run bounded offline comparison of cold, shared-cache and report-history paths. Change only demonstrated bottlenecks.
- [ ] Regression: Run four-module/default/manual/history/cross-category suites, typecheck and build. Record actual outcomes and unresolved business boundaries.
- [ ] Candidate: Update only 32900/32901 and verify saved reports and version identity; 31900 remains unchanged.

- [x] N-01: Add category review development conclusions with positive requirements, negative risks, evidence and validation actions. Bind baseline/manual selection and saved attempt.
- [x] N-02: Add four-module conclusions from matching saved report scope only, showing missing/failed modules separately. No new provider/model calls.
- [x] H-02: Freeze new conclusions and their derivation inputs on explicit save, with immutable content identities; reads remain read-only and historical snapshots never rederive.

The user approved both new conclusions on 2026-10-15. Preview derives automatically from saved evidence; saving freezes the exact preview with a hash guard. This does not collect data or spend MCP quota. Unified conclusions name their batch scope and module versions, and do not substitute one marketplace/month/category for another. Economic viability and compliance remain explicit validation tasks when evidence is absent.
