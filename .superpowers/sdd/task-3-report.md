# Task 3 report: scoped stage-output reads

Original Task 3 base: `874d1926dd3bb27697a90bd5e0bf82253ed1d3bf`

Original Task 3 head before review remediation: `2f3fdd3`

Review remediation base: `2f3fdd3`

Review remediation head: the new remediation commit that includes this report

## RED

Command:

```powershell
npx tsx --conditions=react-server --test tests/agent/stage-output-route.test.ts tests/agent/auth-authorization.test.ts
```

- Initial route RED: 3 passing, 6 failing. The new endpoint was unregistered: scope checks received the framework `Route not found` response and the exact route returned 404 rather than 200.
- After correcting the test fixture so the organization mismatch uses a foreign authenticated principal and adding legacy/non-terminal cases: 3 passing, 8 failing for the same missing-route behavior.
- Service delegation RED: 11 passing, 1 failing; `SyncJobService.readStageOutput` was absent.

## GREEN

Same command: 12 passing, 0 failing.

Additional checks:

```powershell
npx eslint server/services/sync-job-service.ts server/routes/local-data.ts app/lib/agent-service-client.ts tests/agent/stage-output-route.test.ts tests/agent/auth-authorization.test.ts
git diff --check
```

Both completed successfully.

`npx tsc --noEmit` still reports repository-wide, pre-existing type errors. A follow-up filter found no diagnostics in the new `tests/agent/stage-output-route.test.ts` or changed `app/lib/agent-service-client.ts`.

## Changed files

- `server/services/sync-job-service.ts`: exposes the exact-scope repository read.
- `server/routes/local-data.ts`: registers the one exact GET route, takes organization scope only from the authenticated user principal, parses shared params, and maps all absent results to the same 404.
- `app/lib/agent-service-client.ts`: permits the typed GET path.
- `tests/agent/stage-output-route.test.ts`: covers delegation, all five scope mismatches, legacy/non-terminal absence, normalized success, and lifecycle side-effect counters.
- `tests/agent/auth-authorization.test.ts`: asserts the endpoint remains under the default member/admin session classification.
- `server/db/postgres/sync-job-store.ts`: review remediation adds the single-query four-table canonical scope and current-terminal-stage predicates.
- `tests/agent/sync-stage-output-persistence.test.ts`: review remediation adds canonical ownership and stale-output reset integration coverage.

`server/auth/authorization.ts` required no production edit: its closed default classification already keeps this new exact path under the member/admin session rule.

## Review remediation

Review RED command:

```powershell
npx tsx --conditions=react-server --test tests/agent/sync-stage-output-persistence.test.ts
```

Result: 5 passing, 2 failing. The new canonical-ownership assertion and the pending-stage reset assertion both exposed previously readable stale outputs.

Remediation:

- `readStageOutput` now has one SQL query joining `sync_job_stage_outputs`, `sync_jobs`, `projects`, and `analysis_runs`.
- The query requires the output, job, project, run, and authenticated-request selectors to describe the same canonical organization/project/run/job scope. `analysis_runs` has no organization column, so its organization ownership is derived through its joined canonical project.
- The same SQL adds an `EXISTS` predicate over `sync_jobs.stages`; only the requested stage's current `done`, `partial`, or `failed` status can expose a persisted output.
- The repository integration test now creates canonical ownership rows, verifies project-organization, run-project, and missing-run mismatches all return null, and verifies retained output rows disappear after pending and queued resets.

Review GREEN commands:

```powershell
npx tsx --conditions=react-server --test tests/agent/sync-stage-output-persistence.test.ts tests/agent/stage-output-contract.test.ts tests/agent/agent-api-schema.test.ts
npx tsx --conditions=react-server --test tests/agent/stage-output-route.test.ts tests/agent/auth-authorization.test.ts
```

Results: 10 passing, 0 failing; then 12 passing, 0 failing.

Review validation (no ESLint warnings or errors):

```powershell
npx eslint server/db/postgres/sync-job-store.ts tests/agent/sync-stage-output-persistence.test.ts server/services/sync-job-service.ts server/routes/local-data.ts app/lib/agent-service-client.ts tests/agent/stage-output-route.test.ts tests/agent/auth-authorization.test.ts
git diff --check
```

The focused `tsc` filter continues to find the existing `projectStageOutput` options mismatch in `tests/agent/sync-stage-output-persistence.test.ts`; it predates the review remediation and is unrelated to the changed repository query. No diagnostics reference the reviewed `sync-job-store.ts`.

## Self-review

- The route neither calls `readJob` nor starts providers/builds/reloads/jobs/runs/stages/attempts; its only data operation is the scoped `readStageOutput` dependency.
- The caller-supplied path contains only project/run/job/stage; `organizationId` is always `principal.organizationId`.
- The response contract is parsed before success is returned, while null from the scoped repository gives the shared, indistinguishable `Stage output not found` 404.
- The four-table query now handles the previously identified canonical ownership concern without loading a job and authorizing it afterward.

## Commit/status

Original implementation committed as `2f3fdd3 feat: expose scoped stage output reads`. The remediation commit includes this report and leaves the worktree clean.
