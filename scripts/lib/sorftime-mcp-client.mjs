import { createHash } from "node:crypto";

import { readServerConnectorSecret } from "../../server/config/connector-secrets.mjs";
import {
  McpTransportError,
  createMcpConsumerShapeError,
  normalizeMcpResult,
  parseMcpResponse,
} from "../../server/connectors/mcp-transport.mjs";
import { governExternalRequest } from "./postgres-resource-governor.mjs";
import {
  classifyProviderFailure,
  runWithProviderDiagnostics,
} from "./provider-diagnostics.mjs";
import { providerEndpoint } from "./provider-network.mjs";
import { sourceCacheFromEnv } from "./sorftime-source-cache.mjs";
import { isQuotaResponse, SorftimeQuotaError, assertSourceResponse } from "./sorftime-source-policy.mjs";

export function readSorftimeKey(env = process.env) {
  return readServerConnectorSecret("sorftime", env);
}

function providerSiteArguments(args) {
  if (!args || typeof args !== "object") return args;
  return { ...args,
    ...(args.site === "UK" ? { site: "GB" } : {}),
    ...(args.amz_site === "UK" ? { amz_site: "GB" } : {}),
    ...(args.keyword_support_site === "UK" ? { keyword_support_site: "GB" } : {}),
  };
}

export async function requestSorftimeMcp(
  key,
  method,
  params,
  options = {},
) {
  if (method === "tools/call" && params?.arguments) params = { ...params, arguments: providerSiteArguments(params.arguments) };
  const {
    fetchImpl = fetch,
    signal,
    resourceGovernor,
    requireResourceGovernor,
    organizationId,
    jobId,
    env = process.env,
  } = options;
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new Error("Sorftime server credential is not configured");
  }

  const operation = providerOperation(method, params);
  const diagnosticInput = {
    connector: "sorftime",
    stage: env.AGENT_SYNC_STAGE_ID ?? "unknown-stage",
    asin: providerAsin(params),
    operation,
    env,
    emitDiagnostics: options.emitDiagnostics,
    optionalEnrichment: options.optionalEnrichment,
    allowCategorySiblingDispatch: options.allowCategorySiblingDispatch,
  };
  const logicalOperationKey = sorftimeLogicalOperationKey(method, params);
  const dispatchPhysical = async (attemptKind, physicalAttemptKey = attemptKind) => {
    const response = await governExternalRequest({
      resourceGovernor,
      requireResourceGovernor,
      env,
      organizationId,
      jobId,
      resource: "sorftime",
      attemptKind,
      stageId: diagnosticInput.stage,
      logicalOperationKey,
      dispatchKey: `${logicalOperationKey}:${physicalAttemptKey}`,
      signal,
      operation: async () => {
        await options.onPhysicalDispatch?.();
        const endpoint = new URL(providerEndpoint("sorftime", env));
        endpoint.searchParams.set("key", key);
        return fetchImpl(endpoint, {
          method: "POST",
          signal,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: Date.now(),
            method,
            params,
          }),
        });
      },
    });
    return await parseMcpResponse(response);
  };

  return await runWithProviderDiagnostics(diagnosticInput, async () => {
    const firstKind = options.attemptKind ?? env.AGENT_RESOURCE_ATTEMPT_KIND ?? "initial";
    try {
      return await dispatchPhysical(firstKind);
    } catch (error) {
      const diagnostic = classifyProviderFailure(error, diagnosticInput);
      // A transient connection failure gets one governed retry before it can
      // open the job breaker and suppress sibling ASINs or later stages.
      const eligible = !signal?.aborted && diagnostic.causeCode === "CONNECT_TIMEOUT" &&
        firstKind !== "transient-retry";
      if (!eligible) throw error;
      return await dispatchPhysical(
        "transient-retry",
        firstKind === "repair" ? "repair:transient-retry" : "transient-retry",
      );
    }
  });
}

export async function callSorftimeTool(key, toolName, args, options = {}) {
  args = providerSiteArguments(args);
  const env = options.env ?? process.env;
  const cache = options.sourceCache ?? sourceCacheFromEnv(env);
  const execute = async ({recordAttempt = async () => {}} = {}) => runWithProviderDiagnostics({
    connector: "sorftime",
    stage: env.AGENT_SYNC_STAGE_ID ?? "unknown-stage",
    asin: providerAsin(args),
    operation: toolName,
    env,
    emitDiagnostics: options.emitDiagnostics,
    optionalEnrichment: options.optionalEnrichment,
    allowCategorySiblingDispatch: options.allowCategorySiblingDispatch,
  }, async () => {
    const value = normalizeSorftimeToolResult(toolName,
      await requestSorftimeMcp(key, "tools/call", { name: toolName, arguments: args },
        {...options, onPhysicalDispatch: recordAttempt}));
    if(cache) {
      assertSourceResponse(value);
      if(JSON.stringify(value).includes(key))throw new McpTransportError("malformed",null,{boundary:"tool-content"});
    }
    return value;
  });
  if(!cache) return execute();
  return cache.run({
    key, endpoint: providerEndpoint("sorftime", env), tool: toolName, args,
    jobId: options.jobId ?? env.AGENT_SYNC_JOB_ID, signal: options.signal,
    forceRefresh: options.forceRefresh === true || env.FORCE_REFRESH === '1' || process.argv.includes('--force'),
  }, execute);
}

export function normalizeSorftimeToolResult(toolName, result) {
  if(isQuotaResponse(result)) throw new SorftimeQuotaError();
  if (result?.isError === true) {
    throw new McpTransportError("rpc", null, { boundary: "tool-content" });
  }
  // Observed Sorftime responses, not a generic non-JSON fallback. An empty
  // summary does not mean zero reviews; an empty variation list is not zero sales.
  if (Array.isArray(result?.content) && result.content.length === 1 &&
    result.content[0]?.type === "text" && typeof result.content[0].text === "string" &&
    !Object.hasOwn(result, "structuredContent")) {
    const text = result.content[0].text.trim();
    // Observed keyword_extends business response: HTTP 200, no usable keyword
    // page. Keep suggested terms out of the pool; they may be a different market.
    if(toolName==='keyword_extends'&&/^The keyword you queried is not an Amazon trending keyword, but we found related keywords: [\s\S]+\. Which keyword's detail do you want to view\?$/.test(text)){
      throw new McpTransportError('keyword-not-trending',null,{boundary:'tool-content'});
    }
    if (toolName === "product_customers_say" && text === "No relevant data.") {
      return { data: { details: [] } };
    }
    if (toolName === "product_variations" && text === "No data available.") {
      return { data: [] };
    }
    if (toolName === "product_reviews" && text === "No reviews found.") {
      return { data: [] };
    }
  }
  return normalizeMcpResult(result);
}

export async function projectSorftimeConsumerCandidate(toolName, args, response, options = {}) {
  const env = options.env ?? process.env;
  return await runWithProviderDiagnostics({
    connector: "sorftime",
    stage: env.AGENT_SYNC_STAGE_ID ?? "unknown-stage",
    asin: providerAsin(args),
    operation: toolName,
    env,
  }, async () => {
    const candidate = response?.data ?? response;
    const valid = toolName === "product_customers_say"
      ? Array.isArray(candidate?.details)
      : toolName === "product_reviews"
        ? Array.isArray(candidate)
        : true;
    if (!valid) throw createMcpConsumerShapeError(response);
    return candidate;
  });
}

function providerAsin(value) {
  const candidate = value?.asin ?? value?.arguments?.asin;
  return typeof candidate === "string" ? candidate.trim().toUpperCase() : "UNKNOWNASIN";
}

function providerOperation(method, params) {
  return method === "tools/list" ? "tools/list" : params?.name;
}

function sorftimeLogicalOperationKey(method, params) {
  const args = params?.arguments ?? params ?? {};
  const identity = JSON.stringify({
    method: String(method ?? ""),
    toolName: String(params?.name ?? ""),
    asin: providerAsin(params),
    nodeId: String(args?.node_id ?? args?.nodeId ?? ""),
    trendIndex: String(args?.trend_index ?? args?.trendIndex ?? ""),
    productTrendType: String(args?.type ?? args?.product_trend_type ?? ""),
  });
  return `sorftime:${createHash("sha256").update(identity).digest("hex")}`;
}
