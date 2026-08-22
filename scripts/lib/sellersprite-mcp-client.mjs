import { readServerConnectorSecret } from "../../server/config/connector-secrets.mjs";
import { normalizeMcpResult, parseMcpResponse } from "../../server/connectors/mcp-transport.mjs";
import { governExternalRequest } from "./postgres-resource-governor.mjs";
import { runWithProviderDiagnostics } from "./provider-diagnostics.mjs";
import { providerEndpoint } from "./provider-network.mjs";

export function readSellerSpriteSecretKey(env = process.env) {
  return readServerConnectorSecret("sellerSprite", env);
}

export async function requestSellerSpriteMcp(
  secretKey,
  method,
  params,
  {
    fetchImpl = fetch,
    signal,
    resourceGovernor,
    requireResourceGovernor,
    organizationId,
    jobId,
    attemptKind = "initial",
    env = process.env,
  } = {},
) {
  if (typeof secretKey !== "string" || secretKey.trim().length === 0) {
    throw new Error("SellerSprite server credential is not configured");
  }

  return await runWithProviderDiagnostics({
    connector: "sellerSprite",
    stage: env.AGENT_SYNC_STAGE_ID ?? "unknown-stage",
    asin: providerAsin(params),
    env,
  }, async () => {
    const response = await governExternalRequest({
    resourceGovernor,
    requireResourceGovernor,
    env,
    organizationId,
    jobId,
    resource: "sellerSprite",
    attemptKind,
    operation: () => fetchImpl(providerEndpoint("sellerSprite", env), {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "secret-key": secretKey,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method,
        params,
      }),
    }),
    });
    return parseMcpResponse(response);
  });
}

export async function callSellerSpriteMcpTool(secretKey, toolName, args, options = {}) {
  const env = options.env ?? process.env;
  return await runWithProviderDiagnostics({
    connector: "sellerSprite",
    stage: env.AGENT_SYNC_STAGE_ID ?? "unknown-stage",
    asin: providerAsin(args),
    env,
  }, async () => normalizeMcpResult(
    await requestSellerSpriteMcp(secretKey, "tools/call", { name: toolName, arguments: args }, options),
  ));
}

function providerAsin(value) {
  const candidate = value?.asin ?? value?.arguments?.asin;
  return typeof candidate === "string" ? candidate.trim().toUpperCase() : "UNKNOWNASIN";
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
