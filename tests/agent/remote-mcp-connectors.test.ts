import assert from "node:assert/strict";
import test from "node:test";

import {
  ConnectorError,
  type ConnectorRequest,
} from "../../server/connectors/connector-contract";
import { createRemoteMcpConnector } from "../../server/connectors/remote-mcp-connector";
import {
  createRemoteMcpConnectors,
  type McpConnectorDependencies,
} from "../../server/connectors/mcp-connectors";

const checkedAt = "2026-08-17T00:00:00.000Z";
const secrets = {
  SIF_MCP_SECRET: "sif-secret-sentinel",
  SORFTIME_MCP_KEY: "sorftime-secret-sentinel",
  SELLERSPRITE_SECRET_KEY: "seller-secret-sentinel",
};
const immediatePolicy = {
  timeoutMs: 100,
  maxAttempts: 2,
  retryDelayMs: 0,
  maxConcurrent: 1,
  maxQueue: 1,
} as const;

function jsonRpcResponse(
  data: Readonly<Record<string, unknown>> = { accepted: true },
  status = 200,
) {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: JSON.stringify(data) }] },
    }),
    { status },
  );
}

function adapterDependencies(
  fetchImpl: typeof fetch,
): McpConnectorDependencies {
  return {
    env: secrets,
    fetchImpl,
    clock: () => new Date(checkedAt),
    sleep: async () => undefined,
    policy: immediatePolicy,
  };
}

async function captureConnectorError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ConnectorError);
    return error;
  }
  assert.fail("Expected connector call to fail");
}

test("all three MCP adapters return normalized data and non-secret source metadata", async () => {
  const methods: string[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { method: string };
    methods.push(body.method);
    return jsonRpcResponse();
  };
  const connectors = createRemoteMcpConnectors(adapterDependencies(fetchImpl));

  for (const connector of Object.values(connectors)) {
    const result = await connector.execute({
      operation: "probe-operation",
      input: { asin: "B000000000" },
    });
    assert.deepEqual(result.data, { accepted: true });
    assert.deepEqual(result.source, {
      connectorId: connector.id,
      operation: "probe-operation",
      fetchedAt: checkedAt,
      attemptCount: 1,
    });
    assert.deepEqual(Object.keys(result.source).sort(), [
      "attemptCount",
      "connectorId",
      "fetchedAt",
      "operation",
    ]);
    assert.doesNotMatch(
      JSON.stringify(result),
      /secret-sentinel|mcp\.sif|mcp\.sorftime|mcp\.sellersprite/i,
    );
  }
  assert.deepEqual(methods, ["tools/call", "tools/call", "tools/call"]);
});

test("health probes use tools/list and missing configuration never calls transport", async () => {
  const methods: string[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { method: string };
    methods.push(body.method);
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }),
      { status: 200 },
    );
  };
  const configured = createRemoteMcpConnectors(adapterDependencies(fetchImpl));
  assert.deepEqual(await configured.sif.probe(), {
    connectorId: "sif",
    configured: true,
    available: true,
    reason: null,
    checkedAt,
  });
  assert.deepEqual(methods, ["tools/list"]);

  let missingTransportCalls = 0;
  const missing = createRemoteMcpConnectors({
    ...adapterDependencies(async () => {
      missingTransportCalls += 1;
      return jsonRpcResponse();
    }),
    env: {},
  });
  const error = await captureConnectorError(
    missing.sorftime.execute({ operation: "probe", input: {} }),
  );
  assert.equal(error.code, "configuration");
  assert.equal(error.retryable, false);
  assert.deepEqual(await missing.sorftime.probe(), {
    connectorId: "sorftime",
    configured: false,
    available: false,
    reason: "Sorftime connector credential is not configured",
    checkedAt,
  });
  assert.equal(missingTransportCalls, 0);
});

test("malformed responses and raw upstream details are replaced by fixed safe errors", async () => {
  const rawSentinel = "raw-response-secret-sentinel";
  const connectors = createRemoteMcpConnectors(
    adapterDependencies(async () => new Response(rawSentinel, { status: 200 })),
  );

  const error = await captureConnectorError(
    connectors.sellerSprite.execute({ operation: "review", input: {} }),
  );
  assert.equal(error.code, "malformed-response");
  assert.equal(error.retryable, false);
  const serialized = JSON.stringify({
    name: error.name,
    code: error.code,
    message: error.message,
    connectorId: error.connectorId,
    retryable: error.retryable,
  });
  assert.doesNotMatch(serialized, /raw-response|secret-sentinel|https?:|header/i);
});

test("each execute and probe resolves the current credential and rejects credential-bearing responses", async () => {
  let credential = "dynamic-sentinel-A";
  const seen: string[] = [];
  let leak = false;
  const connector = createRemoteMcpConnector({
    id: "sif",
    resolveCredential: async () => credential,
    transport: async (_request, _signal, currentCredential) => {
      seen.push(currentCredential);
      return leak
        ? { nested: ["safe", `reflected:${currentCredential}:value`] }
        : { accepted: true };
    },
    probeTransport: async (_signal, currentCredential) => {
      seen.push(currentCredential);
      return { tools: [] };
    },
    clock: () => new Date(checkedAt),
    sleep: async () => undefined,
    policy: { ...immediatePolicy, maxAttempts: 1 },
  });

  await connector.execute({ operation: "first", input: {} });
  credential = "dynamic-sentinel-B";
  assert.equal((await connector.probe()).available, true);
  assert.deepEqual(seen, ["dynamic-sentinel-A", "dynamic-sentinel-B"]);

  leak = true;
  const error = await captureConnectorError(
    connector.execute({ operation: "leak", input: {} }),
  );
  assert.equal(error.code, "malformed-response");
  assert.equal(error.retryable, false);
  assert.doesNotMatch(error.message, /dynamic|sentinel|reflected/i);
});

test("transient and upstream rate-limit failures retry once and then succeed", async () => {
  for (const firstStatus of [503, 429]) {
    let calls = 0;
    const connectors = createRemoteMcpConnectors(
      adapterDependencies(async () => {
        calls += 1;
        return calls === 1
          ? new Response("upstream-secret-sentinel", { status: firstStatus })
          : jsonRpcResponse({ recovered: true });
      }),
    );
    const result = await connectors.sif.execute({ operation: "recover", input: {} });
    assert.deepEqual(result.data, { recovered: true });
    assert.equal(result.source.attemptCount, 2);
    assert.equal(calls, 2);
  }
});

test("retry exhaustion is bounded to two physical attempts", async () => {
  let calls = 0;
  const connectors = createRemoteMcpConnectors(
    adapterDependencies(async () => {
      calls += 1;
      return new Response("upstream-secret-sentinel", { status: 503 });
    }),
  );
  const error = await captureConnectorError(
    connectors.sif.execute({ operation: "exhaust", input: {} }),
  );
  assert.equal(error.code, "upstream-temporary");
  assert.equal(error.retryable, true);
  assert.equal(calls, 2);
  assert.doesNotMatch(error.message, /secret-sentinel/);
});

test("attempt timeout aborts transport and remains bounded", async () => {
  let calls = 0;
  const connectors = createRemoteMcpConnectors({
    ...adapterDependencies(async (_input, init) => {
      calls += 1;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
          once: true,
        });
      });
    }),
    policy: { ...immediatePolicy, timeoutMs: 5 },
  });

  const error = await captureConnectorError(
    connectors.sorftime.execute({ operation: "timeout", input: {} }),
  );
  assert.equal(error.code, "timeout");
  assert.equal(error.retryable, true);
  assert.equal(calls, 2);
});

test("bounded admission queues one call FIFO and fails fast when the queue is full", async () => {
  const entered: number[] = [];
  const releases: Array<() => void> = [];
  const connector = createRemoteMcpConnector({
    id: "sif",
    resolveCredential: async () => "queue-test-credential",
    transport: async (request: ConnectorRequest) => {
      const sequence = Number(request.input.sequence);
      entered.push(sequence);
      await new Promise<void>((resolve) => releases.push(resolve));
      return { sequence };
    },
    probeTransport: async () => ({ tools: [] }),
    clock: () => new Date(checkedAt),
    sleep: async () => undefined,
    policy: { ...immediatePolicy, maxAttempts: 1 },
  });

  const first = connector.execute({ operation: "queue", input: { sequence: 1 } });
  await new Promise(resolve => setImmediate(resolve));
  const second = connector.execute({ operation: "queue", input: { sequence: 2 } });
  const thirdError = await captureConnectorError(
    connector.execute({ operation: "queue", input: { sequence: 3 } }),
  );
  assert.equal(thirdError.code, "rate-limit");
  assert.equal(thirdError.retryable, true);
  assert.deepEqual(entered, [1]);

  releases.shift()?.();
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(entered, [1, 2]);
  releases.shift()?.();
  await second;
});
