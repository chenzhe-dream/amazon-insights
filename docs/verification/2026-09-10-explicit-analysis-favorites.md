# Explicit analysis favorites: verification and controlled release

## Approved behavior

Analysis creation/save adds history only. Explicit star controls write organization-shared markers under `AGENT_DATA_ROOT/analysis-project-favorites`. Default library view is 已收藏; 历史项目 remains complete. Unfavorite never deletes or rewrites the legacy project or analysis results. Other project kinds retain existing behavior. No comparison-draft migration, cloud deployment or Provider replay.

The existing 24 analysis records contain no explicit favorite provenance. The user approved keeping all as history, initially unstarred; no record migration or backfill is performed.

## Verification

- Test-first backend run failed on missing implementation, then passed. New backend/store/auth and actual Web-proxy/Fastify roundtrip tests: 9/9; existing proxy tests: 27/27.
- Mounted React browser tests: 5/5. Covers empty favorites despite history, explicit add/remove/reload, no project DELETE, failed mutation/retry, abandoned-session read rejection, other kinds, and save-as-new history only.
- `npm run test:traffic-regression`: 36 script tests + 54 TypeScript/browser tests passed (includes VOC restore identity/logout and real traffic display).
- Targeted ESLint: exit 0. Production build: exit 0, existing chunk/static-classification warnings.
- Full typecheck returns the existing 334 diagnostics; new code diagnostics corrected. Do not describe whole-repository typecheck as green.
- `local-data-bridge.test.ts`: 22/23. The existing source-text assertion searches a removed VOC effect literal (`const runId = vocRunIdFromSearch(searchParams.toString())`); the same literal is absent at clean baseline 24e9b10. Existing authenticated bridge behavior passes; actual VOC recovery browser tests pass. This unrelated stale assertion was not modified.
- Independent read-only review found that the original favorite mutation contracts dropped arbitrary browser bodies. Reproduced 200 instead of expected 400. Fixed with strict empty-object validation transformed to undefined, preserving bodyless upstream PUT/DELETE without changing the generic client. Re-ran actual proxy roundtrip and spoofed-scope rejection: 36/36 green. Final focused review approved, no remaining blocker.

## Pre-release baseline

Formal checkout: `integrate-xydc-variant-20260905`; HEAD and running source 2e5a29de2d051b565de910ea6314ffb9cc6f187e. Web artifact 375091a47271e25c260e4daca823da4c7430c327f8bde487652aea7111f3920b; Agent/Web source hash 35465564ce4ef97ac44322f3be3f5fe1e2fb46e97d352aac5bf54a33522d3955. Local health checks returned ok.

Live read-only project inventory: 24 analysis, 2 keyword-compare, 2 traffic-promo. Formal 15 generated files and parallel source WIP will be preserved. OpenSpec task confirmed no concurrent edits or publication. Activation remains through the existing formal manager, after active-work and ownership checks; PostgreSQL is not restarted.

## Activation

Pending controlled release and final artifact/hash evidence. No formal service change has been made at this checkpoint.
