import { callSorftimeTool } from "./sorftime-mcp-client.mjs";

export function createSorftimeBudget({ deadline = Date.now() + 90_000, requestTimeoutMs = 20_000,
  optionalTimeoutMs = 5_000, callTool = callSorftimeTool } = {}) {
  return (optional = false) => async (key, name, args) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new DOMException("Sorftime collection budget exhausted", "TimeoutError");
    const controller = new AbortController();
    const timeout = Math.max(1, Math.min(remaining, optional ? optionalTimeoutMs : requestTimeoutMs));
    let timer;
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new DOMException("Sorftime request budget exhausted", "TimeoutError");
        controller.abort(error);
        reject(error);
      }, timeout);
    });
    try {
      return await Promise.race([callTool(key, name, args, { signal: controller.signal,
        ...(optional ? { optionalEnrichment: true, emitDiagnostics: false } : {}) }), expired]);
    } finally { clearTimeout(timer); }
  };
}
