import dns from "node:dns";

const defaultEndpoints = Object.freeze({
  sellerSprite: "https://mcp.sellersprite.com/mcp",
  sif: "https://mcp.sif.com/mcp",
  sorftime: "https://mcp.sorftime.com",
});

const endpointEnvironmentNames = Object.freeze({
  sellerSprite: "SELLERSPRITE_MCP_ENDPOINT",
  sif: "SIF_MCP_ENDPOINT",
  sorftime: "SORFTIME_MCP_ENDPOINT",
});

export function providerEndpoint(connector, env = process.env) {
  const fallback = defaultEndpoints[connector];
  if (!fallback) throw new TypeError("Unknown provider endpoint");
  const override = env[endpointEnvironmentNames[connector]]?.trim();
  if (!override) return fallback;
  if (env.NODE_ENV !== "test") throw new Error("Provider endpoint override is unavailable");
  const parsed = new URL(override);
  if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
    throw new Error("Provider endpoint override must be loopback");
  }
  return parsed.toString();
}

export function detachedProviderEnvironment(base = process.env, overrides = {}) {
  const env = { ...base, ...overrides };
  const hasProxy = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"].some((key) => Boolean(env[key]?.trim()));
  const openAiHostname = hasProxy ? explicitOpenAiHostname(env) : null;
  if (openAiHostname) mergeNoProxyHostname(env, openAiHostname);
  if (hasProxy && !env.NODE_USE_ENV_PROXY?.trim()) env.NODE_USE_ENV_PROXY = "1";
  if (!env.AGENT_PROVIDER_DISPATCHER?.trim()) {
    env.AGENT_PROVIDER_DISPATCHER = hasProxy ? "env-proxy" : "native";
  }
  if (!env.AGENT_PROVIDER_DNS_RESULT_ORDER?.trim()) {
    env.AGENT_PROVIDER_DNS_RESULT_ORDER = "verbatim";
  }
  return env;
}

export function configureProviderNetworkFromEnv(env = process.env) {
  const order = env.AGENT_PROVIDER_DNS_RESULT_ORDER?.trim().toLowerCase();
  if (["ipv4first", "ipv6first", "verbatim"].includes(order)) {
    dns.setDefaultResultOrder(order);
  }
  return Object.freeze({
    proxy: env.AGENT_PROVIDER_DISPATCHER === "env-proxy",
    customCa: Boolean(env.NODE_EXTRA_CA_CERTS?.trim()),
    dnsResultOrder: ["ipv4first", "ipv6first", "verbatim"].includes(order) ? order : "verbatim",
  });
}

function explicitOpenAiHostname(env) {
  const configured = env.OPENAI_BASE_URL?.trim();
  if (!configured) return null;
  let parsed;
  try {
    parsed = new URL(configured);
  } catch {
    return null;
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    !parsed.hostname ||
    parsed.hostname.includes("*")
  ) {
    return null;
  }
  return parsed.hostname.toLowerCase();
}

function mergeNoProxyHostname(env, hostname) {
  const entries = [];
  const seen = new Set();
  for (const value of [env.NO_PROXY, env.no_proxy]) {
    for (const candidate of String(value ?? "").split(",")) {
      const entry = candidate.trim();
      const key = entry.toLowerCase();
      if (!entry || seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
    }
  }
  if (!seen.has(hostname)) entries.push(hostname);
  const merged = entries.join(",");
  env.NO_PROXY = merged;
  env.no_proxy = merged;
}
