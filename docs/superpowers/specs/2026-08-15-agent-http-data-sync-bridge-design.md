# Local Agent HTTP Data-Sync Bridge Design

## Goal

Remove the Vinext worker from the existing local analysis-data path that fails
with `operation not permitted`. In explicit local fake mode, the browser calls
the ordinary Node Agent Service for legacy projects and ASIN sync operations.
The existing project store and sync runner remain the owners of JSON files,
directories, logs, and detached sync processes.

The supported tracer path is exactly: input ASINs, save or update the analysis
project, start a sync job, poll its status, and refresh the resulting data.
VOC submission, its local fake provider, and its report polling are unchanged.

## Confirmed constraint and cause

`app/api/projects` dynamically imports `project-store`; even a project list can
create directories or backfill a slug. `app/api/sync-asins` opens a sync log and
starts a detached Node runner. Both behaviours succeed from ordinary Node and
are not permitted in the Vinext worker runtime. The failure is therefore a
runtime boundary, not an ASIN, Windows ACL, or VOC problem.

## Approaches considered

1. **Agent HTTP bridge to the existing Node modules (selected).** Add a small
   local-only route group to the ordinary Node service, import the existing
   `project-server` and `sync-server` helpers there, and have the browser call
   it directly. This changes the execution location without duplicating store
   or runner logic.
2. **Keep Vinext routes and make reads side-effect free.** This would still
   leave project create/update/delete and sync process launch in a runtime that
   cannot perform them. It cannot close the approved workflow.
3. **Move projects and jobs into the Agent SQLite repository.** This is a new
   storage model and migration project, and would require rewriting the current
   sync lifecycle. It is outside the tracer-bullet scope.

## Selected architecture

### Local bridge routes

When `AGENT_VOC_LOCAL_FAKE=1`, Agent Service registers these routes in addition
to the existing local VOC route:

| Operation | Agent route | Reused implementation | Response shape |
| --- | --- | --- | --- |
| List projects | `GET /v1/local-data/projects?kind=` | `fetchProjects` | `{ projects }` |
| Create project | `POST /v1/local-data/projects` | `createAnalysisProject` | `{ project }`, 201 |
| Read project | `GET /v1/local-data/projects/:id` | `fetchProject` | `{ project }` or 404 |
| Update project | `PATCH /v1/local-data/projects/:id` | `updateAnalysisProject` | `{ project }` or 404 |
| Delete project | `DELETE /v1/local-data/projects/:id` | `deleteAnalysisProject` | `{ ok: true }` or 404 |
| Read sync readiness | `GET /v1/local-data/sync-asins?asins=` | `normalizeAsins`, `fetchAsinDataStatus` | current `/api/sync-asins` payload |
| Start sync | `POST /v1/local-data/sync-asins` | `normalizeAsins`, `startAsinSyncJob` | current 202 job payload |
| Poll sync job | `GET /v1/local-data/sync-asins/:jobId` | `readJob` | current job payload or 404 |

The path is deliberately separate from `/v1/projects`, whose SQLite analysis
resources have different identifiers and contracts. HTTP error statuses and
payload fields match the current app routes for these operations, so the browser
can replace only its local transport base rather than change its project or
polling semantics.

### Browser transport

In local mode, the page uses the already-proven public local Agent base URL and
token configuration (`NEXT_PUBLIC_AGENT_VOC_LOCAL_URL` and
`NEXT_PUBLIC_AGENT_VOC_LOCAL_TOKEN`, with the current local defaults). Calls
for the approved project and sync closure target `/v1/local-data/*`; they do
not call `app/api/projects` or `app/api/sync-asins`.

The page keeps the existing sequence: persist the project, request sync,
poll the job, then reload catalog/status data. A failed Agent response is shown
as the returned sync or project error rather than being converted into the
Vinext `operation not permitted` failure.

### Local access boundary

The bridge is registered only with `AGENT_VOC_LOCAL_FAKE=1`. Browser requests
reuse the existing Agent Service CORS handling, trusted origin, and
`x-agent-proxy-token` check established for the local VOC tracer. No browser
request contains a provider key. The bridge does not add a production auth,
Cloudflare, PostgreSQL, or deployment design.

The sync runner receives the existing Agent process environment. If a real
external provider is required by a chosen sync stage, the runtime's existing
job status/error exposes that requirement; this design neither supplies nor
prints a key.

## Error handling

- Invalid ASIN lists return 400 before any project or job mutation.
- Missing project and job IDs return 404.
- Project-store and sync-runner errors retain the current stable response
  wording/status policy, except they originate from ordinary Node rather than
  Vinext.
- A successful sync start returns 202 immediately; completion is observed only
  through its existing job status endpoint.
- Non-local Agent configuration exposes no local-data route, preventing an
  accidental production transport switch.

## Verification plan

1. **RED:** Agent route tests use Fastify injection in local fake mode and
   prove the project CRUD, sync readiness, sync start, and job poll endpoints
   exist with their legacy shapes. The same route set is absent outside local
   fake mode.
2. **GREEN:** Implement routes as thin adapters over `project-server` and
   `sync-server`; do not replicate their filesystem, slug, log, or spawn code.
3. **Browser/HTTP regression:** run the local Agent and page, enter
   `B07VY9Q95Q`, `B0BPXRVWYK`, and `B07DYG1C9B`, then confirm project persistence,
   a 202 sync start, job polling, and data refresh without any Vinext
   `operation not permitted` response.
4. Run only the focused route/browser checks needed for this bridge.

## Exclusions

This design does not change the VOC flow, provider configuration, sync scripts,
data model, migrations, package dependencies, login, PostgreSQL, Cloudflare,
production security, or general UI structure. It does not modify migrations
`0001` through `0005`, `package-lock.json`, or generated VOC data.

## Self-review

The chosen route ownership, browser transport, local activation condition,
failure behaviour, and verification path are explicit. The document contains
no unresolved decisions, no conflicting runtime owner, and no scope beyond the
approved local project-and-sync closure.
