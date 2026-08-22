import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDetachedRunner } from "../../server/services/sync-job-worker-handler";

const ASIN = "B0TEST0001";
const ORGANIZATION_ID = "dd400000-0000-4000-8000-000000000001";
const JOB_ID = "detached-provider-fixture";
const SECRET_SENTINEL = "unsafe-provider-credential-sentinel";

test("detached runner reaches a loopback provider, records one physical attempt, persists, and becomes ready", async (t) => {
  const provider = await fakeProvider("success");
  t.after(provider.close);
  const result = await runFixture(t, "success", provider.endpoint);

  assert.equal(provider.requests(), 1);
  assert.deepEqual(result.persisted, {
    asin: ASIN,
    status: "ready",
    persisted: true,
    readiness: "ready",
  });
  assert.equal(result.attempts.length, 1);
  assert.deepEqual(result.mirror.diagnostics, []);
});

test("only a schema-valid empty provider result is upstream-empty", async (t) => {
  const provider = await fakeProvider("empty");
  t.after(provider.close);
  const result = await runFixture(t, "empty", provider.endpoint);

  assert.equal(provider.requests(), 1);
  assert.equal(result.persisted.status, "upstream-empty");
  assert.equal(result.persisted.readiness, "upstream-empty");
  assert.deepEqual(result.mirror.diagnostics, []);
});

test("detached runner applies proxy, CA, DNS and dispatcher configuration at one child boundary", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "detached-network-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const caPath = join(directory, "fixture-ca.pem");
  await writeFile(caPath, "", "utf8");
  const result = await runFixture(t, "network", "http://127.0.0.1:1/mcp", {
    HTTP_PROXY: "http://proxy-user:proxy-secret@127.0.0.1:9",
    NODE_EXTRA_CA_CERTS: caPath,
    AGENT_PROVIDER_DNS_RESULT_ORDER: "ipv4first",
  });

  assert.deepEqual(result.persisted, {
    proxyEnabled: true,
    dispatcher: "env-proxy",
    customCaPresent: true,
    dnsResultOrder: "ipv4first",
  });
  assert.doesNotMatch(JSON.stringify(result.mirror), /proxy-user|proxy-secret|fixture-ca/i);
});

test("a degraded connector stops subsequent automatic requests without fake or cache fallback", async (t) => {
  const provider = await fakeProvider("success");
  t.after(provider.close);
  const result = await runFixture(t, "degraded", provider.endpoint);

  assert.equal(result.persisted.status, "connector-failed");
  assert.equal(result.persisted.secondFetchCalls, 0);
  assert.equal(result.attempts.length, 1);
  assert.deepEqual(result.mirror.diagnostics.map((entry: Record<string, unknown>) => entry.failureKind), [
    "dns",
    "provider-degraded",
  ]);
});

for (const expected of [
  ["dns", "dns", "DNS_NOT_FOUND"],
  ["oversized-dns", "dns", "DNS_NOT_FOUND"],
  ["tls", "tls", "TLS_CERTIFICATE"],
  ["timeout", "timeout", "CONNECT_TIMEOUT"],
  ["governor", "governor", "RESOURCE_GOVERNOR"],
  ["http", "http", "HTTP_5XX"],
  ["rpc", "rpc", "MCP_RPC"],
  ["schema", "schema", "MCP_SCHEMA"],
] as const) {
  const [mode, failureKind, causeCode] = expected;
  test(`detached runner preserves safe ${mode} diagnostics instead of upstream-empty`, async (t) => {
    const provider = await fakeProvider(mode);
    t.after(provider.close);
    const result = await runFixture(t, mode, provider.endpoint);

    assert.equal(result.persisted.status, failureKind === "timeout" ? "timeout" : "connector-failed");
    assert.notEqual(result.persisted.readiness, "upstream-empty");
    assert.deepEqual(result.mirror.diagnostics, [{
      connector: "sif",
      stage: "keywords",
      asin: ASIN,
      failureKind,
      causeCode,
    }]);
    const serialized = JSON.stringify({ mirror: result.mirror, error: result.error });
    assert.doesNotMatch(serialized, /unsafe-provider|credential-sentinel|authorization|secret|https?:\/\//i);
    assert.ok(serialized.length < 4_096, "diagnostics must remain bounded");
  });
}

async function runFixture(
  t: test.TestContext,
  mode: string,
  endpoint: string,
  extraEnvironment: Record<string, string> = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "detached-provider-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "persisted.json");
  const attemptsPath = join(directory, "attempts.jsonl");
  const mirrorPath = join(directory, "mirror.json");
  const mirror: Record<string, unknown> = {};
  let error: string | null = null;
  const runner = createDetachedRunner(process.cwd(), {
    runnerPath: join(process.cwd(), "tests", "fixtures", "sync", "fake-detached-provider-runner.mjs"),
    environment: {
      NODE_ENV: "test",
      SIF_MCP_SECRET: SECRET_SENTINEL,
      SIF_MCP_ENDPOINT: endpoint,
      AGENT_SYNC_STAGE_ID: "keywords",
      FAKE_PROVIDER_MODE: mode,
      FAKE_PROVIDER_ASIN: ASIN,
      FAKE_PROVIDER_OUTPUT_PATH: outputPath,
      FAKE_PROVIDER_ATTEMPTS_PATH: attemptsPath,
      ...extraEnvironment,
    },
  });
  try {
    await runner(fakeLease(), {
      workerId: "fixture-worker",
      leaseGeneration: 1,
      mirrorPath,
      async writeMirror(patch) {
        Object.assign(mirror, patch);
      },
    });
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const persisted = JSON.parse(await readFile(outputPath, "utf8"));
  const attempts = await readFile(attemptsPath, "utf8")
    .then((source) => source.trim() ? source.trim().split("\n").map((line) => JSON.parse(line)) : [])
    .catch(() => []);
  return { persisted, attempts, mirror, error };
}

async function fakeProvider(mode: string) {
  let count = 0;
  const server = createServer(async (_request, response) => {
    count += 1;
    if (mode === "http") {
      response.writeHead(503, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    const payload = mode === "rpc"
      ? { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "unsafe provider error" } }
      : mode === "schema"
        ? { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "not-json" }] } }
        : {
            jsonrpc: "2.0",
            id: 1,
            result: {
              content: [{
                type: "text",
                text: JSON.stringify({ items: mode === "empty" ? [] : [{ asin: ASIN }] }),
              }],
            },
          };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    endpoint: `http://127.0.0.1:${address.port}/mcp`,
    requests: () => count,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function fakeLease() {
  return {
    leaseGeneration: 1,
    job: {
      jobId: JOB_ID,
      organizationId: ORGANIZATION_ID,
      projectId: null,
      runId: null,
      actorId: null,
      fingerprint: "fixture-fingerprint",
      asins: [ASIN],
      marketplace: "US",
      status: "running",
      message: "running",
      currentStageId: "keywords",
      stages: [],
      asinProgress: {},
      leasedBy: "fixture-worker",
      leaseGeneration: 1,
      leaseExpiresAt: null,
      error: null,
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
      scope: {
        organizationId: ORGANIZATION_ID,
        projectId: null,
        runId: null,
        marketplace: "US",
        asins: [ASIN],
      },
    },
  } as never;
}
