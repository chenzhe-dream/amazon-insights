import assert from "node:assert/strict";
import test from "node:test";

import { ConnectorError } from "../../server/connectors/connector-contract";
import { createRemoteMcpConnector } from "../../server/connectors/remote-mcp-connector";
import { OpenAIProvider } from "../../server/runtime/openai-provider";
import {
  ResourceGovernorAdmissionError,
  type GovernedAttemptKind,
  type GovernedResource,
  type ResourceGovernor,
} from "../../server/db/concurrency-control-repository";
import { requestSellerSpriteMcp } from "../../scripts/lib/sellersprite-mcp-client.mjs";
import { requestSifMcp } from "../../scripts/lib/sif-mcp-client.mjs";
import { requestSorftimeMcp } from "../../scripts/lib/sorftime-mcp-client.mjs";
import { governExternalRequest } from "../../scripts/lib/postgres-resource-governor.mjs";
import { runImageRemarkQueue } from "../../scripts/lib/image-remark-queue.mjs";

const organizationId = "cc400000-0000-4000-8000-000000000001";
const safeJobId = "safe-job-1";

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
  assert.equal(error.code, "rate-limit");
  assert.equal(error.retryable, true);
  assert.doesNotMatch(JSON.stringify(error), /provider\.example|credential|owner|db-url|secret/i);
});

test("child MCP request paths pass through the resource governor before fetch", async () => {
  const governor = new CapturingGovernor();
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));

  await requestSellerSpriteMcp("seller-secret", "tools/call", {}, {
    fetchImpl,
    resourceGovernor: governor,
    organizationId,
    jobId: safeJobId,
    attemptKind: "initial",
  });
  await requestSifMcp("tools/call", {}, {
    env: { SIF_MCP_SECRET: "sif-secret" },
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
      type: "json_schema",
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
        type: "json_schema",
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
  const results = await runImageRemarkQueue(["slow"], async (_item, { signal }) => {
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
  assert.deepEqual(results, [{ status: "timeout", reason: "图片分析超过 90 秒" }]);
  assert.deepEqual(governor.attempts.map((attempt) => [
    attempt.resource,
    attempt.attemptKind,
  ]), [["image", "initial"]]);
});

class CapturingGovernor implements ResourceGovernor {
  readonly attempts: Array<{
    resource: GovernedResource;
    attemptKind: GovernedAttemptKind;
    jobId: string;
  }> = [];

  async run<T>(input: {
    resource: GovernedResource;
    attemptKind: GovernedAttemptKind;
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

async function captureConnectorError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ConnectorError);
    return error;
  }
  assert.fail("Expected connector call to fail");
}
