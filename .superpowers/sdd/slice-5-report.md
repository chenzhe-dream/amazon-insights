# Slice 5 report — provider diagnostics, degradation, and explicit repair

Worktree: `C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\stabilize-resumable-sync-pipeline`

Baseline: `caecfe3d718fa3de118aacbbcba716d1ebf3c9f7`

## RED evidence

- Detached runner integration initially exited 1 because `createDetachedRunner` was not exported; no fixture request could launch.
- Unified child network test initially observed the default DNS order instead of the injected `ipv4first` policy.
- Provider-degradation tests initially failed because no connector-local tracker existed and a second physical fetch was dispatched after the first transport failure.
- Admin degradation tests initially failed 2/7: no safe connector status was published and the expanded panel had no provider-degraded projection.
- Explicit repair tests initially failed at all contract boundaries: the route was member-accessible by default, the route returned 404, the runner had no repair-stage selector, and PostgreSQL reported `resume is not a function`.
- The partial-stage repair test initially failed because the runner had no per-ASIN success-preservation selector.

All RED runs used loopback fake MCP/provider processes, temporary directories, or isolated PostgreSQL test schemas. No real provider was called.

## Implemented boundary

- Detached Node children now inherit one centralized proxy, CA, DNS, dispatcher-marker, and provider environment boundary.
- Child output is retained only in a fixed-size tail and parsed into a bounded whitelist: `connector`, `stage`, `asin`, `failureKind`, and `causeCode`. Raw stdout/stderr, headers, full addresses, credentials, and database URLs are not persisted.
- DNS, TLS, proxy, connection, timeout, HTTP, RPC, schema, and governor failures remain `connector-failed` or `timeout`; only successful schema-valid empty results become `upstream-empty`.
- A connector-local failure threshold stops subsequent automatic calls in the same job before resource admission or fetch. It does not select fake, cache, legacy, or retry fallbacks.
- Safe degradation state is published to connector status and rendered only in the expanded administrator panel.
- `POST /v1/admin/sync-asins/:jobId/resume` is admin-only and organization-scoped. PostgreSQL serializes concurrent repair requests, reuses the original job and fingerprint, resets only failed/partial/unfinished automatic stages, preserves successful stages/modules and lease history, and yields one worker claim.
- Repair execution selects only the recorded stages and excludes already successful ASIN results inside a partial stage.

## GREEN evidence

- Provider/worker/admin/local-contract targeted group: 45 passed, 0 failed.
- Runner postcondition/degradation/repair group: 14 passed, 0 failed.
- Contract registry/schema group: 13 passed, 0 failed.
- PostgreSQL concurrent same-scope repair tracer: 1 passed, 0 failed; one `resumed`, one `deduplicated`, and exactly one concurrent worker claim.
- Browser refresh tracers: 2 passed, 0 failed; overview readiness remained GET-only and a real reload did not add a POST before explicit restart.
- `git diff --check` exited 0.

## Build evidence

- Exactly one `npm run build` was run for this Slice.
- Vinext completed all five production build phases and exited 0.
- The existing non-failing large-chunk and static-route-classification advisories remained.

## Scope and safety

- No service was started, restarted, deployed, or rebound; ports 31900, 31901, 58258, and 3000 were untouched.
- No real provider, live task, fake/cache fallback, migration, credential output, database URL output, push, reset, clean, stash, rebase, or amend was used.
- The 13 generated `app/*-data.ts` modifications and two untracked project JSON files remain user-owned real-run data and were neither edited by this Slice nor staged.
- The coordinator assigned the single independent limited review to the separate professional tester after this implementation commit; this implementation window performed only a diff self-check and did not simulate that review.
