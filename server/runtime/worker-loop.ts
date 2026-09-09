import {
  JobLeaseLostError,
  type AgentRepository,
  type JobAttemptRecord,
} from "../db/repository";
import { BudgetExceededError } from "./budget-policy";
import type { RetryPolicy, WorkerErrorCategory } from "./retry-policy";
import {
  WORKER_ERROR_CATEGORIES,
  WorkerTaskError,
  assertRetryPolicy,
  classifyWorkerError,
  computeRetryDelayMs,
} from "./retry-policy";
import { createTrustedExecutionAbortReason } from "./execution-abort";

export type JobExecutionOutcome =
  | Readonly<{ status: "succeeded" }>
  | Readonly<{
      status: "waiting-input" | "budget-exceeded";
      error: Readonly<{
        category: WorkerErrorCategory;
        message: string;
      }>;
    }>;

export interface JobHandlerContext {
  readonly job: JobAttemptRecord;
  readonly signal: AbortSignal;
}

export type JobHandler = (
  context: JobHandlerContext,
) => Promise<unknown>;

export interface WorkerClock {
  readonly now: () => string;
  readonly sleep: (durationMs: number, signal: AbortSignal) => Promise<void>;
}

export interface WorkerLogSummary {
  readonly runId: string;
  readonly stageId: string;
  readonly stage: JobAttemptRecord["stage"];
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly classification: WorkerErrorCategory | null;
  readonly outcome: string;
  readonly durationMs: number;
}

export interface WorkerLogger {
  readonly info: (metadata: WorkerLogSummary, event: string) => void;
}

export interface JobAttemptWorkerLoopOptions {
  readonly repository: AgentRepository;
  readonly ownerId: string;
  readonly handler: JobHandler;
  readonly stage?: JobAttemptRecord["stage"];
  readonly queueTimeoutMs?: number;
  readonly leaseDurationMs: number;
  readonly heartbeatIntervalMs: number;
  readonly pollIntervalMs: number;
  readonly stopTimeoutMs: number;
  readonly retryPolicy: RetryPolicy;
  readonly clock?: WorkerClock;
  readonly random?: () => number;
  readonly logger?: WorkerLogger;
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

export class JobAttemptWorkerLoop {
  readonly #options: JobAttemptWorkerLoopOptions;
  readonly #clock: WorkerClock;
  readonly #loopController = new AbortController();
  #stopping = false;
  #loopPromise: Promise<void> | null = null;
  #stopPromise: Promise<void> | null = null;
  #activeHandlerController: AbortController | null = null;
  #runOnceTail: Promise<void> = Promise.resolve();

  constructor(options: JobAttemptWorkerLoopOptions) {
    assertPositiveSafeInteger(options.leaseDurationMs, "leaseDurationMs");
    assertPositiveSafeInteger(
      options.heartbeatIntervalMs,
      "heartbeatIntervalMs",
    );
    assertPositiveSafeInteger(options.pollIntervalMs, "pollIntervalMs");
    assertPositiveSafeInteger(options.stopTimeoutMs, "stopTimeoutMs");
    if (options.heartbeatIntervalMs >= options.leaseDurationMs) {
      throw new TypeError("heartbeatIntervalMs must be shorter than the lease");
    }
    assertRetryPolicy(options.retryPolicy);
    this.#options = options;
    this.#clock = options.clock ?? defaultWorkerClock;
  }

  start(): void {
    if (this.#stopping) throw new Error("Worker loop has already stopped");
    if (this.#loopPromise) throw new Error("Worker loop has already started");
    this.#loopPromise = this.#runLoop();
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopping = true;
    const reason = createTrustedExecutionAbortReason("worker-stopping");
    this.#loopController.abort(reason);
    this.#activeHandlerController?.abort(reason);
    this.#stopPromise = this.#finishStop();
    return this.#stopPromise;
  }

  async #finishStop(): Promise<void> {
    const draining = Promise.all([
      this.#loopPromise ?? Promise.resolve(),
      this.#runOnceTail,
    ]).then(() => undefined);
    const timeoutController = new AbortController();
    const timeout = this.#clock
      .sleep(this.#options.stopTimeoutMs, timeoutController.signal)
      .catch((error: unknown) => {
        if (!timeoutController.signal.aborted || !isAbortError(error)) throw error;
      });
    try {
      await Promise.race([draining, timeout]);
    } finally {
      timeoutController.abort();
      void draining.catch(() => undefined);
    }
  }

  async #runLoop(): Promise<void> {
    while (!this.#stopping) {
      let processed = false;
      try {
        processed = await this.runOnce();
      } catch {
        if (this.#stopping) return;
      }
      if (processed || this.#stopping) continue;
      try {
        await this.#clock.sleep(
          this.#options.pollIntervalMs,
          this.#loopController.signal,
        );
      } catch (error) {
        if (this.#loopController.signal.aborted && isAbortError(error)) return;
        throw error;
      }
    }
  }

  runOnce(): Promise<boolean> {
    const result = this.#runOnceTail.then(() => this.#runOnce());
    this.#runOnceTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #runOnce(): Promise<boolean> {
    if (this.#stopping) return false;
    const claimedAt = this.#clock.now();
    const job = await this.#options.repository.claimNextJob({
      ownerId: this.#options.ownerId,
      claimedAt,
      leaseDurationMs: this.#options.leaseDurationMs,
      ...(this.#options.stage ? { stage: this.#options.stage } : {}),
      ...(this.#options.queueTimeoutMs !== undefined ? { queueTimeoutMs: this.#options.queueTimeoutMs } : {}),
    });
    if (!job) return false;
    if (this.#stopping) {
      await this.#options.repository.releaseJobLease({
        jobId: job.id,
        ownerId: this.#options.ownerId,
        leaseGeneration: job.leaseGeneration,
        releasedAt: this.#clock.now(),
      });
      return true;
    }

    const handlerController = new AbortController();
    this.#activeHandlerController = handlerController;
    const heartbeatController = new AbortController();
    let leaseLost = false;
    const heartbeat = this.#heartbeat(
      job,
      heartbeatController.signal,
      () => {
        leaseLost = true;
        handlerController.abort(
          createTrustedExecutionAbortReason("lease-lost"),
        );
      },
    );
    let handlerError: unknown;
    let outcome: JobExecutionOutcome | undefined;
    try {
      const settlement = await settleHandler(
        Promise.resolve().then(() =>
          this.#options.handler({
            job,
            signal: handlerController.signal,
          }),
        ),
        handlerController.signal,
      );
      if (settlement.kind === "outcome") {
        outcome = validateJobExecutionOutcome(settlement.outcome);
        if (!outcome) {
          handlerError = new WorkerTaskError(
            "model-output",
            "Worker handler returned an invalid outcome",
          );
        }
      }
      if (settlement.kind === "error") handlerError = settlement.error;
    } finally {
      heartbeatController.abort();
      try {
        await heartbeat;
      } finally {
        if (this.#activeHandlerController === handlerController) {
          this.#activeHandlerController = null;
        }
      }
    }
    if (leaseLost || this.#stopping) {
      this.#logSettled(
        job,
        claimedAt,
        "infrastructure",
        leaseLost ? "lease-lost" : "worker-stopping",
      );
      return true;
    }
    if (handlerError instanceof BudgetExceededError) {
      const failedAt = this.#clock.now();
      const settled = await this.#settleLease(() =>
        this.#options.repository.failJob({
          jobId: job.id,
          ownerId: this.#options.ownerId,
          leaseGeneration: job.leaseGeneration,
          failedAt,
          retryable: false,
          retryAt: null,
          stageStatus: "budget-exceeded",
          error: {
            classification: "configuration",
            message: "Configured model budget was exceeded",
            scope: handlerError.scope,
            metric: handlerError.metric,
            used: handlerError.used,
            projected: handlerError.projected,
            limit: handlerError.limit,
          },
        }),
      );
      if (!settled) return true;
      this.#logSettled(job, claimedAt, "configuration", "budget-exceeded");
      return true;
    }
    if (handlerError !== undefined) {
      const classified = classifyWorkerError(handlerError);
      const retryCycleAttemptNumber =
        job.attemptNumber - job.retryCycleStartAttempt + 1;
      const retryable =
        classified.retryable &&
        job.attemptNumber < job.maxAttempts &&
        retryCycleAttemptNumber < this.#options.retryPolicy.maxAttempts;
      const failedAt = this.#clock.now();
      const retryAt = retryable
        ? new Date(
            new Date(failedAt).getTime() +
              computeRetryDelayMs(
                this.#options.retryPolicy,
                retryCycleAttemptNumber,
                this.#options.random ?? Math.random,
              ),
          ).toISOString()
        : null;
      const settled = await this.#settleLease(() =>
        this.#options.repository.failJob({
          jobId: job.id,
          ownerId: this.#options.ownerId,
          leaseGeneration: job.leaseGeneration,
          failedAt,
          retryable,
          retryAt,
          reportPublicationRetryPolicy: {
            maxAttempts: this.#options.retryPolicy.maxAttempts,
            initialDelayMs: this.#options.retryPolicy.initialDelayMs,
            maxDelayMs: this.#options.retryPolicy.maxDelayMs,
          },
          attemptStatus:
            classified.category === "cancelled" ? "cancelled" : "failed",
          stageStatus: retryable
            ? "queued"
            : classified.category === "cancelled"
              ? "cancelled"
              : "failed",
          error: {
            classification: classified.category,
            message: classified.message,
          },
        }),
      );
      if (!settled) return true;
      this.#logSettled(
        job,
        claimedAt,
        classified.category,
        retryable
          ? "retry-scheduled"
          : classified.category === "cancelled"
            ? "cancelled"
            : "failed",
      );
      return true;
    }
    if (
      outcome?.status === "waiting-input" ||
      outcome?.status === "budget-exceeded"
    ) {
      const failedAt = this.#clock.now();
      const settled = await this.#settleLease(() =>
        this.#options.repository.failJob({
          jobId: job.id,
          ownerId: this.#options.ownerId,
          leaseGeneration: job.leaseGeneration,
          failedAt,
          retryable: false,
          retryAt: null,
          stageStatus: outcome.status,
          error: {
            classification: outcome.error.category,
            message: outcome.error.message,
          },
        }),
      );
      if (!settled) return true;
      this.#logSettled(
        job,
        claimedAt,
        outcome.error.category,
        outcome.status,
      );
      return true;
    }
    const settled = await this.#settleLease(() =>
      this.#options.repository.completeJob({
        jobId: job.id,
        ownerId: this.#options.ownerId,
        leaseGeneration: job.leaseGeneration,
        completedAt: this.#clock.now(),
      }),
    );
    if (!settled) return true;
    this.#logSettled(job, claimedAt, null, "succeeded");
    return true;
  }

  async #settleLease(mutation: () => Promise<unknown>): Promise<boolean> {
    try {
      await mutation();
      return true;
    } catch (error) {
      if (error instanceof JobLeaseLostError) return false;
      throw error;
    }
  }

  #logSettled(
    job: JobAttemptRecord,
    startedAt: string,
    classification: WorkerErrorCategory | null,
    outcome: string,
  ): void {
    const logger = this.#options.logger;
    if (!logger) return;
    const durationMs = Math.max(
      0,
      new Date(this.#clock.now()).getTime() - new Date(startedAt).getTime(),
    );
    try {
      logger.info(
        Object.freeze({
          runId: job.runId,
          stageId: job.stageId,
          stage: job.stage,
          attemptId: job.id,
          attemptNumber: job.attemptNumber,
          classification,
          outcome,
          durationMs,
        }),
        "worker job settled",
      );
    } catch {
      // Observability must not change durable job state.
    }
  }

  async #heartbeat(
    job: JobAttemptRecord,
    signal: AbortSignal,
    onLeaseLost: () => void,
  ): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.#clock.sleep(this.#options.heartbeatIntervalMs, signal);
      } catch (error) {
        if (signal.aborted && isAbortError(error)) return;
        onLeaseLost();
        return;
      }
      if (signal.aborted) return;
      try {
        await this.#options.repository.renewJobLease({
          jobId: job.id,
          ownerId: this.#options.ownerId,
          leaseGeneration: job.leaseGeneration,
          renewedAt: this.#clock.now(),
          leaseDurationMs: this.#options.leaseDurationMs,
        });
      } catch {
        onLeaseLost();
        return;
      }
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

type HandlerSettlement =
  | Readonly<{ kind: "outcome"; outcome: unknown }>
  | Readonly<{ kind: "error"; error: unknown }>
  | Readonly<{ kind: "aborted" }>;

function settleHandler(
  handler: Promise<unknown>,
  signal: AbortSignal,
): Promise<HandlerSettlement> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: HandlerSettlement) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => finish(Object.freeze({ kind: "aborted" }));

    if (signal.aborted) {
      finish(Object.freeze({ kind: "aborted" }));
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    handler.then(
      (outcome) => finish(Object.freeze({ kind: "outcome", outcome })),
      (error: unknown) => finish(Object.freeze({ kind: "error", error })),
    );
  });
}

const workerErrorCategorySet = new Set<string>(WORKER_ERROR_CATEGORIES);

function validateJobExecutionOutcome(
  value: unknown,
): JobExecutionOutcome | undefined {
  try {
    if (!isRecord(value)) return undefined;
    if (value.status === "succeeded") {
      if (!hasExactKeys(value, ["status"])) return undefined;
      return Object.freeze({ status: "succeeded" });
    }
    if (
      value.status !== "waiting-input" &&
      value.status !== "budget-exceeded"
    ) {
      return undefined;
    }
    if (!hasExactKeys(value, ["status", "error"]) || !isRecord(value.error)) {
      return undefined;
    }
    if (!hasExactKeys(value.error, ["category", "message"])) return undefined;
    if (
      typeof value.error.category !== "string" ||
      !workerErrorCategorySet.has(value.error.category) ||
      typeof value.error.message !== "string"
    ) {
      return undefined;
    }
    return Object.freeze({
      status: value.status,
      error: Object.freeze({
        category: value.error.category as WorkerErrorCategory,
        message: value.error.message,
      }),
    });
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    keys.every(
      (key) =>
        typeof key === "string" &&
        expected.includes(key) &&
        Object.prototype.hasOwnProperty.call(value, key),
    )
  );
}

const defaultWorkerClock: WorkerClock = Object.freeze({
  now: () => new Date().toISOString(),
  sleep: (durationMs: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, durationMs);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }),
});
