# Category report preview association — 2026-10-16

## Formal correction already published
31900 commit 6164dc65 fixes the idle overview falling back to the global newest Darts job. Live Chrome verification: saved conditions for 16184244011 show Playground Fitness Equipment; 166423011 show Fitness Equipment; 3413711 show Targets & Accessories. Returning to favorites preserves the selected category. No collection was started.

## Preview association (32900 acceptance only)
- Both history-list previews and detail-drawer previews bind the selected exact saved report plus available published peer reports.
- Match category leaf ID, marketplace, end month and rolling/calendar period. Prefer an existing compatible bound peer, then exact start month, saved report availability, ready status and report creation time. Favorite rename time is not report freshness.
- Retain each report's actual month range, task ID and query parameters. Do not relabel a report's data to fit another scope.
- Missing modules receive the selected category/site/month conditions with no task ID. No automatic refresh or collection.
- Association reads only published favorite metadata and scalar report status, not report bodies. Existing cross-organization shared-read rules remain in effect.
- Returning to the directory preserves category and module.

## Verification
Focused tests: 7 passed (PostgreSQL catalog, favorite persistence/shared authorization, browser integration, pure selection rules). Browser integration exercises two distinct categories and a third category missing peer reports, switches all four modules and reloads, asserting zero non-GET collection writes. The database test also covers the detail drawer, cross-site/month rejection and immutable version identity.

Formal 31900 receives only the first correction. Preview association is staged on 32900 for user acceptance.

Typecheck and git diff --check passed. Candidate pre-update PostgreSQL backup SHA256: 5B95FEC9D107B7B9C71CA4DAF95C82A1E8FD5322BDDB22E02F855CAD51F19888.
