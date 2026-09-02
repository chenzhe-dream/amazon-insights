# Task 3: Image-publication recovery selection

## Scope

- Base observed: `06922ae419f2b2ea6308147ee7609ce15e4ccd97`.
- No real Provider, business POST, service restart, or deployment was invoked.
- Changed only the PostgreSQL scoped resume selection, its service allowlist, and focused service/PG/runner contracts. No SQLite, GET authority order, Provider stage, or general resume architecture was changed.

## RED

1. Added a service contract for a repository result with exactly `image_remarks`, then `build`.
2. Ran:

   ```text
   npx tsx --conditions=react-server --test tests/agent/sync-provider-readiness-gate.test.ts tests/agent/sync-job-production-main-resume.test.ts
   ```

3. The new service contract failed for the intended reason:

   ```text
   Error: Sync job repository returned a non-category resume selection
   ```

   at `server/services/sync-job-service.ts:221`.

4. The runner-only selection contract passed before implementation, confirming `shouldRunSyncStage()` already preserves the requested pair and its order.
5. Added a PostgreSQL repository contract for a failed scoped job with all provider stages through `traffic` done, `image_remarks` partial, and `build` pending. Its dedicated run was blocked before the test body because Docker is unavailable on this host:

   ```text
   Docker is required for PostgreSQL integration tests, but the Docker service is unavailable
   ```

   This is an infrastructure blocker, not a test assertion or provider invocation.

## GREEN

- `SyncJobService.resume()` now accepts only the existing category repair or the exact ordered `image_remarks`, `build` selection.
- `PostgresSyncJobStore` exposes and resumes that exact pair only when the existing scoped terminal/explicit-repair boundaries already apply. It does not reset the canonical traffic run or its run stage, and it retains all other selection rejection paths.
- The runner was not changed because its exact-pair behavior already passed the selection contract.

Verified green:

```text
npx tsx --conditions=react-server --test tests/agent/sync-provider-readiness-gate.test.ts
# 11 passed, 0 failed

node --test tests/scripts/sync-job-resume-selection.test.mjs
# 4 passed, 0 failed
```

The full production-main fake-runner file remains blocked in this sandbox by the pre-existing Windows lock-identity failure (`Unable to establish Windows interprocess lock owner identity`). The failure affected every existing production-main case as well as the new fake-runner case; no fake Provider call was reached.

## Quality gates

```text
npx eslint server/services/sync-job-service.ts server/db/postgres/sync-job-store.ts tests/agent/sync-provider-readiness-gate.test.ts tests/agent/postgres-sync-job-repository.test.ts tests/agent/sync-job-production-main-resume.test.ts tests/scripts/sync-job-resume-selection.test.mjs
# passed

git diff --check
# passed
```

## Self-review

- The pair predicate is positional and has length two, so category/traffic and every broader or reordered recovery remain rejected.
- The `resumableStageIds()` path requires the existing terminal scoped record requirements before returning the pair.
- The `resume()` path treats an already queued identical repair as deduplicated and otherwise queues only `image_remarks` and `build`; it leaves catalog through traffic untouched.
- Outstanding verification limitations are limited to the unavailable local Docker service (PostgreSQL integration) and the sandbox Windows process-identity check (fake runner). Neither was worked around or weakened.
