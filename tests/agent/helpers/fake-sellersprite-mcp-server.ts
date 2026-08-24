import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeMcpRequest = Readonly<{
  method: string;
  hasSession: boolean;
  hasProtocolVersion: boolean;
  hasSecretHeader: boolean;
}>;

type McpPayload = {
  id?: unknown;
  method?: unknown;
  params?: { protocolVersion?: unknown };
};

export async function startFakeSellerSpriteMcpServer(): Promise<{
  url: string;
  requests: readonly FakeMcpRequest[];
  close(): Promise<void>;
}> {
  const requests: FakeMcpRequest[] = [];
  let initialized = false;
  let notified = false;

  const server = createServer(async (request, response) => {
    const payload = await readPayload(request);
    const method = typeof payload.method === "string" ? payload.method : "";
    const metadata = Object.freeze({
      method,
      hasSession: request.headers["mcp-session-id"] === "fake-session-1",
      hasProtocolVersion: typeof request.headers["mcp-protocol-version"] === "string",
      hasSecretHeader: typeof request.headers["secret-key"] === "string",
    });
    requests.push(metadata);

    if (method === "initialize") {
      initialized = true;
      writeResult(response, payload.id, {
        protocolVersion: payload.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fake-seller", version: "1.0.0" },
      }, { "Mcp-Session-Id": "fake-session-1" });
      return;
    }

    if (method === "notifications/initialized" && initialized && metadata.hasSession) {
      notified = true;
      response.writeHead(202).end();
      return;
    }

    if ((method === "tools/list" || method === "tools/call") && notified && metadata.hasSession && metadata.hasProtocolVersion) {
      writeResult(response, payload.id, method === "tools/list" ? { tools: [] } : { content: [] });
      return;
    }

    writeError(response, payload.id, 400, "MCP session handshake is required");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    requests,
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function readPayload(request: IncomingMessage): Promise<McpPayload> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as McpPayload;
}

function writeResult(response: ServerResponse, id: unknown, result: unknown, headers: Record<string, string> = {}) {
  response.writeHead(200, { "Content-Type": "application/json", ...headers });
  response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

function writeError(response: ServerResponse, id: unknown, statusCode: number, message: string) {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }));
}
