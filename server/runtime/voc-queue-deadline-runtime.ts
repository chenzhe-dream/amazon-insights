import { setTimeout as sleep } from "node:timers/promises";
import type { VocQueueRepositoryCapability } from "../db/repository";
import { DEFAULT_VOC_QUEUE_TIMEOUT_MS, vocQueueCutoff } from "../domain/voc/queue-deadline";

export function loadVocQueueTimeoutMs(env: Record<string, string | undefined>): number {
  const raw = env.AGENT_VOC_QUEUE_TIMEOUT_MS;
  if (raw !== undefined && !/^\d+$/.test(raw)) throw new TypeError("Invalid AGENT_VOC_QUEUE_TIMEOUT_MS");
  const value = raw === undefined ? DEFAULT_VOC_QUEUE_TIMEOUT_MS : Number(raw);
  vocQueueCutoff(new Date(0).toISOString(), value);
  return value;
}

interface QueueRuntimeOptions {
  repository: VocQueueRepositoryCapability;
  timeoutMs: number;
  clock?: () => Date;
  logger?: { warn(metadata: Record<string, unknown>, event: string): void };
}

export class VocQueueDeadlineRuntime {
  readonly #options: QueueRuntimeOptions;
  readonly #controller = new AbortController();
  #active: Promise<number> | null = null;
  #loop: Promise<void> | null = null;

  constructor(options: QueueRuntimeOptions) {
    vocQueueCutoff(new Date(0).toISOString(), options.timeoutMs);
    this.#options = options;
  }

  start(): void {
    if (this.#loop || this.#controller.signal.aborted) throw new Error("Queue deadline runtime already started or stopped");
    this.#loop = this.#run();
  }

  runOnce(): Promise<number> {
    if (this.#controller.signal.aborted) return Promise.resolve(0);
    if (this.#active) return this.#active;
    this.#active = this.#options.repository.expireVocQueue({
      checkedAt: (this.#options.clock?.() ?? new Date()).toISOString(),
      timeoutMs: this.#options.timeoutMs,
      limit: 100,
    }).finally(() => { this.#active = null; });
    return this.#active;
  }

  async #run(): Promise<void> {
    while (!this.#controller.signal.aborted) {
      try { await this.runOnce(); }
      catch { this.#options.logger?.warn({ outcome: "queue-expiry-failed" }, "VOC queue deadline check failed"); }
      try { await sleep(5000, undefined, { signal: this.#controller.signal }); }
      catch { if (this.#controller.signal.aborted) return; }
    }
  }

  async stop(): Promise<void> {
    this.#controller.abort();
    await Promise.allSettled([this.#loop, this.#active]);
  }
}
