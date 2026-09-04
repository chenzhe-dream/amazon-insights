export type DingTalkAuthAction = "workbench" | "oauth-start";

export type DingTalkAuthRateLimitResult = Readonly<{
  allowed: boolean;
  retryAfterSeconds: number;
}>;

export interface DingTalkAuthRateLimiter {
  reserve(action: DingTalkAuthAction): DingTalkAuthRateLimitResult;
}

type Bucket = {
  count: number;
  windowStartedAt: number;
};

export class BoundedDingTalkAuthRateLimiter implements DingTalkAuthRateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #windowMs: number;
  readonly #maxGlobal: number;
  readonly #now: () => number;

  constructor(options: {
    windowMs: number;
    maxGlobal: number;
    now?: () => number;
  }) {
    if (
      !Number.isSafeInteger(options.windowMs) || options.windowMs < 1 ||
      !Number.isSafeInteger(options.maxGlobal) || options.maxGlobal < 1
    ) {
      throw new TypeError("DingTalk rate limiter options are invalid");
    }
    this.#windowMs = options.windowMs;
    this.#maxGlobal = options.maxGlobal;
    this.#now = options.now ?? Date.now;
  }

  reserve(action: DingTalkAuthAction): DingTalkAuthRateLimitResult {
    const now = this.#now();
    this.#expire(now);
    const globalKey = `global:${action}`;
    const globalBucket = this.#buckets.get(globalKey);
    if ((globalBucket?.count ?? 0) >= this.#maxGlobal) {
      return Object.freeze({
        allowed: false,
        retryAfterSeconds: retryAfter(globalBucket, now, this.#windowMs),
      });
    }
    this.#increment(globalKey, now);
    return Object.freeze({ allowed: true, retryAfterSeconds: 0 });
  }

  #increment(key: string, now: number): void {
    const bucket = this.#buckets.get(key) ?? {
      count: 0,
      windowStartedAt: now,
    };
    bucket.count += 1;
    this.#buckets.set(key, bucket);
  }

  #expire(now: number): void {
    for (const [key, bucket] of this.#buckets) {
      if (now - bucket.windowStartedAt >= this.#windowMs) this.#buckets.delete(key);
    }
  }

}

function retryAfter(bucket: Bucket | undefined, now: number, windowMs: number): number {
  if (!bucket) return 0;
  return Math.max(1, Math.ceil((windowMs - (now - bucket.windowStartedAt)) / 1_000));
}
