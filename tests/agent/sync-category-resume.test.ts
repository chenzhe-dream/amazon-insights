import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import * as categoryBuilder from "../../scripts/build-sorftime-category-trend.mjs";
import { callSorftimeTool } from "../../scripts/lib/sorftime-mcp-client.mjs";

const { collectSorftimeCategoryRecords } = categoryBuilder;

const categoryEnv = {
  NODE_ENV: "test",
  AGENT_SYNC_STAGE_ID: "category",
  SORFTIME_MCP_ENDPOINT: "http://127.0.0.1:1/mcp",
};

afterEach(() => {
  process.exitCode = undefined;
});

test("missing node_id is isolated and a later ASIN still becomes ready", async () => {
  const calls: Array<{ asin: string; tool: string }> = [];
  const result = await collectSorftimeCategoryRecords({
    key: "fixture-key",
    jobId: "category-resume-fixture",
    marketplace: "US",
    catalog: [
      { asin: "B074QLWRDQ", subRankCategory: "Do not infer this" },
      { asin: "B0BTM28F9N", subRankCategory: "Fixture category" },
    ],
    existing: {},
    fetchedAt: "2026-09-02",
    callTool: async (_key: string, tool: string, args: Record<string, unknown>) => {
      const asin = String(args.asin ?? "B0BTM28F9N");
      calls.push({ asin, tool });
      if (tool === "product_detail" && asin === "B074QLWRDQ") return { data: {} };
      if (tool === "product_detail") return { data: { node_id: "123456789", subcategory: "Fixture category" } };
      return { data: ["2026-08=10"] };
    },
    wait: async () => {},
  });

  assert.equal(result.records["123456789"].status, "ready");
  const failed = Object.values(result.records).find(record => typeof record === "object" && record !== null && "sourceAsin" in record && record.sourceAsin === "B074QLWRDQ");
  assert.ok(failed && typeof failed === "object" && "nodeId" in failed && "status" in failed && "statusMessage" in failed);
  assert.equal(failed.nodeId, "");
  assert.equal(failed?.status, "error");
  assert.equal(failed?.statusMessage, "MCP_SCHEMA");
  assert.deepEqual(result.diagnostics, [{
    connector: "sorftime",
    stage: "category",
    asin: "B074QLWRDQ",
    failureKind: "schema",
    causeCode: "MCP_SCHEMA",
    operation: "product_detail",
    boundary: "consumer-shape",
  }]);
  assert.equal(calls.some(item => item.asin === "B0BTM28F9N" && item.tool === "category_trend"), true);
});

test("one failed node emits one bounded diagnostic per ASIN and does not abort a later node", async () => {
  const result = await collectMixedNodeFixture();

  assert.equal(result.records["111111111"].status, "error");
  assert.equal(result.records["111111111"].statusMessage, "CONNECT_TIMEOUT");
  assert.equal(result.records["222222222"].status, "ready");
  assert.deepEqual(result.diagnostics.map(item => [item.asin, item.failureKind, item.causeCode]), [
    ["B074QLWRDQ", "timeout", "CONNECT_TIMEOUT"],
    ["B096LRXPBW", "timeout", "CONNECT_TIMEOUT"],
  ]);
  assert.equal(result.categoryDispatchesByNode["111111111"], 2);
  assert.equal(result.categoryDispatchesByNode["222222222"], 5);
  assert.equal(result.governedDispatches, 10);
});

test("repair settlement retains one transient retry with one logical operation", async () => {
  const result = await collectMixedNodeFixture("repair");

  assert.deepEqual(result.failedNodeAttempts.map(item => item.attemptKind), ["repair", "transient-retry"]);
  assert.equal(new Set(result.failedNodeAttempts.map(item => item.logicalOperationKey)).size, 1);
  assert.equal(new Set(result.failedNodeAttempts.map(item => item.dispatchKey)).size, 2);
});

test("a successful empty trend uses the existing empty schema without an error diagnostic", async () => {
  const result = await collectSorftimeCategoryRecords({
    key: "fixture-key",
    jobId: "category-resume-fixture",
    marketplace: "US",
    catalog: [{ asin: "B0BTM28F9N", subRankCategory: "Fixture category" }],
    existing: {},
    fetchedAt: "2026-09-02",
    callTool: async (_key: string, tool: string) => tool === "product_detail"
      ? { data: { node_id: "123456789", subcategory: "Fixture category" } }
      : { data: [] },
    wait: async () => {},
  });

  assert.equal(result.records["123456789"].status, "empty");
  assert.equal(result.records["123456789"].statusMessage, "UPSTREAM_EMPTY");
  assert.deepEqual(result.records["123456789"].volume, []);
  assert.deepEqual(result.diagnostics, []);
});

test("full-catalog CLI writes current settlements before emitting each ASIN diagnostic once", async () => {
  assert.equal(typeof categoryBuilder.runSorftimeCategoryCli, "function");
  const events: string[] = [];
  let written = "";
  let governedDispatches = 0;
  const categoryDispatchesByNode: Record<string, number> = {};
  const resourceGovernor = {
    async run(input: { operation(): Promise<Response> }) {
      governedDispatches += 1;
      return await input.operation();
    },
  };
  const fetchImpl = async (_input: URL | RequestInfo, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const tool = String(body.params.name);
    const args = body.params.arguments ?? {};
    if (tool === "product_detail") {
      if (args.asin === "B074QLWRDQ") return mcpResponse({ data: {} });
      const nodeId = args.asin === "B0BTM28F9N" ? "222222222" : "111111111";
      return mcpResponse({ data: { node_id: nodeId, subcategory: `Fixture ${nodeId}` } });
    }
    const nodeId = String(args.node_id);
    categoryDispatchesByNode[nodeId] = (categoryDispatchesByNode[nodeId] ?? 0) + 1;
    if (nodeId === "111111111") throw providerFailure("UND_ERR_CONNECT_TIMEOUT");
    return mcpResponse({ data: ["2026-08=10"] });
  };
  const providerCall = (
    key: string,
    tool: string,
    args: Record<string, unknown>,
    options: Record<string, unknown> = {},
  ) => {
    const jobId = "cli-category-shared-job";
    return callSorftimeTool(key, tool, args, {
      ...options,
      env: { ...categoryEnv, AGENT_SYNC_JOB_ID: jobId },
      organizationId: "cli-category-organization",
      jobId,
      resourceGovernor,
      fetchImpl,
    });
  };

  const providerStderr: string[] = [];
  const originalStderrWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    providerStderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  let cliResult;
  try {
    cliResult = await categoryBuilder.runSorftimeCategoryCli({
      key: "fixture-key",
    jobId: "category-resume-fixture",
      marketplace: "US",
      asinFilter: null,
      catalog: [
        { asin: "B074QLWRDQ", subRankCategory: "Do not infer this" },
        { asin: "B096LRXPBW", subRankCategory: "Fixture category" },
        { asin: "B0TEST0001", subRankCategory: "Fixture category" },
        { asin: "B0BTM28F9N", subRankCategory: "Later category" },
      ],
      existing: { "asin-error:B0STALE001": { status: "error" } },
      fetchedAt: "2026-09-02",
      providerCall,
      wait: async () => {},
      writeFileSync: (_path: string, body: string) => {
        assert.equal(process.exitCode, undefined);
        events.push("write");
        written = body;
      },
      stderrWrite: (line: string) => events.push(`diagnostic:${line}`),
    });
  } finally {
    process.stderr.write = originalStderrWrite;
  }

  assert.match(written, /"asin-error:B074QLWRDQ"/);
  assert.ok(cliResult);
  assert.equal(cliResult.records["222222222"].status, "ready");
  assert.doesNotMatch(written, /B0STALE001/);
  assert.deepEqual(events.map(event => event.startsWith("diagnostic:") ? "diagnostic" : event), [
    "write", "diagnostic", "diagnostic", "diagnostic",
  ]);
  const diagnostics = events.slice(1).map(event => JSON.parse(event.slice(event.indexOf("{") )));
  assert.deepEqual(diagnostics.map(item => item.asin), ["B074QLWRDQ", "B096LRXPBW", "B0TEST0001"]);
  assert.equal(diagnostics.some(item => item.asin === "UNKNOWNASIN"), false);
  assert.equal(categoryDispatchesByNode["111111111"], 2);
  assert.equal(categoryDispatchesByNode["222222222"], 5);
  assert.equal(governedDispatches, 11);
  assert.deepEqual(providerStderr, []);
  assert.equal(process.exitCode, 1);
});

async function collectMixedNodeFixture(firstAttemptKind: "initial" | "repair" = "initial") {
  const categoryDispatchesByNode: Record<string, number> = {};
  const attempts: Array<{ attemptKind: string; logicalOperationKey: string; dispatchKey: string }> = [];
  const resourceGovernor = {
    async run(input: {
      attemptKind: string;
      logicalOperationKey: string;
      dispatchKey: string;
      operation(): Promise<Response>;
    }) {
      attempts.push({
        attemptKind: input.attemptKind,
        logicalOperationKey: input.logicalOperationKey,
        dispatchKey: input.dispatchKey,
      });
      return await input.operation();
    },
  };
  const fetchImpl = async (_input: URL | RequestInfo, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const tool = String(body.params.name);
    const args = body.params.arguments ?? {};
    if (tool === "product_detail") {
      const nodeId = args.asin === "B0BTM28F9N" ? "222222222" : "111111111";
      return mcpResponse({ data: { node_id: nodeId, subcategory: `Fixture ${nodeId}` } });
    }
    const nodeId = String(args.node_id);
    categoryDispatchesByNode[nodeId] = (categoryDispatchesByNode[nodeId] ?? 0) + 1;
    if (nodeId === "111111111") throw providerFailure("UND_ERR_CONNECT_TIMEOUT");
    return mcpResponse({ data: ["2026-08=10"] });
  };
  const providerCall = (
    key: string,
    tool: string,
    args: Record<string, unknown>,
    options: Record<string, unknown> = {},
  ) => {
    const jobId = `mixed-category-${firstAttemptKind}-shared-job`;
    return callSorftimeTool(key, tool, args, {
      ...options,
      env: {
        ...categoryEnv,
        AGENT_SYNC_JOB_ID: jobId,
        AGENT_RESOURCE_ATTEMPT_KIND: firstAttemptKind,
      },
      organizationId: "mixed-category-organization",
      jobId,
      resourceGovernor,
      fetchImpl,
    });
  };
  const result = await collectSorftimeCategoryRecords({
    key: "fixture-key",
    jobId: "category-resume-fixture",
    marketplace: "US",
    catalog: [
      { asin: "B074QLWRDQ", subRankCategory: "Fixture category" },
      { asin: "B096LRXPBW", subRankCategory: "Fixture category" },
      { asin: "B0BTM28F9N", subRankCategory: "Later category" },
    ],
    existing: {},
    fetchedAt: "2026-09-02",
    providerCall,
    wait: async () => {},
  });
  const attemptsByLogicalKey = Map.groupBy(attempts, item => item.logicalOperationKey);
  const failedNodeAttempts = [...attemptsByLogicalKey.values()].find(items => items.length === 2) ?? [];
  return { ...result, categoryDispatchesByNode, failedNodeAttempts, governedDispatches: attempts.length };
}

function mcpResponse(result: unknown) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
}

function providerFailure(code: string) {
  const cause = Object.assign(new Error("provider fixture failed"), { code });
  return Object.assign(new TypeError("fetch failed"), { cause });
}
