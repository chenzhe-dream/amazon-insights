export { createSellerSpriteSessionPool } from './sellersprite-session-pool.mjs';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { readServerConnectorSecret } from "../../server/config/connector-secrets.mjs";
import {
  safeSellerSpriteTransportError,
} from "../../server/connectors/mcp-transport.mjs";
import { governExternalRequest } from "./postgres-resource-governor.mjs";
import { runWithProviderDiagnostics } from "./provider-diagnostics.mjs";
import { providerEndpoint } from "./provider-network.mjs";
import {withSharedProviderSource,normalizeSharedProviderResult} from './shared-provider-source-client.mjs';

/** @param {Readonly<Record<string, string | undefined>>} [env] */
export function readSellerSpriteSecretKey(env = process.env) {
  return readServerConnectorSecret("sellerSprite", env);
}

/**
 * @typedef {object} SellerSpriteMcpOptions
 * @property {Readonly<Record<string, string | undefined>>} [env]
 * @property {typeof fetch} [fetchImpl]
 * @property {AbortSignal} [signal]
 * @property {import('../../server/db/concurrency-control-repository').ResourceGovernor} [resourceGovernor]
 * @property {boolean} [requireResourceGovernor]
 * @property {string | null} [organizationId]
 * @property {string | null} [jobId]
 * @property {import('../../server/db/concurrency-control-repository').GovernedAttemptKind} [attemptKind]
 * @property {'market'} [sessionScope]
 * @property {ReturnType<import('./sellersprite-session-pool.mjs').createSellerSpriteSessionPool>} [sessionPool]
 * @property {number} [timeoutMs]
 * @property {ReturnType<import('./sorftime-source-cache.mjs').createSorftimeSourceCache>} [sourceCache]
 * @property {boolean} [forceRefresh]
 * @property {()=>Promise<void>} [onPhysicalDispatch]
 */

/** @param {SellerSpriteMcpOptions} [options] */
export async function requestSellerSpriteMcp(
  secretKey,
  method,
  params,
  options = {},
) {
  const {
    fetchImpl = fetch,
    signal,
    resourceGovernor,
    requireResourceGovernor,
    organizationId,
    jobId,
    attemptKind = "initial",
    env = process.env,
    timeoutMs = 15_000,
  } = options;
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
    if (options.sessionPool && options.sessionScope === 'market' && organizationId && jobId) {
      return await options.sessionPool.request(secretKey, providerEndpoint('sellerSprite', env), method, params, options);
    }
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
          onPhysicalDispatch: options.onPhysicalDispatch,
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
  onPhysicalDispatch,
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
    operation: async () => {
      if(typeof init.body==='string' && JSON.parse(init.body).method==='tools/call')await onPhysicalDispatch?.();
      return fetchImpl(input, {
      ...init,
      signal: init.signal
        ? AbortSignal.any([lifecycleSignal, init.signal])
        : lifecycleSignal,
      redirect: "error",
    });},
  });
}

/** @param {SellerSpriteMcpOptions} [options] */
export async function callSellerSpriteMcpTool(secretKey, toolName, args, options = {}) {
  const env = options.env ?? process.env;
  return withSharedProviderSource('sellerSprite',secretKey,toolName,args,options,recordAttempt=>runWithProviderDiagnostics({
    connector: "sellerSprite",
    stage: env.AGENT_SYNC_STAGE_ID ?? "unknown-stage",
    asin: providerAsin(args),
    operation: toolName,
    env,
  }, async () => {
    const result=await requestSellerSpriteMcp(secretKey, "tools/call", { name: toolName, arguments: args }, {...options,onPhysicalDispatch:recordAttempt});
    return normalizeSharedProviderResult(result,'SellerSprite');
  }));
}

function providerAsin(value) {
  const candidate = value?.asin ?? value?.arguments?.asin;
  return typeof candidate === "string" ? candidate.trim().toUpperCase() : "UNKNOWNASIN";
}

function providerOperation(method, params) {
  return method === "tools/list" ? "tools/list" : params?.name;
}

export function parseSellerSpriteReviewPage(payload) {
  if (payload?.code !== "OK") throw new Error(`${payload?.code ?? "MCP_SCHEMA"}: ${payload?.message ?? "SellerSprite review 请求失败"}`);
  const data = payload.data;
  if (!data || typeof data !== "object" || !Array.isArray(data.items)) throw Object.assign(new Error("MCP_SCHEMA: SellerSprite review items must be an array"), {kind:"schema"});
  const total = Number.isInteger(data.total) && data.total >= 0 ? data.total : 0;
  const pages = Number.isInteger(data.pages) && data.pages >= 0 ? data.pages : 0;
  return { items: data.items, total, pages };
}

export async function fetchSellerSpriteReviews(secretKey, marketplace, asin, { pageSize = 50, maxPages = 50, callTool = callSellerSpriteMcpTool, ...options } = {}) {
  const reviews = [];
  const seen = new Set();

  for (let page = 1; page <= maxPages; page += 1) {
    const payload = await callTool(secretKey, "review", {
      marketplace,
      asin,
      page,
      size: pageSize,
    }, options);

    const { items, total, pages } = await runWithProviderDiagnostics({
      connector:"sellerSprite",stage:options.env?.AGENT_SYNC_STAGE_ID ?? process.env.AGENT_SYNC_STAGE_ID ?? "unknown-stage",
      asin,operation:"review",boundary:"consumer-shape",env:options.env ?? process.env,
    }, async () => parseSellerSpriteReviewPage(payload));
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
