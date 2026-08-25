import assert from "node:assert/strict";
import test from "node:test";

import { requestSorftimeMcp } from "../../scripts/lib/sorftime-mcp-client.mjs";

const categoryParams = {
  name: "category_trend",
  arguments: {
    asin: "B0TEST0001",
    node_id: "123456789",
    trend_index: "SalesCount",
  },
};

const categoryEnv = {
  NODE_ENV: "test",
  AGENT_SYNC_STAGE_ID: "category",
  SORFTIME_MCP_ENDPOINT: "http://127.0.0.1:1/mcp",
};

test("category CONNECT_TIMEOUT retries once through the governor", async () => {
  const attempts = [];
  const result = await requestSorftimeMcp("key", "tools/call", categoryParams, {
    env: categoryEnv,
    organizationId: "retry-organization",
    jobId: "retry-job",
    resourceGovernor: recordingGovernor(attempts),
    fetchImpl: timeoutThenSuccessFetch(),
  });

  assert.equal(result.jsonrpc, "2.0");
  assert.deepEqual(attempts.map(item => item.attemptKind), ["initial", "transient-retry"]);
  assert.equal(attempts.every(item => item.stageId === "category"), true);
  assert.equal(new Set(attempts.map(item => item.logicalOperationKey)).size, 1);
  const base = attempts[0].logicalOperationKey;
  assert.deepEqual(attempts.map(item => item.dispatchKey), [
    `${base}:initial`,
    `${base}:transient-retry`,
  ]);
  assert.equal(new Set(attempts.map(item => item.dispatchKey)).size, 2);
});

test("an explicit category repair cycle receives distinct physical dispatch keys", async () => {
  const attempts = [];
  const options = {
    env: categoryEnv,
    organizationId: "repair-organization",
    jobId: "repair-job",
    resourceGovernor: recordingGovernor(attempts),
    fetchImpl: async () => { throw providerFailure("UND_ERR_CONNECT_TIMEOUT"); },
  };

  await assert.rejects(requestSorftimeMcp("key", "tools/call", categoryParams, options));
  await assert.rejects(requestSorftimeMcp("key", "tools/call", categoryParams, {
    ...options,
    attemptKind: "repair",
  }));

  assert.deepEqual(attempts.map(item => item.attemptKind), [
    "initial", "transient-retry", "repair", "transient-retry",
  ]);
  assert.equal(new Set(attempts.map(item => item.logicalOperationKey)).size, 1);
  const base = attempts[0].logicalOperationKey;
  assert.deepEqual(attempts.map(item => item.dispatchKey), [
    `${base}:initial`,
    `${base}:transient-retry`,
    `${base}:repair`,
    `${base}:repair:transient-retry`,
  ]);
  assert.equal(new Set(attempts.map(item => item.dispatchKey)).size, 4);
});

test("non-category and non-CONNECT_TIMEOUT failures dispatch once", async () => {
  assert.equal(await dispatchCount({ stage: "reviews", code: "UND_ERR_CONNECT_TIMEOUT" }), 1);
  assert.equal(await dispatchCount({ stage: "category", code: "ECONNRESET" }), 1);
});

function recordingGovernor(attempts) {
  return {
    async run(input) {
      attempts.push({
        attemptKind: input.attemptKind,
        stageId: input.stageId,
        logicalOperationKey: input.logicalOperationKey,
        dispatchKey: input.dispatchKey,
      });
      return await input.operation();
    },
  };
}

function timeoutThenSuccessFetch() {
  let dispatches = 0;
  return async () => {
    dispatches += 1;
    if (dispatches === 1) throw providerFailure("UND_ERR_CONNECT_TIMEOUT");
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { jsonrpc: "2.0" },
    }));
  };
}

async function dispatchCount({ stage, code }) {
  const attempts = [];
  await assert.rejects(
    requestSorftimeMcp("key", "tools/call", categoryParams, {
      env: { ...categoryEnv, AGENT_SYNC_STAGE_ID: stage },
      organizationId: "ineligible-organization",
      jobId: `ineligible-${stage}-${code}`,
      resourceGovernor: recordingGovernor(attempts),
      fetchImpl: async () => {
        throw providerFailure(code);
      },
    }),
  );
  return attempts.length;
}

function providerFailure(code) {
  const cause = Object.assign(new Error("provider fixture failed"), { code });
  return Object.assign(new TypeError("fetch failed"), { cause });
}
