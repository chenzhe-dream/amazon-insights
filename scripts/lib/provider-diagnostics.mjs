const diagnosticPrefix = "@@provider-diagnostic@@";
const connectors = new Set(["sellerSprite", "sif", "sorftime"]);
const failureKinds = new Set([
  "dns", "tls", "proxy", "connection", "timeout", "http", "rpc", "schema",
  "governor", "provider-degraded",
]);
const causeCodes = new Set([
  "DNS_NOT_FOUND", "DNS_AGAIN", "TLS_CERTIFICATE", "PROXY_CONNECT",
  "CONNECTION_REFUSED", "CONNECTION_RESET", "CONNECT_TIMEOUT", "REQUEST_TIMEOUT",
  "HTTP_4XX", "HTTP_5XX", "MCP_RPC", "MCP_SCHEMA", "RESOURCE_GOVERNOR",
  "PROVIDER_DEGRADED", "UNKNOWN_TRANSPORT",
]);
const processTrackers = new Map();

export class ProviderDiagnosticError extends Error {
  constructor(diagnostic, options) {
    super("Provider request failed", options);
    this.name = "ProviderDiagnosticError";
    this.diagnostic = sanitizeProviderDiagnostic(diagnostic);
  }
}

export async function runWithProviderDiagnostics(input, operation) {
  const tracker = trackerFor(input.env?.AGENT_SYNC_JOB_ID);
  if (tracker?.isDegraded(input.connector)) {
    const diagnostic = providerDegradedDiagnostic(input);
    process.stderr.write(`${formatProviderDiagnosticLine(diagnostic)}\n`);
    process.exitCode = 1;
    throw new ProviderDiagnosticError(diagnostic);
  }
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ProviderDiagnosticError) throw error;
    const diagnostic = classifyProviderFailure(error, input);
    if (!input.env?.AGENT_SYNC_JOB_ID) throw error;
    tracker?.record(diagnostic);
    process.stderr.write(`${formatProviderDiagnosticLine(diagnostic)}\n`);
    process.exitCode = 1;
    throw new ProviderDiagnosticError(diagnostic, { cause: error });
  }
}

export function createProviderDegradationTracker({ threshold = 1 } = {}) {
  const failures = new Map();
  const tracker = {
    record(diagnostic) {
      const safe = sanitizeProviderDiagnostic(diagnostic);
      if (safe.failureKind === "provider-degraded") return;
      const current = failures.get(safe.connector) ?? { count: 0, diagnostic: safe };
      failures.set(safe.connector, { count: current.count + 1, diagnostic: current.diagnostic });
    },
    recordAll(diagnostics) {
      for (const diagnostic of diagnostics ?? []) tracker.record(diagnostic);
    },
    isDegraded(connector) {
      return (failures.get(connector)?.count ?? 0) >= threshold;
    },
    skipDiagnostics(connector, stage, asins) {
      if (!tracker.isDegraded(connector)) return [];
      return asins.map((asin) => providerDegradedDiagnostic({ connector, stage, asin }));
    },
    snapshot() {
      return [...failures.entries()]
        .filter(([, value]) => value.count >= threshold)
        .map(([connector, value]) => ({
          connector,
          failureKind: value.diagnostic.failureKind,
          causeCode: value.diagnostic.causeCode,
        }))
        .sort((left, right) => left.connector.localeCompare(right.connector));
    },
  };
  return Object.freeze(tracker);
}

export function classifyProviderFailure(error, input) {
  const code = nestedCode(error);
  const kind = error?.kind;
  const name = error?.name;
  let failureKind = "connection";
  let causeCode = "UNKNOWN_TRANSPORT";

  if (name === "ResourceGovernorAdmissionError") {
    failureKind = "governor";
    causeCode = "RESOURCE_GOVERNOR";
  } else if (kind === "http") {
    failureKind = "http";
    causeCode = Number(error?.status) >= 500 ? "HTTP_5XX" : "HTTP_4XX";
  } else if (kind === "rpc") {
    failureKind = "rpc";
    causeCode = "MCP_RPC";
  } else if (kind === "malformed" || kind === "schema" || error instanceof SyntaxError) {
    failureKind = "schema";
    causeCode = "MCP_SCHEMA";
  } else if (["ENOTFOUND"].includes(code)) {
    failureKind = "dns";
    causeCode = "DNS_NOT_FOUND";
  } else if (["EAI_AGAIN"].includes(code)) {
    failureKind = "dns";
    causeCode = "DNS_AGAIN";
  } else if (/^(?:ERR_TLS_|CERT_|UNABLE_TO_VERIFY|DEPTH_ZERO|SELF_SIGNED)/.test(code)) {
    failureKind = "tls";
    causeCode = "TLS_CERTIFICATE";
  } else if (/PROXY/.test(code)) {
    failureKind = "proxy";
    causeCode = "PROXY_CONNECT";
  } else if (["UND_ERR_CONNECT_TIMEOUT", "ETIMEDOUT"].includes(code)) {
    failureKind = "timeout";
    causeCode = "CONNECT_TIMEOUT";
  } else if (name === "AbortError" || code === "ABORT_ERR") {
    failureKind = "timeout";
    causeCode = "REQUEST_TIMEOUT";
  } else if (code === "ECONNREFUSED") {
    causeCode = "CONNECTION_REFUSED";
  } else if (["ECONNRESET", "UND_ERR_SOCKET"].includes(code)) {
    causeCode = "CONNECTION_RESET";
  }

  return sanitizeProviderDiagnostic({
    connector: input.connector,
    stage: input.stage,
    asin: input.asin,
    failureKind,
    causeCode,
  });
}

export function providerDegradedDiagnostic(input) {
  return sanitizeProviderDiagnostic({
    connector: input.connector,
    stage: input.stage,
    asin: input.asin,
    failureKind: "provider-degraded",
    causeCode: "PROVIDER_DEGRADED",
  });
}

export function sanitizeProviderDiagnostic(input) {
  const connector = connectors.has(input?.connector) ? input.connector : "sif";
  const stage = safeIdentifier(input?.stage, "unknown-stage", 100);
  const asin = /^[A-Z0-9]{10}$/.test(String(input?.asin ?? ""))
    ? String(input.asin)
    : "UNKNOWNASIN";
  const failureKind = failureKinds.has(input?.failureKind)
    ? input.failureKind
    : "connection";
  const causeCode = causeCodes.has(input?.causeCode)
    ? input.causeCode
    : "UNKNOWN_TRANSPORT";
  return Object.freeze({ connector, stage, asin, failureKind, causeCode });
}

export function formatProviderDiagnosticLine(diagnostic) {
  return `${diagnosticPrefix}${JSON.stringify(sanitizeProviderDiagnostic(diagnostic))}`;
}

export function parseProviderDiagnosticOutput(output, { maxEntries = 32 } = {}) {
  const entries = [];
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const index = line.indexOf(diagnosticPrefix);
    if (index < 0) continue;
    try {
      const parsed = JSON.parse(line.slice(index + diagnosticPrefix.length));
      entries.push(sanitizeProviderDiagnostic(parsed));
    } catch {
      // Ignore untrusted malformed child output.
    }
  }
  const unique = new Map(entries.map((entry) => [JSON.stringify(entry), entry]));
  return [...unique.values()].slice(-Math.max(0, Math.min(64, maxEntries)));
}

export function createBoundedTail(maxBytes = 16_384) {
  let value = Buffer.alloc(0);
  return Object.freeze({
    append(chunk) {
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      value = Buffer.concat([value, next]).subarray(-maxBytes);
    },
    text() {
      return value.toString("utf8");
    },
  });
}

function nestedCode(error) {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const code = current.code;
    if (typeof code === "string" && code.length <= 80) return code.toUpperCase();
    current = current.cause;
  }
  return "";
}

function trackerFor(jobId) {
  if (!jobId) return null;
  if (!processTrackers.has(jobId)) {
    processTrackers.set(jobId, createProviderDegradationTracker());
  }
  return processTrackers.get(jobId);
}

function safeIdentifier(value, fallback, maxLength) {
  const candidate = String(value ?? "").trim();
  return /^[A-Za-z0-9_-]+$/.test(candidate)
    ? candidate.slice(0, maxLength)
    : fallback;
}
