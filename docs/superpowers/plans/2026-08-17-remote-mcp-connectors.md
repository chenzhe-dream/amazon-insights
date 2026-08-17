# Remote MCP Connectors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement OpenSpec 11.2 as a bounded server-side MCP connector runtime with three thin adapters, passive persisted health, and an explicit on-demand probe.

**Architecture:** A generic executor owns timeout, one retry, bounded FIFO admission, normalization, source metadata, and fixed safe errors. SIF, Sorftime, and SellerSprite adapters reuse the existing low-level JSON-RPC clients. A probe service is the only caller that persists health into the existing `connector_status` table; Agent Service startup remains passive and capabilities read configured plus last-known state.

**Tech Stack:** TypeScript, Node.js ESM/fetch/AbortController, Fastify, SQLite, Zod, Node test runner, tsx.

## Global Constraints

- Do not make real MCP/model requests, read `.env.local`, or require credentials in tests.
- Do not probe during Agent Service construction/startup and do not let connector health block listening.
- Do not implement DataSnapshot acquisition jobs, Worker integration, distributed limiting, circuit breakers, or 11.3.
- Do not add dependencies or modify `package-lock.json`, migrations `0001`–`0008`, generated VOC, protected runtime WIP, or stash.
- Do not reset, checkout, rebase, amend, stash, clean, push, or start Web/Agent services.

---

### Task 1: Unified connector executor and three adapters

**Files:**
- Create: `server/connectors/connector-contract.ts`
- Create: `server/connectors/mcp-transport.mjs`
- Create: `server/connectors/remote-mcp-connector.ts`
- Create: `server/connectors/mcp-connectors.ts`
- Create: `tests/agent/remote-mcp-connectors.test.ts`
- Modify: `scripts/lib/sif-mcp-client.mjs`
- Modify: `scripts/lib/sorftime-mcp-client.mjs`
- Modify: `scripts/lib/sellersprite-mcp-client.mjs`

**Interfaces:**
- Produces: `ConnectorId`, `ConnectorRequest`, `ConnectorResult`, `ConnectorHealth`, `ConnectorError`, `RemoteMcpConnector`.
- Produces: `createRemoteMcpConnector(options): RemoteMcpConnector` with injected `transport`, `clock`, `sleep`, and policy `{timeoutMs,maxAttempts,retryDelayMs,maxConcurrent,maxQueue}`.
- Produces: `createSifConnector`, `createSorftimeConnector`, `createSellerSpriteConnector`, and `createRemoteMcpConnectors`.
- Preserves existing `callSifTool`, `callSorftimeTool`, and `callSellerSpriteMcpTool` signatures.

- [x] **Step 1: Write RED connector tests**

```ts
test("three adapters normalize data and source metadata", async () => {
  for (const connector of createFakeAdapters()) {
    const result = await connector.execute({ operation: "probe", input: { asin: "B000000000" } });
    assert.deepEqual(result.source, {
      connectorId: connector.id,
      operation: "probe",
      fetchedAt: "2026-08-17T00:00:00.000Z",
      attemptCount: 1,
      protocol: "mcp-json-rpc",
    });
  }
});
```

Add separate tests for malformed output, timeout/abort, transient success on attempt two, exhaustion at two attempts, upstream 429, FIFO queue plus queue-full fail-fast, missing secret zero transport, and sentinel absence from serialized errors/health.

- [x] **Step 2: Verify RED**

Run: `npx tsx --conditions=react-server --test tests/agent/remote-mcp-connectors.test.ts`

Expected: FAIL because `server/connectors/connector-contract.ts` and the connector factories do not exist.

- [x] **Step 3: Implement the minimum executor and transport seams**

```ts
export interface RemoteMcpConnector {
  readonly id: ConnectorId;
  execute(request: ConnectorRequest): Promise<ConnectorResult>;
  probe(): Promise<ConnectorHealth>;
}

export function createRemoteMcpConnector(options: RemoteMcpConnectorOptions): RemoteMcpConnector {
  return Object.freeze({
    id: options.id,
    execute: request => limiter.run(() => executeWithRetry(options, request)),
    probe: () => probeWithSafeHealth(options, limiter),
  });
}
```

Export raw `request*Mcp(method, params, {signal,fetchImpl,...})` seams from the existing clients. The adapters use `tools/call` for `execute` and `tools/list` for `probe`; the executor validates object/array output and never copies raw causes into `ConnectorError`.

- [x] **Step 4: Verify GREEN**

Run: `npx tsx --conditions=react-server --test tests/agent/remote-mcp-connectors.test.ts tests/agent/connector-secret-config.test.ts`

Expected: all tests pass, every transport is fake, and each physical call count is exact.

---

### Task 2: Persisted passive health, explicit probe, and capabilities

**Files:**
- Create: `server/services/connector-probe-service.ts`
- Create: `server/routes/connectors.ts`
- Create: `tests/agent/connector-probe-service.test.ts`
- Modify: `shared/agent-contracts.ts`
- Modify: `server/db/repository.ts`
- Modify: `server/db/sqlite-repository.ts`
- Modify: `server/routes/capabilities.ts`
- Modify: `server/app.ts`
- Modify: `server/agent-service.ts`
- Modify: `tests/agent/capabilities.test.ts`
- Modify: `openspec/changes/build-standalone-agent-workflow/tasks.md`

**Interfaces:**
- Produces repository methods `upsertConnectorStatus`, `findConnectorStatus`, and `listConnectorStatuses` over the existing 0001 table.
- Produces `ConnectorProbeService.getCapabilities()` and `ConnectorProbeService.probe(connectorId)`.
- Produces `POST /v1/connectors/:connectorId/probe` returning the closed `ConnectorHealthSchema`.
- Extends only SIF/Sorftime/SellerSprite capability state with `checkedAt: string | null`.

- [x] **Step 1: Write RED passive-start and probe tests**

```ts
test("Agent Service remains passive until an explicit probe", async () => {
  const service = await createAgentService({ env: fakeEnv, connectors: fakeConnectors });
  assert.equal(transportCalls, 0);
  const before = await service.app.inject({ method: "GET", url: "/v1/capabilities", headers });
  assert.equal(transportCalls, 0);
  const probe = await service.app.inject({ method: "POST", url: "/v1/connectors/sif/probe", headers });
  assert.equal(probe.statusCode, 200);
  assert.equal(transportCalls, 1);
});
```

Also assert missing configuration makes zero calls, fake probe persists a closed row, SQLite reopen returns the same last-known state, probe failures remain sanitized/unavailable, and `/health` stays `200`.

- [x] **Step 2: Verify RED**

Run: `npx tsx --conditions=react-server --test tests/agent/connector-probe-service.test.ts tests/agent/capabilities.test.ts`

Expected: FAIL because repository methods, probe service/route, and `checkedAt` contract do not exist.

- [x] **Step 3: Implement repository, passive capability provider, and route**

```ts
export class ConnectorProbeService {
  async probe(connectorId: ConnectorId): Promise<ConnectorHealth> {
    const health = await this.connectors[connectorId].probe();
    await this.repository.upsertConnectorStatus(toRecord(this.organizationId, health));
    return health;
  }

  async getCapabilities(): Promise<ConnectorCapabilityMap> {
    return combineConfiguredWithLastKnown(this.configured, await this.repository.listConnectorStatuses(this.organizationId));
  }
}
```

Construct the registry and service without calling `probe()`. `buildAgentApp` wires the route and async capability provider. Agent Service `start()` continues to listen regardless of stored unavailable state and performs zero connector transport calls.

- [x] **Step 4: Verify GREEN and regression**

Run: `npx tsx --conditions=react-server --test tests/agent/remote-mcp-connectors.test.ts tests/agent/connector-probe-service.test.ts tests/agent/connector-secret-config.test.ts tests/agent/capabilities.test.ts tests/agent/health.test.ts`

Expected: all focused tests pass with no network.

- [x] **Step 5: Final gates and checkpoint**

Run relevant ESLint on created/modified source and tests; expect zero errors. Run `npx openspec validate build-standalone-agent-workflow --strict`; expect valid. Check only 11.2, leave 11.3 unchecked, stage only task files, run `git diff --cached --check`, and commit with `git commit -m "feat(connectors): add bounded remote MCP runtime"`.

## Self-Review

- Spec coverage: unified contract, three adapters, bounded timeout/retry/rate limiting, normalized metadata, safe errors, explicit health probe, passive startup, persisted last-known status, and closed capabilities are mapped to Tasks 1–2.
- Placeholder scan: no deferred implementation markers or ambiguous fallback behavior.
- Type consistency: connector ids and health/result shapes match the design and remain identical across executor, adapters, repository, route, and capability provider.
