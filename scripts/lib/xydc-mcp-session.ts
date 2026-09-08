import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { acquireXydcCoordination, type CoordinationOptions } from "./xydc-request-coordination";
import { decodeXydcResult, providerErrorFor, XydcProviderError } from "./xydc-provider-error";
export type AllowedTool = "get_asin_variations" | "get_asin_info" | "get_asin_order_trends";

export type XydcSession = { callTool(toolName: AllowedTool, args: Readonly<Record<string, unknown>>): Promise<unknown> };
export type XydcSessionOptions = Partial<Pick<CoordinationOptions, "env" | "beforeRequest" | "onRateWait" | "wallNow" | "delay">> & {
  signal?: AbortSignal;
  timeoutMs?: number;
  budgetReason?: "TIMEOUT" | "BUDGET_EXHAUSTED";
};

/** One credential lock and one lazy SDK connection, always closed before releasing the lock. */
export async function withXydcSession<T>(token: string, run: (session: XydcSession) => Promise<T>, options: XydcSessionOptions = {}): Promise<T> {
  const controller = new AbortController();
  const shutdown = new AbortController();
  const budget = options.timeoutMs ?? 15_000;
  const start = performance.now();
  const remaining = () => budget - (performance.now() - start);
  let transport: StreamableHTTPClientTransport | undefined;
  let client: Client | undefined;
  let closed = false;
  let failure: XydcProviderError | undefined;
  const requests = new Set<AbortController>();
  const bodies = new Set<() => Promise<void>>();
  const ownResponseBody = (response: Response) => {
    if (!response.body) return response;
    const reader = response.body.getReader();
    const cancel = async () => { bodies.delete(cancel); await reader.cancel(failure).catch(() => {}); };
    bodies.add(cancel);
    const body = new ReadableStream<Uint8Array>({
      async pull(stream) {
        try {
          const next = await reader.read();
          if (next.done) { bodies.delete(cancel); reader.releaseLock(); stream.close(); }
          else stream.enqueue(next.value);
        } catch (error) { bodies.delete(cancel); stream.error(error); }
      },
      cancel,
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  let closing: Promise<void> | undefined;
  const close = () => {
    closed = true;
    closing ??= (async () => {
      // Disable SDK reconnect before cancelling its detached SSE readers.
      await transport?.close().catch(() => {});
      await Promise.allSettled([...bodies].map(cancel => cancel()));
      for (const request of requests) request.abort(failure);
      requests.clear();
      await client?.close().catch(() => {});
    })();
    return closing;
  };
  const fail = (error: XydcProviderError) => { failure ??= error; controller.abort(failure); void close(); };
  const cancelled = () => fail(new XydcProviderError("CANCELLED"));
  options.signal?.addEventListener("abort", cancelled, { once: true });
  if (options.signal?.aborted) cancelled();
  const timer = setTimeout(() => fail(new XydcProviderError(options.budgetReason ?? "TIMEOUT")), Math.max(1, budget));
  const timers = new Map<ReturnType<typeof setTimeout>, string>();
  const inFlight = new Set<Promise<Response>>();
  let coordination: Awaited<ReturnType<typeof acquireXydcCoordination>> | undefined;
  const stopTimers = (method?: string) => { for (const [pending, owner] of timers) if (!method || method === owner) { clearTimeout(pending); timers.delete(pending); } };
  const bounded = async <R>(work: Promise<R>): Promise<R> => {
    if (controller.signal.aborted) throw failure;
    let listener: () => void = () => {};
    try {
      return await Promise.race([work, new Promise<never>((_, reject) => {
        listener = () => reject(failure ?? new XydcProviderError("CANCELLED"));
        controller.signal.addEventListener("abort", listener, { once: true });
      })]);
    } finally { controller.signal.removeEventListener("abort", listener); }
  };
  try {
    let endpoint: URL;
    try { endpoint = new URL((options.env ?? process.env).XYDC_MCP_URL?.trim() || "https://mcp.xydc.com/mcp"); }
    catch { throw new XydcProviderError("NOT_CONFIGURED"); }
    coordination = await acquireXydcCoordination(token, endpoint, { ...options, signal: AbortSignal.any([controller.signal, shutdown.signal]), remaining });
    let connection: Promise<void> | undefined;
    const connect = () => {
      if (connection) return connection;
      if (closed) throw failure ?? new XydcProviderError("RPC_ERROR");
      client = new Client({ name: "amazon-opportunity-insights", version: "1.0.0" });
      transport = new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: { Authorization: `Bearer ${token.trim()}` }, redirect: "error" },
        reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1, maxReconnectionDelay: 1, reconnectionDelayGrowFactor: 1 },
        fetch: (input, init) => {
          if (closed) return Promise.reject(failure ?? new XydcProviderError("CANCELLED"));
          const pending = (async () => {
            try {
              let requestTimer!: ReturnType<typeof setTimeout>;
              const method = init?.method === "GET" ? "GET" : typeof init?.body === "string" ? JSON.parse(init.body).method as string : "POST";
              const dispatched = await coordination!.dispatch(() => {
                if (closed || controller.signal.aborted) throw failure ?? new XydcProviderError("CANCELLED");
                requestTimer = setTimeout(() => fail(new XydcProviderError("TIMEOUT")), Math.min(15_000, remaining()));
                timers.set(requestTimer, method);
                const request = new AbortController();
                requests.add(request);
                const response = fetch(input, { ...init, redirect: "error", signal: request.signal });
                response.catch(() => {});
                return response;
              });
              const fetched = await dispatched.response;
              if (closed) { await fetched.body?.cancel().catch(() => {}); throw failure ?? new XydcProviderError("CANCELLED"); }
              const response = ownResponseBody(fetched);
              const notificationCompleted = method?.startsWith("notifications/") && response.ok;
              if (init?.method === "GET" || notificationCompleted) { clearTimeout(requestTimer); timers.delete(requestTimer); }
              if (!response.ok && !(init?.method === "GET" && response.status === 405)) {
                await response.body?.cancel();
                const error = providerErrorFor({ code: response.status, retryAfter: response.headers.get("retry-after") }, controller.signal, true);
                if (error.reasonCode === "RATE_LIMITED") await coordination!.rateLimited(error);
                // SDK must never receive 401/429 responses that can trigger implicit retries.
                throw error;
              }
              return response;
            } catch (error) {
              const safe = error instanceof XydcProviderError ? error : providerErrorFor(error, controller.signal, true);
              if (init?.method === "GET" || !["RATE_LIMITED", "AUTH_FAILED", "QUOTA_EXCEEDED", "NOT_FOUND"].includes(safe.reasonCode)) fail(safe);
              throw safe;
            }
            })();
          inFlight.add(pending);
          void pending.then(() => inFlight.delete(pending), () => inFlight.delete(pending));
          return pending;
        },
      });
      connection = client.connect(transport, { timeout: Math.max(1, remaining()) }).finally(() => stopTimers("initialize"));
      return connection;
    };
    let toolQueue = Promise.resolve();
    return await bounded(run({ callTool: (toolName, args) => {
      const result = toolQueue.then(async () => {
        if (!["get_asin_variations", "get_asin_info", "get_asin_order_trends"].includes(toolName)) throw new XydcProviderError("RPC_ERROR");
        try {
          await bounded(connect());
          const raw = await bounded(client!.callTool({ name: toolName, arguments: args }, undefined, { timeout: Math.max(1, remaining()) }));
          try { return decodeXydcResult(raw); }
          catch (error) { if (error instanceof XydcProviderError && error.reasonCode === "RATE_LIMITED") await coordination!.rateLimited(error); throw error; }
        } catch (error) {
          // SDK and scope deadlines race; the SDK's remaining-budget timer can win first.
          const safe = failure ?? (error instanceof McpError && error.code === ErrorCode.RequestTimeout
            ? new XydcProviderError(options.budgetReason ?? "TIMEOUT")
            : error instanceof XydcProviderError ? error : providerErrorFor(error, controller.signal, true));
          if (safe.reasonCode === "TIMEOUT" || safe.reasonCode === "CANCELLED" || safe.reasonCode === "BUDGET_EXHAUSTED") fail(safe);
          throw safe;
        } finally { stopTimers("tools/call"); }
        });
      toolQueue = result.then(() => {}, () => {});
      return result;
    } }));
  } catch (error) {
    throw failure ?? (error instanceof XydcProviderError ? error : new XydcProviderError("RPC_ERROR"));
  } finally {
    clearTimeout(timer); stopTimers(); options.signal?.removeEventListener("abort", cancelled);
    shutdown.abort(new XydcProviderError("CANCELLED"));
    await close(); await Promise.allSettled([...inFlight]); await coordination?.release();
  }
}
