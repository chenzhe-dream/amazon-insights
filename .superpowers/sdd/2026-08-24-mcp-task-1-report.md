# MCP Task 1 report: three-connector failure-scope matrix

## Status

`DONE` — `NO_PRODUCTION_CHANGE`.

## Scope and boundary

- Baseline inspected: `53dd30a`.
- Modified only the two requested tests. `scripts/lib/provider-diagnostics.mjs` was inspected but remains unchanged.
- Protected generated app files, project JSON files, and `task-3-report.md` were left untouched.
- Tests use local child-process shims only: no live MCP request, browser action, POST, or deployment occurred.

## Characterization result

`tests/scripts/provider-degradation.test.mjs` now has a table-driven matrix across `sif`, `sorftime`, and `sellerSprite`:

- `schema` / `MCP_SCHEMA` leaves the connector breaker closed, emits no skip diagnostic for ASIN B, and leaves a later dispatch available. SellerSprite has one production stage, so its independently dispatched second catalog ASIN is the corresponding isolation check.
- `dns`, `tls`, `proxy`, `connection`, `timeout`, `http`, `rpc`, `governor`, plus auth and quota represented by the existing safe `http` contract, open only the failed connector's breaker and return the fixed `provider-degraded` / `PROVIDER_DEGRADED` skip diagnostic.
- Authentication is represented by `http` / `HTTP_4XX`; remote quota by `http` / `HTTP_5XX`; local admission/queue limiting by `governor` / `RESOURCE_GOVERNOR`. No diagnostic enum was expanded.

The new matrix passed on its first characterization run, confirming the existing closed allowlist and breaker policy already implement the requested behavior. No production diagnostic change was justified.

## Production continuation coverage

`tests/agent/sync-job-production-main-resume.test.ts` adds an isolated local runner scenario for each connector. A single first-ASIN `schema` / `MCP_SCHEMA` diagnostic is injected once; the test proves `providerDegraded` stays empty, ASIN B has no `provider-degraded` diagnostic, and the connector's next real dispatch still executes:

- SIF: `keywords` failure then ASIN B `traffic` dispatch.
- Sorftime: `reviews` failure then `sales_trend` dispatch containing ASIN B.
- SellerSprite: first `catalog` ASIN failure then second `catalog` ASIN dispatch.

## Verification evidence

1. `node --test tests/scripts/provider-degradation.test.mjs` — 37 passed, 0 failed.
2. `npx tsx --test tests/agent/sync-job-production-main-resume.test.ts` — 5 passed, 0 failed.
3. Changed-file ESLint and scoped whitespace/diff checks are run immediately before commit.

## Self-review

- Assertions exercise the real tracker and production runner, rather than testing a mock's call count alone.
- Scope remains limited to schema-local behavior and existing provider-wide classifications.
- No unrelated dirty worktree changes are staged by this task.
