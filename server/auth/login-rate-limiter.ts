export interface LoginRateLimitCheck {
  allowed: boolean;
  retryAfterSeconds: number;
}

interface Bucket {
  failures: number;
  windowStartedAt: number;
  lastTouchedAt: number;
}

export class BoundedLoginRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly windowMs: number;
  private readonly maxFailures: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: {
    windowMs: number;
    maxFailures: number;
    maxEntries: number;
    now?: () => number;
  }) {
    if (
      options.windowMs <= 0 ||
      options.maxFailures <= 0 ||
      options.maxEntries <= 0
    ) {
      throw new Error("Login rate limiter options are invalid");
    }

    this.windowMs = options.windowMs;
    this.maxFailures = options.maxFailures;
    this.maxEntries = options.maxEntries;
    this.now = options.now ?? Date.now;
  }

  check(email: string, source: string): LoginRateLimitCheck {
    const checkedAt = this.now();
    this.expireBuckets(checkedAt);

    const emailBucket = this.touchExistingBucket(this.emailKey(email), checkedAt);
    const sourceBucket = this.touchExistingBucket(
      this.sourceKey(source),
      checkedAt,
    );
    const retryAfterSeconds = Math.max(
      retryAfter(emailBucket, checkedAt, this.windowMs),
      retryAfter(sourceBucket, checkedAt, this.windowMs),
    );

    if (
      (emailBucket?.failures ?? 0) >= this.maxFailures ||
      (sourceBucket?.failures ?? 0) >= this.maxFailures
    ) {
      return {
        allowed: false,
        retryAfterSeconds,
      };
    }

    return { allowed: true, retryAfterSeconds: 0 };
  }

  recordFailure(email: string, source: string): void {
    const failedAt = this.now();
    this.expireBuckets(failedAt);
    this.incrementBucket(this.emailKey(email), failedAt);
    this.incrementBucket(this.sourceKey(source), failedAt);
    this.evictToBound(failedAt);
  }

  recordSuccess(email: string): void {
    const succeededAt = this.now();
    this.expireBuckets(succeededAt);
    this.buckets.delete(this.emailKey(email));
  }

  private emailKey(email: string): string {
    return `email:${email.trim().toLowerCase()}`;
  }

  private sourceKey(source: string): string {
    return `source:${source.trim().toLowerCase()}`;
  }

  private touchExistingBucket(key: string, now: number): Bucket | null {
    const bucket = this.buckets.get(key);
    if (!bucket) return null;
    bucket.lastTouchedAt = now;
    return bucket;
  }

  private incrementBucket(key: string, now: number): void {
    const bucket =
      this.buckets.get(key) ??
      ({ failures: 0, windowStartedAt: now, lastTouchedAt: now } satisfies Bucket);
    bucket.failures += 1;
    bucket.lastTouchedAt = now;
    this.buckets.set(key, bucket);
  }

  private expireBuckets(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStartedAt > this.windowMs) {
        this.buckets.delete(key);
      }
    }
  }

  private evictToBound(now: number): void {
    this.expireBuckets(now);
    while (this.buckets.size > this.maxEntries) {
      const oldest = [...this.buckets.entries()].sort(
        ([, left], [, right]) => left.lastTouchedAt - right.lastTouchedAt,
      )[0];
      if (!oldest) return;
      this.buckets.delete(oldest[0]);
    }
  }
}

function retryAfter(
  bucket: Bucket | null,
  now: number,
  windowMs: number,
): number {
  if (!bucket) return 0;
  const remainingMs = windowMs - (now - bucket.windowStartedAt);
  return Math.max(1, Math.ceil(remainingMs / 1_000));
}
