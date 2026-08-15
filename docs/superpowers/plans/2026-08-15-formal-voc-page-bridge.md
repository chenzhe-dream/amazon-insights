# Formal VOC Page Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fake-only browser tracer with a durable VOC submission, stage, report, and URL-refresh path that uses the existing 8.1-8.3 SQLite Worker pipeline.

**Architecture:** Keep `POST /v1/local-voc` as a narrow composition endpoint because it already persists the trusted project, run, snapshot, stage, and job in the correct order. Register that endpoint for both fixture and configured OpenAI runtimes, return its durable identities, and move browser polling/restore behavior into a small testable client module. The existing Worker, Skill runner, report repository, and provider selection remain unchanged.

**Tech Stack:** TypeScript, Fastify, SQLite repository, React/vinext, Zod, Node `node:test`, existing local Agent HTTP security.

## Global Constraints

- Work only in `C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\feat-voc-positioning-skill-execution` on `feat/voc-positioning-skill-execution`.
- Preserve all current runtime-data WIP. Never reset, checkout, delete, overwrite, stage, or commit generated sync data or `data/projects/*.json`.
- Do not modify `package-lock.json`, migrations `0001`-`0005`, generated VOC inputs, or the stash.
- Do not push, merge, rebase, amend, or use stash.
- Add no dependency and do not run `npm audit fix`.
- Keep data-sync progress separate from VOC analysis-run progress.
- Use the existing 8.1 snapshot, 8.2 deterministic facts, 8.3 Worker/Skill/report path. Do not create a second runner or report store.
- Fixture and real providers use the same page and HTTP path; provider selection stays in Agent Service configuration.
- Do not implement Alexa automation, history browsing, retry, cancellation, login, PostgreSQL, Cloudflare, traffic Agent, or product-definition Agent.
- Keep OpenSpec 8.4 and 8.5 unchecked after this slice.
- Services are currently stopped. Any smoke process on Windows must be hidden and scoped to ports `31900`/`31901`, then stopped after evidence is captured.

---

## File responsibility map

- `shared/agent-contracts.ts`: public request/response identities for VOC submission.
- `server/routes/local-voc.ts`: trusted composition boundary that creates project, run, immutable snapshot, stage, and job.
- `server/app.ts`: route registration, local-browser CORS, and live runtime-capability injection.
- `app/lib/voc-run-browser.ts`: browser-safe submit/read/poll helpers and URL run identity helpers.
- `app/page.tsx`: minimal run-state presentation and refresh restoration.
- `tests/agent/formal-voc-submission.test.ts`: real SQLite route boundary tests.
- `tests/agent/voc-run-browser.test.ts`: deterministic browser client and URL restoration tests.
- `tests/agent/local-data-bridge.test.ts`: source-level guard that the page keeps sync and analysis boundaries separate.

---

### Task 1: Make VOC submission provider-neutral and durable

**Files:**
- Modify: `shared/agent-contracts.ts:704-710`
- Modify: `server/routes/local-voc.ts`
- Modify: `server/app.ts:70-215`
- Create: `tests/agent/formal-voc-submission.test.ts`

**Interfaces:**
- Consumes: `SqliteAgentRepository`, `AnalysisExecutionContext`, mutable `OpenAiRuntimeCapability`, `RepositoryVocSourceReader`.
- Produces: `LocalVocSubmissionResponse = { projectId: string; runId: string }` and `registerLocalVocRoute(..., runtimeCapability)` available in fixture and configured modes.

- [x] **Step 1: Write the failing route tests**

Create `tests/agent/formal-voc-submission.test.ts` with a real temporary SQLite repository. Use the repository fixture ASINs and assert that normal configured mode registers the endpoint, returns both identities, and persists exactly one snapshot and queued attempt.

```ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";

import { LocalVocSubmissionResponseSchema } from "../../shared/agent-contracts";
import { buildAgentApp } from "../../server/app";
import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";
import { SCOOTER_ASINS } from "./helpers/voc-positioning-fixture";

const origin = "http://127.0.0.1:31900";
const token = "formal-voc-browser-token";

function env(fake?: boolean) {
  return {
    AGENT_SERVICE_PROXY_TOKEN: token,
    AGENT_SERVICE_TRUSTED_ORIGINS: origin,
    AGENT_VOC_LOCAL_ORIGIN: origin,
    AGENT_VOC_LOCAL_FAKE: fake ? "1" : undefined,
    OPENAI_API_KEY: fake ? undefined : "configured-test-key",
  };
}

function headers() {
  return {
    origin,
    "x-agent-proxy-token": token,
    "content-type": "application/json",
  };
}

for (const mode of ["fixture", "configured"] as const) {
  test(`${mode} runtime uses the same durable VOC submission route`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "formal-voc-submit-"));
    const repository = openSqliteAgentRepository({ path: join(dir, "agent.sqlite"), busyTimeoutMs: 5_000 });
    const executionContext = { actorId: randomUUID(), organizationId: randomUUID() };
    const app = buildAgentApp({
      env: env(mode === "fixture"),
      repository,
      executionContext,
      storageAvailable: true,
      openaiCapability: { configured: true, available: true, reason: null },
    });
    t.after(async () => { await app.close(); repository.close(); rmSync(dir, { recursive: true, force: true }); });

    const response = await app.inject({
      method: "POST",
      url: "/v1/local-voc",
      headers: headers(),
      payload: { asins: SCOOTER_ASINS, marketplace: "US" },
    });
    assert.equal(response.statusCode, 200);
    const payload = LocalVocSubmissionResponseSchema.parse(response.json());
    assert.ok(await repository.findProjectById(payload.projectId));
    const run = await repository.findAnalysisRun(payload.runId);
    assert.equal(run?.projectId, payload.projectId);
    const snapshots = await repository.listDataSnapshotsByRun({
      actorOrganizationId: executionContext.organizationId,
      runId: payload.runId,
    });
    assert.equal(snapshots.length, 1);
    const restored = await app.inject({ method: "GET", url: `/v1/runs/${payload.runId}`, headers: headers() });
    assert.equal(restored.statusCode, 200);
    const stage = restored.json().stages.find((item: { stage: string }) => item.stage === "voc-positioning");
    assert.equal((await repository.listJobAttempts(stage.id)).length, 1);
  });
}

test("unavailable VOC runtime rejects submission before mutation", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "formal-voc-unavailable-"));
  const repository = openSqliteAgentRepository({ path: join(dir, "agent.sqlite"), busyTimeoutMs: 5_000 });
  const executionContext = { actorId: randomUUID(), organizationId: randomUUID() };
  const app = buildAgentApp({
    env: env(false), repository, executionContext, storageAvailable: true,
    openaiCapability: { configured: true, available: false, reason: "OpenAI runtime is not active" },
  });
  t.after(async () => { await app.close(); repository.close(); rmSync(dir, { recursive: true, force: true }); });
  const response = await app.inject({
    method: "POST", url: "/v1/local-voc", headers: headers(),
    payload: { asins: SCOOTER_ASINS, marketplace: "US" },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, "CONFIGURATION_ERROR");
  assert.equal(await repository.findUserById(executionContext.actorId), null);
});
```

- [x] **Step 2: Run the route test to verify RED**

Run:

```powershell
node --import tsx --conditions=react-server --test tests/agent/formal-voc-submission.test.ts
```

Expected: configured mode returns 404 because registration is fake-only; the response schema also rejects the missing `projectId`.

- [x] **Step 3: Extend the contract and route runtime dependency**

Change the response schema to:

```ts
export const LocalVocSubmissionResponseSchema = strictObject({
  projectId: EntityIdSchema,
  runId: EntityIdSchema,
});
```

In `server/routes/local-voc.ts`, add a small read-only runtime boundary and check it before reading sources or creating the actor:

```ts
export interface VocSubmissionRuntimeCapability {
  readonly available: boolean;
  readonly reason: string | null;
}

export function registerLocalVocRoute(
  app: FastifyInstance,
  repository: SqliteAgentRepository | null,
  context: AnalysisExecutionContext | null,
  runtime: VocSubmissionRuntimeCapability | null,
) {
  app.post("/v1/local-voc", async (request) => {
    if (!repository || !context) {
      throw new ContractRouteError(503, "CONFIGURATION_ERROR", "Analysis lifecycle is not configured");
    }
    if (!runtime?.available) {
      throw new ContractRouteError(
        503,
        "CONFIGURATION_ERROR",
        runtime?.reason ?? "VOC positioning runtime is not available",
      );
    }
    // Keep the existing validated project -> run -> snapshot -> stage -> job order.
  });
}
```

Replace the fixture-specific missing-data text and return both durable IDs:

```ts
if (!source.candidate) {
  throw new ContractRouteError(422, "VALIDATION_ERROR", "VOC data is unavailable for the requested ASINs");
}

return LocalVocSubmissionResponseSchema.parse({ projectId, runId });
```

- [x] **Step 4: Register the route in both provider modes and generalize local CORS**

In `server/app.ts`, compute the browser origin independently of provider mode and pass the same mutable runtime capability object used by `/v1/capabilities`:

```ts
const localBrowserOrigin =
  env.AGENT_VOC_LOCAL_ORIGIN ??
  (env.AGENT_VOC_LOCAL_FAKE === "1" ? "http://127.0.0.1:31900" : null);

// In onRequest:
if (localBrowserOrigin && request.headers.origin === localBrowserOrigin) {
  reply.header("access-control-allow-origin", localBrowserOrigin);
  reply.header("access-control-allow-headers", "content-type, x-agent-proxy-token, x-request-id");
  reply.header("access-control-allow-methods", "GET, POST, OPTIONS");
  if (request.method === "OPTIONS") return reply.status(204).send();
}

registerAnalysisRunRoutes(app, analysisRunService);
registerLocalVocRoute(
  app,
  options.repository ?? null,
  options.executionContext ?? null,
  options.openaiCapability ?? null,
);
if (env.AGENT_VOC_LOCAL_FAKE === "1") {
  registerLocalDataRoutes(app, options.localDataBridgeDeps);
}
```

- [x] **Step 5: Run GREEN and focused security/contract regressions**

Run:

```powershell
node --import tsx --conditions=react-server --test tests/agent/formal-voc-submission.test.ts tests/agent/service-security.test.ts tests/agent/contracts.test.ts
```

Expected: all focused tests pass; direct requests still require trusted origin and proxy token; no secret appears in payloads.

- [x] **Step 6: Commit Task 1**

```powershell
git add -- shared/agent-contracts.ts server/routes/local-voc.ts server/app.ts tests/agent/formal-voc-submission.test.ts
git diff --cached --check
git commit -m "feat(agent): formalize VOC browser submission"
```

---

### Task 2: Add a testable browser run client and URL identity

**Files:**
- Create: `app/lib/voc-run-browser.ts`
- Create: `tests/agent/voc-run-browser.test.ts`

**Interfaces:**
- Consumes: `localAgentFetch`, `localAgentErrorMessage`, shared run/report/submission types.
- Produces: `vocRunIdFromSearch`, `searchWithVocRunId`, `submitVocRun`, `observeVocRun`, and `waitForVocRun`.

- [x] **Step 1: Write the failing browser-client tests**

Create `tests/agent/voc-run-browser.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  observeVocRun,
  searchWithVocRunId,
  submitVocRun,
  vocRunIdFromSearch,
  VocRunClientError,
} from "../../app/lib/voc-run-browser";

const runId = "11111111-1111-4111-8111-111111111111";

test("VOC run identity round-trips through the URL without dropping workspace parameters", () => {
  const next = searchWithVocRunId("?project=p1&asins=A,B,C", runId);
  assert.equal(next.get("project"), "p1");
  assert.equal(next.get("asins"), "A,B,C");
  assert.equal(vocRunIdFromSearch(next), runId);
});

test("refresh observation reads run and report without submitting a second run", async () => {
  const calls: Array<{ method: string; url: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ method: init?.method ?? "GET", url });
    if (url.endsWith(`/v1/runs/${runId}`)) {
      return Response.json({
        run: { id: runId, status: "succeeded" },
        stages: [{ id: "stage-1", stage: "voc-positioning", status: "succeeded", progress: 100, lastError: null }],
      });
    }
    return Response.json({ reports: [{ id: "report-1", version: 1, status: "complete", result: { coreConclusion: { strategy: "durable" } } }] });
  };
  const observed = await observeVocRun(runId, fetchImpl);
  assert.equal(observed.report?.id, "report-1");
  assert.deepEqual(calls.map(call => call.method), ["GET", "GET"]);
});

test("network refusal becomes an actionable offline observation", async () => {
  const fetchImpl: typeof fetch = async () => { throw new TypeError("fetch failed"); };
  const observed = await observeVocRun(runId, fetchImpl);
  assert.equal(observed.kind, "offline");
  assert.match(observed.message, /npm run agent:dev/);
  assert.equal(observed.runId, runId);
});

test("missing VOC input is classified as waiting-input", async () => {
  const fetchImpl: typeof fetch = async () => Response.json(
    { error: { code: "VALIDATION_ERROR", message: "VOC data is unavailable for the requested ASINs", requestId: "request-1" } },
    { status: 422 },
  );
  await assert.rejects(
    () => submitVocRun(["B07VY9Q95Q", "B0BPXRVWYK", "B07DYG1C9B"], "US", fetchImpl),
    (error: unknown) => error instanceof VocRunClientError && error.kind === "waiting-input",
  );
});
```

- [x] **Step 2: Run the client test to verify RED**

Run:

```powershell
node --import tsx --conditions=react-server --test tests/agent/voc-run-browser.test.ts
```

Expected: module-not-found for `app/lib/voc-run-browser.ts`.

- [x] **Step 3: Implement the minimal client module**

Create `app/lib/voc-run-browser.ts` with these public types and functions. Use the injected `fetchImpl` in tests and `localAgentFetch` by default in the browser.

```ts
import { localAgentErrorMessage, localAgentFetch } from "./local-agent-browser";

const entityId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function vocRunIdFromSearch(search: string | URLSearchParams) {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const value = params.get("run");
  return value && entityId.test(value) ? value : null;
}

export function searchWithVocRunId(search: string | URLSearchParams, runId: string) {
  if (!entityId.test(runId)) throw new TypeError("Invalid VOC run identifier");
  const params = new URLSearchParams(typeof search === "string" ? search : search.toString());
  params.set("run", runId);
  return params;
}

export type VocRunObservation = {
  kind: "active" | "waiting-input" | "failed" | "succeeded" | "offline";
  runId: string | null;
  stage: Record<string, unknown> | null;
  report: Record<string, unknown> | null;
  message: string;
};

export class VocRunClientError extends Error {
  constructor(
    readonly kind: "waiting-input" | "failed",
    message: string,
  ) {
    super(message);
    this.name = "VocRunClientError";
  }
}

async function responseJson(response: Response, fallback: string) {
  const payload = await response.json();
  if (!response.ok) throw new Error(localAgentErrorMessage(payload, fallback));
  return payload;
}

export async function submitVocRun(
  asins: string[],
  marketplace = "US",
  fetchImpl: typeof localAgentFetch = localAgentFetch,
) {
  const response = await fetchImpl("/v1/local-voc", {
    method: "POST",
    body: JSON.stringify({ asins, marketplace }),
  });
  const payload = await response.json();
  if (!response.ok) {
    const message = localAgentErrorMessage(payload, "VOC analysis submission failed");
    throw new VocRunClientError(response.status === 422 ? "waiting-input" : "failed", message);
  }
  return payload as { projectId: string; runId: string };
}

export async function observeVocRun(runId: string, fetchImpl: typeof fetch = localAgentFetch as typeof fetch): Promise<VocRunObservation> {
  try {
    const [runResponse, reportsResponse] = await Promise.all([
      fetchImpl(`/v1/runs/${encodeURIComponent(runId)}`),
      fetchImpl(`/v1/runs/${encodeURIComponent(runId)}/reports`),
    ]);
    const run = await responseJson(runResponse, "Unable to read VOC run") as { stages?: Array<Record<string, unknown>> };
    const reports = await responseJson(reportsResponse, "Unable to read VOC reports") as { reports?: Array<Record<string, unknown>> };
    const stage = run.stages?.find(item => item.stage === "voc-positioning") ?? null;
    const report = reports.reports?.[0] ?? null;
    const status = typeof stage?.status === "string" ? stage.status : "queued";
    const kind: VocRunObservation["kind"] = report
      ? "succeeded"
      : status === "waiting-input"
        ? "waiting-input"
        : status === "failed"
          ? "failed"
          : "active";
    return { kind, runId, stage, report, message: kind === "succeeded" ? "VOC report is persisted" : `VOC stage: ${status}` };
  } catch (error) {
    if (error instanceof TypeError) {
      return { kind: "offline", runId, stage: null, report: null, message: "Agent Service is offline. Run: npm run agent:dev" };
    }
    throw error;
  }
}

export async function waitForVocRun(runId: string, options: { attempts?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {}) {
  const attempts = options.attempts ?? 60;
  const intervalMs = options.intervalMs ?? 250;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let observation = await observeVocRun(runId);
  for (let index = 1; index < attempts && observation.kind === "active"; index += 1) {
    await sleep(intervalMs);
    observation = await observeVocRun(runId);
  }
  return observation;
}
```

During implementation, keep the production fetch adapter correct: `localAgentFetch` accepts a path while the injected test function accepts the same path. Do not construct or expose the proxy token in this module.

- [x] **Step 4: Run GREEN**

```powershell
node --import tsx --conditions=react-server --test tests/agent/voc-run-browser.test.ts tests/agent/asin-sync-session.test.ts
```

Expected: all tests pass and the existing duplicate-sync gate remains green.

- [x] **Step 5: Commit Task 2**

```powershell
git add -- app/lib/voc-run-browser.ts tests/agent/voc-run-browser.test.ts
git diff --cached --check
git commit -m "feat(web): add durable VOC run client"
```

---

### Task 3: Wire the page, restore after refresh, and run one fixture smoke

**Files:**
- Modify: `app/page.tsx:1763,2185-2224,2975`
- Modify: `tests/agent/local-data-bridge.test.ts`
- Modify: `docs/superpowers/plans/2026-08-15-formal-voc-page-bridge.md` only to check completed steps and record concise smoke evidence.

**Interfaces:**
- Consumes: Task 1 `{ projectId, runId }` response and Task 2 `submitVocRun`, `observeVocRun`, `waitForVocRun`, `vocRunIdFromSearch`, `searchWithVocRunId`.
- Produces: a separate persisted VOC run panel restored from `?run=<uuid>`.

- [x] **Step 1: Extend the source-level page RED**

In `tests/agent/local-data-bridge.test.ts`, extend the page-boundary test:

```ts
assert.match(page, /submitVocRun/);
assert.match(page, /vocRunIdFromSearch/);
assert.match(page, /searchWithVocRunId/);
assert.match(page, /observeVocRun/);
assert.match(page, /npm run agent:dev/);
assert.doesNotMatch(page, /fetch\(`\$\{localVocAgentUrl\}\/v1\/local-voc/);
```

- [x] **Step 2: Run the page test to verify RED**

```powershell
node --import tsx --conditions=react-server --test tests/agent/local-data-bridge.test.ts
```

Expected: the new client imports and refresh restoration are absent.

- [x] **Step 3: Replace the one-line tracer with durable run state**

Import the Task 2 helpers and replace `localVocResult: string | null` with an observation state plus a ref that prevents duplicate restoration:

```ts
import {
  observeVocRun,
  searchWithVocRunId,
  submitVocRun,
  vocRunIdFromSearch,
  waitForVocRun,
  VocRunClientError,
  type VocRunObservation,
} from "./lib/voc-run-browser";

const [vocRun, setVocRun] = useState<VocRunObservation | null>(null);
const restoringVocRun = useRef<string | null>(null);
```

Add one mount/update effect. It only reads a run already present in the URL and never submits:

```ts
useEffect(() => {
  const runId = vocRunIdFromSearch(searchParams.toString());
  if (!runId || restoringVocRun.current === runId) return;
  restoringVocRun.current = runId;
  void observeVocRun(runId)
    .then(setVocRun)
    .catch(error => setVocRun({
      kind: "failed", runId, stage: null, report: null,
      message: error instanceof Error ? error.message : "Unable to restore VOC run",
    }));
}, [searchParams]);
```

Replace the inline submit/poll closure in `runAnalysis`:

```ts
void (async () => {
  try {
    const submission = await submitVocRun(values, "US");
    const params = searchWithVocRunId(window.location.search, submission.runId);
    replaceAppUrl(params, window.location.pathname);
    restoringVocRun.current = submission.runId;
    setVocRun({ kind: "active", runId: submission.runId, stage: null, report: null, message: "VOC run queued" });
    setVocRun(await waitForVocRun(submission.runId));
  } catch (error) {
    setVocRun({
      kind: error instanceof TypeError
        ? "offline"
        : error instanceof VocRunClientError ? error.kind : "failed",
      runId: vocRunIdFromSearch(window.location.search),
      stage: null,
      report: null,
      message: error instanceof TypeError
        ? "Agent Service is offline. Run: npm run agent:dev"
        : error instanceof Error ? error.message : "VOC analysis failed",
    });
  }
})();
```

- [x] **Step 4: Render the minimal formal result panel**

Replace the old `localVocResult` paragraph with a small card that shows separate run/stage/report identity. Reuse existing card classes; do not redesign the page.

```tsx
{vocRun ? (
  <section className="card launch-block" data-voc-run={vocRun.runId ?? undefined}>
    <strong>VOC Agent · {vocRun.kind}</strong>
    <p>{vocRun.message}</p>
    {vocRun.runId ? <small>Run {vocRun.runId}</small> : null}
    {vocRun.report ? (
      <p>
        Report v{String(vocRun.report.version ?? 1)} · {String(vocRun.report.status ?? "complete")} · {String(
          (vocRun.report.result as { coreConclusion?: { strategy?: string } } | undefined)?.coreConclusion?.strategy ?? "已持久化",
        )}
      </p>
    ) : null}
  </section>
) : null}
```

- [x] **Step 5: Run focused GREEN**

```powershell
node --import tsx --conditions=react-server --test tests/agent/formal-voc-submission.test.ts tests/agent/voc-run-browser.test.ts tests/agent/local-data-bridge.test.ts tests/agent/asin-sync-session.test.ts tests/agent/service-security.test.ts tests/agent/contracts.test.ts
```

Expected: all focused tests pass. Run targeted lint on the changed app/server files if the repository script supports file arguments; otherwise run `npm run lint` once and report only new errors.

- [x] **Step 6: Start hidden local services for one fixture smoke**

Use `.env.local` with fixture mode and the existing UUID execution context. Do not print secret values. Start only hidden processes and redirect logs:

```powershell
$repo = 'C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\feat-voc-positioning-skill-execution'
$logDir = Join-Path $env:TEMP 'amazon-voc-8-4-logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$agent = Start-Process node -ArgumentList '--env-file=.env.local','--import','tsx','server/index.ts' -WorkingDirectory $repo -RedirectStandardOutput (Join-Path $logDir 'agent.log') -RedirectStandardError (Join-Path $logDir 'agent.err.log') -WindowStyle Hidden -PassThru
$web = Start-Process npm.cmd -ArgumentList 'run','dev','--','--hostname','127.0.0.1','--port','31900' -WorkingDirectory $repo -RedirectStandardOutput (Join-Path $logDir 'web.log') -RedirectStandardError (Join-Path $logDir 'web.err.log') -WindowStyle Hidden -PassThru
```

Verify `GET http://127.0.0.1:31900` and `GET http://127.0.0.1:31901/health` return 200 before browser interaction.

- [x] **Step 7: Perform the single browser refresh smoke**

Open `http://127.0.0.1:31900/p/kick-scooters-us-2` and submit exactly:

```text
B07VY9Q95Q
B0BPXRVWYK
B07DYG1C9B
```

Required evidence:

1. `POST /v1/local-voc` succeeds and returns `projectId` plus `runId`.
2. Worker reaches `voc-positioning=succeeded`.
3. `GET /v1/runs/:runId/reports` returns one persisted report and version.
4. The URL contains the same `runId`.
5. Reloading the page performs only GET reads, shows the same report/version, and does not create a second provider call/report.
6. Data-sync UI, if triggered by the existing button, remains visually and semantically separate; Alexa is allowed to remain manual.

Stop only the captured `$agent` and `$web` process trees after evidence is recorded, and verify ports 31900/31901 are released. Do not leave visible terminals.

```powershell
taskkill /PID $agent.Id /T /F
taskkill /PID $web.Id /T /F
Get-NetTCPConnection -LocalPort 31900,31901 -State Listen -ErrorAction SilentlyContinue
```

Expected: both process trees are stopped and the final port query returns no listener.

Observed fixture smoke: `B07VY9Q95Q`, `B0BPXRVWYK`, and `B07DYG1C9B` produced run `22466295-9f59-49b5-b09c-99bf9284ff3b` and one persisted report `cd1fc25f-42bd-4f7b-9ef5-cadc30acc52b` version `1`. A fresh URL load rendered that report and only requested existing run/report resources from Agent HTTP.

- [x] **Step 8: Commit Task 3**

```powershell
git add -- app/page.tsx tests/agent/local-data-bridge.test.ts docs/superpowers/plans/2026-08-15-formal-voc-page-bridge.md
git diff --cached --check
git commit -m "feat(web): restore persisted VOC runs"
```

---

## Final slice verification

- [x] Run the Task 1-3 focused suite once; do not repeat full hostile-review gates.
- [x] Run `npx openspec validate build-standalone-agent-workflow --strict`.
- [x] Confirm OpenSpec 8.4 and 8.5 remain unchecked.
- [x] Confirm the three task commits are non-amended and no push/merge/rebase/stash occurred.
- [x] Confirm `package-lock.json`, migrations `0001`-`0005`, and generated VOC source files have zero diff from pre-slice HEAD.
- [x] Confirm all pre-existing runtime data WIP remains present and uncommitted.
- [x] Confirm ports 31900/31901 are released and no project Node process remains.
- [ ] Report exact commands, fixture ASINs, run ID, report ID/version, refresh evidence, and any remaining 8.4 follow-up.
