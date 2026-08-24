import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { readServerConnectorSecret } from "../../server/config/connector-secrets.mjs";
import {
  normalizeMcpResult,
  safeSellerSpriteTransportError,
} from "../../server/connectors/mcp-transport.mjs";
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
    timeoutMs = 15_000,
  } = {},
) {
  if (typeof secretKey !== "string" || secretKey.trim().length === 0) {
    throw new Error("SellerSprite server credential is not configured");
  }

  const operation = providerOperation(method, params);
  return await runWithProviderDiagnostics({
    connector: "sellerSprite",
    stage: env.AGENT_SYNC_STAGE_ID ?? "unknown-stage",
    asin: providerAsin(params),
    operation,
    env,
  }, async () => {
    const lifecycleSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    const client = new Client({
      name: "amazon-opportunity-insights",
      version: "1.0.0",
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(providerEndpoint("sellerSprite", env)),
      {
        fetch: createSellerSpriteGovernedFetch({
          fetchImpl,
          lifecycleSignal,
          resourceGovernor,
          requireResourceGovernor,
          env,
          organizationId,
          jobId,
          attemptKind,
        }),
        requestInit: {
          headers: { "secret-key": secretKey },
          redirect: "error",
          signal: lifecycleSignal,
        },
        reconnectionOptions: {
          maxRetries: 0,
          initialReconnectionDelay: 1,
          maxReconnectionDelay: 1,
          reconnectionDelayGrowFactor: 1,
        },
      },
    );
    let connected = false;
    try {
      await client.connect(transport, { signal: lifecycleSignal });
      connected = true;
      return method === "tools/list"
        ? await client.listTools(undefined, { signal: lifecycleSignal })
        : await client.callTool(
            { name: params.name, arguments: params.arguments },
            undefined,
            { signal: lifecycleSignal },
          );
    } catch (error) {
      if (error instanceof Error && error.name === "ResourceGovernorAdmissionError") {
        throw error;
      }
      throw safeSellerSpriteTransportError(error, lifecycleSignal, {
        boundary: "rpc-envelope",
      });
    } finally {
      if (connected) {
        await Promise.race([
          client.close().catch(() => undefined),
          new Promise(resolve => setTimeout(resolve, 250)),
        ]);
      }
    }
  });
}

function createSellerSpriteGovernedFetch({
  fetchImpl,
  lifecycleSignal,
  resourceGovernor,
  requireResourceGovernor,
  env,
  organizationId,
  jobId,
  attemptKind,
}) {
  return async (input, init = {}) => governExternalRequest({
    resourceGovernor,
    requireResourceGovernor,
    env,
    organizationId,
    jobId,
    resource: "sellerSprite",
    attemptKind,
    signal: lifecycleSignal,
    operation: () => fetchImpl(input, {
      ...init,
      signal: init.signal
        ? AbortSignal.any([lifecycleSignal, init.signal])
        : lifecycleSignal,
      redirect: "error",
    }),
  });
}

export async function callSellerSpriteMcpTool(secretKey, toolName, args, options = {}) {
  const env = options.env ?? process.env;
  return await runWithProviderDiagnostics({
    connector: "sellerSprite",
    stage: env.AGENT_SYNC_STAGE_ID ?? "unknown-stage",
    asin: providerAsin(args),
    operation: toolName,
    env,
  }, async () => normalizeMcpResult(
    await requestSellerSpriteMcp(secretKey, "tools/call", { name: toolName, arguments: args }, options),
  ));
}

function providerAsin(value) {
  const candidate = value?.asin ?? value?.arguments?.asin;
  return typeof candidate === "string" ? candidate.trim().toUpperCase() : "UNKNOWNASIN";
}

function providerOperation(method, params) {
  return method === "tools/list" ? "tools/list" : params?.name;
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
