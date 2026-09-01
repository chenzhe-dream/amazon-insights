import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDetachedRunner } from "../../server/services/sync-job-worker-handler";

import { detachedProviderEnvironment } from "../../scripts/lib/provider-network.mjs";
import { asinsForSyncStage } from "../../scripts/run-asin-sync-job.mjs";

const ASIN = "B0TEST0001";
const ORGANIZATION_ID = "dd400000-0000-4000-8000-000000000001";
const JOB_ID = "detached-provider-fixture";
const SECRET_SENTINEL = "unsafe-provider-credential-sentinel";

test("detached sync jobs receive freshly resolved managed connector credentials", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "managed-detached-credential-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runnerPath = join(directory, "managed-environment-check.mjs");
  const outputPath = join(directory, "managed-environment-check.json");
  const fakeManagedSecret = "fake-managed-sif-secret";
  await writeFile(runnerPath, [
    'import { writeFile } from "node:fs/promises";',
    'await writeFile(process.env.OUTPUT_PATH, JSON.stringify({',
    '  matched: process.env.SIF_MCP_SECRET === "fake-managed-sif-secret",',
    '  hasSellerSprite: Boolean(process.env.SELLERSPRITE_SECRET_KEY),',
    '}));',
  ].join("\n"));
  const resolvedOrganizations: string[] = [];
  const runner = createDetachedRunner(process.cwd(), {
    runnerPath,
    environment: { NODE_ENV: "test", OUTPUT_PATH: outputPath, SIF_MCP_SECRET: "stale-environment-secret" },
    async resolveConnectorEnvironment(organizationId) {
      resolvedOrganizations.push(organizationId);
      return { SIF_MCP_SECRET: fakeManagedSecret };
    },
  });

  await runner(fakeLease(), {
    workerId: "managed-credential-worker",
    leaseGeneration: 1,
    mirrorPath: join(directory, "mirror.json"),
    async writeMirror() {},
  });
  assert.deepEqual(resolvedOrganizations, [ORGANIZATION_ID]);
  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), {
    matched: true,
    hasSellerSprite: false,
  });
});

test("detached environment bypasses only an explicit safe OpenAI hostname", () => {
  for (const protocol of ["http", "https"]) {
    const base = {
      HTTPS_PROXY: "http://proxy.example.test:8080",
      NO_PROXY: "localhost,127.0.0.1",
      no_proxy: "internal.example.test",
      OPENAI_BASE_URL: `${protocol}://Relay.Example.Test:8443/gateway/v1?mode=fixture`,
      SELLERSPRITE_MCP_ENDPOINT: "https://seller.example.test/mcp",
      SIF_MCP_ENDPOINT: "https://sif.example.test/mcp",
      SORFTIME_MCP_ENDPOINT: "https://sorftime.example.test/mcp",
    };

    const first = detachedProviderEnvironment(base);
    const second = detachedProviderEnvironment(first);
    for (const name of ["NO_PROXY", "no_proxy"] as const) {
      const entries = (first[name] ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
      assert.deepEqual(entries, ["localhost", "127.0.0.1", "internal.example.test", "relay.example.test"]);
      assert.equal(entries.filter((entry) => entry.toLowerCase() === "relay.example.test").length, 1);
      assert.equal(entries.some((entry) => entry.includes("*")), false);
      assert.equal(entries.some((entry) => /seller|sif|sorftime/i.test(entry)), false);
      assert.equal(second[name], first[name]);
    }
  }

  for (const openAiBaseUrl of [
    undefined,
    " ",
    "not-a-url",
    "ftp://relay.example.test/v1",
    "https://user:unsafe-provider-credential-sentinel@relay.example.test/v1",
    "https://relay.example.test/v1#unsafe-fragment",
  ]) {
    const environment = {
      HTTPS_PROXY: "http://proxy.example.test:8080",
      NO_PROXY: "localhost",
      no_proxy: "internal.example.test",
      ...(openAiBaseUrl === undefined ? {} : { OPENAI_BASE_URL: openAiBaseUrl }),
    };
    const result = detachedProviderEnvironment(environment);
    assert.equal(result.NO_PROXY, environment.NO_PROXY);
    assert.equal(result.no_proxy, environment.no_proxy);
  }
});

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

test("explicit resume detaches providers only for persisted resumable gaps despite stale readiness", async (t) => {
  const statuses = [
    ["B0PENDING01", "pending"],
    ["B0FAILED001", "connector-failed"],
    ["B0TIMEOUT01", "timeout"],
    ["B0EMPTY0001", "upstream-empty"],
    ["B0READY0001", "ready"],
    ["B0MANUAL001", "manual"],
  ] as const;
  const job = {
    resumeStages: ["keywords"],
    asinProgress: Object.fromEntries(statuses.map(([asin, status]) => [asin, {
      keywords: {
        status,
        ...(status === "pending" ? { reason: "LEGACY_UNVERIFIED" } : {}),
        ...(status === "upstream-empty" ? { reason: "PROVIDER_SCHEMA_VALID_EMPTY" } : {}),
      },
    }])),
  };
  const requestedAsins = statuses.map(([asin]) => asin);
  const selected = asinsForSyncStage(job, "keywords", [], requestedAsins);
  const requestCounts = new Map<string, number>();

  for (const asin of requestedAsins) {
    const provider = await fakeProvider("success");
    t.after(provider.close);
    if (selected.includes(asin)) {
      await runFixture(t, "success", provider.endpoint, {}, asin);
    }
    requestCounts.set(asin, provider.requests());
  }

  assert.deepEqual(Object.fromEntries(requestCounts), {
    B0PENDING01: 1,
    B0FAILED001: 1,
    B0TIMEOUT01: 1,
    B0EMPTY0001: 0,
    B0READY0001: 0,
    B0MANUAL001: 0,
  });
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
  asin = ASIN,
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
      FAKE_PROVIDER_ASIN: asin,
      FAKE_PROVIDER_OUTPUT_PATH: outputPath,
      FAKE_PROVIDER_ATTEMPTS_PATH: attemptsPath,
      ...extraEnvironment,
    },
  });
  try {
    await runner(fakeLease(asin), {
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

function fakeLease(asin = ASIN) {
  return {
    leaseGeneration: 1,
    job: {
      jobId: JOB_ID,
      organizationId: ORGANIZATION_ID,
      projectId: null,
      runId: null,
      actorId: null,
      fingerprint: "fixture-fingerprint",
      asins: [asin],
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
        asins: [asin],
      },
    },
  } as never;
}
