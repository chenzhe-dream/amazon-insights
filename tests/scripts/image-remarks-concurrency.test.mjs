import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateImageRemarkResults,
  IMAGE_REMARK_CONCURRENCY,
  IMAGE_REMARK_TIMEOUT_MS,
  runImageRemarkQueue,
  shouldQueueImageRemarkSlot,
} from "../../scripts/lib/image-remark-queue.mjs";

test("persisted ready or terminal image outcomes are not submitted again without force", () => {
  for (const status of ["ready", "upstream-empty", "timeout", "connector-failed"]) {
    assert.equal(shouldQueueImageRemarkSlot({ outcome: { status }, force: false }), false, status);
  }
  assert.equal(shouldQueueImageRemarkSlot({ outcome: null, force: false }), true);
  assert.equal(shouldQueueImageRemarkSlot({ outcome: { status: "timeout" }, force: true }), true);
});

test("fully cached image remarks stay ready when no work is queued", () => {
  assert.equal(aggregateImageRemarkResults([], { completeWithoutWork: true }), "ready");
  assert.equal(aggregateImageRemarkResults([], { completeWithoutWork: false }), "upstream-empty");
});

test("one ready and one empty slot remains an explicit per-ASIN gap until persistence is complete", () => {
  const mixed = [{ status: "ready" }, { status: "upstream-empty" }];
  assert.equal(aggregateImageRemarkResults(mixed, { persistedComplete: false }), "upstream-empty");
  assert.equal(aggregateImageRemarkResults(mixed, { persistedComplete: true }), "ready");
  assert.equal(aggregateImageRemarkResults([{ status: "ready" }, { status: "ready" }]), "ready");
  assert.equal(aggregateImageRemarkResults([
    { status: "ready" },
    { status: "connector-failed" },
    { status: "upstream-empty" },
  ], { persistedComplete: true }), "connector-failed");
  assert.equal(aggregateImageRemarkResults([
    { status: "ready" },
    { status: "timeout" },
    { status: "connector-failed" },
  ], { persistedComplete: true }), "timeout");
});

test("image queue caps concurrent workers at four and reports safe settled progress", async () => {
  let active = 0;
  let peak = 0;
  const settled = [];
  const results = await runImageRemarkQueue([0, 1, 2, 3, 4, 5], async image => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active -= 1;
    return { status: "ready" };
  }, { onSettled: event => settled.push(event) });

  assert.equal(IMAGE_REMARK_CONCURRENCY, 4);
  assert.equal(peak, 4);
  assert.deepEqual(results.map(result => result.status), ["ready", "ready", "ready", "ready", "ready", "ready"]);
  assert.deepEqual(settled.map(item => item.completed), [1, 2, 3, 4, 5, 6]);
  assert.equal(settled.every(item => item.total === 6), true);
  assert.equal(settled.every(item => Object.keys(item).sort().join(",") === "completed,status,total"), true);
});

test("image queue replaces provider text with fixed safe per-slot outcomes", async () => {
  const secret = "https://secret.test/image.jpg bearer-provider-secret";
  const results = await runImageRemarkQueue(
    ["ready", "empty", "failed"],
    async (status) => status === "ready"
      ? { status: "ready", reason: secret, body: secret }
      : status === "empty"
        ? { status: "upstream-empty", reason: secret, body: secret }
        : { status: "connector-failed", reason: secret, body: secret },
  );

  assert.deepEqual(results, [
    { status: "ready", reason: "图片备注已就绪" },
    { status: "upstream-empty", reason: "上游未返回可用图片备注" },
    { status: "connector-failed", reason: "图片分析连接器失败" },
  ]);
  assert.doesNotMatch(JSON.stringify(results), /secret\.test|provider-secret/);
});

test("each image has an independent 120 second timeout boundary", async () => {
  assert.equal(IMAGE_REMARK_TIMEOUT_MS, 120_000);
  const results = await runImageRemarkQueue(["slow", "next"], async (image, { signal }) => {
    if (image === "slow") return new Promise(resolve => signal.addEventListener("abort", () => resolve({ status: "ready" }), { once: true }));
    return { status: "upstream-empty" };
  }, { timeoutMs: 1 });

  assert.deepEqual(results.map(result => result.status), ["timeout", "upstream-empty"]);
});

test("queue frees timed-out slots without waiting for abort-aware cleanup", async () => {
  let active = 0;
  let peak = 0;
  const seen = [];
  const results = await runImageRemarkQueue(["slow", "next", "last"], (_image, { signal }) => new Promise(resolve => {
    active += 1;
    seen.push(_image);
    peak = Math.max(peak, active);
    signal.addEventListener("abort", () => setTimeout(() => {
      active -= 1;
      resolve({ status: "timeout" });
    }, 2), { once: true });
  }), { concurrency: 99, timeoutMs: 1 });

  assert.deepEqual(seen, ["slow", "next", "last"]);
  assert.equal(peak, 3);
  assert.deepEqual(results.map(result => result.status), ["timeout", "timeout", "timeout"]);
});

test("never-resolving timed-out workers return bounded results and let queued work start", async () => {
  const seen = [];
  const outcome = await Promise.race([
    runImageRemarkQueue(["never", "next"], async (image) => {
      seen.push(image);
      if (image === "never") return await new Promise(() => undefined);
      return { status: "ready" };
    }, { concurrency: 1, timeoutMs: 1 }),
    new Promise(resolve => setTimeout(() => resolve("hung"), 50)),
  ]);

  assert.notEqual(outcome, "hung");
  assert.deepEqual(seen, ["never", "next"]);
  assert.deepEqual(outcome.map(result => result.status), ["timeout", "ready"]);
});
