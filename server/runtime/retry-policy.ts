export const WORKER_ERROR_CATEGORIES = Object.freeze([
  "validation",
  "configuration",
  "authentication",
  "rate-limit",
  "upstream-temporary",
  "upstream-permanent",
  "data-quality",
  "model-output",
  "infrastructure",
  "cancelled",
] as const);

export type WorkerErrorCategory = (typeof WORKER_ERROR_CATEGORIES)[number];

export interface ClassifiedWorkerError {
  readonly category: WorkerErrorCategory;
  readonly retryable: boolean;
  readonly message: string;
}

export class WorkerTaskError extends Error {
  constructor(
    readonly category: WorkerErrorCategory,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkerTaskError";
  }
}

function isExplicitlyTemporary(category: WorkerErrorCategory): boolean {
  return category === "rate-limit" || category === "upstream-temporary";
}

export function classifyWorkerError(error: unknown): ClassifiedWorkerError {
  if (error instanceof WorkerTaskError) {
    return Object.freeze({
      category: error.category,
      retryable: isExplicitlyTemporary(error.category),
      message: error.message,
    });
  }

  return Object.freeze({
    category: "infrastructure",
    retryable: false,
    message: "Unhandled worker task failure",
  });
}

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

export function assertRetryPolicy(policy: RetryPolicy): void {
  assertPositiveSafeInteger(policy.maxAttempts, "maxAttempts");
  assertPositiveSafeInteger(policy.initialDelayMs, "initialDelayMs");
  assertPositiveSafeInteger(policy.maxDelayMs, "maxDelayMs");
  if (
    !Number.isFinite(policy.jitterRatio) ||
    policy.jitterRatio < 0 ||
    policy.jitterRatio > 1
  ) {
    throw new TypeError("jitterRatio must be between zero and one");
  }
}

export function computeRetryDelayMs(
  policy: RetryPolicy,
  failedAttemptNumber: number,
  random: () => number,
): number {
  assertRetryPolicy(policy);
  assertPositiveSafeInteger(failedAttemptNumber, "failedAttemptNumber");

  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) {
    throw new TypeError("random must return a value between zero and one");
  }

  const exponential =
    policy.initialDelayMs * 2 ** Math.max(0, failedAttemptNumber - 1);
  const baseDelay = Math.min(policy.maxDelayMs, exponential);
  const jitterFactor =
    1 - policy.jitterRatio + 2 * policy.jitterRatio * sample;
  return Math.min(policy.maxDelayMs, Math.round(baseDelay * jitterFactor));
}
