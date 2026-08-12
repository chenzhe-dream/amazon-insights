import fs from "node:fs";
import path from "node:path";

export function readSellerSpriteSecretKey() {
  if (process.env.SELLERSPRITE_SECRET_KEY) return process.env.SELLERSPRITE_SECRET_KEY;
  const mcpPath = path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".cursor", "mcp.json");
  if (!fs.existsSync(mcpPath)) return null;
  const config = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
  return config?.mcpServers?.["sellersprite-mcp"]?.headers?.["secret-key"] ?? null;
}

function parseMcpPayload(text) {
  const line = text
    .split("\n")
    .map(item => item.trim())
    .find(item => item.startsWith("data:"));
  const payload = line ? JSON.parse(line.slice(5).trim()) : JSON.parse(text);
  if (payload.error) throw new Error(payload.error.message ?? JSON.stringify(payload.error));
  return payload.result ?? payload;
}

export async function callSellerSpriteMcpTool(secretKey, toolName, args) {
  const response = await fetch("https://mcp.sellersprite.com/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "secret-key": secretKey,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });

  const text = await response.text();
  const result = parseMcpPayload(text);
  const content = result?.content?.[0]?.text;
  if (typeof content === "string") {
    try {
      return JSON.parse(content);
    } catch {
      return content;
    }
  }
  return result;
}

export async function fetchSellerSpriteReviews(secretKey, marketplace, asin, { pageSize = 50, maxPages = 50 } = {}) {
  const reviews = [];
  const seen = new Set();

  for (let page = 1; page <= maxPages; page += 1) {
    const payload = await callSellerSpriteMcpTool(secretKey, "review", {
      marketplace,
      asin,
      page,
      size: pageSize,
    });

    if (payload?.code && payload.code !== "OK") {
      throw new Error(`${payload.code}: ${payload.message ?? "review 请求失败"}`);
    }

    const items = payload?.data?.items ?? payload?.items ?? [];
    const total = payload?.data?.total ?? 0;
    const pages = payload?.data?.pages ?? 0;
    if (!Array.isArray(items) || !items.length) break;

    items.forEach(item => {
      const key = `${item.author ?? ""}|${item.date ?? ""}|${(item.content ?? "").slice(0, 40)}`;
      if (seen.has(key)) return;
      seen.add(key);
      reviews.push({
        author: item.author ?? "",
        title: item.title ?? "",
        content: item.content ?? "",
        star: Math.round(item.star ?? item.star_rating ?? 0),
      });
    });

    if (total && reviews.length >= total) break;
    if (pages && page >= pages) break;
    if (!total && !pages && items.length < pageSize) break;
    await new Promise(resolve => setTimeout(resolve, 400));
  }

  return reviews;
}
