import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("pins the reviewed MCP SDK exports", async () => {
  const entry = import.meta.resolve("@modelcontextprotocol/sdk/client/index.js");
  const pkg = JSON.parse(await readFile(new URL("../../../package.json", entry), "utf8"));
  assert.equal(pkg.version, "1.30.0");
  const [{ Client }, { StreamableHTTPClientTransport, StreamableHTTPError }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
  ]);
  assert.equal(typeof Client, "function");
  assert.equal(typeof StreamableHTTPClientTransport, "function");
  assert.equal(typeof StreamableHTTPError, "function");
});
