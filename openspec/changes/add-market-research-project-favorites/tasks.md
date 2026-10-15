## 1. Persistence and contracts
- [x] 1.1 Add validated project/group contracts and PostgreSQL persistence with deduplication, cross-organization visibility and versioned edits.
- [x] 1.2 Add authenticated HTTP routes, authoritative task bindings and current status summaries; verify integration tests.
## 2. V2 interface
- [x] 2.1 Add fifth navigation entry and V2 library with groups, statistics, filters, table and pagination.
- [x] 2.2 Add current research save, details, metadata editing, CSV export and report restore without collection.
- [x] 2.3 Backfill real historical runs and legacy favorites on 32900 with explicit batch lineage, authoritative scopes, original ownership, idempotency and an audit snapshot.
## 3. Verification and delivery
- [x] 3.1 Pass focused backend/frontend regressions, typecheck and production build; validate OpenSpec.
- [ ] 3.2 Update 32900 candidate and verify authenticated browser save/reload/open flows.
- [ ] 3.3 Publish to 31900 only after candidate acceptance and record post-release verification.

32900 updated with the candidate worktree. Browser save/reload/open acceptance remains pending: the in-app browser repeatedly timed out and Chrome extension inspection was unavailable. Do not mark 3.2 or 3.3 complete from a successful build or service start.

## 4. Category library and demand loading (approved 2026-10-14)
- [x] 4.1 Add read-only category aggregation and paginated module history endpoints; retain every saved reference, normalize leaf category identity, isolate site/period completeness, and avoid transferring report bodies.
- [x] 4.2 Replace flat list with category selector, four module cards, historical details/preview and request cancellation/error recovery; preserve group/filter/edit/export features.
- [x] 4.3 Verify integration and UI regressions, typecheck, candidate read timings and build; record evidence separately from browser acceptance.
- [x] 4.4 Update 32900 and verify authenticated category/module/history/preview flows. Do not delete records or publish 31900 in this task.

2026-10-14 category-library acceptance: 17/17 focused tests; typecheck/build passed; candidate source hash 947f9e02ee39c87d118f5dd49f3b88de856af696c4a6fc234a2fd2fd7e5943bd. Authenticated Chrome verified 10 categories / 81 historical report references / 3 saved conditions, category switching, all four cards including empty modules, shape history pagination, site filter/reset, detail read, actual overview preview and browser back. Database still has 81 favorites. Section 3.2 remains pending for its broader save/edit acceptance; no 31900 release or archive. See docs/market-research/category-favorites-acceptance-20261014.md.
