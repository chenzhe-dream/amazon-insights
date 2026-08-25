# Task 3 report: scoped stage-output reads

Base/HEAD: `874d1926dd3bb27697a90bd5e0bf82253ed1d3bf`

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

`server/auth/authorization.ts` required no production edit: its closed default classification already keeps this new exact path under the member/admin session rule.

## Self-review and concern

- The route neither calls `readJob` nor starts providers/builds/reloads/jobs/runs/stages/attempts; its only data operation is the scoped `readStageOutput` dependency.
- The caller-supplied path contains only project/run/job/stage; `organizationId` is always `principal.organizationId`.
- The response contract is parsed before success is returned, while null from the scoped repository gives the shared, indistinguishable `Stage output not found` 404.
- Concern for the integrator: the Task 2 `PostgresSyncJobStore.readStageOutput` implementation present in this worktree joins `sync_job_stage_outputs` and `sync_jobs`, but not `projects` or `analysis_runs`. Task 3's permitted edit list excludes that Task 2 file, so it was intentionally left untouched. Confirm Task 2's reviewed query satisfies the intended persisted cross-check, or amend it separately if the four-table join requirement is literal.

## Commit/status

Committed as `feat: expose scoped stage output reads`; worktree is clean.
