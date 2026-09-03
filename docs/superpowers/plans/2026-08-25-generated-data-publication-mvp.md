# Generated Data Publication MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make generated MCP data reliably appear after one confirmed Web publication, without SSE, a new MCP call, a replacement sync job, or a fixed-delay premature reload.

**Architecture:** The runner binds each successful build to a 64-hex `artifactId`, writes a versioned reload request, and records a small publication reference in the existing job mirror. The supervisor accepts only the matching artifact, validates the candidate and final Web health responses, and atomically archives the request as applied or failed. The Agent projects that acknowledgement into the existing sync-job GET response; the browser keeps polling a terminal job while publication is pending and reloads exactly once only after the applied artifact differs from the page artifact.

**Tech Stack:** Node.js ESM scripts, TypeScript, React, Next/vinext route handlers, Fastify Agent API, Zod contracts, Node test runner, `tsx`, Playwright browser harness.

## Global Constraints

- This is the minimum MVP only: do not implement SSE, runtime PostgreSQL result snapshots, or the “重新发布数据” action.
- Do not change MCP connector calls, ASIN selection, provider readiness, parsing, generated-data formats, image AI, or Alexa VOC behavior.
- Do not create a new sync job/run/stage and do not add any background POST from the browser.
- `applied` and `failed` acknowledgement files are authoritative; the supervisor must not rewrite the full sync-job mirror.
- A Web process is publication-ready only when `/api/health` returns the exact requested `artifactId`.
- Preserve all existing modified generated `app/*.ts`, `.superpowers/sdd/task-3-report.md`, and `data/projects/*.json` WIP; stage only each task's listed files.
- Use TDD for every task and keep commits task-scoped.
- Run the production build exactly once, only in the final combined gate after all focused suites and review pass.

---

## File Structure

- `scripts/lib/web-artifact-store.mjs`: create, validate, persist, and read the current build identity.
- `scripts/lib/web-reload-request.mjs`: version-2 request schema, atomic spool transitions, and safe publication status resolution.
- `scripts/run-asin-sync-job.mjs`: bind one successful build to one publication reference in the existing job mirror.
- `scripts/start-agent-stack.mjs`: start the requested artifact, verify preflight/final identity, and preserve the known-good identity for rollback.
- `app/api/health/route.ts`: return the bounded nonsecret current artifact identity.
- `app/layout.tsx`: expose the current artifact identity to the browser root element.
- `server/services/sync-publication-status-service.ts`: read the exact job mirror reference and resolve its authoritative spool state.
- `server/routes/local-data.ts`: append the safe publication projection to the existing authenticated job response.
- `shared/agent-contracts.ts`: strict public publication union.
- `app/lib/sync-progress-presentation.ts`: browser-visible publication type.
- `app/asin-sync-funnel.tsx`: keep GET polling after business terminal while publication is pending and render truthful Chinese publication copy.
- `app/page.tsx`: replace the fixed 2.5-second reload with `(jobId, artifactId)` one-shot reload ownership.
- Existing focused tests under `tests/scripts` and `tests/agent`: prove the complete handshake and no duplicate POST/reload behavior.

---

### Task 1: Versioned artifact and publication primitives

**Files:**
- Modify: `scripts/lib/web-artifact-store.mjs`
- Modify: `scripts/lib/web-reload-request.mjs`
- Modify: `tests/scripts/web-reload-request.test.mjs`
- Create: `tests/scripts/web-artifact-store.test.mjs`

**Interfaces:**
- Produces: `createWebPublicationArtifactId(): string`
- Produces: `writeCurrentWebArtifact({ worktree, artifactId }): Promise<void>`
- Produces: `createWebArtifactStore(...).current(): { id: string; root: string }`
- Produces: `writeWebReloadRequest({ jobId, artifactId, buildCompletedAt, target }, options)`
- Produces: `readWebReloadPublication({ jobId, requestId, artifactId, requestedAt }, options): Promise<SyncPublication>`
- Consumes: existing `createWebReloadTarget` and spool directory layout.

- [ ] **Step 1: Write failing artifact-manifest tests**

Add tests that require a generated 64-hex identity, an atomic `dist/web-artifact.json`, exact identity recovery, and rejection of malformed or out-of-worktree manifests:

```js
test("a build artifact identity is bounded and recovered from the dist manifest", async () => {
  await withArtifactRoot(async ({ worktree, artifactRoot }) => {
    const artifactId = createWebPublicationArtifactId();
    assert.match(artifactId, /^[a-f0-9]{64}$/);
    await writeCurrentWebArtifact({ worktree, artifactId });
    assert.deepEqual(createWebArtifactStore({ worktree, artifactRoot }).current(), {
      id: artifactId,
      root: artifactRoot,
    });
  });
});

test("a malformed artifact manifest fails closed", async () => {
  await withArtifactRoot(async ({ worktree, artifactRoot }) => {
    await writeFile(path.join(artifactRoot, "web-artifact.json"), JSON.stringify({ artifactId: "wrong" }));
    assert.throws(() => createWebArtifactStore({ worktree, artifactRoot }).current(), /Invalid Web artifact manifest/);
  });
});
```

- [ ] **Step 2: Run the artifact test and confirm RED**

Run: `node --test tests/scripts/web-artifact-store.test.mjs`

Expected: FAIL because the two exported identity helpers do not exist and `current()` still returns `id: "current"`.

- [ ] **Step 3: Implement the minimal artifact identity boundary**

Use a strict manifest and atomic temp-file rename. The implementation must have this public shape:

```js
export function createWebPublicationArtifactId() {
  return createHash("sha256").update(randomUUID()).digest("hex");
}

export async function writeCurrentWebArtifact({ worktree, artifactId }) {
  assertArtifactId(artifactId);
  const artifactRoot = path.join(path.resolve(worktree), "dist");
  const destination = path.join(artifactRoot, "web-artifact.json");
  const temporary = `${destination}.tmp-${randomUUID()}`;
  await fs.mkdir(artifactRoot, { recursive: true });
  await fs.writeFile(temporary, JSON.stringify({ version: 1, artifactId }), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await fs.rename(temporary, destination);
}
```

`createWebArtifactStore.current()` must return `{ id: "legacy", root }` when no manifest exists, synchronously parse exactly `{ version: 1, artifactId }` when it does exist, reject malformed or unknown keys, and return that artifact ID with the existing `dist` root. Keep snapshot path IDs unchanged, but copy a `publicationArtifactId` field when the supervisor supplies one in Task 2.

- [ ] **Step 4: Write failing reload-publication tests**

Change the request fixture to include `artifactId`. Add exact assertions for pending, applied, failed, duplicate, and malformed states:

```js
const request = Object.freeze({
  jobId: "job-safe-123",
  artifactId: "a".repeat(64),
  buildCompletedAt: "2026-08-22T00:00:00.000Z",
  target,
});

test("publication status follows the authoritative spool transition", async () => {
  await withSpool(async (spoolDir) => {
    const written = await writeWebReloadRequest(request, { spoolDir });
    assert.deepEqual(await readWebReloadPublication({
      jobId: request.jobId,
      requestId: written.id,
      artifactId: request.artifactId,
      requestedAt: request.buildCompletedAt,
    }, { spoolDir }), {
      status: "pending",
      requestId: written.id,
      artifactId: request.artifactId,
      requestedAt: request.buildCompletedAt,
    });

    await consumeWebReloadRequest({ spoolDir, expectedTarget: target, apply: async () => undefined });
    const applied = await readWebReloadPublication({
      jobId: request.jobId,
      requestId: written.id,
      artifactId: request.artifactId,
      requestedAt: request.buildCompletedAt,
    }, { spoolDir });
    assert.equal(applied.status, "applied");
    assert.equal(applied.artifactId, request.artifactId);
    assert.match(applied.appliedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});
```

- [ ] **Step 5: Run the reload test and confirm RED**

Run: `node --test tests/scripts/web-reload-request.test.mjs`

Expected: FAIL because version 1 rejects `artifactId` and no publication reader exists.

- [ ] **Step 6: Implement version-2 reload requests and publication resolution**

Set new writes to `WEB_RELOAD_REQUEST_VERSION = 2`. Validate an exact 64-hex `artifactId` and include it in the request hash. Export the closed union reader:

```js
export async function readWebReloadPublication(reference, { spoolDir = defaultSpoolDir } = {}) {
  const safe = validatePublicationReference(reference);
  const paths = await ensureSpool(spoolDir);
  for (const [directory, status] of [
    [paths.applied, "applied"],
    [paths.failed, "failed"],
    [paths.processing, "pending"],
    [paths.pending, "pending"],
  ]) {
    const match = await findExactRequest(directory, safe.requestId);
    if (!match) continue;
    const payload = validatePayload(JSON.parse(await fs.readFile(match, "utf8")));
    if (payload.artifactId !== safe.artifactId || payload.jobId !== safe.jobId) {
      return failedPublication(safe, "WEB_PUBLICATION_FAILED", await fileTime(match));
    }
    return status === "applied"
      ? appliedPublication(safe, await fileTime(match))
      : status === "failed"
        ? failedPublication(safe, "WEB_PUBLICATION_FAILED", await fileTime(match))
        : pendingPublication(safe);
  }
  return pendingPublication(safe);
}
```

Do not expose paths, target hosts, raw exceptions, or request bodies. Continue to archive malformed legacy requests safely without executing them.

- [ ] **Step 7: Run Task 1 tests and commit**

Run:

```powershell
node --test tests/scripts/web-artifact-store.test.mjs tests/scripts/web-reload-request.test.mjs
npx eslint scripts/lib/web-artifact-store.mjs scripts/lib/web-reload-request.mjs tests/scripts/web-artifact-store.test.mjs tests/scripts/web-reload-request.test.mjs
git diff --check -- scripts/lib/web-artifact-store.mjs scripts/lib/web-reload-request.mjs tests/scripts/web-artifact-store.test.mjs tests/scripts/web-reload-request.test.mjs
```

Expected: all tests PASS; ESLint and diff-check exit 0.

Commit only the four Task 1 files:

```powershell
git add -- scripts/lib/web-artifact-store.mjs scripts/lib/web-reload-request.mjs tests/scripts/web-artifact-store.test.mjs tests/scripts/web-reload-request.test.mjs
git commit -m "feat: bind web reloads to artifact identity"
```

---

### Task 2: Runner and supervisor publication handshake

**Files:**
- Modify: `scripts/run-asin-sync-job.mjs`
- Modify: `scripts/start-agent-stack.mjs`
- Create: `app/lib/web-artifact-id.ts`
- Modify: `app/api/health/route.ts`
- Modify: `app/layout.tsx`
- Modify: `tests/scripts/start-agent-stack.test.mjs`
- Modify: `tests/agent/web-health.test.ts`
- Modify: `tests/scripts/sync-runtime-policy.test.mjs`

**Interfaces:**
- Consumes: Task 1 artifact ID, manifest writer, version-2 request writer.
- Produces: Web health JSON `{ status, service, agent, artifactId }`.
- Produces: root `<html data-web-artifact-id="...">`.
- Produces: job mirror `publication: { generation, requestId, artifactId, requestedAt }`.

- [ ] **Step 1: Write failing runner and supervisor tests**

Add source-level runner assertions that one build creates one artifact manifest before one request and stores the returned request ID. Extend the launcher fixture so health probes return an artifact ID and assert candidate/final/rollback environments:

```js
test("a reload starts and validates only the requested artifact", async () => {
  const requested = "b".repeat(64);
  const launcher = createStackLauncher({
    // existing fake child setup
    waitForHealth: async (_url, options = {}) => {
      assert.equal(options.expectedArtifactId, requested);
      return { artifactId: requested };
    },
    reloadRequest: {
      consume: async ({ apply }) => apply({ artifactId: requested }),
    },
  });
  await launcher.start();
  await launcher.processReloadRequests();
  assert.equal(children.at(-1).options.env.WEB_PUBLICATION_ARTIFACT_ID, requested);
});

test("an artifact mismatch restores the known-good Web", async () => {
  // Return another artifact from final health and assert rejection plus rollback.
});
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run:

```powershell
node --test tests/scripts/start-agent-stack.test.mjs tests/scripts/sync-runtime-policy.test.mjs
npx tsx --conditions=react-server --test tests/agent/web-health.test.ts
```

Expected: new identity assertions FAIL.

- [ ] **Step 3: Implement runner identity publication**

In the build branch, use exactly this ordering:

```js
const artifactId = createWebPublicationArtifactId();
runCommand("build", "npm", ["run", "build"]);
await writeCurrentWebArtifact({ worktree: root, artifactId });
completeStage(jobId, "build");
const requestedAt = new Date().toISOString();
const target = configuredWebReloadTarget(process.env, root);
const request = await writeWebReloadRequest({
  jobId,
  artifactId,
  buildCompletedAt: requestedAt,
  target,
}, { spoolDir });
patchSyncJob(jobId, {
  publication: {
    generation: Number(readSyncJob(jobId)?.publication?.generation ?? 0) + 1,
    requestId: request.id,
    artifactId,
    requestedAt,
  },
});
```

The final job patch may still set `needsReload: true` for compatibility, but the browser will stop using it as the trigger in Task 4. A build failure must leave no request and must follow the existing job failure path.

- [ ] **Step 4: Implement health and root artifact exposure**

Create `app/lib/web-artifact-id.ts` as the single browser/server validator:

```ts
export type WebArtifactEnvironment = Readonly<Record<string, string | undefined>>;

export function webArtifactId(env: WebArtifactEnvironment): string {
  const value = env.WEB_PUBLICATION_ARTIFACT_ID?.trim();
  return value && /^[a-f0-9]{64}$/.test(value) ? value : "legacy";
}
```

Use it in both health and layout. Both healthy and degraded responses include the nonsecret artifact ID:

```ts
function webArtifactId(env: WebHealthEnvironment): string {
  const value = env.WEB_PUBLICATION_ARTIFACT_ID?.trim();
  return value && /^[a-f0-9]{64}$/.test(value) ? value : "legacy";
}

function webHealth(status: 200 | 503, agent: "ok" | "degraded", env: WebHealthEnvironment) {
  return Response.json({
    status: status === 200 ? "ok" : "degraded",
    service: "web",
    agent,
    artifactId: webArtifactId(env),
  }, { status });
}
```

`RootLayout` must render:

```tsx
const artifactId = webArtifactId(process.env);
return <html lang="zh-CN" data-web-artifact-id={artifactId}>...</html>;
```

Do not define another artifact regex in the route or layout.

- [ ] **Step 5: Implement supervisor verification and rollback identity**

Make `waitForHealth(url, { expectedArtifactId })` parse a bounded health body when an expected artifact is supplied and reject mismatch. Pass the request payload into `replaceWeb`:

```js
async function replaceWeb(baseEnv, request) {
  const candidateArtifact = artifactStore.current();
  if (candidateArtifact.id !== request.artifactId) throw new Error("Web artifact does not match reload request");
  // Spawn preflight and final Web with WEB_PUBLICATION_ARTIFACT_ID=request.artifactId.
  await wait(webHealthUrl(preflightSpec), { expectedArtifactId: request.artifactId });
  await wait(webHealthUrl(configuredSpec), { expectedArtifactId: request.artifactId });
  const snapshot = await artifactStore.snapshot(candidateArtifact);
  knownGoodArtifact = { ...snapshot, publicationArtifactId: request.artifactId };
}
```

`spawnWeb` sets `WEB_PUBLICATION_ARTIFACT_ID` from `artifact.publicationArtifactId ?? artifact.id`. On rollback, the restored snapshot must use its own preserved publication identity, never the failed request identity.

- [ ] **Step 6: Run Task 2 tests and commit**

Run:

```powershell
node --test tests/scripts/web-artifact-store.test.mjs tests/scripts/web-reload-request.test.mjs tests/scripts/start-agent-stack.test.mjs tests/scripts/sync-runtime-policy.test.mjs
npx tsx --conditions=react-server --test tests/agent/web-health.test.ts
npx eslint scripts/run-asin-sync-job.mjs scripts/start-agent-stack.mjs app/lib/web-artifact-id.ts app/api/health/route.ts app/layout.tsx tests/scripts/start-agent-stack.test.mjs tests/scripts/sync-runtime-policy.test.mjs tests/agent/web-health.test.ts
git diff --check -- scripts/run-asin-sync-job.mjs scripts/start-agent-stack.mjs app/lib/web-artifact-id.ts app/api/health/route.ts app/layout.tsx tests/scripts/start-agent-stack.test.mjs tests/scripts/sync-runtime-policy.test.mjs tests/agent/web-health.test.ts
```

Expected: all focused tests PASS; ESLint and diff-check exit 0.

Commit only Task 2 files:

```powershell
git add -- scripts/run-asin-sync-job.mjs scripts/start-agent-stack.mjs app/lib/web-artifact-id.ts app/api/health/route.ts app/layout.tsx tests/scripts/start-agent-stack.test.mjs tests/scripts/sync-runtime-policy.test.mjs tests/agent/web-health.test.ts
git commit -m "feat: acknowledge healthy web publication"
```

---

### Task 3: Authenticated publication projection

**Files:**
- Create: `server/services/sync-publication-status-service.ts`
- Modify: `server/routes/local-data.ts`
- Modify: `shared/agent-contracts.ts`
- Modify: `app/lib/sync-server.ts`
- Modify: `app/lib/sync-progress-presentation.ts`
- Modify: `tests/agent/local-data-bridge.test.ts`
- Modify: `tests/agent/contracts.test.ts`

**Interfaces:**
- Consumes: Task 1 `readWebReloadPublication` and the exact mirror publication reference.
- Produces: `SyncPublicationStatusService.read(jobId): Promise<SyncPublication>`.
- Produces: optional strict `publication` field on `LocalDataSyncJobPublicSchema`.

- [ ] **Step 1: Write failing contract and route tests**

Add a strict union and route assertions:

```ts
const publication = {
  status: "applied",
  requestId: "c".repeat(64),
  artifactId: "d".repeat(64),
  requestedAt: "2026-08-25T00:00:00.000Z",
  appliedAt: "2026-08-25T00:00:05.000Z",
} as const;

assert.equal(LocalDataSyncJobSchema.safeParse({ ...job, publication }).success, true);
assert.equal(LocalDataSyncJobSchema.safeParse({
  ...job,
  publication: { ...publication, target: "C:/secret" },
}).success, false);
```

In the authenticated route test, inject `readPublication` and assert it is called only after the job exists and organization ownership matches. Assert a wrong organization receives 404 and does not learn publication state.

- [ ] **Step 2: Run tests and confirm RED**

Run:

```powershell
npx tsx --conditions=react-server --test tests/agent/contracts.test.ts tests/agent/local-data-bridge.test.ts
```

Expected: FAIL because the contract and dependency do not exist.

- [ ] **Step 3: Implement the closed public contract**

Add exact schemas:

```ts
const PublicationBase = {
  requestId: z.string().regex(/^[a-f0-9]{64}$/),
  artifactId: z.string().regex(/^[a-f0-9]{64}$/),
  requestedAt: DateTimeSchema,
};

export const LocalDataSyncPublicationSchema = z.discriminatedUnion("status", [
  strictObject({ status: z.literal("not-required") }),
  strictObject({ status: z.literal("pending"), ...PublicationBase }),
  strictObject({ status: z.literal("applied"), ...PublicationBase, appliedAt: DateTimeSchema }),
  strictObject({
    status: z.literal("failed"),
    ...PublicationBase,
    failedAt: DateTimeSchema,
    code: z.literal("WEB_PUBLICATION_FAILED"),
  }),
]);
```

Add `publication: LocalDataSyncPublicationSchema.optional()` to the public job schema and matching TypeScript types in both app modules.

- [ ] **Step 4: Implement the publication status service**

The service reads at most one bounded mirror and delegates spool resolution. Define the helpers in the same file:

```ts
const MAX_MIRROR_BYTES = 2 * 1024 * 1024;

async function readBoundedJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size < 2 || info.size > MAX_MIRROR_BYTES) return null;
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

function parseExactPublicationReference(value: unknown, jobId: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).sort().join(",") !== "artifactId,generation,requestId,requestedAt") return null;
  if (!Number.isSafeInteger(candidate.generation) || Number(candidate.generation) < 1) return null;
  if (typeof candidate.requestId !== "string" || !/^[a-f0-9]{64}$/.test(candidate.requestId)) return null;
  if (typeof candidate.artifactId !== "string" || !/^[a-f0-9]{64}$/.test(candidate.artifactId)) return null;
  if (typeof candidate.requestedAt !== "string" || Number.isNaN(Date.parse(candidate.requestedAt))) return null;
  return {
    jobId,
    requestId: candidate.requestId,
    artifactId: candidate.artifactId,
    requestedAt: candidate.requestedAt,
  };
}

export class SyncPublicationStatusService {
  constructor(private readonly options = {
    mirrorDirectory: path.join(process.cwd(), "data", "sync-jobs"),
    spoolDirectory: path.join(process.cwd(), "data", "web-reload-requests"),
  }) {}

  async read(jobId: string): Promise<SyncPublication> {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(jobId)) return { status: "not-required" };
    const mirror = await readBoundedJson(path.join(this.options.mirrorDirectory, `${jobId}.json`));
    const reference = parseExactPublicationReference(mirror?.publication, jobId);
    if (!reference) return { status: "not-required" };
    return await readWebReloadPublication(reference, { spoolDir: this.options.spoolDirectory });
  }
}
```

The reference parser accepts only generation, requestId, artifactId, requestedAt, and the exact job ID. It never returns mirror paths, targets, errors, logs, or environment data.

- [ ] **Step 5: Append publication only after authorization**

Add `readPublication(jobId)` to `LocalDataBridgeDeps` and default it to the new service. In the GET route:

```ts
const job = await deps.readJob(jobId);
if (!job) return missing("Sync job not found");
if (job.scope?.organizationId && !ownsJob(request.authPrincipal, job)) {
  return missing("Sync job not found");
}
const publication = await deps.readPublication(jobId);
return LocalDataSyncJobSchema.parse(publicSyncJob(job, publication));
```

Do not resolve publication before the ownership check.

- [ ] **Step 6: Run Task 3 tests and commit**

Run:

```powershell
npx tsx --conditions=react-server --test tests/agent/contracts.test.ts tests/agent/local-data-bridge.test.ts
npx eslint server/services/sync-publication-status-service.ts server/routes/local-data.ts shared/agent-contracts.ts app/lib/sync-server.ts app/lib/sync-progress-presentation.ts tests/agent/local-data-bridge.test.ts tests/agent/contracts.test.ts
git diff --check -- server/services/sync-publication-status-service.ts server/routes/local-data.ts shared/agent-contracts.ts app/lib/sync-server.ts app/lib/sync-progress-presentation.ts tests/agent/local-data-bridge.test.ts tests/agent/contracts.test.ts
```

Expected: all focused tests PASS; ESLint and diff-check exit 0.

Commit only Task 3 files:

```powershell
git add -- server/services/sync-publication-status-service.ts server/routes/local-data.ts shared/agent-contracts.ts app/lib/sync-server.ts app/lib/sync-progress-presentation.ts tests/agent/local-data-bridge.test.ts tests/agent/contracts.test.ts
git commit -m "feat: expose sync publication status"
```

---

### Task 4: Browser waits for applied artifact and reloads once

**Files:**
- Modify: `app/asin-sync-funnel.tsx`
- Modify: `app/page.tsx`
- Modify: `app/lib/sync-terminal-owner.ts`
- Modify: `tests/agent/helpers/asin-sync-funnel-browser-harness.tsx`
- Modify: `tests/agent/asin-sync-session.test.ts`
- Modify: `tests/agent/sync-terminal-owner.test.ts`

**Interfaces:**
- Consumes: Task 3 `job.publication`.
- Produces: GET-only pending publication polling.
- Produces: one-shot `(jobId, artifactId)` reload ownership.

- [ ] **Step 1: Write the browser RED tests**

Add a real harness test with response sequence `pending → pending → applied`. Track GET, POST, reload callbacks, and the root artifact:

```ts
test("terminal publication waits for applied artifact and reloads exactly once", async () => {
  let gets = 0;
  let posts = 0;
  await page.route("**/v1/local-data/sync-asins/job-1", async route => {
    if (route.request().method() !== "GET") posts += 1;
    gets += 1;
    const publication = gets < 3
      ? { status: "pending", requestId, artifactId: nextArtifact, requestedAt }
      : { status: "applied", requestId, artifactId: nextArtifact, requestedAt, appliedAt };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      ...syncJob(), status: "completed-with-gaps", publication,
    }) });
  });
  await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?run=${runId}&syncJob=job-1&artifact=${currentArtifact}`);
  await expectVisibleText(page, "数据已生成，正在发布到页面");
  assert.equal(await reloadCount(page), 0);
  await waitForReloadCount(page, 1);
  assert.equal(posts, 0);
  await wait(3_000);
  assert.equal(await reloadCount(page), 1);
});
```

Add separate tests for:

- `applied` with the same current artifact: zero reload, “数据已发布”.
- `failed`: zero reload, fixed Chinese error, existing business progress remains visible.
- restored terminal URL: same `run` and `syncJob`, zero POST.
- old `needsReload=true` without publication: no automatic fixed-delay reload.

- [ ] **Step 2: Run the browser suite and confirm RED**

Run: `npx tsx --test tests/agent/asin-sync-session.test.ts`

Expected: new tests FAIL because polling stops at business terminal and page still uses `needsReload` plus 2.5 seconds.

- [ ] **Step 3: Keep polling publication after business terminal**

Use explicit predicates:

```ts
function publicationPending(job: SyncJob) {
  return (job.status === "completed" || job.status === "completed-with-gaps")
    && job.publication?.status === "pending";
}

function publicationSettled(job: SyncJob) {
  return job.publication?.status === "applied" || job.publication?.status === "failed";
}
```

In the poll loop, set terminal business state immediately but do not add the job to `completedJobs`, stop the interval, or call `onComplete` while publication is pending. Continue GET polling. Stop and call `onComplete` only when applied/failed, or when the job has no publication and is a true historical/not-required job.

Render exact copy:

```tsx
{job.publication?.status === "pending" ? (
  <p role="status">数据已生成，正在发布到页面，请勿重复提交。</p>
) : job.publication?.status === "failed" ? (
  <p role="alert" className="error">数据已生成，但页面发布失败。数据不会重新抓取。</p>
) : job.publication?.status === "applied" ? (
  <p role="status">数据已发布。</p>
) : null}
```

For MVP, retain the existing 1.5-second job GET interval rather than adding the full long-backoff policy. The polling ends as soon as publication settles.

- [ ] **Step 4: Replace the fixed-delay page reload**

Read the current artifact from the root element:

```ts
function currentWebArtifactId(): string {
  return document.documentElement.dataset.webArtifactId ?? "legacy";
}
```

In `handleTerminalSyncJob`, delete the `needsReload` 2.5-second branch. Use publication identity:

```ts
const applied = job.publication?.status === "applied" ? job.publication : null;
if (
  applied &&
  applied.artifactId !== currentWebArtifactId() &&
  scheduledReloadJobId.current !== `${job.jobId}:${applied.artifactId}`
) {
  scheduledReloadJobId.current = `${job.jobId}:${applied.artifactId}`;
  window.location.reload();
}
```

Upgrade the terminal record to version 2 and persist `{ jobId, artifactId }`, while still reading version-1 records as `{ jobId, artifactId: null }`:

```ts
type TerminalRecord = {
  version: 2;
  identity: string;
  jobId: string;
  artifactId: string | null;
};

recordTerminal: ({ jobId, artifactId }: { jobId: string; artifactId?: string | null }) => {
  const safeArtifact = artifactId && /^[a-f0-9]{64}$/.test(artifactId) ? artifactId : null;
  input.storage.setItem(key, JSON.stringify({ version: 2, identity, jobId, artifactId: safeArtifact }));
  return true;
};
```

Use the stored `(jobId, artifactId)` to distinguish an old pre-publication tombstone from the newly applied artifact. Preserve the canonical `run` and `syncJob` URL pointer.

- [ ] **Step 5: Run Task 4 tests and commit**

Run:

```powershell
npx tsx --test tests/agent/asin-sync-session.test.ts
npx tsx --test tests/agent/sync-terminal-owner.test.ts
npx eslint app/asin-sync-funnel.tsx app/lib/sync-terminal-owner.ts tests/agent/helpers/asin-sync-funnel-browser-harness.tsx tests/agent/asin-sync-session.test.ts tests/agent/sync-terminal-owner.test.ts
git diff --check -- app/asin-sync-funnel.tsx app/page.tsx app/lib/sync-terminal-owner.ts tests/agent/helpers/asin-sync-funnel-browser-harness.tsx tests/agent/asin-sync-session.test.ts tests/agent/sync-terminal-owner.test.ts
```

Expected: the full session suite passes; changed files have no new ESLint errors; diff-check exits 0. If whole-file `app/page.tsx` lint reports existing hook debt, compare changed lines and record the unchanged baseline rather than editing unrelated code.

Commit only Task 4 files:

```powershell
git add -- app/asin-sync-funnel.tsx app/page.tsx app/lib/sync-terminal-owner.ts tests/agent/helpers/asin-sync-funnel-browser-harness.tsx tests/agent/asin-sync-session.test.ts tests/agent/sync-terminal-owner.test.ts
git commit -m "fix: wait for web publication before reload"
```

---

### Task 5: Combined gate, limited review, and controlled deployment

**Files:**
- No production file changes unless the limited review finds a Critical or direct MVP blocker.
- Create ignored evidence report under `.superpowers/sdd/` only if the existing workflow requires it.

**Interfaces:**
- Consumes: Tasks 1–4 exact commits.
- Produces: one reviewed, built, deployable MVP candidate.

- [ ] **Step 1: Record the protected WIP boundary**

Run:

```powershell
git status --short
git diff -- app/competitor-data.ts app/listing-image-remarks.ts app/sif-keyword-analysis-data.ts app/sif-keyword-enrichment-data.ts app/sif-listing-traffic-raw-data.ts app/sif-monthly-traffic-trend-raw-data.ts app/sorftime-category-trend-data.ts app/sorftime-child-sales-data.ts app/sorftime-fba-fee-data.ts app/sorftime-listing-content-data.ts app/sorftime-price-strategy-data.ts app/sorftime-rating-data.ts app/sorftime-review-analysis-data.ts app/sorftime-sales-trend-data.ts app/variant-data.ts | git hash-object --stdin
```

Expected: staged index empty; the existing WIP hash is recorded before tests and remains identical after deployment.

- [ ] **Step 2: Run the combined focused gate**

Run once:

```powershell
node --test tests/scripts/web-artifact-store.test.mjs tests/scripts/web-reload-request.test.mjs tests/scripts/start-agent-stack.test.mjs tests/scripts/sync-runtime-policy.test.mjs
npx tsx --conditions=react-server --test tests/agent/web-health.test.ts tests/agent/contracts.test.ts tests/agent/local-data-bridge.test.ts
npx tsx --test tests/agent/asin-sync-session.test.ts tests/agent/sync-terminal-owner.test.ts
git diff --check -- HEAD~4..HEAD
```

Expected: all tests pass and diff-check exits 0.

- [ ] **Step 3: Perform one limited independent review**

Review only these release gates:

- candidate/final Web identity must match the request;
- old Web must be restored on mismatch or health failure;
- publication resolution must occur only after job authorization;
- terminal pending must remain GET-only;
- applied artifact must trigger at most one reload;
- no connector/MCP/data parsing path changed;
- protected WIP remains outside all commits.

Gate: Critical = 0 and direct MVP blocker = 0. Defer nonblocking refactors and the full SSE architecture.

- [ ] **Step 4: Run the one production build**

Run exactly once after review passes:

```powershell
npm run build
```

Expected: exit 0. A normal code-release build may have no `dist/web-artifact.json` and therefore starts as `artifactId=legacy`; the first successful sync publication writes the bound manifest. Do not rerun the build without documenting a direct build failure and obtaining a new release decision.

- [ ] **Step 5: Controlled deployment preflight**

Verify without provider calls or browser POST:

- PostgreSQL remains on `127.0.0.1:58258` and migrations are 15/15;
- active sync jobs, stages, attempts, and analysis runs are 0;
- `AGENT_VOC_LOCAL_FAKE=0` in the formal launcher environment;
- port 3000 is absent;
- current Web/Agent health and exact PID ownership are known;
- HEAD equals the reviewed candidate;
- protected WIP hash and staged index are unchanged.

Stop on any mismatch.

- [ ] **Step 6: Deploy through the retained formal supervisor channel**

Use the existing complete runbook environment block and one retained foreground supervisor. Keep PostgreSQL running. After launch, verify:

- Web `31900` loopback and LAN health 200;
- Agent `31901` loopback health 200;
- PG `58258` unchanged;
- port 3000 absent;
- health `artifactId` equals the deployed manifest;
- one supervisor owns the Web and Agent children;
- protected WIP hash remains unchanged.

- [ ] **Step 7: User acceptance with one new-ASIN submission**

The user performs the only browser click. Monitoring is read-only. Acceptance evidence:

- one POST creates one job;
- generated MCP files gain only the submitted ASIN data;
- terminal UI shows “数据已生成，正在发布到页面” while publication is pending;
- no early reload occurs;
- applied acknowledgement appears after the new Web health check;
- the browser reloads once and retains `run` plus `syncJob`;
- the generated rating, price/sales, keywords, listing images, and other ready modules are visible;
- no second POST, replacement job, or MCP retry occurs.

If this passes, stop. SSE/snapshot work remains a separately approved future phase.
