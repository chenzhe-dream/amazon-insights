export type DingTalkAuthAction = "workbench" | "oauth-start";

export type DingTalkAuthRateLimitResult = Readonly<{
  allowed: boolean;
  retryAfterSeconds: number;
}>;

export interface DingTalkAuthRateLimiter {
  reserve(action: DingTalkAuthAction, source: string): DingTalkAuthRateLimitResult;
}

type Bucket = {
  count: number;
  windowStartedAt: number;
  lastTouchedAt: number;
};

export class BoundedDingTalkAuthRateLimiter implements DingTalkAuthRateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #windowMs: number;
  readonly #maxPerSource: number;
  readonly #maxGlobal: number;
  readonly #maxEntries: number;
  readonly #now: () => number;

  constructor(options: {
    windowMs: number;
    maxPerSource: number;
    maxGlobal: number;
    maxEntries: number;
    now?: () => number;
  }) {
    if (
      !Number.isSafeInteger(options.windowMs) || options.windowMs < 1 ||
      !Number.isSafeInteger(options.maxPerSource) || options.maxPerSource < 1 ||
      !Number.isSafeInteger(options.maxGlobal) || options.maxGlobal < options.maxPerSource ||
      !Number.isSafeInteger(options.maxEntries) || options.maxEntries < 3
    ) {
      throw new TypeError("DingTalk rate limiter options are invalid");
    }
    this.#windowMs = options.windowMs;
    this.#maxPerSource = options.maxPerSource;
    this.#maxGlobal = options.maxGlobal;
    this.#maxEntries = options.maxEntries;
    this.#now = options.now ?? Date.now;
  }

  reserve(action: DingTalkAuthAction, source: string): DingTalkAuthRateLimitResult {
    const now = this.#now();
    this.#expire(now);
    const normalizedSource = source.trim().toLowerCase().slice(0, 200) || "unknown-source";
    const sourceKey = `source:${action}:${normalizedSource}`;
    const globalKey = `global:${action}`;
    const sourceBucket = this.#buckets.get(sourceKey);
    const globalBucket = this.#buckets.get(globalKey);
    if (
      (sourceBucket?.count ?? 0) >= this.#maxPerSource ||
      (globalBucket?.count ?? 0) >= this.#maxGlobal
    ) {
      return Object.freeze({
        allowed: false,
        retryAfterSeconds: Math.max(
          retryAfter(sourceBucket, now, this.#windowMs),
          retryAfter(globalBucket, now, this.#windowMs),
        ),
      });
    }
    this.#increment(sourceKey, now);
    this.#increment(globalKey, now);
    this.#evictToBound();
    return Object.freeze({ allowed: true, retryAfterSeconds: 0 });
  }

  #increment(key: string, now: number): void {
    const bucket = this.#buckets.get(key) ?? {
      count: 0,
      windowStartedAt: now,
      lastTouchedAt: now,
    };
    bucket.count += 1;
    bucket.lastTouchedAt = now;
    this.#buckets.set(key, bucket);
  }

  #expire(now: number): void {
    for (const [key, bucket] of this.#buckets) {
      if (now - bucket.windowStartedAt >= this.#windowMs) this.#buckets.delete(key);
    }
  }

  #evictToBound(): void {
    while (this.#buckets.size > this.#maxEntries) {
      const oldestSource = [...this.#buckets.entries()]
        .filter(([key]) => key.startsWith("source:"))
        .sort(([, left], [, right]) => left.lastTouchedAt - right.lastTouchedAt)[0];
      if (!oldestSource) return;
      this.#buckets.delete(oldestSource[0]);
    }
  }
}

function retryAfter(bucket: Bucket | undefined, now: number, windowMs: number): number {
  if (!bucket) return 0;
  return Math.max(1, Math.ceil((windowMs - (now - bucket.windowStartedAt)) / 1_000));
}
