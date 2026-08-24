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

export type FakeSellerSpriteMcpMode =
  | "success"
  | "initialize-http-error"
  | "initialize-malformed"
  | "initialize-hang"
  | "initialized-http-error"
  | "get-hang"
  | "operation-malformed"
  | "operation-hang";

export async function startFakeSellerSpriteMcpServer({
  mode = "success",
}: {
  mode?: FakeSellerSpriteMcpMode;
} = {}): Promise<{
  url: string;
  requests: readonly FakeMcpRequest[];
  dispatchMethods: readonly string[];
  waitForRequest(method: string): Promise<void>;
  waitForGetClose(): Promise<void>;
  close(): Promise<void>;
}> {
  const requests: FakeMcpRequest[] = [];
  const dispatchMethods: string[] = [];
  const requestWaiters = new Map<string, Set<() => void>>();
  const getCloseWaiters = new Set<() => void>();
  let getClosed = false;
  let initialized = false;
  let notified = false;

  const server = createServer(async (request, response) => {
    dispatchMethods.push(request.method ?? "UNKNOWN");
    if (request.method === "GET") {
      if (mode === "get-hang") {
        response.once("close", () => {
          getClosed = true;
          for (const resolve of getCloseWaiters) resolve();
          getCloseWaiters.clear();
        });
        return;
      }
      response.writeHead(405).end();
      return;
    }
    const payload = await readPayload(request);
    const method = typeof payload.method === "string" ? payload.method : "";
    const metadata = Object.freeze({
      method,
      hasSession: request.headers["mcp-session-id"] === "fake-session-1",
      hasProtocolVersion: typeof request.headers["mcp-protocol-version"] === "string",
      hasSecretHeader: typeof request.headers["secret-key"] === "string",
    });
    requests.push(metadata);
    for (const resolve of requestWaiters.get(method) ?? []) resolve();
    requestWaiters.delete(method);

    if (method === "initialize") {
      if (mode === "initialize-http-error") {
        writeError(response, payload.id, 400, "raw-provider-body-sentinel");
        return;
      }
      if (mode === "initialize-malformed") {
        writeResult(response, payload.id, { invalid: true });
        return;
      }
      if (mode === "initialize-hang") return;
      initialized = true;
      writeResult(response, payload.id, {
        protocolVersion: payload.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fake-seller", version: "1.0.0" },
      }, { "Mcp-Session-Id": "fake-session-1" });
      return;
    }

    if (method === "notifications/initialized" && initialized && metadata.hasSession) {
      if (mode === "initialized-http-error") {
        writeError(response, payload.id, 400, "raw-initialized-body-sentinel");
        return;
      }
      notified = true;
      response.writeHead(202).end();
      return;
    }

    if ((method === "tools/list" || method === "tools/call") && notified && metadata.hasSession && metadata.hasProtocolVersion) {
      if (mode === "operation-malformed") {
        writeResult(response, payload.id, method === "tools/list" ? { tools: "invalid" } : { content: "invalid" });
        return;
      }
      if (mode === "operation-hang") return;
      writeResult(response, payload.id, method === "tools/list"
        ? { tools: [] }
        : { content: [{ type: "text", text: JSON.stringify({ accepted: true }) }] });
      return;
    }

    writeError(response, payload.id, 400, "MCP session handshake is required");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    requests,
    dispatchMethods,
    async waitForRequest(method) {
      if (requests.some(request => request.method === method)) return;
      await new Promise<void>((resolve) => {
        const waiters = requestWaiters.get(method) ?? new Set();
        waiters.add(resolve);
        requestWaiters.set(method, waiters);
      });
    },
    async waitForGetClose() {
      if (getClosed) return;
      await new Promise<void>(resolve => getCloseWaiters.add(resolve));
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
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
