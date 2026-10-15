import assert from "node:assert/strict";
import test from "node:test";

import { ConnectorError } from "../../server/connectors/connector-contract";
import {
  createSellerSpriteConnector,
  createSifConnector,
  createSorftimeConnector,
} from "../../server/connectors/mcp-connectors";
import { createRemoteMcpConnector } from "../../server/connectors/remote-mcp-connector";
import { OpenAIProvider } from "../../server/runtime/openai-provider";
import {
  PostgresResourceGovernor,
  ResourceGovernorAdmissionError,
  type AcquirePermitInput,
  type ConcurrencyControlRepository,
  type GovernedAttemptKind,
  type GovernedResource,
  type PhysicalAttemptReceipt,
  type RecordPhysicalAttemptInput,
  type ResourceGovernor,
  type ResourcePermit,
} from "../../server/db/concurrency-control-repository";
import { requestSellerSpriteMcp } from "../../scripts/lib/sellersprite-mcp-client.mjs";
import { requestSifMcp } from "../../scripts/lib/sif-mcp-client.mjs";
import { requestSorftimeMcp } from "../../scripts/lib/sorftime-mcp-client.mjs";
import { governExternalRequest } from "../../scripts/lib/postgres-resource-governor.mjs";
import { runImageRemarkQueue } from "../../scripts/lib/image-remark-queue.mjs";
import { startFakeSellerSpriteMcpServer } from "./helpers/fake-sellersprite-mcp-server";

const organizationId = "cc400000-0000-4000-8000-000000000001";
const safeJobId = "safe-job-1";

test("every SellerSprite SDK HTTP dispatch is governed once", async (t) => {
  const fake = await startFakeSellerSpriteMcpServer();
  const governor = new CapturingGovernor();
  let fetchDispatches = 0;
  t.after(async () => fake.close());

  const connector = createSellerSpriteConnector({
    env: {
      NODE_ENV: "test",
      SELLERSPRITE_SECRET_KEY: "fake-secret",
    },
    fetchImpl: async (_input, init) => {
      fetchDispatches += 1;
      return await fetch(fake.url, init);
    },
    resourceGovernor: governor,
    clock: () => new Date("2026-08-24T00:00:00.000Z"),
    sleep: async () => undefined,
    policy: {
      timeoutMs: 1_000,
      maxAttempts: 1,
      retryDelayMs: 0,
      maxConcurrent: 1,
      maxQueue: 0,
    },
  });

  const result = await connector.execute({
    operation: "review",
    input: { asin: "B000000000" },
    governorScope: { organizationId, jobId: safeJobId },
  });

  assert.deepEqual(result.data, { accepted: true });
  assert.deepEqual(fake.dispatchMethods, ["POST", "POST", "GET", "POST"]);
  assert.equal(fetchDispatches, fake.dispatchMethods.length);
  assert.equal(governor.attempts.length, fetchDispatches);
  assert.deepEqual(governor.attempts.map((attempt) => [
    attempt.resource,
    attempt.attemptKind,
    attempt.jobId,
  ]), Array.from({ length: fetchDispatches }, () => [
    "sellerSprite",
    "initial",
    safeJobId,
  ]));
});

test("SellerSprite failure paths govern exactly the fetches they dispatch", async (t) => {
  const scenarios = [
    {
      mode: "initialize-http-error",
      expectedDispatches: ["POST"],
    },
    {
      mode: "initialized-http-error",
      expectedDispatches: ["POST", "POST"],
    },
    {
      mode: "operation-malformed",
      expectedDispatches: ["POST", "POST", "GET", "POST"],
    },
  ] as const;

  for (const scenario of scenarios) {
    const fake = await startFakeSellerSpriteMcpServer({ mode: scenario.mode });
    const governor = new CapturingGovernor();
    let fetchDispatches = 0;
    t.after(async () => fake.close());
    const connector = createSellerSpriteConnector({
      env: {
        NODE_ENV: "test",
        SELLERSPRITE_MCP_ENDPOINT: fake.url,
        SELLERSPRITE_SECRET_KEY: "fake-secret",
      },
      fetchImpl: async (input, init) => {
        fetchDispatches += 1;
        return await fetch(input, init);
      },
      resourceGovernor: governor,
      policy: {
        timeoutMs: 1_000,
        maxAttempts: 1,
        retryDelayMs: 0,
        maxConcurrent: 1,
        maxQueue: 0,
      },
      clock: () => new Date("2026-08-24T00:00:00.000Z"),
      sleep: async () => undefined,
    });

    await assert.rejects(connector.execute({
      operation: "review",
      input: { asin: "B000000000" },
      governorScope: { organizationId, jobId: safeJobId },
    }), ConnectorError);

    assert.deepEqual(fake.dispatchMethods, scenario.expectedDispatches);
    assert.equal(fetchDispatches, scenario.expectedDispatches.length);
    assert.equal(governor.attempts.length, fetchDispatches);
    assert.equal(governor.attempts.every((attempt) =>
      attempt.resource === "sellerSprite" &&
      attempt.attemptKind === "initial" &&
      attempt.jobId === safeJobId
    ), true);
  }
});

test("SellerSprite retry ownership propagates attempt kind to every dispatch", async (t) => {
  const fake = await startFakeSellerSpriteMcpServer();
  const governor = new CapturingGovernor();
  let fetchDispatches = 0;
  t.after(async () => fake.close());
  const connector = createSellerSpriteConnector({
    env: {
      NODE_ENV: "test",
      SELLERSPRITE_MCP_ENDPOINT: fake.url,
      SELLERSPRITE_SECRET_KEY: "fake-secret",
    },
    fetchImpl: async (input, init) => {
      fetchDispatches += 1;
      if (fetchDispatches === 1) {
        return new Response("temporary-provider-sentinel", { status: 503 });
      }
      return await fetch(input, init);
    },
    resourceGovernor: governor,
    policy: {
      timeoutMs: 1_000,
      maxAttempts: 2,
      retryDelayMs: 0,
      maxConcurrent: 1,
      maxQueue: 0,
    },
    clock: () => new Date("2026-08-24T00:00:00.000Z"),
    sleep: async () => undefined,
  });

  const result = await connector.execute({
    operation: "review",
    input: { asin: "B000000000" },
    governorScope: { organizationId, jobId: safeJobId },
  });

  assert.deepEqual(result.data, { accepted: true });
  assert.equal(result.source.attemptCount, 2);
  assert.equal(fetchDispatches, 5);
  assert.equal(governor.attempts.length, fetchDispatches);
  assert.deepEqual(governor.attempts.map((attempt) => attempt.attemptKind), [
    "initial",
    "retry",
    "retry",
    "retry",
    "retry",
  ]);
});

test("SellerSprite probes govern every dispatch with probe attempt kind", async (t) => {
  const fake = await startFakeSellerSpriteMcpServer();
  const governor = new CapturingGovernor();
  let fetchDispatches = 0;
  t.after(async () => fake.close());
  const connector = createSellerSpriteConnector({
    env: {
      NODE_ENV: "test",
      SELLERSPRITE_MCP_ENDPOINT: fake.url,
      SELLERSPRITE_SECRET_KEY: "fake-secret",
    },
    fetchImpl: async (input, init) => {
      fetchDispatches += 1;
      return await fetch(input, init);
    },
    resourceGovernor: governor,
    policy: {
      timeoutMs: 1_000,
      maxAttempts: 1,
      retryDelayMs: 0,
      maxConcurrent: 1,
      maxQueue: 0,
    },
    clock: () => new Date("2026-08-24T00:00:00.000Z"),
    sleep: async () => undefined,
  });

  const health = await connector.probe({ organizationId, jobId: safeJobId });

  assert.equal(health.available, true);
  assert.equal(fetchDispatches, 4);
  assert.equal(governor.attempts.length, fetchDispatches);
  assert.equal(governor.attempts.every((attempt) =>
    attempt.attemptKind === "probe"
  ), true);
});

test("SellerSprite server execute and probe never use environment governor identity", async () => {
  let governorCalls = 0;
  let fetchDispatches = 0;
  const connector = createSellerSpriteConnector({
    env: {
      AGENT_EXECUTION_ORGANIZATION_ID: "environment-organization-sentinel",
      AGENT_SYNC_JOB_ID: "environment-job-sentinel",
      SELLERSPRITE_SECRET_KEY: "fake-secret",
    },
    fetchImpl: async () => {
      fetchDispatches += 1;
      return new Response("{}");
    },
    resourceGovernor: {
      async run(): Promise<never> {
        governorCalls += 1;
        throw new ResourceGovernorAdmissionError();
      },
    },
    policy: {
      timeoutMs: 1_000,
      maxAttempts: 1,
      retryDelayMs: 0,
      maxConcurrent: 1,
      maxQueue: 0,
    },
    clock: () => new Date("2026-08-24T00:00:00.000Z"),
    sleep: async () => undefined,
  });

  const executeError = await captureConnectorError(connector.execute({
    operation: "review",
    input: {},
  }));
  const health = await connector.probe();

  assert.equal(executeError.code, "local-admission");
  assert.equal(health.available, false);
  assert.equal(governorCalls, 0);
  assert.equal(fetchDispatches, 0);
});

test("standalone SellerSprite helper retains explicit environment governor scope", async (t) => {
  const fake = await startFakeSellerSpriteMcpServer();
  const governor = new CapturingGovernor();
  let fetchDispatches = 0;
  t.after(async () => fake.close());

  await requestSellerSpriteMcp("fake-secret", "tools/list", {}, {
    env: {
      NODE_ENV: "test",
      SELLERSPRITE_MCP_ENDPOINT: fake.url,
      AGENT_EXECUTION_ORGANIZATION_ID: organizationId,
      AGENT_SYNC_JOB_ID: safeJobId,
    },
    resourceGovernor: governor,
    fetchImpl: async (input, init) => {
      fetchDispatches += 1;
      return await fetch(input, init);
    },
  });

  assert.equal(fetchDispatches, 4);
  assert.equal(governor.attempts.length, fetchDispatches);
  assert.equal(governor.attempts.every((attempt) =>
    attempt.jobId === safeJobId
  ), true);
});

test("SellerSprite attempt deadline cancels queued governor admission before retry", async () => {
  const activeAdmissionKinds: GovernedAttemptKind[] = [];
  let retryAdmissionOverlap = false;
  let governorRecords = 0;
  let fetchDispatches = 0;
  const observedSignals: Array<AbortSignal | undefined> = [];
  const governor: ResourceGovernor = {
    async run<T>(input: Omit<Parameters<ResourceGovernor["run"]>[0], "operation"> & {
      readonly signal?: AbortSignal;
      readonly operation: () => Promise<T>;
    }): Promise<T> {
      observedSignals.push(input.signal);
      if (activeAdmissionKinds.some((kind) => kind !== input.attemptKind)) {
        retryAdmissionOverlap = true;
      }
      activeAdmissionKinds.push(input.attemptKind);
      try {
        await cancellableDelay(60, input.signal);
        governorRecords += 1;
        return await input.operation();
      } finally {
        activeAdmissionKinds.splice(
          activeAdmissionKinds.indexOf(input.attemptKind),
          1,
        );
      }
    },
  };
  const connector = createSellerSpriteConnector({
    env: { SELLERSPRITE_SECRET_KEY: "fake-secret" },
    fetchImpl: async () => {
      fetchDispatches += 1;
      return new Response("{}");
    },
    resourceGovernor: governor,
    policy: {
      timeoutMs: 20,
      maxAttempts: 2,
      retryDelayMs: 0,
      maxConcurrent: 1,
      maxQueue: 0,
    },
    clock: () => new Date("2026-08-24T00:00:00.000Z"),
    sleep: async () => undefined,
  });

  const error = await captureConnectorError(connector.execute({
    operation: "review",
    input: {},
    governorScope: { organizationId, jobId: safeJobId },
  }));
  await new Promise(resolve => setTimeout(resolve, 100));

  assert.equal(error.code, "timeout");
  assert.ok(observedSignals.length >= 2);
  assert.equal(observedSignals.every(Boolean), true);
  assert.equal(retryAdmissionOverlap, false);
  assert.equal(governorRecords, 0);
  assert.equal(fetchDispatches, 0);
  assert.equal(governorRecords, fetchDispatches);
});

test("canonical governor cancellation preserves non-aborted behavior and records nothing after abort", async () => {
  const nonAborted = new GovernorTestRepository();
  const normalGovernor = new PostgresResourceGovernor(nonAborted, "normal-owner");
  let normalOperations = 0;
  const normalResult = await normalGovernor.run({
    organizationId,
    resource: "sellerSprite",
    jobId: safeJobId,
    attemptKind: "initial",
    operation: async () => {
      normalOperations += 1;
      return "ok";
    },
  });
  assert.equal(normalResult, "ok");
  assert.deepEqual([
    nonAborted.acquireCalls,
    nonAborted.recordCalls,
    normalOperations,
    nonAborted.releaseCalls,
  ], [1, 1, 1, 1]);

  const preAbortedController = new AbortController();
  preAbortedController.abort();
  const preAborted = new GovernorTestRepository();
  let preAbortedOperations = 0;
  await assert.rejects(
    new PostgresResourceGovernor(preAborted, "pre-aborted-owner").run({
      organizationId,
      resource: "sellerSprite",
      jobId: safeJobId,
      attemptKind: "initial",
      signal: preAbortedController.signal,
      operation: async () => {
        preAbortedOperations += 1;
      },
    }),
    ResourceGovernorAdmissionError,
  );
  assert.deepEqual([
    preAborted.acquireCalls,
    preAborted.recordCalls,
    preAbortedOperations,
    preAborted.releaseCalls,
  ], [0, 0, 0, 0]);

  const queuedController = new AbortController();
  const queued = new GovernorTestRepository({ admissionDelayMs: 60 });
  let queuedOperations = 0;
  const queuedRun = new PostgresResourceGovernor(queued, "queued-owner").run({
    organizationId,
    resource: "sellerSprite",
    jobId: safeJobId,
    attemptKind: "initial",
    signal: queuedController.signal,
    operation: async () => {
      queuedOperations += 1;
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  queuedController.abort();
  await assert.rejects(queuedRun, ResourceGovernorAdmissionError);
  assert.deepEqual([
    queued.recordCalls,
    queuedOperations,
    queued.releaseCalls,
  ], [0, 0, 0]);

  const acquiredController = new AbortController();
  const acquired = new GovernorTestRepository({
    onAcquire: () => acquiredController.abort(),
  });
  let acquiredOperations = 0;
  await assert.rejects(
    new PostgresResourceGovernor(acquired, "acquired-owner").run({
      organizationId,
      resource: "sellerSprite",
      jobId: safeJobId,
      attemptKind: "initial",
      signal: acquiredController.signal,
      operation: async () => {
        acquiredOperations += 1;
      },
    }),
    ResourceGovernorAdmissionError,
  );
  assert.deepEqual([
    acquired.acquireCalls,
    acquired.recordCalls,
    acquiredOperations,
    acquired.releaseCalls,
  ], [1, 0, 0, 1]);
});

test("canonical governor fails closed when exact compensation cannot be proven", async () => {
  for (const cancellation of ["missing", "database-failure"] as const) {
    const controller = new AbortController();
    const repository = new GovernorTestRepository({
      onRecord: () => controller.abort(),
      cancelResult: cancellation === "missing" ? false : undefined,
      cancelError: cancellation === "database-failure"
        ? new Error("raw-database-secret-sentinel")
        : undefined,
    });
    let operations = 0;

    await assert.rejects(
      new PostgresResourceGovernor(repository, `compensation-${cancellation}`).run({
        organizationId,
        resource: "sellerSprite",
        jobId: safeJobId,
        attemptKind: "initial",
        signal: controller.signal,
        operation: async () => {
          operations += 1;
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof ResourceGovernorAdmissionError);
        assert.equal(error.message, "External request capacity is temporarily unavailable");
        assert.doesNotMatch(String(error), /database|secret|sentinel/i);
        return true;
      },
    );
    assert.deepEqual([
      repository.recordCalls,
      repository.cancelCalls,
      operations,
      repository.releaseCalls,
    ], [1, 1, 0, 1]);
  }
});

test("SIF and Sorftime retain one governance record per physical dispatch", async () => {
  const governor = new CapturingGovernor();
  let fetchDispatches = 0;
  const fetchImpl: typeof fetch = async () => {
    fetchDispatches += 1;
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "{\"accepted\":true}" }] },
    }));
  };
  const common = {
    fetchImpl,
    resourceGovernor: governor,
    clock: () => new Date("2026-08-24T00:00:00.000Z"),
    sleep: async () => undefined,
    policy: {
      timeoutMs: 1_000,
      maxAttempts: 1,
      retryDelayMs: 0,
      maxConcurrent: 1,
      maxQueue: 0,
    },
  } as const;
  const sif = createSifConnector({
    ...common,
    env: { NODE_ENV: "test", SIF_MCP_SECRET: "sif-secret" },
  });
  const sorftime = createSorftimeConnector({
    ...common,
    env: { SORFTIME_MCP_KEY: "sorftime-secret" },
  });

  await sif.execute({
    operation: "review",
    input: {},
    governorScope: { organizationId, jobId: safeJobId },
  });
  await sorftime.execute({
    operation: "review",
    input: {},
    governorScope: { organizationId, jobId: safeJobId },
  });

  assert.equal(fetchDispatches, 2);
  assert.deepEqual(governor.attempts.map((attempt) => [
    attempt.resource,
    attempt.attemptKind,
  ]), [
    ["sif", "initial"],
    ["sorftime", "initial"],
  ]);
});

test("parent MCP retries and probes consume separate governed physical attempts", async () => {
  const governor = new CapturingGovernor();
  let calls = 0;
  const connector = createRemoteMcpConnector({
    id: "sellerSprite",
    resourceGovernor: governor,
    resolveCredential: async () => "parent-secret-sentinel",
    transport: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("temporary"), { kind: "http", status: 503 });
      return { accepted: true };
    },
    probeTransport: async () => ({ tools: [] }),
    clock: () => new Date("2026-08-22T04:00:00.000Z"),
    sleep: async () => undefined,
    policy: {
      timeoutMs: 1_000,
      maxAttempts: 2,
      retryDelayMs: 0,
      maxConcurrent: 1,
      maxQueue: 1,
    },
  });

  const result = await connector.execute({
    operation: "review",
    input: {},
    governorScope: { organizationId, jobId: safeJobId },
  });
  assert.deepEqual(result.data, { accepted: true });
  assert.equal(result.source.attemptCount, 2);
  await connector.probe({ organizationId, jobId: safeJobId });

  assert.deepEqual(governor.attempts.map((attempt) => [
    attempt.resource,
    attempt.attemptKind,
    attempt.jobId,
  ]), [
    ["sellerSprite", "initial", safeJobId],
    ["sellerSprite", "retry", safeJobId],
    ["sellerSprite", "probe", safeJobId],
  ]);
});

test("governor admission failure is fail-closed and safe before transport is called", async () => {
  const rawSentinel = "https://provider.example/secret-owner-db-url";
  const connector = createRemoteMcpConnector({
    id: "sif",
    resourceGovernor: new FailingGovernor(rawSentinel),
    resolveCredential: async () => "credential-sentinel",
    transport: async () => {
      assert.fail("transport must not run after governor admission failure");
    },
    probeTransport: async () => {
      assert.fail("probe transport must not run after governor admission failure");
    },
    clock: () => new Date("2026-08-22T04:00:00.000Z"),
    sleep: async () => undefined,
    policy: {
      timeoutMs: 1_000,
      maxAttempts: 1,
      retryDelayMs: 0,
      maxConcurrent: 1,
      maxQueue: 1,
    },
  });

  const error = await captureConnectorError(
    connector.execute({
      operation: "blocked",
      input: {},
      governorScope: { organizationId, jobId: safeJobId },
    }),
  );
  assert.equal(error.code, "local-admission");
  assert.equal(error.retryable, false);
  assert.equal(error.admission?.reason, "unavailable");
  assert.doesNotMatch(JSON.stringify(error), /provider\.example|credential|owner|db-url|secret/i);
});

test("child MCP request paths pass through the resource governor before fetch", async (t) => {
  const governor = new CapturingGovernor();
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
  const fake = await startFakeSellerSpriteMcpServer();
  t.after(async () => fake.close());

  await requestSellerSpriteMcp("seller-secret", "tools/call", {}, {
    fetchImpl: (_input, init) => fetch(fake.url, init),
    resourceGovernor: governor,
    organizationId,
    jobId: safeJobId,
    attemptKind: "initial",
    env: {
      NODE_ENV: "test",
      SELLERSPRITE_MCP_ENDPOINT: fake.url,
    },
  });
  await requestSifMcp("tools/call", {}, {
    env: { NODE_ENV: "test", SIF_MCP_SECRET: "sif-secret" },
    fetchImpl,
    resourceGovernor: governor,
    organizationId,
    jobId: safeJobId,
    attemptKind: "repair",
  });
  await requestSorftimeMcp("sorftime-secret", "tools/call", {}, {
    fetchImpl,
    resourceGovernor: governor,
    organizationId,
    jobId: safeJobId,
    attemptKind: "probe",
  });

  assert.deepEqual(governor.attempts.map((attempt) => [
    attempt.resource,
    attempt.attemptKind,
  ]), [
    ["sellerSprite", "initial"],
    ["sellerSprite", "initial"],
    ["sellerSprite", "initial"],
    ["sellerSprite", "initial"],
    ["sif", "repair"],
    ["sorftime", "probe"],
  ]);
});

test("child MCP calls fail closed without a duplicate physical fetch when governance times out", async () => {
  let fetchCalls = 0;
  await assert.rejects(
    requestSellerSpriteMcp("seller-secret", "tools/call", {}, {
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response("{}");
      },
      resourceGovernor: new FailingGovernor("raw-url-owner-secret"),
      organizationId,
      jobId: safeJobId,
      attemptKind: "initial",
    }),
    ResourceGovernorAdmissionError,
  );
  assert.equal(fetchCalls, 0);
});

test("default child PostgreSQL governor lifecycle closes every owned pool during repeated requests", async () => {
  let createdGovernors = 0;
  let closeCalls = 0;
  let operations = 0;

  const results = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      governExternalRequest({
        requireResourceGovernor: true,
        env: {
          NODE_ENV: "test",
          AGENT_DATABASE_URL: "postgresql://postgres:secret@127.0.0.1:1/app",
        },
        organizationId,
        jobId: safeJobId,
        resource: "sellerSprite",
        attemptKind: "initial",
        createResourceGovernor: () => {
          createdGovernors += 1;
          return {
            async run<T>(input: { operation: () => Promise<T> }) {
              operations += 1;
              return await input.operation();
            },
            async close() {
              closeCalls += 1;
            },
          };
        },
        operation: async () => `ok-${index}`,
      }),
    ),
  );

  assert.deepEqual(results, ["ok-0", "ok-1", "ok-2", "ok-3", "ok-4"]);
  assert.equal(createdGovernors, 5);
  assert.equal(operations, 5);
  assert.equal(closeCalls, 5);
});

test("default child PostgreSQL governor lifecycle closes an owned pool when admission rejects", async () => {
  let closeCalls = 0;

  await assert.rejects(
    governExternalRequest({
      requireResourceGovernor: true,
      env: {
        NODE_ENV: "test",
        AGENT_DATABASE_URL: "postgresql://postgres:secret@127.0.0.1:1/app",
      },
      organizationId: "",
      jobId: safeJobId,
      resource: "sellerSprite",
      attemptKind: "initial",
      createResourceGovernor: () => ({
        async run<T>(input: { operation: () => Promise<T> }) {
          return await input.operation();
        },
        async close() {
          closeCalls += 1;
        },
      }),
      operation: async () => "ok",
    }),
    /capacity is temporarily unavailable/,
  );
  assert.equal(closeCalls, 1);
});

test("OpenAI SDK calls are governed per physical model attempt", async () => {
  const governor = new CapturingGovernor();
  const provider = new OpenAIProvider({
    resourceGovernor: governor,
    client: {
      responses: {
        create: async () => ({
          id: "resp_1",
          status: "completed",
          error: null,
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          output: [
            {
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "{\"ok\":true}" }],
            },
          ],
        }),
      },
      chat: { completions: { create: async () => ({}) } },
    } as never,
  });

  const result = await provider.generateStructured({
    model: "fake-model",
    instructions: "Return JSON",
    input: { asin: "B000000001" },
    maxOutputTokens: 20,
    timeoutMs: 1_000,
    governorScope: {
      organizationId,
      jobId: safeJobId,
      attemptKind: "initial",
    },
    responseFormat: {
      digest: "a".repeat(64),
      format: {
        type: "json_schema",
        name: "Result",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["ok"],
          properties: { ok: { type: "boolean" } },
        },
      },
    },
    outputSchema: {
      safeParse(value: unknown) {
        return { success: true, data: value } as const;
      },
    } as never,
  });

  assert.deepEqual(result.value, { ok: true });
  assert.deepEqual(governor.attempts.map((attempt) => [
    attempt.resource,
    attempt.attemptKind,
  ]), [["model", "initial"]]);
});

test("OpenAI SDK calls fail closed before provider call when governed request scope is missing", async () => {
  let providerCalls = 0;
  const provider = new OpenAIProvider({
    resourceGovernor: new CapturingGovernor(),
    client: {
      responses: {
        create: async () => {
          providerCalls += 1;
          return {};
        },
      },
      chat: { completions: { create: async () => ({}) } },
    } as never,
  });

  await assert.rejects(
    provider.generateStructured({
      model: "fake-model",
      instructions: "Return JSON",
      input: {},
      maxOutputTokens: 20,
      timeoutMs: 1_000,
      responseFormat: {
        digest: "a".repeat(64),
        format: {
          type: "json_schema",
          name: "Result",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["ok"],
            properties: { ok: { type: "boolean" } },
          },
        },
      },
      outputSchema: {
        safeParse(value: unknown) {
          return { success: true, data: value } as const;
        },
      } as never,
    }),
    /capacity is temporarily unavailable/,
  );
  assert.equal(providerCalls, 0);
});

test("image remark workers are governed once per item and timeout does not duplicate work", async () => {
  const governor = new CapturingGovernor();
  let workerCalls = 0;
  const results = await runImageRemarkQueue(["slow"], async (_item: string, { signal }: { signal: AbortSignal }) => {
    workerCalls += 1;
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return { status: "ready", reason: null };
  }, {
    timeoutMs: 5,
    resourceGovernor: governor,
    organizationId,
    jobId: safeJobId,
  });

  assert.equal(workerCalls, 1);
  assert.deepEqual(results, [{ status: "timeout", reason: "图片分析超过 120 秒", attemptJobId: safeJobId }]);
  assert.deepEqual(governor.attempts.map((attempt) => [
    attempt.resource,
    attempt.attemptKind,
  ]), [["image", "initial"]]);
});

class CapturingGovernor implements ResourceGovernor {
  readonly attempts: Array<{
    resource: GovernedResource;
    attemptKind: GovernedAttemptKind | 'transient-retry';
    jobId: string;
  }> = [];

  async run<T>(input: {
    resource: GovernedResource;
    attemptKind: GovernedAttemptKind | 'transient-retry';
    organizationId: string;
    jobId: string;
    operation: () => Promise<T>;
  }): Promise<T> {
    assert.equal(input.organizationId, organizationId);
    this.attempts.push({
      resource: input.resource,
      attemptKind: input.attemptKind,
      jobId: input.jobId,
    });
    return await input.operation();
  }
}

class FailingGovernor implements ResourceGovernor {
  constructor(private readonly rawMessage: string) {}

  async run(): Promise<never> {
    throw new ResourceGovernorAdmissionError({ cause: new Error(this.rawMessage) });
  }
}

class GovernorTestRepository implements ConcurrencyControlRepository {
  acquireCalls = 0;
  recordCalls = 0;
  cancelCalls = 0;
  releaseCalls = 0;

  constructor(private readonly options: Readonly<{
    admissionDelayMs?: number;
    onAcquire?: () => void;
    onRecord?: () => void;
    cancelResult?: boolean;
    cancelError?: Error;
  }> = {}) {}

  getEffectivePolicy(): Promise<never> {
    throw new Error("not used");
  }

  async acquirePermit(input: AcquirePermitInput): Promise<ResourcePermit> {
    this.acquireCalls += 1;
    if (this.options.admissionDelayMs) {
      await cancellableDelay(
        this.options.admissionDelayMs,
        (input as AcquirePermitInput & { signal?: AbortSignal }).signal,
      );
    }
    this.options.onAcquire?.();
    return Object.freeze({
      permitId: "permit-1",
      organizationId: input.organizationId,
      resource: input.resource,
      jobId: input.jobId,
      attemptKind: input.attemptKind,
      ownerId: input.ownerId,
      leaseGeneration: 1,
      policyVersion: "standard-v1",
      acquiredAt: "2026-08-24T00:00:00.000Z",
      leaseExpiresAt: "2026-08-24T00:01:00.000Z",
    });
  }

  heartbeatPermit(): Promise<boolean> {
    throw new Error("not used");
  }

  async releasePermit(): Promise<boolean> {
    this.releaseCalls += 1;
    return true;
  }

  async recordPhysicalAttempt(
    input: RecordPhysicalAttemptInput,
  ): Promise<PhysicalAttemptReceipt> {
    this.recordCalls += 1;
    this.options.onRecord?.();
    return Object.freeze({
      attemptId: "1",
      organizationId: input.organizationId,
      resource: input.resource,
      jobId: input.jobId,
      attemptKind: input.attemptKind,
      policyVersion: "standard-v1",
      recordedAt: "2026-08-24T00:00:00.000Z",
    });
  }

  async cancelUndispatchedPhysicalAttempt(): Promise<boolean> {
    this.cancelCalls += 1;
    if (this.options.cancelError) throw this.options.cancelError;
    return this.options.cancelResult ?? true;
  }
}

async function cancellableDelay(
  durationMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new ResourceGovernorAdmissionError();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, durationMs);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(new ResourceGovernorAdmissionError());
    }, { once: true });
  });
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
