# Alexa VOC Authenticated Publication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require a valid same-origin login for every Alexa/system Web mutation and publish manual Alexa VOC changes through the immutable 31900 supervisor pipeline without ever starting port 3000.

**Architecture:** A server-only Web mutation guard validates Origin and delegates session truth to the existing 31901 `/v1/auth/session` route. The existing static Alexa projection remains in place, but its background rebuild becomes a manual publication Module that builds an immutable artifact, writes a versioned reload request, and leaves all Web process replacement to the formal supervisor.

**Tech Stack:** TypeScript, Node.js ESM, Next/vinext route handlers, Zod contracts, Node test runner with `tsx`, existing Agent client, immutable Web artifact store, reload request spool.

## Global Constraints

- Work only in `C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\stabilize-resumable-sync-pipeline` on `codex/stabilize-resumable-sync-pipeline`.
- Preserve every existing modified generated `app/*.ts`, `.superpowers/sdd/task-3-report.md`, and `data/projects/*.json`; never use `git add .`.
- Do not deploy, push, restart, stop, or otherwise modify live 31900, 31901, or 58258 while implementing or testing.
- Do not call a real provider, Alexa, Rainforest, Sorftime, Chrome profile, or MCP connector.
- Alexa import permits `admin` and `member`; Alexa sync and system rebuild permit only `admin`.
- Missing or mismatched Origin is 403; unauthenticated is 401; insufficient role is 403; unavailable/invalid 31901 session response is 503.
- Invalid JSON, ASIN, or blank report is 400; a report with fewer than three recognized dimensions is 422; unexpected write failures use a fixed redacted 500 response.
- Before any cache or TypeScript write, `saveAlexaVocToSystem` must verify that the parsed report contains a non-empty ASIN equal to the selected ASIN; otherwise it throws stable `asin_mismatch_report`, mapped by the route to 422 with exactly `Alexa 报告 ASIN 与所选 ASIN 不一致`.
- No new code path may import, call, or spawn `start-team-server.ps1`; no generated reload target may accept port 3000.
- Manual publication uses a unique artifact-derived job identity, job version `1`, and the exact `alexa_voc` projection content hash.
- Follow RED-GREEN-REFACTOR for every behavior change and commit only after its focused tests pass.
- Do not require the pre-existing full-repository `npm run lint` baseline to pass (it currently reports approximately 8,019 historical issues). Run `npx eslint` only on every TS/TSX file changed by this slice and require it to pass; also run full-repository `npm run lint` to record the baseline, do not attribute its non-zero result to this slice, and do not introduce new lint issues in changed files.

---

## File Structure

- `app/lib/authenticated-web-mutation.ts`: same-origin and Agent-session authorization for local Web mutation routes.
- `tests/agent/authenticated-web-mutation.test.ts`: guard behavior and redacted failure coverage.
- `app/api/alexa-voc/import/route.ts`: authenticated member/admin manual import Adapter and bounded error mapping.
- `app/api/alexa-voc/sync/route.ts`: authenticated admin-only Alexa capture Adapter.
- `app/api/system/rebuild/route.ts`: authenticated admin-only rebuild Adapter.
- `scripts/lib/alexa-voc-pipeline.mjs`: parse and validate Alexa VOC reports, including selected/report ASIN identity before any cache or TypeScript write.
- `tests/agent/alexa-voc-mutation-routes.test.ts`: route ordering, role policy, and no-side-effect rejection tests.
- `scripts/lib/manual-web-publication.mjs`: manual artifact identity, Alexa content hash, immutable build, and reload request orchestration.
- `scripts/lib/web-artifact-store.mjs`: allow `alexa_voc` as a publication-stage hash.
- `scripts/lib/web-reload-request.mjs`: validate `alexa_voc` in manual reload requests.
- `tests/scripts/manual-web-publication.test.mjs`: exact manual publication identity and orchestration tests.
- `tests/scripts/web-artifact-store.test.mjs`: artifact acceptance regression for `alexa_voc`.
- `tests/scripts/web-reload-request.test.mjs`: reload request acceptance regression for `alexa_voc`.
- `scripts/run-background-rebuild.mjs`: testable entrypoint that invokes manual publication and clears the rebuild lock, with no Web process spawn.
- `tests/scripts/background-rebuild.test.mjs`: success/failure lock cleanup and legacy-path absence tests.

---

### Task 1: Same-origin authenticated mutation guard

**Files:**
- Create: `app/lib/authenticated-web-mutation.ts`
- Create: `tests/agent/authenticated-web-mutation.test.ts`

**Interfaces:**
- Consumes: `createAgentServiceClient(): AgentServiceClient`, `SessionResponseSchema`, and request Cookie/Origin headers.
- Produces: `authorizeWebMutation(request, options): Promise<WebMutationAuthorization>` where success is `{ ok: true, role: "admin" | "member" }` and failure is `{ ok: false, response: Response }`.

- [ ] **Step 1: Write the failing guard tests**

Create `tests/agent/authenticated-web-mutation.test.ts` with this active-user fixture and these tests:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { authorizeWebMutation } from "../../app/lib/authenticated-web-mutation";
import type { AgentServiceClient } from "../../app/lib/agent-service-client";

const user = {
  id: "10000000-0000-4000-8000-000000000001",
  organizationId: "10000000-0000-4000-8000-000000000002",
  email: "member@example.com",
  displayName: "Member",
  role: "member" as const,
  status: "active" as const,
  createdAt: "2026-08-29T00:00:00.000Z",
  updatedAt: "2026-08-29T00:00:00.000Z",
};

function request(origin = "http://127.0.0.1:31900") {
  return new Request("http://127.0.0.1:31900/api/alexa-voc/import", {
    method: "POST",
    headers: { origin, cookie: "agent_session=opaque" },
  });
}

test("rejects a cross-origin mutation before calling Agent", async () => {
  let calls = 0;
  const client = (async () => { calls += 1; throw new Error("must not run"); }) as AgentServiceClient;
  const result = await authorizeWebMutation(request("http://untrusted.example"), {
    allowedRoles: ["admin", "member"], client,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.response.status, 403);
  assert.equal(calls, 0);
});

test("returns the authenticated role from a valid Agent session", async () => {
  const client = (async (input) => {
    assert.equal(input.path, "/v1/auth/session");
    assert.equal(new Headers(input.headers).get("cookie"), "agent_session=opaque");
    return { status: 200, headers: new Headers(), body: { authenticated: true, user } };
  }) as AgentServiceClient;
  assert.deepEqual(await authorizeWebMutation(request(), {
    allowedRoles: ["admin", "member"], client,
  }), { ok: true, role: "member" });
});
```

Append the remaining closed failure matrix using this exact table and one test per row:

```ts
const failures = [
  { name: "missing Origin", origin: null, body: { authenticated: true, user }, status: 403 },
  { name: "missing session", origin: "http://127.0.0.1:31900", body: { authenticated: false, user: null }, status: 401 },
] as const;

for (const scenario of failures) {
  test(`rejects ${scenario.name}`, async () => {
    const headers: Record<string, string> = { cookie: "agent_session=opaque" };
    if (scenario.origin) headers.origin = scenario.origin;
    const client = (async () => ({ status: 200, headers: new Headers(), body: scenario.body })) as AgentServiceClient;
    const result = await authorizeWebMutation(new Request(
      "http://127.0.0.1:31900/api/alexa-voc/import",
      { method: "POST", headers },
    ), { allowedRoles: ["admin", "member"], client });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.response.status, scenario.status);
  });
}
```

Add explicit tests using the same fixture for member against `["admin"]` → 403, Agent status 502 → 503, and Agent status 200 with an unknown response key → 503. In each failure response, serialize the body and assert it contains none of `internal-url-sentinel`, `proxy-token-sentinel`, `agent_session=opaque`, or `upstream-body-sentinel`.

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
npx tsx --conditions=react-server --test tests/agent/authenticated-web-mutation.test.ts
```

Expected: FAIL because `app/lib/authenticated-web-mutation.ts` does not exist.

- [ ] **Step 3: Implement the minimal guard**

Create `app/lib/authenticated-web-mutation.ts` with this shape:

```ts
import "server-only";

import { SessionResponseSchema, type User } from "../../shared/agent-contracts";
import { createAgentServiceClient, type AgentServiceClient } from "./agent-service-client";

type UserRole = User["role"];
export type WebMutationAuthorization =
  | Readonly<{ ok: true; role: UserRole }>
  | Readonly<{ ok: false; response: Response }>;

function rejected(status: 401 | 403 | 503, error: string) {
  return Object.freeze({ ok: false as const, response: Response.json({ error }, { status }) });
}

export async function authorizeWebMutation(
  request: Request,
  options: Readonly<{ allowedRoles: readonly UserRole[]; client?: AgentServiceClient }>,
): Promise<WebMutationAuthorization> {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) return rejected(403, "请求来源未获授权");

  const headers = new Headers({ origin });
  const cookie = request.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);
  const result = await (options.client ?? createAgentServiceClient())({
    method: "GET", path: "/v1/auth/session", headers,
  });
  if (result.status !== 200) return rejected(503, "登录状态暂时无法验证");
  const parsed = SessionResponseSchema.safeParse(result.body);
  if (!parsed.success) return rejected(503, "登录状态暂时无法验证");
  if (!parsed.data.authenticated || !parsed.data.user) return rejected(401, "请先登录后再操作");
  if (!options.allowedRoles.includes(parsed.data.user.role)) return rejected(403, "当前账号无权执行此操作");
  return Object.freeze({ ok: true, role: parsed.data.user.role });
}
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Step 2 command. Expected: all guard tests PASS with no warnings or secret sentinels.

- [ ] **Step 5: Commit Task 1**

```powershell
git add -- app/lib/authenticated-web-mutation.ts tests/agent/authenticated-web-mutation.test.ts
git commit -m "feat(auth): guard local Web mutations"
```

---

### Task 2: Authenticate Alexa import, Alexa sync, and rebuild routes

**Files:**
- Modify: `app/api/alexa-voc/import/route.ts`
- Modify: `app/api/alexa-voc/sync/route.ts`
- Modify: `app/api/system/rebuild/route.ts`
- Modify: `scripts/lib/alexa-voc-pipeline.mjs`
- Create: `tests/agent/alexa-voc-mutation-routes.test.ts`
- Modify: `tests/alexa-voc-import-validation.test.ts`

**Interfaces:**
- Consumes: `authorizeWebMutation()` from Task 1 and the existing `saveAlexaVocToSystem`, `triggerBackgroundRebuild`, and Alexa runner spawn behavior.
- Produces: `createAlexaVocImportHandler`, `createAlexaVocSyncHandler`, and `createSystemRebuildHandler` factories for behavior tests; exported `POST` handlers use production dependencies.

- [ ] **Step 1: Write failing route-order and policy tests**

Create `tests/agent/alexa-voc-mutation-routes.test.ts`. Import the three factory functions and inject authorization/save/rebuild/spawn fakes. Require these exact behaviors:

```ts
test("unauthorized Alexa import returns before reading or writing", async () => {
  let saved = 0;
  let rebuilt = 0;
  const handler = createAlexaVocImportHandler({
    authorize: async () => ({ ok: false, response: Response.json({ error: "请先登录后再操作" }, { status: 401 }) }),
    save: () => { saved += 1; throw new Error("must not run"); },
    rebuild: () => { rebuilt += 1; return { started: true, message: "unexpected" }; },
  });
  const response = await handler(new Request("http://127.0.0.1:31900/api/alexa-voc/import", {
    method: "POST", headers: { origin: "http://127.0.0.1:31900" }, body: "not-json",
  }));
  assert.equal(response.status, 401);
  assert.equal(saved, 0);
  assert.equal(rebuilt, 0);
});
```

Add the following exact policy matrix to the route test and assert the authorization fake receives it before any other injected dependency runs:

```ts
const routePolicies = [
  ["import", createAlexaVocImportHandler, ["admin", "member"]],
  ["sync", createAlexaVocSyncHandler, ["admin"]],
  ["rebuild", createSystemRebuildHandler, ["admin"]],
] as const;
```

Add separate tests where `save` throws `new Error("incomplete_report · 仅识别 2/7 个维度")` and expect status 422 plus exactly `{ error: "Alexa 报告至少需要识别 3 个维度" }`; where `save` throws `new Error("secret-write-sentinel")` and expect status 500 plus exactly `{ error: "Alexa VOC 写入失败" }`; and where `save` appends `"save"` before `rebuild` appends `"rebuild"`, expecting `["save", "rebuild"]`. Import the route module as a namespace and assert `Object.hasOwn(module, "OPTIONS") === false`.

In `tests/alexa-voc-import-validation.test.ts`, add a red-first regression for `saveAlexaVocToSystem(selectedAsin, reportText, ...)`: a report whose parsed ASIN is empty or differs from `selectedAsin` must throw exactly `asin_mismatch_report`, and the test must assert both the cache file and generated TypeScript file bytes are unchanged. Add the matching passing test for an equal non-empty parsed ASIN and assert both files contain the new report. The implementation in `scripts/lib/alexa-voc-pipeline.mjs` must perform this identity check immediately after parsing and before either write; route handling must map `asin_mismatch_report` to status 422 and exactly `{ error: "Alexa 报告 ASIN 与所选 ASIN 不一致" }`.

- [ ] **Step 2: Run route tests and verify RED**

```powershell
npx tsx --conditions=react-server --test tests/agent/alexa-voc-mutation-routes.test.ts tests/alexa-voc-import-validation.test.ts
```

Expected: FAIL because the three handler factories do not exist and the import route still exports permissive CORS/OPTIONS behavior.

- [ ] **Step 3: Implement the three handler factories**

In each route, authorize before `request.json()`, file writes, rebuild, or spawn. The import factory must follow this control flow:

```ts
export function createAlexaVocImportHandler(dependencies: Partial<ImportDependencies> = {}) {
  const authorize = dependencies.authorize ?? authorizeWebMutation;
  const save = dependencies.save ?? saveAlexaVocToSystem;
  const rebuild = dependencies.rebuild ?? triggerBackgroundRebuild;
  return async function handleAlexaVocImport(request: Request) {
    const authorization = await authorize(request, { allowedRoles: ["admin", "member"] });
    if (!authorization.ok) return authorization.response;
    let payload: ImportPayload;
    try { payload = await request.json() as ImportPayload; }
    catch { return Response.json({ error: "请求内容不是有效 JSON" }, { status: 400 }); }
    const asin = normalizeAsin(payload.asin);
    const text = String(payload.text ?? "").trim();
    if (!asin) return Response.json({ error: "ASIN 必须是 10 位编码" }, { status: 400 });
    if (!hasManualAlexaVocText(text)) return Response.json({ error: "Alexa 报告内容不能为空" }, { status: 400 });
    let processed;
    try {
      processed = save(asin, text, { captureMode: "browser" });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "empty_report") return Response.json({ error: "Alexa 报告内容不能为空" }, { status: 400 });
      if (code.startsWith("incomplete_report")) return Response.json({ error: "Alexa 报告至少需要识别 3 个维度" }, { status: 422 });
      return Response.json({ error: "Alexa VOC 写入失败" }, { status: 500 });
    }
    const rebuildResult = payload.autoRebuild === false
      ? { started: false, message: "skipped" }
      : rebuild();
    return Response.json({
      ok: true,
      asin,
      filled: processed.filled,
      missing: processed.missing,
      overallConclusion: processed.overallConclusion,
      preview: {
        attention: processed.sections.attention.slice(0, 2),
        positives: processed.sections.positives.slice(0, 2),
        negatives: processed.sections.negatives.slice(0, 2),
      },
      rebuild: rebuildResult,
      message: rebuildResult.started ? "已写入 VOC 数据，正式页面正在后台发布" : "已写入 VOC 数据",
    });
  };
}
export const POST = createAlexaVocImportHandler();
```

Implement equivalent factories for sync and rebuild using `["admin"]`. Remove `corsHeaders` and the `OPTIONS` export entirely. Do not copy Agent response headers, session details, Cookie, or internal diagnostics into any route response.

- [ ] **Step 4: Run route and ASIN-validation tests and verify GREEN**

Run the Step 2 command. Expected: all tests PASS; unauthorized requests record zero save/rebuild/spawn calls, mismatched/blank parsed ASIN fails before either target file changes, and matching ASIN writes both targets.

- [ ] **Step 5: Run nearby proxy/auth regressions**

```powershell
npx tsx --conditions=react-server --test tests/agent/proxy.test.ts tests/agent/auth-authorization.test.ts tests/agent/authenticated-web-mutation.test.ts
```

Expected: all tests PASS.

- [ ] **Step 6: Commit Task 2**

```powershell
git add -- app/api/alexa-voc/import/route.ts app/api/alexa-voc/sync/route.ts app/api/system/rebuild/route.ts scripts/lib/alexa-voc-pipeline.mjs tests/agent/alexa-voc-mutation-routes.test.ts tests/alexa-voc-import-validation.test.ts
git commit -m "fix(auth): protect Alexa mutation routes"
```

---

### Task 3: Build a manual immutable Web publication Module

**Files:**
- Create: `scripts/lib/manual-web-publication.mjs`
- Modify: `scripts/lib/web-artifact-store.mjs`
- Modify: `scripts/lib/web-reload-request.mjs`
- Create: `tests/scripts/manual-web-publication.test.mjs`
- Modify: `tests/scripts/web-artifact-store.test.mjs`
- Modify: `tests/scripts/web-reload-request.test.mjs`

**Interfaces:**
- Consumes: `createWebPublicationArtifactId`, `publishImmutableWebArtifact`, `configuredWebReloadTarget`, and `writeWebReloadRequest`.
- Produces: `manualWebPublicationDescriptor({ artifactId, source })` and `publishManualWebUpdate({ worktree, env, build, ...dependencies })`.

- [ ] **Step 1: Write failing descriptor and orchestration tests**

Create `tests/scripts/manual-web-publication.test.mjs` with these assertions:

```js
test("manual publication identity binds the exact Alexa projection", () => {
  const artifactId = "a".repeat(64);
  const descriptor = manualWebPublicationDescriptor({ artifactId, source: "exact-voc-source" });
  assert.equal(descriptor.jobId, `manual-alexa-voc-${artifactId.slice(0, 32)}`);
  assert.equal(descriptor.jobVersion, 1);
  assert.deepEqual(descriptor.stageContentHashes, {
    alexa_voc: createHash("sha256").update("exact-voc-source").digest("hex"),
  });
});

test("manual publication writes reload only after immutable artifact succeeds", async () => {
  const calls = [];
  const result = await publishManualWebUpdate({
    worktree: "C:/safe-worktree",
    env: { WEB_HOST: "0.0.0.0", WEB_PORT: "31900" },
    build: async () => { calls.push("build"); },
    readSource: async () => "voc-source",
    createArtifactId: () => "b".repeat(64),
    publishArtifact: async (input) => { calls.push("artifact"); await input.build(); return { id: input.artifactId }; },
    writeReloadRequest: async (input) => { calls.push("reload"); return { id: "c".repeat(64), payload: input }; },
  });
  assert.deepEqual(calls, ["artifact", "build", "reload"]);
  assert.equal(result.artifactId, "b".repeat(64));
  assert.equal(result.reloadRequestId, "c".repeat(64));
});
```

Add focused regressions to `web-artifact-store.test.mjs` and `web-reload-request.test.mjs` proving `{ alexa_voc: <64-hex> }` is accepted while unknown stage names remain rejected.

- [ ] **Step 2: Run publication tests and verify RED**

```powershell
node --test tests/scripts/manual-web-publication.test.mjs tests/scripts/web-artifact-store.test.mjs tests/scripts/web-reload-request.test.mjs
```

Expected: FAIL because the manual publication Module does not exist and `alexa_voc` is not an allowed stage hash.

- [ ] **Step 3: Implement the descriptor and publisher**

Create `scripts/lib/manual-web-publication.mjs` with the following complete flow:

```js
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createWebPublicationArtifactId, publishImmutableWebArtifact } from "./web-artifact-store.mjs";
import { configuredWebReloadTarget, writeWebReloadRequest } from "./web-reload-request.mjs";

export function manualWebPublicationDescriptor({ artifactId, source }) {
  if (!/^[a-f0-9]{64}$/.test(artifactId) || typeof source !== "string") throw new Error("Invalid manual Web publication");
  return Object.freeze({
    jobId: `manual-alexa-voc-${artifactId.slice(0, 32)}`,
    jobVersion: 1,
    stageContentHashes: Object.freeze({ alexa_voc: createHash("sha256").update(source).digest("hex") }),
  });
}

export async function publishManualWebUpdate(options) {
  const artifactId = (options.createArtifactId ?? createWebPublicationArtifactId)();
  const source = await (options.readSource ?? (() => fs.readFile(path.join(options.worktree, "app", "rufus-voc-data.ts"), "utf8")))();
  const descriptor = manualWebPublicationDescriptor({ artifactId, source });
  await (options.publishArtifact ?? publishImmutableWebArtifact)({
    worktree: options.worktree, artifactId, ...descriptor, build: options.build,
  });
  const written = await (options.writeReloadRequest ?? writeWebReloadRequest)({
    ...descriptor, artifactId, buildCompletedAt: new Date().toISOString(),
    target: configuredWebReloadTarget(options.env, options.worktree),
  });
  return Object.freeze({ artifactId, reloadRequestId: written.id });
}
```

Add `"alexa_voc"` to the private allowed-stage sets in both Web artifact and reload request Modules. Do not add it to `ProjectableSyncStageSchema`; manual publication is not a sync-stage output contract.

- [ ] **Step 4: Run publication tests and verify GREEN**

Run the Step 2 command. Expected: all publication tests PASS, including rejection of an unknown stage.

- [ ] **Step 5: Commit Task 3**

```powershell
git add -- scripts/lib/manual-web-publication.mjs scripts/lib/web-artifact-store.mjs scripts/lib/web-reload-request.mjs tests/scripts/manual-web-publication.test.mjs tests/scripts/web-artifact-store.test.mjs tests/scripts/web-reload-request.test.mjs
git commit -m "feat(web): publish manual Alexa artifacts"
```

---

### Task 4: Replace the legacy background restart entrypoint

**Files:**
- Modify: `scripts/run-background-rebuild.mjs`
- Create: `tests/scripts/background-rebuild.test.mjs`
- Modify: `app/lib/trigger-rebuild.ts`

**Interfaces:**
- Consumes: `publishManualWebUpdate()` from Task 3 and the existing rebuild lock path.
- Produces: `runBackgroundRebuild({ worktree, env, build, publish })`, which always clears its own lock and never starts a Web process.

- [ ] **Step 1: Write failing entrypoint tests**

Create `tests/scripts/background-rebuild.test.mjs`. Use a temporary worktree and an injected publisher; do not run a real build. Include this success test:

```js
test("background rebuild publishes once and clears its lock", async () => {
  await withTemporaryWorktree(async ({ worktree, lockFile }) => {
    await fs.mkdir(path.dirname(lockFile), { recursive: true });
    await fs.writeFile(lockFile, "{}", "utf8");
    const calls = [];
    await runBackgroundRebuild({
      worktree, env: { WEB_HOST: "0.0.0.0", WEB_PORT: "31900" },
      build: async () => calls.push("build"),
      publish: async (input) => { calls.push("publish"); await input.build(); return { artifactId: "a".repeat(64) }; },
    });
    assert.deepEqual(calls, ["publish", "build"]);
    await assert.rejects(fs.access(lockFile), { code: "ENOENT" });
  });
});
```

Add a publisher-failure test proving the lock is still removed and the error is rethrown. Read `scripts/run-background-rebuild.mjs` as text and assert it contains neither `start-team-server.ps1` nor `spawn(` nor port `3000`.

- [ ] **Step 2: Run entrypoint tests and verify RED**

```powershell
node --test tests/scripts/background-rebuild.test.mjs
```

Expected: FAIL because `run-background-rebuild.mjs` has no exported function and still contains the legacy restart path.

- [ ] **Step 3: Implement the testable entrypoint**

Change the entrypoint to import only `spawnSync` for the build command, export `runBackgroundRebuild`, use `publishManualWebUpdate`, and keep the CLI main guard:

```js
export async function runBackgroundRebuild({
  worktree = root,
  env = process.env,
  build = async () => run("build", "npm", ["run", "build"], worktree, env),
  publish = publishManualWebUpdate,
} = {}) {
  try {
    return await publish({ worktree, env, build });
  } finally {
    clearLock(worktree);
  }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  runBackgroundRebuild().then(
    () => console.log("[rebuild] publication requested"),
    (error) => { console.error("[rebuild] publication failed"); process.exitCode = 1; },
  );
}
```

Ensure `clearLock(worktree)` derives `data/.rebuild-lock.json` from its argument. Update `trigger-rebuild.ts` success text from “服务重启” to “正式页面发布”; do not expose artifact paths or raw background errors.

- [ ] **Step 4: Run entrypoint and publication tests and verify GREEN**

```powershell
node --test tests/scripts/background-rebuild.test.mjs tests/scripts/manual-web-publication.test.mjs tests/scripts/web-artifact-store.test.mjs tests/scripts/web-reload-request.test.mjs tests/scripts/start-agent-stack.test.mjs
```

Expected: all tests PASS; source assertion proves no legacy restart reference.

- [ ] **Step 5: Commit Task 4**

```powershell
git add -- scripts/run-background-rebuild.mjs tests/scripts/background-rebuild.test.mjs app/lib/trigger-rebuild.ts
git commit -m "fix(web): route rebuilds through formal publication"
```

---

### Task 5: Full verification and clean handoff

**Files:**
- Verify only; modify a prior task file only if a test exposes a defect.

**Interfaces:**
- Consumes: completed Tasks 1–4.
- Produces: evidence that authentication, publication, formal supervisor behavior, and existing project behavior remain green without touching live services.

- [ ] **Step 1: Run all focused authentication and publication suites**

```powershell
npx tsx --conditions=react-server --test tests/agent/authenticated-web-mutation.test.ts tests/agent/alexa-voc-mutation-routes.test.ts tests/agent/proxy.test.ts tests/agent/auth-authorization.test.ts tests/alexa-voc-import-validation.test.ts
node --test tests/scripts/background-rebuild.test.mjs tests/scripts/manual-web-publication.test.mjs tests/scripts/web-artifact-store.test.mjs tests/scripts/web-reload-request.test.mjs tests/scripts/start-agent-stack.test.mjs
```

Expected: every focused test PASS with zero real provider calls and zero live-port changes.

- [ ] **Step 2: Run changed-file lint, record the repository baseline, and run ordinary project tests**

```powershell
npx eslint app/lib/authenticated-web-mutation.ts app/api/alexa-voc/import/route.ts app/api/alexa-voc/sync/route.ts app/api/system/rebuild/route.ts app/lib/trigger-rebuild.ts tests/agent/authenticated-web-mutation.test.ts tests/agent/alexa-voc-mutation-routes.test.ts tests/alexa-voc-import-validation.test.ts
npm run lint
npm test
```

Expected: the changed-file `npx eslint` command exits 0. `npm run lint` is run only to record the existing approximately 8,019-issue baseline; if it exits non-zero, preserve that result as baseline evidence, do not attribute it to this slice, and confirm the changed-file command introduced no new issues. `npm test` must exit 0.

- [ ] **Step 3: Run one fresh production build**

```powershell
npm run build
```

Expected: exit 0. This build is verification only; do not write a reload request and do not start/restart a server.

- [ ] **Step 4: Verify no forbidden path and no unintended staging**

```powershell
rg -n "start-team-server\.ps1|Port = 3000" scripts/run-background-rebuild.mjs app/lib/trigger-rebuild.ts tests/scripts/background-rebuild.test.mjs
git status --short
git diff --cached --name-only
```

Expected: `rg` finds no production reference; live generated WIP remains present and unstaged; cached diff is empty after task commits.

- [ ] **Step 5: Record final commit range and stop before deployment**

```powershell
git log --oneline 54d78bd..HEAD
```

Expected: only the plan and Task 1–4 scoped commits are listed. Report results to the user; do not push or deploy without separate authorization.
