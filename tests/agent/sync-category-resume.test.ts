import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { collectSorftimeCategoryRecords } from "../../scripts/build-sorftime-category-trend.mjs";
import { callSorftimeTool } from "../../scripts/lib/sorftime-mcp-client.mjs";

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
    marketplace: "US",
    catalog: [
      { asin: "B074QLWRDQ", subRankCategory: "Do not infer this" },
      { asin: "B0BTM28F9N", subRankCategory: "Fixture category" },
    ],
    existing: {},
    fetchedAt: "2026-09-02",
    callTool: async (_key, tool, args) => {
      const asin = String(args.asin ?? "B0BTM28F9N");
      calls.push({ asin, tool });
      if (tool === "product_detail" && asin === "B074QLWRDQ") return { data: {} };
      if (tool === "product_detail") return { data: { node_id: "123456789", subcategory: "Fixture category" } };
      return { data: ["2026-08=10"] };
    },
    wait: async () => {},
  });

  assert.equal(result.records["123456789"].status, "ready");
  const failed = Object.values(result.records).find(record => record.sourceAsin === "B074QLWRDQ");
  assert.equal(failed?.nodeId, "");
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
});

test("a successful empty trend uses the existing empty schema without an error diagnostic", async () => {
  const result = await collectSorftimeCategoryRecords({
    key: "fixture-key",
    marketplace: "US",
    catalog: [{ asin: "B0BTM28F9N", subRankCategory: "Fixture category" }],
    existing: {},
    fetchedAt: "2026-09-02",
    callTool: async (_key, tool) => tool === "product_detail"
      ? { data: { node_id: "123456789", subcategory: "Fixture category" } }
      : { data: [] },
    wait: async () => {},
  });

  assert.equal(result.records["123456789"].status, "empty");
  assert.equal(result.records["123456789"].statusMessage, "UPSTREAM_EMPTY");
  assert.deepEqual(result.records["123456789"].volume, []);
  assert.deepEqual(result.diagnostics, []);
});

async function collectMixedNodeFixture() {
  const categoryDispatchesByNode: Record<string, number> = {};
  const resourceGovernor = {
    async run(input: { operation(): Promise<Response> }) {
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
  const callTool = (key: string, tool: string, args: Record<string, unknown>) => {
    const identity = String(args.node_id ?? args.asin);
    const jobId = `mixed-category-${identity}`;
    return callSorftimeTool(key, tool, args, {
      env: { ...categoryEnv, AGENT_SYNC_JOB_ID: jobId },
      organizationId: "mixed-category-organization",
      jobId,
      resourceGovernor,
      fetchImpl,
    });
  };
  const result = await collectSorftimeCategoryRecords({
    key: "fixture-key",
    marketplace: "US",
    catalog: [
      { asin: "B074QLWRDQ", subRankCategory: "Fixture category" },
      { asin: "B096LRXPBW", subRankCategory: "Fixture category" },
      { asin: "B0BTM28F9N", subRankCategory: "Later category" },
    ],
    existing: {},
    fetchedAt: "2026-09-02",
    callTool,
    wait: async () => {},
  });
  return { ...result, categoryDispatchesByNode };
}

function mcpResponse(result: unknown) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
}

function providerFailure(code: string) {
  const cause = Object.assign(new Error("provider fixture failed"), { code });
  return Object.assign(new TypeError("fetch failed"), { cause });
}
