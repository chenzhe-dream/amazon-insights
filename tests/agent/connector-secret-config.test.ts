import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  getServerConnectorSecretState,
  readServerConnectorSecret,
} from "../../server/config/connector-secrets.mjs";
import { getAgentCapabilities } from "../../server/routes/capabilities";
import {
  callSellerSpriteMcpTool,
  readSellerSpriteSecretKey,
} from "../../scripts/lib/sellersprite-mcp-client.mjs";
import {
  callSifTool,
  readSifHeaders,
} from "../../scripts/lib/sif-mcp-client.mjs";
import {
  callSorftimeTool,
  readSorftimeKey,
} from "../../scripts/lib/sorftime-mcp-client.mjs";

const worktreeRoot = path.resolve(import.meta.dirname, "../..");

function mcpResponse(result: unknown = { ok: true }) {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: JSON.stringify(result) }] },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

test("connector secrets are loaded only from declared server environment variables", () => {
  const cursorHome = fs.mkdtempSync(path.join(os.tmpdir(), "connector-secrets-"));
  fs.mkdirSync(path.join(cursorHome, ".cursor"));
  fs.writeFileSync(
    path.join(cursorHome, ".cursor", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        "sif-mcp": { headers: { "secret-key": "cursor-sif-secret" } },
        "sorftime-mcp": { url: "https://private.invalid?key=cursor-sorftime-secret" },
        "sellersprite-mcp": { headers: { "secret-key": "cursor-seller-secret" } },
      },
    }),
  );

  const cursorOnlyEnv = { USERPROFILE: cursorHome, HOME: cursorHome };
  assert.equal(readServerConnectorSecret("sif", cursorOnlyEnv), null);
  assert.equal(readSifHeaders(cursorOnlyEnv), null);
  assert.equal(readSorftimeKey(cursorOnlyEnv), null);
  assert.equal(readSellerSpriteSecretKey(cursorOnlyEnv), null);

  const serverEnv = {
    SIF_MCP_SECRET: "  server-sif-secret  ",
    SORFTIME_MCP_KEY: " server-sorftime-secret ",
    SELLERSPRITE_SECRET_KEY: " server-seller-secret ",
  };
  assert.equal(readServerConnectorSecret("sif", serverEnv), "server-sif-secret");
  assert.deepEqual(readSifHeaders(serverEnv), {
    "secret-key": "server-sif-secret",
    Authorization: "server-sif-secret",
  });
  assert.equal(readSorftimeKey(serverEnv), "server-sorftime-secret");
  assert.equal(readSellerSpriteSecretKey(serverEnv), "server-seller-secret");
  assert.deepEqual(getServerConnectorSecretState(serverEnv), {
    sif: true,
    sorftime: true,
    sellerSprite: true,
  });
  assert.deepEqual(getServerConnectorSecretState({ SIF_MCP_SECRET: "   " }), {
    sif: false,
    sorftime: false,
    sellerSprite: false,
  });
});

test("connector calls fail closed before transport when a server secret is missing", async () => {
  let transportCalls = 0;
  const fetchImpl = async () => {
    transportCalls += 1;
    return mcpResponse();
  };

  await assert.rejects(
    callSifTool("probe", {}, { env: {}, fetchImpl }),
    /SIF server credential is not configured/,
  );
  await assert.rejects(
    callSorftimeTool(null, "probe", {}, { fetchImpl }),
    /Sorftime server credential is not configured/,
  );
  await assert.rejects(
    callSellerSpriteMcpTool(null, "probe", {}, { fetchImpl }),
    /SellerSprite server credential is not configured/,
  );
  assert.equal(transportCalls, 0);
});

test("connector calls accept injected transport without exposing credentials publicly", async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return mcpResponse({ accepted: true });
  };

  const sifEnv = { SIF_MCP_SECRET: "transport-sif-secret" };
  assert.deepEqual(
    await callSifTool("probe", { asin: "B000000000" }, { env: sifEnv, fetchImpl }),
    { accepted: true },
  );
  assert.deepEqual(
    await callSorftimeTool("transport-sorftime-secret", "probe", {}, { fetchImpl }),
    { accepted: true },
  );
  assert.deepEqual(
    await callSellerSpriteMcpTool("transport-seller-secret", "probe", {}, { fetchImpl }),
    { accepted: true },
  );

  assert.equal(requests.length, 3);
  assert.equal(
    new Headers(requests[0]?.init?.headers).get("secret-key"),
    "transport-sif-secret",
  );
  assert.match(requests[1]?.url ?? "", /key=transport-sorftime-secret/);
  assert.equal(
    new Headers(requests[2]?.init?.headers).get("secret-key"),
    "transport-seller-secret",
  );

  const publicPayload = JSON.stringify(
    getAgentCapabilities({
      SIF_MCP_SECRET: "transport-sif-secret",
      SORFTIME_MCP_KEY: "transport-sorftime-secret",
      SELLERSPRITE_SECRET_KEY: "transport-seller-secret",
    }),
  );
  assert.doesNotMatch(publicPayload, /transport-|mcp\.sif|mcp\.sorftime|mcp\.sellersprite/i);
});

test("connector and page sources contain no Cursor configuration fallback or prompt", () => {
  const sourcePaths = [
    "scripts/lib/sif-mcp-client.mjs",
    "scripts/lib/sorftime-mcp-client.mjs",
    "scripts/lib/sellersprite-mcp-client.mjs",
    "scripts/fetch-sellersprite-review-analysis.mjs",
    "app/keyword-demand-section.tsx",
    "app/page.tsx",
    "app/seller-sprite-review-analysis.ts",
  ];
  const sources = sourcePaths
    .map(sourcePath => fs.readFileSync(path.join(worktreeRoot, sourcePath), "utf8"))
    .join("\n");

  assert.doesNotMatch(sources, /\.cursor[\\/]mcp\.json|Cursor Settings|Cursor\s*→\s*Settings|mcpSetup/i);
});
