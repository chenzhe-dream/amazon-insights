# SellerSprite MCP Handshake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace SellerSprite's stateless MCP request with a standard bounded initialize/session handshake for readiness and tool execution.

**Architecture:** Pin `@modelcontextprotocol/sdk@1.30.0`, then use a fresh `Client` plus `StreamableHTTPClientTransport` for every SellerSprite logical attempt. An injected fetch accounts every SellerSprite HTTP dispatch through the existing governor; `RemoteMcpConnector` retains limiter, logical retry, deadline, credential, result, and safe-error ownership. SIF and Sorftime remain unchanged.

**Tech Stack:** Node.js 22.13+, TypeScript 5.9, `@modelcontextprotocol/sdk@1.30.0`, Node HTTP loopback fixture, `tsx` Node tests, ESLint, Vinext, OpenSpec.

## Global Constraints

- Work only in `C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\stabilize-resumable-sync-pipeline` on `codex/stabilize-resumable-sync-pipeline`; do not create another worktree.
- Preserve the 15 modified generated `app/*.ts` files and 4 untracked `data/projects/*.json` files as unstaged business data; never overwrite, clean, reset, stash, delete, or commit them.
- No change to SIF or Sorftime transports, probes, credentials, retries, or parsing.
- No ASIN-specific fallback, endpoint override, readiness bypass, timeout inflation, automatic job creation, new job/run/stage type, or database migration.
- No persistence of MCP session identifiers and no session sharing across organizations, credentials, probes, attempts, or jobs.
- No SellerSprite product tool during readiness.
- `RemoteMcpConnector` continues to own the bounded FIFO limiter, logical attempt timeout, existing outer retry policy, structured-result validation, credential-leak rejection, and fixed `ConnectorError` projection.
- `ConnectorProbeService` remains the only production path that persists connector health.
- `SyncProviderReadinessService` continues requiring a fresh available state before sync admission; no unavailable connector may create a job.
- The current per-attempt timeout remains the single total deadline for `connect()` plus `listTools()` or `callTool()`; SDK retry/reconnect is disabled.
- `client.close()` is called exactly once in `finally`; normal close never calls `terminateSession()`.
- Never log or persist credentials, header values, bodies, session ids, SDK messages/causes, database URLs, tokens, cookies, or certificates.
- Tests use loopback fixtures only; Tasks 1–7 perform no provider call, browser action, deploy, POST, job creation, or business-data write.
- Use `npm install` to update `package.json` and `package-lock.json` together; never hand-edit lock resolutions.
- If the selected SDK cannot inject fetch, disable reconnects, obey abort, or close deterministically, stop before production code changes.
- Do not push, rebase, amend, reset, clean, or stash. Stage only the exact paths named by each task.

---

## File Structure

- `package.json`, `package-lock.json`: exact SDK dependency.
- `scripts/lib/sellersprite-mcp-client.mjs`: SellerSprite-only SDK session adapter with existing public helper signatures.
- `server/connectors/remote-mcp-connector.ts`: closed physical-governance mode and attempt context.
- `server/connectors/mcp-connectors.ts`: SellerSprite-only transport-dispatch wiring; SIF/Sorftime unchanged.
- `server/connectors/mcp-transport.mjs`: safe structural timeout/error input.
- `tests/agent/helpers/fake-sellersprite-mcp-server.ts`: protocol/session loopback server.
- `tests/agent/sellersprite-sdk-contract.test.ts`: exact dependency/API contract.
- `tests/agent/sellersprite-mcp-handshake.test.ts`: handshake/readiness/execution/close/error contract.
- Existing connector, governor, probe, readiness, and secret tests: affected regressions.
- `openspec/changes/stabilize-resumable-sync-pipeline/tasks.md`: final evidence only.

---

### Task 1: Lock the exact SDK dependency

**Files:**
- Create: `tests/agent/sellersprite-sdk-contract.test.ts`
- Modify: `package.json:68-81`
- Modify through npm only: `package-lock.json`

**Interfaces:**
- Consumes: Node engine `>=22.13.0` and npm package metadata/types.
- Produces: pinned `@modelcontextprotocol/sdk@1.30.0` with `Client`, `StreamableHTTPClientTransport`, injected `fetch`, abortable requests, `maxRetries: 0`, `close()`, and separate unused `terminateSession()`.

- [ ] Inspect the exact package without installing:

```powershell
$v='1.30.0'; $r=Join-Path $env:TEMP "seller-sdk-$v"
if (Test-Path -LiteralPath $r) { Remove-Item -LiteralPath $r -Recurse -Force }
New-Item -ItemType Directory -Path $r | Out-Null
$m=npm view "@modelcontextprotocol/sdk@$v" version engines --json | ConvertFrom-Json
if ($m.version -ne $v -or $m.engines.node -ne '>=18'){throw 'SDK metadata mismatch'}
npm pack "@modelcontextprotocol/sdk@$v" --pack-destination $r --silent | Out-Null
tar -xf (Get-ChildItem $r -Filter '*.tgz').FullName -C $r
$t=Get-Content -Raw "$r/package/dist/esm/client/streamableHttp.d.ts"
$c=Get-Content -Raw "$r/package/dist/esm/client/index.d.ts"
@('fetch?: FetchLike','reconnectionOptions?: StreamableHTTPReconnectionOptions','maxRetries: number','close(): Promise<void>','terminateSession(): Promise<void>')|%{if(-not$t.Contains($_)){throw "Missing $_"}}
@('connect(transport: Transport, options?: RequestOptions): Promise<void>','listTools(','callTool(')|%{if(-not$c.Contains($_)){throw "Missing $_"}}
```

- [ ] Add the dependency contract test:

```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("pins the reviewed MCP SDK exports", async () => {
  const entry = import.meta.resolve("@modelcontextprotocol/sdk/client/index.js");
  const pkg = JSON.parse(await readFile(new URL("../../../package.json", entry), "utf8"));
  assert.equal(pkg.version, "1.30.0");
  const [{ Client }, { StreamableHTTPClientTransport, StreamableHTTPError }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
  ]);
  assert.equal(typeof Client, "function");
  assert.equal(typeof StreamableHTTPClientTransport, "function");
  assert.equal(typeof StreamableHTTPError, "function");
});
```

- [ ] RED: `npx tsx --conditions=react-server --test tests/agent/sellersprite-sdk-contract.test.ts`
  - Expected: module-not-found because the SDK is absent.
- [ ] GREEN: run `npm install --save-exact @modelcontextprotocol/sdk@1.30.0`, then rerun the RED command; expected `1/1` pass.
- [ ] Commit:

```powershell
git add package.json package-lock.json tests/agent/sellersprite-sdk-contract.test.ts
git diff --cached --check
git commit -m "build: pin reviewed MCP client SDK"
```

---

### Task 2: Prove the stateless protocol failure with a loopback server

**Files:**
- Create: `tests/agent/helpers/fake-sellersprite-mcp-server.ts`
- Create: `tests/agent/sellersprite-mcp-handshake.test.ts`
- Read: `scripts/lib/sellersprite-mcp-client.mjs:11-73`

**Interfaces:**
- Consumes: `requestSellerSpriteMcp(secret, method, params, options)` and test-only loopback endpoint override.
- Produces: `startFakeSellerSpriteMcpServer()` exposing `url`, bounded request metadata, and `close()`.

- [ ] Create a loopback server that returns HTTP 400 for pre-init list/call, accepts initialize, returns `Mcp-Session-Id`, accepts initialized notification, then requires session and protocol headers for list/call. Record only:

```ts
export type FakeMcpRequest = Readonly<{
  method: string;
  hasSession: boolean;
  hasProtocolVersion: boolean;
  hasSecretHeader: boolean;
}>;

writeResult(response, payload.id, {
  protocolVersion: payload.params.protocolVersion,
  capabilities: { tools: {} },
  serverInfo: { name: "fake-seller", version: "1.0.0" },
}, { "Mcp-Session-Id": "fake-session-1" });
```

- [ ] Add the protocol expectation:

```ts
const result = await requestSellerSpriteMcp("fake-secret", "tools/list", {}, options);
assert.equal(Array.isArray(result.tools), true);
assert.deepEqual(fake.requests.map((r) => r.method), [
  "initialize", "notifications/initialized", "tools/list",
]);
assert.equal(fake.requests[2]?.hasSession, true);
assert.equal(fake.requests[2]?.hasProtocolVersion, true);
```

- [ ] RED: `npx tsx --conditions=react-server --test tests/agent/sellersprite-mcp-handshake.test.ts`
  - Expected: current direct `tools/list` receives HTTP 400 and no initialize is observed.
- [ ] GREEN after Task 3: rerun the RED command; expected handshake test passes with initialize → initialized → list.
- [ ] Commit the authentic RED:

```powershell
git add tests/agent/helpers/fake-sellersprite-mcp-server.ts tests/agent/sellersprite-mcp-handshake.test.ts
git commit -m "test: require SellerSprite MCP session handshake"
```

---

### Task 3: Implement the bounded SellerSprite session adapter

**Files:**
- Modify: `scripts/lib/sellersprite-mcp-client.mjs:1-79`
- Modify: `server/connectors/mcp-transport.mjs:1-47`
- Modify: `tests/agent/sellersprite-mcp-handshake.test.ts`

**Interfaces:**
- Consumes: secret, `tools/list | tools/call`, params, injected fetch, parent signal, timeout, optional governor scope.
- Produces: unchanged `requestSellerSpriteMcp(...)` and `callSellerSpriteMcpTool(...)` helpers using one fresh session and one operation.

- [ ] Add SDK imports, `15_000ms` total timeout, `250ms` bounded close, `redirect:"error"`, and reconnection options `{maxRetries:0, initialReconnectionDelay:1, maxReconnectionDelay:1, reconnectionDelayGrowFactor:1}`.
- [ ] RED: rerun Task 2's handshake command; expected HTTP 400 before implementation.
- [ ] Implement the lifecycle inside the existing one-time diagnostics wrapper:

```js
const signal = options.signal
  ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 15_000)])
  : AbortSignal.timeout(options.timeoutMs ?? 15_000);
const client = new Client({ name: "amazon-opportunity-insights", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(providerEndpoint("sellerSprite", env)), {
  fetch: createSellerSpriteGovernedFetch({ ...options, lifecycleSignal: signal }),
  requestInit: { headers: { "secret-key": secretKey }, redirect: "error", signal },
  reconnectionOptions: {
    maxRetries: 0, initialReconnectionDelay: 1,
    maxReconnectionDelay: 1, reconnectionDelayGrowFactor: 1,
  },
});
try {
  await client.connect(transport, { signal });
  return method === "tools/list"
    ? await client.listTools(undefined, { signal })
    : await client.callTool(
        { name: params.name, arguments: params.arguments }, undefined, { signal },
      );
} catch (error) {
  throw safeSellerSpriteTransportError(error, signal);
} finally {
  await Promise.race([
    client.close().catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 250)),
  ]);
}
```

- [ ] Project errors only to structural `timeout`, `http(status)`, or `malformed`; add `structural.kind === "timeout"` mapping to existing safe `ConnectorError("timeout")`. Never call `terminateSession()`.
- [ ] Extend tests for list, call, initialize failure, timeout, parent abort, malformed negotiation/result, and exactly-one bounded close with no post-close request.
- [ ] GREEN: `npx tsx --conditions=react-server --test tests/agent/sellersprite-mcp-handshake.test.ts tests/agent/connector-secret-config.test.ts`
- [ ] Commit:

```powershell
git add scripts/lib/sellersprite-mcp-client.mjs server/connectors/mcp-transport.mjs server/connectors/remote-mcp-connector.ts tests/agent/sellersprite-mcp-handshake.test.ts tests/agent/connector-secret-config.test.ts
git commit -m "fix: establish SellerSprite MCP sessions"
```

---

### Task 4: Govern every SellerSprite HTTP dispatch exactly once

**Files:**
- Modify: `server/connectors/remote-mcp-connector.ts:23-42,187-255,276-367`
- Modify: `server/connectors/mcp-connectors.ts:27-175`
- Modify: `scripts/lib/sellersprite-mcp-client.mjs`
- Modify: `tests/agent/connector-resource-governor.test.ts:22-155`

**Interfaces:**
- Consumes: existing `ResourceGovernor`, `ConnectorRequest.governorScope`, attempt kind, and policy timeout.
- Produces: `physicalGovernance: "outer-attempt" | "transport-dispatch"` and `ConnectorAttemptContext`; SellerSprite uses dispatch mode, SIF/Sorftime keep outer mode.

- [ ] Add a fake-session test expecting three observed readiness HTTP dispatches and exactly three governor records.
- [ ] RED: `npx tsx --conditions=react-server --test --test-name-pattern="governed once" tests/agent/connector-resource-governor.test.ts`; expected governor count differs from the three fake-server dispatches.
- [ ] Add the closed internal context:

```ts
type ConnectorAttemptContext = Readonly<{
  attemptKind: GovernedAttemptKind;
  governorScope: Readonly<{ organizationId: string; jobId: string }> | null;
  resourceGovernor: ResourceGovernor | null;
  timeoutMs: number;
}>;
```

- [ ] In `executeAttempts`, choose one owner only:

```ts
const data = await runWithTimeout(
  (signal) => options.physicalGovernance === "transport-dispatch"
    ? operation(signal, context)
    : runGovernedConnectorAttempt(options, request, context.attemptKind,
        () => operation(signal, context)),
  options.policy.timeoutMs,
  request.signal,
);
```

- [ ] Configure only `createSellerSpriteConnector` for `transport-dispatch`; pass governor, organization/job, attempt kind, signal, fetch, environment, and timeout into the adapter. Leave SIF/Sorftime factory calls unchanged.
- [ ] Make the SDK's injected fetch the only SellerSprite network seam:

```js
return async (input, init = {}) => governExternalRequest({
  resourceGovernor, requireResourceGovernor, env, organizationId, jobId,
  resource: "sellerSprite", attemptKind,
  operation: () => fetchImpl(input, {
    ...init,
    signal: init.signal ? AbortSignal.any([lifecycleSignal, init.signal]) : lifecycleSignal,
    redirect: "error",
  }),
});
```

- [ ] GREEN: `npx tsx --conditions=react-server --test tests/agent/sellersprite-mcp-handshake.test.ts tests/agent/connector-resource-governor.test.ts tests/agent/remote-mcp-connectors.test.ts`
- [ ] Commit:

```powershell
git add server/connectors/remote-mcp-connector.ts server/connectors/mcp-connectors.ts scripts/lib/sellersprite-mcp-client.mjs tests/agent/connector-resource-governor.test.ts tests/agent/remote-mcp-connectors.test.ts tests/agent/sellersprite-mcp-handshake.test.ts
git commit -m "fix: govern SellerSprite session dispatches"
```

---

### Task 5: Prove capability-only readiness and fail-closed admission

**Files:**
- Modify: `tests/agent/connector-probe-service.test.ts:291-380`
- Modify: `tests/agent/sync-provider-readiness-gate.test.ts:68-161`
- Modify: `tests/agent/sellersprite-mcp-handshake.test.ts`
- Production services remain read-only unless RED proves a focused mapper defect.

**Interfaces:**
- Consumes: `ConnectorProbeService.probe("sellerSprite")` and `SyncProviderReadinessService.assertReady(...)`.
- Produces: `connect()+listTools()` only, safe persisted capability, and zero `SyncJobRepository.admit` on failure.

- [ ] Add a success test asserting request order initialize → initialized → list, zero call, zero ASIN, and persisted available status.
- [ ] Add initialize-400 and timeout cases asserting unavailable safe status, zero list/call, and no raw secret/session/body.
- [ ] Extend the existing readiness counter test so SellerSprite probe failure leaves `{admit:0, workerLaunch:0}`; a successful fresh status permits the unchanged catalog requirement.
- [ ] RED: `npx tsx --conditions=react-server --test --test-name-pattern="SellerSprite|readiness|sync admission" tests/agent/connector-probe-service.test.ts tests/agent/sync-provider-readiness-gate.test.ts tests/agent/sellersprite-mcp-handshake.test.ts`; expected new SellerSprite capability assertions fail before service/session wiring.
- [ ] GREEN: rerun the RED command; expected all selected tests pass with zero skipped.
- [ ] Commit:

```powershell
git add tests/agent/connector-probe-service.test.ts tests/agent/sync-provider-readiness-gate.test.ts tests/agent/sellersprite-mcp-handshake.test.ts
git diff --cached --check
git commit -m "test: prove SellerSprite capability readiness"
```

---

### Task 6: Lock execution, secrecy, and SIF/Sorftime regressions

**Files:**
- Modify: `tests/agent/sellersprite-mcp-handshake.test.ts`
- Modify: `tests/agent/remote-mcp-connectors.test.ts:64-254`
- Modify: `tests/agent/connector-resource-governor.test.ts:22-155`
- Modify: `tests/agent/connector-secret-config.test.ts:82-144`
- Read-only: `scripts/lib/sif-mcp-client.mjs`, `scripts/lib/sorftime-mcp-client.mjs`

**Interfaces:**
- Consumes: existing SellerSprite helper callers and `Client.callTool({name, arguments})`.
- Produces: unchanged normalized object/array results; fixed safe error codes; unchanged SIF/Sorftime direct list/call and authentication styles.

- [ ] Add SellerSprite execution success plus HTTP error mapping:

```ts
const expected = [
  [400, "upstream-permanent", false], [401, "authentication", false],
  [403, "authentication", false], [429, "rate-limit", true],
  [503, "upstream-temporary", true],
] as const;
```

- [ ] Assert each logical retry creates a fresh session, failed initialize never calls a tool, no hidden retry/reconnect/redirect occurs, and fake secret/session/body sentinels never appear.
- [ ] Assert SellerSprite object and array results still normalize through current helper names; no production caller changes.
- [ ] RED: `npx tsx --conditions=react-server --test --test-name-pattern="SellerSprite execution boundaries" tests/agent/sellersprite-mcp-handshake.test.ts`; expected new status/secrecy/regression assertions fail before completion.
- [ ] Assert SIF/Sorftime production files and request/auth/governor behavior remain unchanged:

```powershell
git diff --exit-code 3920709446bded497fe1a722db3e742c746c9b73 -- scripts/lib/sif-mcp-client.mjs scripts/lib/sorftime-mcp-client.mjs
```

- [ ] GREEN: `npx tsx --conditions=react-server --test tests/agent/sellersprite-sdk-contract.test.ts tests/agent/sellersprite-mcp-handshake.test.ts tests/agent/remote-mcp-connectors.test.ts tests/agent/connector-resource-governor.test.ts tests/agent/connector-secret-config.test.ts tests/agent/connector-probe-service.test.ts tests/agent/sync-provider-readiness-gate.test.ts`
- [ ] Commit:

```powershell
git add tests/agent/sellersprite-mcp-handshake.test.ts tests/agent/remote-mcp-connectors.test.ts tests/agent/connector-resource-governor.test.ts tests/agent/connector-secret-config.test.ts
git commit -m "test: lock MCP execution boundaries"
```

---

### Task 7: Verify once and obtain one limited review

**Files:**
- Modify: `openspec/changes/stabilize-resumable-sync-pipeline/tasks.md`
- Create ignored evidence: `.superpowers/sdd/sellersprite-mcp-handshake-review.md`

**Interfaces:**
- Consumes: exact Task 1–6 diff and affected tests.
- Produces: one evidence entry and one verdict requiring `Critical=0` and direct blockers `=0`.

- [ ] Run the Task 6 GREEN command once; require all pass and `0` skipped.
- [ ] RED gate: any affected test, lint, build, OpenSpec, diff, or WIP-boundary failure stops review; record the first failing command exactly.
- [ ] Run changed-file lint, one build, strict OpenSpec, and diff checks:

```powershell
npx eslint server/connectors/mcp-connectors.ts server/connectors/remote-mcp-connector.ts scripts/lib/sellersprite-mcp-client.mjs tests/agent/helpers/fake-sellersprite-mcp-server.ts tests/agent/sellersprite-sdk-contract.test.ts tests/agent/sellersprite-mcp-handshake.test.ts tests/agent/remote-mcp-connectors.test.ts tests/agent/connector-resource-governor.test.ts tests/agent/connector-secret-config.test.ts tests/agent/connector-probe-service.test.ts tests/agent/sync-provider-readiness-gate.test.ts --quiet
npm run build
npx openspec validate stabilize-resumable-sync-pipeline --strict
git diff --check 3920709446bded497fe1a722db3e742c746c9b73..HEAD
git status --short
git diff --cached --name-only
```

- [ ] Append exact RED/GREEN, SDK version, test/build/OpenSpec results, zero provider/live actions, and WIP boundary to the existing OpenSpec evidence; commit only that file.
- [ ] One independent reviewer checks only SDK gate, handshake/session, list-vs-call, timeout/close, exact governor accounting, safe errors, SIF/Sorftime no-change, and WIP boundary. Minor/non-blocking notes defer.
- [ ] Accept only `Critical=0`, direct blockers `=0`, and `APPROVED FOR CONTROLLED DEPLOYMENT`.
- [ ] GREEN gate: all commands pass and the limited review reports the exact acceptance values.
- [ ] Commit evidence:

```powershell
git add openspec/changes/stabilize-resumable-sync-pipeline/tasks.md
git diff --cached --check
git commit -m "docs: record SellerSprite handshake evidence"
```

---

### Task 8: Deploy safely and submit the saved project once

**Files:**
- Create or append ignored evidence: `.superpowers/sdd/sellersprite-mcp-handshake-deploy.md`
- No production source or business-data edit.

**Interfaces:**
- Consumes: approved exact HEAD; authenticated highest-admin session; saved project `4d49aafa-029d-41b2-a101-c8891048f857` with `B0FN7L65C1`, `B0GZSTTBVW`, `B0GL22N4GY` in US.
- Produces: one deployment, one SellerSprite capability probe, and only after readiness passes, one saved-project submission monitored to terminal.

- [ ] Preflight: active job/stage/attempt `0`, `31900/31901/58258` healthy, `3000` absent, migration `15/15`, fake disabled, exact artifact, WIP 15+4 and index clean.
- [ ] RED gate: any failed preflight, probe, readiness, identity, or single-submit invariant stops immediately without retry or replacement.
- [ ] Deploy Web/Agent with the existing protected runbook; PostgreSQL stays running. Repeat every preflight gate.
- [ ] Run one authenticated SellerSprite capability probe. Require initialize/session plus one list, zero call/ASIN/business writes, and exact governor accounting. Failure stops with no retry or submit.
- [ ] Confirm all required connectors available and active zero; do not re-probe SIF/Sorftime unless their freshness rule requires it.
- [ ] Submit the saved project exactly once, then stop all submission actions. Require one POST/job/canonical run/traffic stage/Worker and no automatic replacement.
- [ ] Monitor by GET/read-only database evidence to terminal. Report per-ASIN modules, PG traffic snapshot, run/stage state, image/gallery state, page refresh visibility, and truthful safe gaps. Never issue a second submission.
- [ ] GREEN gate: exact artifact stays healthy, capability probe passes, one saved-project submission reaches terminal, and all counts/gaps are truthfully recorded. Operational evidence is ignored and is not committed.

---

## Plan Self-Review

- **Coverage:** Tasks 1–8 cover exact SDK, loopback RED, session adapter, deadline/close/error, readiness, execution, governor accounting, regressions, review, deployment, one probe, and one submit.
- **Placeholders:** Paths, signatures, version, commands, project id, market, ASINs, RED/GREEN outcomes, and commits are concrete.
- **Types:** Attempt context reuses `GovernedAttemptKind`, `ResourceGovernor`, `ConnectorRequest.governorScope`, and policy timeout; public result/health contracts stay compatible.
- **Scope:** No migration, UI, ASIN exception, image/traffic/Sorftime change, job-model change, or new OpenSpec change.
- **Boundary:** Only named files may enter commits; protected 15 modified app files and 4 untracked project JSON files remain unstaged.

This plan is ready for a separate implementation session. Do not begin implementation from this documentation-only task.
