# Local Agent HTTP Data-Sync Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the local browser tracer save analysis projects and run/poll ASIN sync through the ordinary Node Agent Service, so Vinext never performs the filesystem or process-spawn work that produces `operation not permitted`.

**Architecture:** In `AGENT_VOC_LOCAL_FAKE=1`, Fastify exposes a small `/v1/local-data/*` route group. It adapts existing `app/lib/project-server.ts` and `app/lib/sync-server.ts`, retaining those modules as the sole owners of project JSON, sync-job files, logs, and detached Node runner creation. The page changes only the current analysis workspace/save/sync/poll transport to call that Agent base URL and reuse the local CORS/token settings introduced by `7ec1cfd`; the VOC transport remains unchanged.

**Tech Stack:** TypeScript, Fastify, Node `node:test`, existing project-store and sync-server modules, Vinext browser page, browser HTTP smoke.

## Global Constraints

- Deliver one local tracer-bullet only: input ASINs, project save/update, sync start/status poll, data refresh.
- Register the bridge only when `AGENT_VOC_LOCAL_FAKE=1`; reuse `NEXT_PUBLIC_AGENT_VOC_LOCAL_URL`, `NEXT_PUBLIC_AGENT_VOC_LOCAL_TOKEN`, existing trusted-origin CORS, and `x-agent-proxy-token`.
- Reuse `app/lib/project-server.ts` and `app/lib/sync-server.ts`; do not duplicate file, slug, log, or spawn logic.
- Leave local VOC submission, fake provider, report polling, and all non-analysis project features unchanged.
- If a sync runner reaches a provider lacking configuration, show its existing job error in the page; never fabricate a completed sync.
- Add no dependency and do not change `package-lock.json`, migrations `0001` through `0005`, generated VOC data, login, PostgreSQL, Cloudflare, production security, concurrency architecture, or general UI structure.
- Do not push, merge, rebase, amend, or use stash. Keep the currently running local Agent and Vinext services running during implementation.
- Run only focused route tests and one browser closure; do not run full gates.

---

## File structure and interfaces

| File | Change | Responsibility |
| --- | --- | --- |
| `server/routes/local-data.ts` | Create | Local-fake-only Fastify adapters for legacy analysis projects and ASIN sync. |
| `server/app.ts` | Modify | Accept local-data route dependencies and register the route group only when local fake mode is enabled. |
| `shared/agent-contracts.ts` | Modify | Define strict local-data request/response schemas and add only the local-data HTTP contracts. |
| `tests/agent/local-data-bridge.test.ts` | Create | Fastify-injection contract tests with controlled project/sync dependencies. |
| `app/page.tsx` | Modify | Route the current analysis workspace/save/sync/poll fetches to Agent HTTP in local mode; retain all other page transports. |
| `app/asin-sync-funnel.tsx` | Modify | Route the actual sync start, status refresh, and job polling component to Agent HTTP. |
| `app/lib/local-agent-browser.ts` | Create | Shared browser-only Agent URL/token fetch and structured error reader. |
| `tests/agent/local-data-bridge.test.ts` | Modify | Add the browser-transport-facing request-shape assertions required by the page change. |

The route module defines the following implementation seam, which prevents tests
from writing project files or spawning a real runner:

```ts
export type LocalDataBridgeDeps = {
  fetchProjects(options?: { kind?: ProjectKind }): Promise<AnalysisProject[]>;
  fetchProject(id: string): Promise<AnalysisProject | null>;
  createAnalysisProject(input: Record<string, unknown>): Promise<AnalysisProject>;
  updateAnalysisProject(id: string, patch: Record<string, unknown>): Promise<AnalysisProject | null>;
  deleteAnalysisProject(id: string): Promise<boolean>;
  normalizeAsins(values: unknown): Promise<string[] | null>;
  fetchAsinDataStatus(asins: string[]): Promise<AsinModuleStatus[]>;
  startAsinSyncJob(asins: string[], marketplace: string): Promise<StartAsinSyncResult>;
  readJob(jobId: string): Promise<SyncJob | null>;
};

export type StartAsinSyncResult = Awaited<ReturnType<typeof startAsinSyncJob>>;

export function registerLocalDataRoutes(
  app: FastifyInstance,
  deps?: LocalDataBridgeDeps,
): void;
```

`createDefaultLocalDataBridgeDeps()` imports the existing `project-server` and
`sync-server` exports and is used by Agent Service. Tests pass a complete
in-memory dependency object. `buildAgentApp` accepts an optional
`localDataBridgeDeps` field and forwards it only in local fake mode.

The page adds one narrow helper, not a global rewrite:

```ts
const localAgentUrl = process.env.NEXT_PUBLIC_AGENT_VOC_LOCAL_URL ?? "http://127.0.0.1:31901";
const localAgentToken = process.env.NEXT_PUBLIC_AGENT_VOC_LOCAL_TOKEN ?? "local-ui-token";

function localDataFetch(path: string, init?: RequestInit): Promise<Response>;
```

It is used only by analysis-project load/save/update and `startSyncIfNeeded` /
sync polling. VOC retains its existing `localVocAgentUrl` calls.

### Task 1: Local Agent project and sync bridge

**Files:**
- Create: `server/routes/local-data.ts`
- Create: `tests/agent/local-data-bridge.test.ts`
- Modify: `server/app.ts`
- Modify: `shared/agent-contracts.ts`

**Interfaces:**
- Consumes: `ProjectKind` and project functions from `app/lib/project-server.ts`; ASIN status/job types and functions from `app/lib/sync-server.ts`; local fake origin/token enforcement in `server/app.ts`.
- Produces: `registerLocalDataRoutes(app, deps?)`, `LocalDataBridgeDeps`, and the eight `/v1/local-data/*` contracts for Task 2.

- [ ] **Step 1: Record the Vinext runtime RED boundary before touching routes**

Run from a PowerShell terminal against the current page service:

```powershell
try {
  Invoke-WebRequest -Uri 'http://127.0.0.1:31900/api/projects?kind=analysis' -UseBasicParsing -ErrorAction Stop
} catch {
  $response = $_.Exception.Response
  "status=$([int]$response.StatusCode)"
  $reader = [IO.StreamReader]::new($response.GetResponseStream())
  $reader.ReadToEnd()
}
```

Expected: `status=500` and the response contains `operation not permitted`.
Save the command output in the implementation turn, not in a source file. This
is the proof that the Vinext route is outside the supported runtime boundary.

- [ ] **Step 2: Write failing Fastify route tests**

Create `tests/agent/local-data-bridge.test.ts`. Build `securityEnv` with
`AGENT_VOC_LOCAL_FAKE: "1"`, the loopback origin, and `local-ui-token`; build
`fakeDeps` with one analysis project, one all-ready ASIN status, a 202-like
queued job result, and a readable job. Assert these requests:

```ts
const app = buildAgentApp({ env: securityEnv, localDataBridgeDeps: fakeDeps });
const headers = { origin: "http://127.0.0.1:31900", "x-agent-proxy-token": "local-ui-token" };

assert.equal((await app.inject({ method: "GET", url: "/v1/local-data/projects?kind=analysis", headers })).statusCode, 200);
assert.equal((await app.inject({ method: "POST", url: "/v1/local-data/projects", headers, payload: createPayload })).statusCode, 201);
assert.equal((await app.inject({ method: "PATCH", url: "/v1/local-data/projects/project-1", headers, payload: patchPayload })).statusCode, 200);
assert.equal((await app.inject({ method: "GET", url: "/v1/local-data/sync-asins?asins=B07VY9Q95Q", headers })).statusCode, 200);
assert.equal((await app.inject({ method: "POST", url: "/v1/local-data/sync-asins", headers, payload: { asins: ["B07VY9Q95Q"], marketplace: "US" } })).statusCode, 202);
assert.equal((await app.inject({ method: "GET", url: "/v1/local-data/sync-asins/job-1", headers })).statusCode, 200);
```

Also assert invalid ASIN input returns 400, absent project/job returns 404, and
an app constructed without `AGENT_VOC_LOCAL_FAKE` returns 404 for the bridge.

- [ ] **Step 3: Run the new test to verify RED**

Run:

```powershell
npx tsx --conditions=react-server --test tests/agent/local-data-bridge.test.ts
```

Expected: FAIL because `localDataBridgeDeps`, route registration, and
`/v1/local-data/*` contracts do not exist.

- [ ] **Step 4: Add strict contracts and the thin route adapters**

In `shared/agent-contracts.ts`, add strict schemas for project create/update
payloads, a one-to-ten unique ASIN sync request, a sync readiness response,
sync start response, and job response. Add these exact paths to `v1Contracts`:

```ts
"/v1/local-data/projects"
"/v1/local-data/projects/:id"
"/v1/local-data/sync-asins"
"/v1/local-data/sync-asins/:jobId"
```

Create `server/routes/local-data.ts` with the dependency interface above. Its
handlers parse request data, call one existing dependency, and serialize the
same top-level fields as the corresponding existing `app/api` route. For sync
readiness, calculate `needsSync`, `catalogPending`, and `vocPending` from the
returned status rows exactly as `app/api/sync-asins/route.ts` does. For
`POST /sync-asins`, return `jobId`, `status`, `message`, pending ASINs,
estimates, and `stages` with status 202. Map validation failures to 400 and
missing resources to 404; preserve unexpected helper failure as the normal
structured Agent 500.

- [ ] **Step 5: Gate the route group in Agent composition**

Extend `BuildAgentAppOptions` in `server/app.ts`:

```ts
localDataBridgeDeps?: LocalDataBridgeDeps;
```

Register the route group beside `registerLocalVocRoute` only under the same
condition:

```ts
if (env.AGENT_VOC_LOCAL_FAKE === "1") {
  registerLocalVocRoute(app, options.repository ?? null, options.executionContext ?? null);
  registerLocalDataRoutes(app, options.localDataBridgeDeps);
}
```

The existing `onRequest` hook remains the sole CORS, trusted-origin, and token
check. Do not add a bypass.

- [ ] **Step 6: Run focused GREEN tests**

Run:

```powershell
npx tsx --conditions=react-server --test tests/agent/local-data-bridge.test.ts tests/agent/service-security.test.ts
```

Expected: all local-data route cases pass; existing token/origin protection
still passes; no test starts a detached sync runner.

- [ ] **Step 7: Commit the independently testable Agent bridge**

Run:

```powershell
git add server/routes/local-data.ts server/app.ts shared/agent-contracts.ts tests/agent/local-data-bridge.test.ts
git commit -m "feat(agent): bridge local project and sync data"
```

Expected: one non-amend commit containing only route, contract, composition,
and focused test changes.

### Task 2: Direct the current analysis workspace and sync flow to Agent HTTP

**Files:**
- Modify: `app/page.tsx`
- Modify: `app/asin-sync-funnel.tsx`
- Create: `app/lib/local-agent-browser.ts`
- Modify: `tests/agent/local-data-bridge.test.ts`

**Interfaces:**
- Consumes: Task 1's local-data endpoints and the existing browser-local Agent
  URL/token defaults from `7ec1cfd`.
- Produces: a browser tracer that never asks Vinext to persist an analysis
  project or start/poll an ASIN sync job.

- [ ] **Step 1: Write the browser transport RED assertions**

Extend `tests/agent/local-data-bridge.test.ts` with source-level transport
assertions that hold the narrow page boundary in place:

```ts
const page = readFileSync("app/page.tsx", "utf8");
assert.match(page, /\/v1\/local-data\/projects/);
assert.match(page, /\/v1\/local-data\/sync-asins/);
assert.doesNotMatch(page.slice(page.indexOf("const ensureAnalysisWorkspace"), page.indexOf("const saveKeywordCompareProject")), /fetch\("\/api\/projects/);
const syncBlock = page.slice(page.indexOf("const startSyncIfNeeded"), page.indexOf("const runAnalysis"));
assert.doesNotMatch(syncBlock, /\/api\/sync-asins/);
assert.match(page, /\/v1\/local-voc/);
```

Add a matching bounded assertion around `startSyncIfNeeded` proving its
analysis sync requests use `/v1/local-data/sync-asins`, while assertions for
`/v1/local-voc` and report polling remain present.

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```powershell
npx tsx --conditions=react-server --test tests/agent/local-data-bridge.test.ts
```

Expected: FAIL because the page still issues analysis project and sync requests
to `/api/projects` and `/api/sync-asins`.

- [ ] **Step 3: Add the shared local browser transport helper**

Create `app/lib/local-agent-browser.ts` and export `localAgentFetch(path, init?)`
plus a structured-error reader. It must call
`${localDataAgentUrl}${path}`, merge the existing token header, and preserve
the caller's method/body. Import it into `app/page.tsx` and
`app/asin-sync-funnel.tsx`. Keep `localVocAgentUrl` and its current submission
logic unchanged.

```ts
export function localAgentFetch(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-agent-proxy-token", localAgentToken);
  if (init.body) headers.set("Content-Type", "application/json");
  return fetch(`${localAgentUrl}${path}`, {
    ...init,
    headers,
  });
}
```

- [ ] **Step 4: Replace only the analysis workspace and sync calls**

Within the existing `ensureAnalysisWorkspace` function, replace its current
analysis-project list/create/read/update fetches with `localDataFetch` calls to
the Task 1 project paths, keeping the current `AnalysisProject` parsing,
same-ASIN selection, `applyProject`, and failure fallback unchanged. In
`startSyncIfNeeded`, replace only the current readiness URL. In the existing
`AsinSyncProgressSection` and `AsinSyncFunnel` component, replace the current
status, start, and job-poll URLs with the Task 1 paths. Do not modify other
project-save functions, catalog fetches, or UI layout.

For non-2xx responses, parse the Agent structured error and propagate its
message to the existing page state. In particular, a sync job that reports a
missing external-provider configuration remains failed/pending in the UI; it
is not changed to complete.

- [ ] **Step 5: Run page-boundary and Agent tests to verify GREEN**

Run:

```powershell
npx tsx --conditions=react-server --test tests/agent/local-data-bridge.test.ts
npx eslint app/page.tsx server/app.ts server/routes/local-data.ts shared/agent-contracts.ts
```

Expected: focused tests pass and lint has zero errors. Existing page warnings
may remain warnings.

- [ ] **Step 6: Perform one browser tracer closure**

Use the already-running local Agent at `http://127.0.0.1:31901` and page at
`http://127.0.0.1:31900`. Enter these fixture ASINs and click the existing
analysis action:

```text
B07VY9Q95Q
B0BPXRVWYK
B07DYG1C9B
```

Expected network sequence: Agent project list/create or update returns 200 or
201, Agent sync readiness returns 200, Agent sync start returns 202, and Agent
job polling returns 200. The page no longer calls Vinext
`/api/projects` or `/api/sync-asins` for this closure and does not show
`operation not permitted`. If the runner reports a provider configuration
error, capture and display that exact non-secret message as the smoke result.

- [ ] **Step 7: Commit the page transport tracer**

Run:

```powershell
git add app/page.tsx tests/agent/local-data-bridge.test.ts
git commit -m "feat(web): use agent bridge for local data sync"
```

Expected: one non-amend commit containing only the narrow browser transport
change and its focused regression assertion.

## Final focused verification

- [ ] **Step 1: Check protected paths and whitespace**

Run:

```powershell
git diff HEAD~2..HEAD --check
git diff --name-only HEAD~2..HEAD -- package-lock.json migrations/0001* migrations/0002* migrations/0003* migrations/0004* migrations/0005* generated
git status --short
```

Expected: no whitespace errors, no protected-path output, and a clean worktree.

- [ ] **Step 2: Record handoff evidence**

Record the two commit hashes, focused test command summaries, browser HTTP
statuses, any non-secret external-provider configuration error, and the page
URL. Do not run full test, build, migration, or production deployment gates.

## Plan self-review

Spec coverage: Task 1 implements the local-only Node bridge, legacy payloads,
validation, direct Node route proof, and existing CORS/token boundary. Task 2
implements only the current analysis workspace and sync transport replacement,
preserves VOC, and verifies the original runtime error is absent. The final
steps enforce the requested focused-only and protected-path boundaries.

Placeholder review: every code-changing step identifies files, symbols, route
paths, commands, expected outcomes, and commit content. No unresolved marker
or deferred decision remains.

Type consistency review: `LocalDataBridgeDeps`, `registerLocalDataRoutes`,
`localDataBridgeDeps`, `localDataFetch`, and all four route families are named
consistently across file structure, Task 1, and Task 2.

## Execution handoff

Recommended execution: **Inline Execution** in the current single development
task. It preserves the live local service context and keeps the two task gates
serial, while using `superpowers:executing-plans` for task-by-task execution.
