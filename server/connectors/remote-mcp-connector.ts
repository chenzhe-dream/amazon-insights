import {
  ConnectorError,
  type ConnectorExecutionPolicy,
  type ConnectorHealth,
  type ConnectorId,
  type ConnectorRequest,
  type ConnectorResult,
  type RemoteMcpConnector,
} from "./connector-contract";

interface StructuralTransportError {
  kind?: unknown;
  status?: unknown;
}

export interface RemoteMcpConnectorOptions {
  id: ConnectorId;
  configured: () => boolean;
  transport: (
    request: ConnectorRequest,
    signal: AbortSignal,
  ) => Promise<unknown>;
  probeTransport: (signal: AbortSignal) => Promise<unknown>;
  clock: () => Date;
  sleep: (durationMs: number) => Promise<void>;
  policy: Readonly<ConnectorExecutionPolicy>;
}

class AttemptTimeoutError extends Error {}

class BoundedConnectorLimiter {
  readonly #connectorId: ConnectorId;
  readonly #maxConcurrent: number;
  readonly #maxQueue: number;
  #active = 0;
  readonly #queue: Array<() => void> = [];

  constructor(
    connectorId: ConnectorId,
    maxConcurrent: number,
    maxQueue: number,
  ) {
    this.#connectorId = connectorId;
    this.#maxConcurrent = maxConcurrent;
    this.#maxQueue = maxQueue;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await operation();
    } finally {
      this.#release();
    }
  }

  #acquire(): Promise<void> {
    if (this.#active < this.#maxConcurrent) {
      this.#active += 1;
      return Promise.resolve();
    }
    if (this.#queue.length >= this.#maxQueue) {
      return Promise.reject(
        new ConnectorError(this.#connectorId, "rate-limit", true),
      );
    }
    return new Promise(resolve => this.#queue.push(resolve));
  }

  #release() {
    const next = this.#queue.shift();
    if (next) {
      next();
      return;
    }
    this.#active -= 1;
  }
}

function assertPolicy(policy: Readonly<ConnectorExecutionPolicy>) {
  const positive = [
    policy.timeoutMs,
    policy.maxAttempts,
    policy.maxConcurrent,
  ];
  const nonNegative = [policy.retryDelayMs, policy.maxQueue];
  if (
    positive.some(value => !Number.isSafeInteger(value) || value <= 0) ||
    nonNegative.some(value => !Number.isSafeInteger(value) || value < 0) ||
    policy.maxAttempts > 2
  ) {
    throw new TypeError("Invalid connector execution policy");
  }
}

function isStructuredData(
  value: unknown,
): value is Readonly<Record<string, unknown>> | readonly unknown[] {
  return value !== null && typeof value === "object";
}

function classifyError(connectorId: ConnectorId, error: unknown) {
  if (error instanceof ConnectorError) return error;
  if (error instanceof AttemptTimeoutError) {
    return new ConnectorError(connectorId, "timeout", true);
  }

  const structural =
    error && typeof error === "object"
      ? (error as StructuralTransportError)
      : null;
  if (structural?.kind === "malformed" || error instanceof SyntaxError) {
    return new ConnectorError(connectorId, "malformed-response", false);
  }
  if (structural?.kind === "http") {
    const status = structural.status;
    if (status === 401 || status === 403) {
      return new ConnectorError(connectorId, "authentication", false);
    }
    if (status === 429) {
      return new ConnectorError(connectorId, "rate-limit", true);
    }
    if (typeof status === "number" && status >= 500) {
      return new ConnectorError(connectorId, "upstream-temporary", true);
    }
    return new ConnectorError(connectorId, "upstream-permanent", false);
  }
  if (error instanceof TypeError) {
    return new ConnectorError(connectorId, "upstream-temporary", true);
  }
  return new ConnectorError(connectorId, "upstream-permanent", false);
}

async function runWithTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let parentAbort: (() => void) | null = null;

  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new AttemptTimeoutError());
    }, timeoutMs);
  });
  const parent = new Promise<never>((_resolve, reject) => {
    parentAbort = () => {
      controller.abort();
      reject(new AttemptTimeoutError());
    };
    if (parentSignal?.aborted) parentAbort();
    else parentSignal?.addEventListener("abort", parentAbort, { once: true });
  });

  try {
    return await Promise.race([operation(controller.signal), timeout, parent]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (parentAbort) parentSignal?.removeEventListener("abort", parentAbort);
  }
}

async function executeAttempts(
  options: RemoteMcpConnectorOptions,
  request: ConnectorRequest,
  operation: (signal: AbortSignal) => Promise<unknown>,
) {
  for (let attempt = 1; attempt <= options.policy.maxAttempts; attempt += 1) {
    try {
      const data = await runWithTimeout(
        operation,
        options.policy.timeoutMs,
        request.signal,
      );
      if (!isStructuredData(data)) {
        throw new ConnectorError(
          options.id,
          "malformed-response",
          false,
        );
      }
      return { data, attemptCount: attempt };
    } catch (error) {
      const classified = classifyError(options.id, error);
      if (!classified.retryable || attempt === options.policy.maxAttempts) {
        throw classified;
      }
      await options.sleep(options.policy.retryDelayMs);
    }
  }
  throw new ConnectorError(options.id, "upstream-permanent", false);
}

export function createRemoteMcpConnector(
  options: RemoteMcpConnectorOptions,
): RemoteMcpConnector {
  assertPolicy(options.policy);
  const limiter = new BoundedConnectorLimiter(
    options.id,
    options.policy.maxConcurrent,
    options.policy.maxQueue,
  );

  const configured = () => {
    if (!options.configured()) {
      throw new ConnectorError(options.id, "configuration", false);
    }
  };

  return Object.freeze({
    id: options.id,
    async execute(request: ConnectorRequest): Promise<ConnectorResult> {
      configured();
      if (!request.operation.trim()) {
        throw new ConnectorError(options.id, "configuration", false);
      }
      return limiter.run(async () => {
        const executed = await executeAttempts(options, request, signal =>
          options.transport(request, signal),
        );
        return Object.freeze({
          data: executed.data,
          source: Object.freeze({
            connectorId: options.id,
            operation: request.operation,
            fetchedAt: options.clock().toISOString(),
            attemptCount: executed.attemptCount,
            protocol: "mcp-json-rpc" as const,
          }),
        });
      });
    },
    async probe(): Promise<ConnectorHealth> {
      const probeCheckedAt = options.clock().toISOString();
      if (!options.configured()) {
        const displayName =
          options.id === "sellerSprite" ? "SellerSprite" :
          options.id === "sorftime" ? "Sorftime" : "SIF";
        return Object.freeze({
          connectorId: options.id,
          configured: false,
          available: false,
          reason: `${displayName} connector credential is not configured`,
          checkedAt: probeCheckedAt,
        });
      }
      try {
        await limiter.run(() =>
          executeAttempts(
            options,
            { operation: "tools/list", input: {} },
            signal => options.probeTransport(signal),
          ),
        );
        return Object.freeze({
          connectorId: options.id,
          configured: true,
          available: true,
          reason: null,
          checkedAt: probeCheckedAt,
        });
      } catch (error) {
        const classified = classifyError(options.id, error);
        return Object.freeze({
          connectorId: options.id,
          configured: true,
          available: false,
          reason: classified.message,
          checkedAt: probeCheckedAt,
        });
      }
    },
  });
}
