import assert from "node:assert/strict";
import test from "node:test";

import { requestSellerSpriteMcp } from "../../scripts/lib/sellersprite-mcp-client.mjs";
import { startFakeSellerSpriteMcpServer } from "./helpers/fake-sellersprite-mcp-server";

test("SellerSprite lists tools through an initialized MCP session", async (t) => {
  const fake = await startFakeSellerSpriteMcpServer();
  t.after(async () => fake.close());

  const result = await requestSellerSpriteMcp("fake-secret", "tools/list", {}, {
    env: {
      NODE_ENV: "test",
      SELLERSPRITE_MCP_ENDPOINT: fake.url,
    },
  });

  assert.equal(Array.isArray(result.tools), true);
  assert.deepEqual(fake.requests.map((request) => request.method), [
    "initialize",
    "notifications/initialized",
    "tools/list",
  ]);
  assert.equal(fake.requests[2]?.hasSession, true);
  assert.equal(fake.requests[2]?.hasProtocolVersion, true);
});
