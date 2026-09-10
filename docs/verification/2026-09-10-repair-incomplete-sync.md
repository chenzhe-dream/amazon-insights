# 补抓未完成 verification

## Delivered behavior

The terminal restart button is now 补抓未完成. It posts repair-incomplete with the parent job and full project ASIN scope. The server verifies ownership, marketplace and the exact ASIN set, plans current incomplete automatic cells and missing Xiyou families/orders, and creates a fresh canonical run through existing atomic queue admission. Active equivalent jobs reuse existing identities. No-work returns without creating a job or clearing the terminal UI.

Stage JSON durably carries the targeted ASINs and parent reference. Cached stages are projected into the new run without provider dispatch. Missing cells run with repair-only cache policy, including image slots and scoped Xiyou children. Manual VOC is excluded from repair and the data-gap list. A successful new repair clears the active old VOC report pointer; saved historical reports are not deleted. Final VOC evidence gating remains the responsibility of the separate OpenSpec change.

Repair does not delete global caches. Failed or empty replacements preserve prior populated records and provenance, with separate failure diagnostics. Xiyou uses the existing child-history checkpoint granularity: incomplete child histories can be requested again, while complete child histories are reused. It does not promise a provider request limited to four individual months when the upstream endpoint returns a child's full history. Optional Sorftime variant details retain prior data on errors, empty details, or disappearing children.

## Verification

- Final targeted Node suite: 57/57 (runner selection, cached projections, postconditions, cache safety, readiness, Sorftime budgets, existing resume compatibility).
- Final targeted TypeScript suite: 57/57 (repair service and request contracts, browser request behavior, UI readiness, actual Xiyou file caches, variant recovery and offline CLI).
- PostgreSQL repository / service / Xiyou order and variant suite: 85/85, including durable repair-stage metadata roundtrip, concurrent admission, lease fencing and canonical run lifecycle.
- Additional provider compatibility suite: 41/41 (SIF strict payloads, scoped Sorftime fallbacks, zero-review evidence, streaming deadlines).
- Xiyou progress subset: 14/14; real directly-owned child-process cancellation: all five scenarios passed after the authoritative repair subset change.
- UI browser regression: four focused terminal/publication cases passed across the funnel consumers; four repair request-helper cases passed.
- After final variant empty-response hardening: Sorftime variant suite 9/9, including thrown optional error, resolved empty details, and resolved empty variations using temporary output files.
- `npm run build` passed. Changed JavaScript modules checked with ESLint `no-undef:error`; diff whitespace validation passed.

Independent review found and drove fixes for a missing traffic import, Xiyou subset progress, Xiyou RPC/timeout classification, default data-root parity, image force-policy inheritance, and optional variant data loss.

## Existing baseline limits and release status

Repository-wide TypeScript and page lint are not clean. A same-file ESLint comparison against git HEAD found 9 prior errors versus 8 after this change, with the same six pre-existing ref-render errors. The old local-data bridge source assertion searches a VOC recovery string absent in both HEAD and the working file; its unrelated failure was not hidden or weakened.

Verification used temporary files, test databases, fake providers and browser harnesses. No full authenticated production-page repair E2E or live-provider repair was run for this change. Formal runtime/data were not modified or deployed during implementation. The existing untracked test-results directory was preserved.
