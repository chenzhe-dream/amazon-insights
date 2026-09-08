import { XydcProviderError, decodeXydcResult, providerErrorFor } from "./xydc-provider-error";
export { unwrapXydcToolResult } from "./xydc-provider-error";
import { withXydcSession, type AllowedTool } from "./xydc-mcp-session";
export { XydcProviderError } from "./xydc-provider-error";
export { withXydcSession } from "./xydc-mcp-session";
export type { AllowedTool } from "./xydc-mcp-session";
const ALLOWED_TOOLS = new Set(["get_asin_variations", "get_asin_info", "get_asin_order_trends"]);
export interface XydcClientOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  beforeRequest?: () => void | Promise<void>;
  callTool?: (input: {
    toolName: AllowedTool;
    args: Readonly<Record<string, unknown>>;
    headers: Readonly<{ Authorization: string }>;
    signal: AbortSignal;
  }) => Promise<unknown>;
}

export function xydcRequestHeaders(token: string) {
  if (!token.trim()) throw new XydcProviderError("NOT_CONFIGURED");
  return Object.freeze({ Authorization: `Bearer ${token.trim()}` });
}

export async function callXydcTool(
  token: string,
  toolName: AllowedTool,
  args: Readonly<Record<string, unknown>>,
  options: XydcClientOptions = {},
) {
  if (!ALLOWED_TOOLS.has(toolName)) throw new XydcProviderError("RPC_ERROR");
  if (!options.callTool) return withXydcSession(token, session => session.callTool(toolName, args), options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new XydcProviderError("TIMEOUT")), options.timeoutMs ?? 15_000);
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  try {
    const headers = xydcRequestHeaders(token);
    if (signal.aborted) throw new XydcProviderError(options.signal?.aborted ? "CANCELLED" : "TIMEOUT");
    await options.beforeRequest?.();
    return decodeXydcResult(await options.callTool({ toolName, args, headers, signal }));
  } catch (error) {
    if (error instanceof XydcProviderError) throw error;
    throw providerErrorFor(error, signal, true);
  } finally { clearTimeout(timer); }
}
