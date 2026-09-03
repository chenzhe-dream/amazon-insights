import {
  ConnectorError,
  type ConnectorCredentialScope,
  type ConnectorExecutionPolicy,
  type ConnectorHealth,
  type ConnectorId,
  type ConnectorRequest,
  type ConnectorResult,
  type RemoteMcpConnector,
} from "./connector-contract";
import {
  ResourceGovernorAdmissionError,
  type GovernedAttemptKind,
  type GovernedResource,
  type ResourceGovernor,
} from "../db/concurrency-control-repository";

interface StructuralTransportError {
  kind?: unknown;
  status?: unknown;
}

export interface RemoteMcpConnectorOptions {
  id: ConnectorId;
  physicalGovernance?: "outer-attempt" | "transport-dispatch";
  /**
   * Deprecated fallback for direct unit construction. Production callers should
   * pass per-execution scope on ConnectorRequest/probe.
   */
  organizationId?: string;
  jobId?: string;
  resourceGovernor?: ResourceGovernor;
  resolveCredential: (scope?: ConnectorCredentialScope) => Promise<string | null>;
  transport: (
    request: ConnectorRequest,
    signal: AbortSignal,
    credential: string,
    context: ConnectorAttemptContext,
  ) => Promise<unknown>;
  probeTransport: (
    signal: AbortSignal,
    credential: string,
    context: ConnectorAttemptContext,
  ) => Promise<unknown>;
  clock: () => Date;
  sleep: (durationMs: number) => Promise<void>;
  policy: Readonly<ConnectorExecutionPolicy>;
}

class AttemptTimeoutError extends Error {}

type ConnectorAttemptContext = Readonly<{
  attemptKind: GovernedAttemptKind;
  governorScope: Readonly<{ organizationId: string; jobId: string }> | null;
  resourceGovernor: ResourceGovernor | null;
  timeoutMs: number;
}>;

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
  if (
    error instanceof ResourceGovernorAdmissionError ||
    (error instanceof Error && error.name === "ResourceGovernorAdmissionError")
  ) {
    return new ConnectorError(connectorId, "rate-limit", true);
  }

  const structural =
    error && typeof error === "object"
      ? (error as StructuralTransportError)
      : null;
  if (structural?.kind === "timeout") {
    return new ConnectorError(connectorId, "timeout", true);
  }
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
  settleAfterAbort = false,
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

  const running = operation(controller.signal);
  try {
    return await Promise.race([running, timeout, parent]);
  } catch (error) {
    if (settleAfterAbort && controller.signal.aborted) {
      await running.catch(() => undefined);
    }
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (parentAbort) parentSignal?.removeEventListener("abort", parentAbort);
  }
}

async function executeAttempts(
  options: RemoteMcpConnectorOptions,
  request: ConnectorRequest,
  operation: (
    signal: AbortSignal,
    context: ConnectorAttemptContext,
  ) => Promise<unknown>,
  credential: string,
  attemptKindFor: (attempt: number) => GovernedAttemptKind,
) {
  for (let attempt = 1; attempt <= options.policy.maxAttempts; attempt += 1) {
    try {
      const context: ConnectorAttemptContext = Object.freeze({
        attemptKind: attemptKindFor(attempt),
        governorScope: request.governorScope ??
          (options.organizationId && options.jobId
            ? { organizationId: options.organizationId, jobId: options.jobId }
            : null),
        resourceGovernor: options.resourceGovernor ?? null,
        timeoutMs: options.policy.timeoutMs,
      });
      const data = await runWithTimeout(
        signal => options.physicalGovernance === "transport-dispatch"
          ? operation(signal, context)
          : runGovernedConnectorAttempt(
              options,
              request,
              context.attemptKind,
              () => operation(signal, context),
            ),
        options.policy.timeoutMs,
        request.signal,
        options.physicalGovernance === "transport-dispatch",
      );
      if (!isStructuredData(data)) {
        throw new ConnectorError(
          options.id,
          "malformed-response",
          false,
        );
      }
      if (containsCredential(data, credential)) {
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

async function runGovernedConnectorAttempt<T>(
  options: RemoteMcpConnectorOptions,
  request: ConnectorRequest,
  attemptKind: GovernedAttemptKind,
  operation: () => Promise<T>,
): Promise<T> {
  if (!options.resourceGovernor) return await operation();
  const scope = request.governorScope ??
    (options.organizationId && options.jobId
      ? { organizationId: options.organizationId, jobId: options.jobId }
      : null);
  if (!scope) {
    throw new ResourceGovernorAdmissionError();
  }
  return await options.resourceGovernor.run({
    organizationId: scope.organizationId,
    resource: resourceForConnector(options.id),
    jobId: scope.jobId,
    attemptKind,
    operation,
    leaseMs: options.policy.timeoutMs + 5_000,
    maxWaitMs: options.policy.timeoutMs,
  });
}

function resourceForConnector(connectorId: ConnectorId): GovernedResource {
  return connectorId;
}

function containsCredential(value: unknown, credential: string): boolean {
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown): boolean => {
    if (typeof candidate === "string") return candidate.includes(credential);
    if (candidate === null || typeof candidate !== "object") return false;
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    if (Array.isArray(candidate)) return candidate.some(visit);
    return Object.entries(candidate).some(
      ([key, entry]) => key.includes(credential) || visit(entry),
    );
  };
  return visit(value);
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

  const resolveCredential = async (scope?: ConnectorCredentialScope) => {
    const credential = await options.resolveCredential(scope);
    if (!credential) {
      throw new ConnectorError(options.id, "configuration", false);
    }
    return credential;
  };

  return Object.freeze({
    id: options.id,
    async execute(request: ConnectorRequest): Promise<ConnectorResult> {
      if (!request.operation.trim()) {
        throw new ConnectorError(options.id, "configuration", false);
      }
      return limiter.run(async () => {
        const credential = await resolveCredential(request.governorScope);
        const executed = await executeAttempts(
          options,
          request,
          (signal, context) =>
            options.transport(request, signal, credential, context),
          credential,
          attempt => attempt === 1 ? "initial" : "retry",
        );
        return Object.freeze({
          data: executed.data,
          source: Object.freeze({
            connectorId: options.id,
            operation: request.operation,
            fetchedAt: options.clock().toISOString(),
            attemptCount: executed.attemptCount,
          }),
        });
      });
    },
    async probe(scope?: Readonly<{ organizationId: string; jobId: string }>): Promise<ConnectorHealth> {
      const probeCheckedAt = options.clock().toISOString();
      const credential = await options.resolveCredential(scope);
      if (!credential) {
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
            {
              operation: "tools/list",
              input: {},
              ...(scope ? { governorScope: scope } : {}),
            },
            (signal, context) =>
              options.probeTransport(signal, credential, context),
            credential,
            () => "probe",
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
