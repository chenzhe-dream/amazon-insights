import type {
  AgentRepository,
  JobAttemptRecord,
} from "../db/repository";
import { BudgetExceededError } from "./budget-policy";
import type { RetryPolicy, WorkerErrorCategory } from "./retry-policy";
import {
  assertRetryPolicy,
  classifyWorkerError,
  computeRetryDelayMs,
} from "./retry-policy";

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
) => Promise<JobExecutionOutcome>;

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
    this.#loopController.abort();
    this.#activeHandlerController?.abort();
    this.#stopPromise = this.#finishStop();
    return this.#stopPromise;
  }

  async #finishStop(): Promise<void> {
    if (!this.#loopPromise) return;
    const timeoutController = new AbortController();
    const timeout = this.#clock
      .sleep(this.#options.stopTimeoutMs, timeoutController.signal)
      .catch((error: unknown) => {
        if (!timeoutController.signal.aborted || !isAbortError(error)) throw error;
      });
    try {
      await Promise.race([this.#loopPromise, timeout]);
    } finally {
      timeoutController.abort();
      void this.#loopPromise.catch(() => undefined);
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

  async runOnce(): Promise<boolean> {
    if (this.#stopping) return false;
    const claimedAt = this.#clock.now();
    const job = await this.#options.repository.claimNextJob({
      ownerId: this.#options.ownerId,
      claimedAt,
      leaseDurationMs: this.#options.leaseDurationMs,
    });
    if (!job) return false;

    const handlerController = new AbortController();
    this.#activeHandlerController = handlerController;
    const heartbeatController = new AbortController();
    let leaseLost = false;
    const heartbeat = this.#heartbeat(
      job,
      heartbeatController.signal,
      () => {
        leaseLost = true;
        handlerController.abort();
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
      if (settlement.kind === "outcome") outcome = settlement.outcome;
      if (settlement.kind === "error") handlerError = settlement.error;
    } finally {
      heartbeatController.abort();
      await heartbeat;
      if (this.#activeHandlerController === handlerController) {
        this.#activeHandlerController = null;
      }
    }
    if (leaseLost || this.#stopping) {
      this.#logSettled(
        job,
        claimedAt,
        leaseLost ? "infrastructure" : "cancelled",
        leaseLost ? "lease-lost" : "aborted",
      );
      return true;
    }
    if (handlerError instanceof BudgetExceededError) {
      const failedAt = this.#clock.now();
      await this.#options.repository.failJob({
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
      });
      this.#logSettled(job, claimedAt, "configuration", "budget-exceeded");
      return true;
    }
    if (handlerError !== undefined) {
      const classified = classifyWorkerError(handlerError);
      const retryable =
        classified.retryable &&
        job.attemptNumber <
          Math.min(job.maxAttempts, this.#options.retryPolicy.maxAttempts);
      const failedAt = this.#clock.now();
      const retryAt = retryable
        ? new Date(
            new Date(failedAt).getTime() +
              computeRetryDelayMs(
                this.#options.retryPolicy,
                job.attemptNumber,
                this.#options.random ?? Math.random,
              ),
          ).toISOString()
        : null;
      await this.#options.repository.failJob({
        jobId: job.id,
        ownerId: this.#options.ownerId,
        leaseGeneration: job.leaseGeneration,
        failedAt,
        retryable,
        retryAt,
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
      });
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
    if (outcome?.status === "waiting-input" || outcome?.status === "budget-exceeded") {
      const failedAt = this.#clock.now();
      await this.#options.repository.failJob({
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
      });
      this.#logSettled(
        job,
        claimedAt,
        outcome.error.category,
        outcome.status,
      );
      return true;
    }
    await this.#options.repository.completeJob({
      jobId: job.id,
      ownerId: this.#options.ownerId,
      leaseGeneration: job.leaseGeneration,
      completedAt: this.#clock.now(),
    });
    this.#logSettled(job, claimedAt, null, "succeeded");
    return true;
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
        throw error;
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
  | Readonly<{ kind: "outcome"; outcome: JobExecutionOutcome }>
  | Readonly<{ kind: "error"; error: unknown }>
  | Readonly<{ kind: "aborted" }>;

function settleHandler(
  handler: Promise<JobExecutionOutcome>,
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
