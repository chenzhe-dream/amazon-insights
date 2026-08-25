import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { collectSorftimeCategoryRecords } from "../../scripts/build-sorftime-category-trend.mjs";
import { callSorftimeTool } from "../../scripts/lib/sorftime-mcp-client.mjs";
import { ProviderDiagnosticError } from "../../scripts/lib/provider-diagnostics.mjs";

const asin = "B0TEST0001";
const categoryEnv = {
  NODE_ENV: "test",
  AGENT_SYNC_STAGE_ID: "category",
  AGENT_SYNC_JOB_ID: "category-timeout-fixture",
  SORFTIME_MCP_ENDPOINT: "http://127.0.0.1:1/mcp",
};

afterEach(() => {
  process.exitCode = undefined;
});

test("category projection preserves non-timeout provider and credential failures", async () => {
  const failures = [
    new ProviderDiagnosticError({
      connector: "sorftime", stage: "category", asin,
      failureKind: "http", causeCode: "HTTP_5XX",
    }),
    new ProviderDiagnosticError({
      connector: "sorftime", stage: "category", asin,
      failureKind: "schema", causeCode: "MCP_SCHEMA", operation: "product_detail",
    }),
    new Error("Sorftime server credential is not configured"),
  ];

  for (const failure of failures) {
    await assert.rejects(
      collectSorftimeCategoryRecords({
        key: "fixture-key",
        marketplace: "US",
        catalog: [{ asin, subRankCategory: "Fixture category" }],
        existing: {},
        fetchedAt: "2026-08-26",
        callTool: async () => { throw failure; },
        wait: async () => {},
      }),
      (error: unknown) => {
        assert.strictEqual(error, failure);
        return true;
      },
    );
  }
});

test("permanent category timeout has two attempts and no third category dispatch", async () => {
  const fixture = categoryFixture("initial");

  await assert.rejects(
    collectSorftimeCategoryRecords({
      key: "fixture-key",
      marketplace: "US",
      catalog: [{ asin, subRankCategory: "Fixture category" }],
      existing: {},
      fetchedAt: "2026-08-26",
      callTool: fixture.callTool,
      wait: async () => {},
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderDiagnosticError);
      assert.equal(error.diagnostic.stage, "category");
      assert.equal(error.diagnostic.causeCode, "CONNECT_TIMEOUT");
      return true;
    },
  );

  assert.deepEqual(fixture.categoryAttempts(), ["initial", "transient-retry"]);
  assert.equal(fixture.categoryDispatches(), 2);
  assert.deepEqual(fixture.toolCalls(), ["product_detail", "category_trend", "category_trend"]);
});

test("resumed category starts with repair and remains eligible for exactly one transient retry", async () => {
  const fixture = categoryFixture("repair");

  await assert.rejects(collectSorftimeCategoryRecords({
    key: "fixture-key",
    marketplace: "US",
    catalog: [{ asin, subRankCategory: "Fixture category" }],
    existing: {},
    fetchedAt: "2026-08-26",
    callTool: fixture.callTool,
    wait: async () => {},
  }), ProviderDiagnosticError);

  assert.deepEqual(fixture.categoryAttempts(), ["repair", "transient-retry"]);
  assert.equal(fixture.categoryDispatches(), 2);
});

function categoryFixture(firstAttemptKind: "initial" | "repair") {
  const jobId = `${categoryEnv.AGENT_SYNC_JOB_ID}-${firstAttemptKind}`;
  const attempts: Array<{ attemptKind: string; logicalOperationKey: string }> = [];
  const calls: string[] = [];
  const resourceGovernor = {
    async run(input: {
      attemptKind: string;
      logicalOperationKey: string;
      operation(): Promise<Response>;
    }) {
      attempts.push({
        attemptKind: input.attemptKind,
        logicalOperationKey: input.logicalOperationKey,
      });
      return await input.operation();
    },
  };
  const fetchImpl = async (_input: URL | RequestInfo, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const toolName = String(body.params.name);
    calls.push(toolName);
    if (toolName === "product_detail") {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          data: {
            node_id: "123456789",
            subcategory: "Fixture category (Rank: 1)",
            top_category: "Fixture top (Rank: 2)",
          },
        },
      }));
    }
    throw providerFailure("UND_ERR_CONNECT_TIMEOUT");
  };
  const callTool = (
    key: string,
    toolName: string,
    args: Record<string, unknown>,
  ) => callSorftimeTool(key, toolName, args, {
    env: { ...categoryEnv, AGENT_SYNC_JOB_ID: jobId, AGENT_RESOURCE_ATTEMPT_KIND: firstAttemptKind },
    organizationId: "category-timeout-organization",
    jobId,
    resourceGovernor,
    fetchImpl,
  });
  const categoryLogicalKey = () => attempts.find((item) =>
    item.logicalOperationKey !== attempts[0]?.logicalOperationKey
  )?.logicalOperationKey;
  return {
    callTool,
    categoryAttempts: () => attempts
      .filter((item) => item.logicalOperationKey === categoryLogicalKey())
      .map((item) => item.attemptKind),
    categoryDispatches: () => calls.filter((toolName) => toolName === "category_trend").length,
    toolCalls: () => calls,
  };
}

function providerFailure(code: string) {
  const cause = Object.assign(new Error("provider fixture failed"), { code });
  return Object.assign(new TypeError("fetch failed"), { cause });
}
