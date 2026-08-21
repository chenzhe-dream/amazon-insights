import assert from "node:assert/strict";
import test from "node:test";

import { BoundedLoginRateLimiter } from "../../server/auth/login-rate-limiter";

test("failed login attempts exhaust either email or source bucket", () => {
  const limiter = new BoundedLoginRateLimiter({
    windowMs: 900_000,
    maxFailures: 5,
    maxEntries: 100,
  });

  for (let index = 0; index < 5; index += 1) {
    limiter.recordFailure("member@example.com", "203.0.113.7");
  }

  assert.equal(
    limiter.check("other@example.com", "203.0.113.7").allowed,
    false,
  );
  assert.equal(
    limiter.check("member@example.com", "203.0.113.8").allowed,
    false,
  );
  assert.equal(
    limiter.check("other@example.com", "203.0.113.8").allowed,
    true,
  );
});

test("login limiter normalizes email and source before counting failures", () => {
  const limiter = new BoundedLoginRateLimiter({
    windowMs: 900_000,
    maxFailures: 2,
    maxEntries: 100,
  });

  limiter.recordFailure(" Member@Example.COM ", " 203.0.113.7 ");
  limiter.recordFailure("member@example.com", "203.0.113.7");

  assert.equal(
    limiter.check("MEMBER@example.com", "203.0.113.8").allowed,
    false,
  );
  assert.equal(
    limiter.check("other@example.com", "203.0.113.7").allowed,
    false,
  );
});

test("successful login clears only the email bucket", () => {
  const limiter = new BoundedLoginRateLimiter({
    windowMs: 900_000,
    maxFailures: 2,
    maxEntries: 100,
  });

  limiter.recordFailure("member@example.com", "203.0.113.7");
  limiter.recordFailure("member@example.com", "203.0.113.7");
  limiter.recordSuccess("member@example.com");

  assert.equal(
    limiter.check("member@example.com", "203.0.113.8").allowed,
    true,
  );
  assert.equal(
    limiter.check("other@example.com", "203.0.113.7").allowed,
    false,
  );
});

test("login limiter expires buckets using the injected clock", () => {
  let now = 1_000;
  const limiter = new BoundedLoginRateLimiter({
    windowMs: 1_000,
    maxFailures: 1,
    maxEntries: 100,
    now: () => now,
  });

  limiter.recordFailure("member@example.com", "203.0.113.7");
  assert.deepEqual(limiter.check("member@example.com", "203.0.113.7"), {
    allowed: false,
    retryAfterSeconds: 1,
  });

  now = 2_001;

  assert.deepEqual(limiter.check("member@example.com", "203.0.113.7"), {
    allowed: true,
    retryAfterSeconds: 0,
  });
});

test("login limiter evicts old buckets and keeps later buckets bounded", () => {
  let now = 1_000;
  const limiter = new BoundedLoginRateLimiter({
    windowMs: 900_000,
    maxFailures: 1,
    maxEntries: 4,
    now: () => now,
  });

  limiter.recordFailure("first@example.com", "203.0.113.1");
  now = 2_000;
  limiter.recordFailure("second@example.com", "203.0.113.2");
  now = 3_000;
  assert.equal(
    limiter.check("first@example.com", "203.0.113.1").allowed,
    false,
  );

  now = 4_000;
  limiter.recordFailure("third@example.com", "203.0.113.3");

  assert.equal(
    limiter.check("first@example.com", "203.0.113.1").allowed,
    false,
  );
  assert.equal(
    limiter.check("second@example.com", "203.0.113.2").allowed,
    true,
  );
  assert.equal(
    limiter.check("third@example.com", "203.0.113.3").allowed,
    false,
  );
});
