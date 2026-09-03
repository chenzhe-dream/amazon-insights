import type { SyncJobRepository } from "../db/sync-job-repository";
import type { ConcurrencyControlRepository } from "../db/concurrency-control-repository";
import type { SyncJobWorkerHandler } from "../services/sync-job-worker-handler";

export type SyncJobDispatcherOptions = {
  readonly syncJobs: SyncJobRepository;
  readonly handler: SyncJobWorkerHandler;
  readonly concurrencyControl?: ConcurrencyControlRepository;
  readonly workerIdPrefix?: string;
  readonly loopCount?: number;
  readonly leaseMs?: number;
  readonly wholeJobLimit?: number;
  readonly idleDelayMs?: number;
  readonly now?: () => string;
};

const defaultLoopCount = 6;
const defaultLeaseMs = 60_000;
const defaultWholeJobLimit = 4;
const defaultIdleDelayMs = 1_000;

export class SyncJobDispatcher {
  readonly #syncJobs: SyncJobRepository;
  readonly #handler: SyncJobWorkerHandler;
  readonly #concurrencyControl: ConcurrencyControlRepository | undefined;
  readonly #workerIdPrefix: string;
  readonly #loopCount: number;
  readonly #leaseMs: number;
  readonly #wholeJobLimit: number;
  readonly #idleDelayMs: number;
  readonly #now: () => string;
  #stopped = true;
  #loops: Promise<void>[] = [];
  #abortController: AbortController | null = null;

  constructor(options: SyncJobDispatcherOptions) {
    this.#syncJobs = options.syncJobs;
    this.#handler = options.handler;
    this.#concurrencyControl = options.concurrencyControl;
    this.#workerIdPrefix = options.workerIdPrefix ?? `sync-${process.pid}`;
    this.#loopCount = options.loopCount ?? defaultLoopCount;
    this.#leaseMs = options.leaseMs ?? defaultLeaseMs;
    this.#wholeJobLimit = options.wholeJobLimit ?? defaultWholeJobLimit;
    this.#idleDelayMs = options.idleDelayMs ?? defaultIdleDelayMs;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#abortController = new AbortController();
    this.#loops = Array.from({ length: this.#loopCount }, (_, index) =>
      this.#runLoop(`${this.#workerIdPrefix}-${index + 1}`),
    );
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#abortController?.abort();
    await Promise.allSettled(this.#loops);
    this.#loops = [];
    this.#abortController = null;
  }

  async runOnce(workerId = `${this.#workerIdPrefix}-once`): Promise<boolean> {
    const wholeJobLimit = await this.#effectiveWholeJobLimit();
    const lease = await this.#syncJobs.claimNext({
      workerId,
      leaseMs: this.#leaseMs,
      wholeJobLimit,
      claimedAt: this.#now(),
    });
    if (!lease) return false;
    await this.#handler.handle(lease, this.#abortController?.signal);
    return true;
  }

  async #effectiveWholeJobLimit(): Promise<number> {
    if (!this.#concurrencyControl) return this.#wholeJobLimit;
    const policy = await this.#concurrencyControl.getEffectivePolicy("*");
    return Math.min(this.#wholeJobLimit, policy.limits.wholeJob);
  }

  async #runLoop(workerId: string): Promise<void> {
    while (!this.#stopped) {
      let handled = false;
      try {
        handled = await this.runOnce(workerId);
      } catch {
        handled = false;
      }
      if (!handled && !this.#stopped) {
        await delay(this.#idleDelayMs);
      }
    }
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
