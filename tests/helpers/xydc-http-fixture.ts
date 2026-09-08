import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { XydcVariantFamily } from "../../shared/xydc-variant-contract";
import { getXydcOrderWindow } from "../../shared/xydc-order-summary";

export const fixtureNow = new Date("2026-09-08T09:00:00Z");
export function fixtureFamily(asins = ["B0CHILD001", "B0CHILD002"], country = "US"): XydcVariantFamily {
  return { inputAsin: asins[0]!, country, parentAsin: "B0PARENT01", dimensions: [],
    children: asins.map(asin => ({ asin, attributes: [], title: null, imageUrl: null, price: null, currency: null,
      stars: null, productPageRatings: null, listingDate: null, infoStatus: "pending" })),
    sourceUpdatedAt: null, fetchedAt: fixtureNow.toISOString(), status: "partial", reasonCode: "PARTIAL_CHILD_INFO", cacheState: "fresh" };
}
export function fixtureOrders(asin: string, country = "US", orders = 100) {
  return { status: 200, data: { asin, country, trends: getXydcOrderWindow(fixtureNow).months.map(date => ({ date, orders })) } };
}
type FixtureRpc = { id?: number; method?: string; params?: { arguments?: { asin?: string; country?: string } } };
export async function httpFixture(handler?: (body: FixtureRpc, req: IncomingMessage, res: ServerResponse) => boolean | Promise<boolean>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "xydc-http-"));
  const requests: Array<{ method: string; rpc?: string; at: number; authorization?: string }> = [];
  const connections: Array<{ openedAt: number; closedAt?: number }> = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    requests.push({ method: req.method!, rpc: body.method, at: performance.now(), authorization: req.headers.authorization });
    if (await handler?.(body, req, res)) return;
    if (req.method === "GET") { res.writeHead(405).end(); return; }
    if (body.method === "notifications/initialized") { res.writeHead(202).end(); return; }
    res.setHeader("Content-Type", "application/json");
    res.setHeader("mcp-session-id", "fixture-session");
    const result = body.method === "initialize"
      ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
      : { content: [], structuredContent: fixtureOrders(body.params?.arguments?.asin ?? "B0CHILD001", body.params?.arguments?.country ?? "US") };
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  server.on("connection", socket => {
    const connection: { openedAt: number; closedAt?: number } = { openedAt: performance.now() };
    connections.push(connection);
    socket.once("close", () => { connection.closedAt = performance.now(); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return { root, requests, connections, env: { NODE_ENV: "test" as const, XYDC_MCP_URL: `http://127.0.0.1:${address.port}/mcp`, XYDC_COORDINATION_ROOT: path.join(root, "coordination") },
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); } };
}
