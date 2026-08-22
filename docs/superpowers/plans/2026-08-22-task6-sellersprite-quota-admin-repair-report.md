# Task 6 SellerSprite Quota/Admin Repair Report

Date: 2026-08-22

## Scope

Repaired the Task 6 review findings for SellerSprite quota refresh, resource-circuit admission, scheduled refresh lifecycle, audit reliability, migration tenant guards, and the primary-admin UI controls. No live Agent Service ports, live PostgreSQL instance, real users, or real SellerSprite endpoint were used; all provider behavior was exercised through isolated PostgreSQL and fake transports.

## Changes

- `acquirePermit` and `recordPhysicalAttempt` now read the tenant/resource circuit inside the PostgreSQL admission transaction before inserting permits or physical attempts.
- SellerSprite quota refresh is disabled unless `/v1/visits` URL and `SELLERSPRITE_SECRET_KEY` are explicitly configured; the client enforces HTTPS `/v1/visits`, uses the existing `secret-key` header contract, and passes an abortable timeout signal.
- Manual quota refresh appends non-secret audit for success, malformed response, upstream unavailable, timeout, and `ERROR_VISIT_MAX`; scheduled refresh uses a system-safe scheduled audit event with no fake user actor.
- Scheduled `ERROR_VISIT_MAX` opens the SellerSprite circuit without a fake actor while preserving existing manual holds.
- Added a bounded 45-minute default scheduler, constrained to the 30-60 minute lifecycle window, started/stopped exactly once by Agent Service only when complete config and execution context exist.
- Updated undeployed migration `0013` with same-active-organization actor triggers for quota settings/circuits/snapshots and append-only triggers for SellerSprite quota snapshots.
- UI now exposes explicit conservative/standard/fast policy choices to the primary administrator.

## Verification

- `npx tsx --conditions=react-server --test tests/agent/agent-service-shutdown.test.ts tests/agent/concurrency-admin-page.test.tsx tests/agent/concurrency-admin-routes.test.ts tests/agent/postgres-concurrency-control.test.ts tests/agent/postgres-migrations.test.ts` — GREEN, 32/32.
- `npx eslint app/concurrency-admin-panel.tsx server/agent-service.ts server/app.ts server/config.ts server/db/postgres/concurrency-control-store.ts server/services/seller-sprite-quota-service.ts tests/agent/agent-service-shutdown.test.ts tests/agent/concurrency-admin-page.test.tsx tests/agent/concurrency-admin-routes.test.ts tests/agent/postgres-concurrency-control.test.ts tests/agent/postgres-migrations.test.ts` — GREEN.
- `npm run build` — GREEN.
- `npx tsc --noEmit --pretty false` with touched-file filtering — GREEN for Task 6 touched files; full repository still reports pre-existing baseline TypeScript errors outside this repair scope.

## Concern

- `npm run test:agent` was started as an affected long gate and passed the early emitted tests, but produced no further output for several minutes; it was manually stopped to avoid an unbounded wait. It is not claimed as GREEN.
