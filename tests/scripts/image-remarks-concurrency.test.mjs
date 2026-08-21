import assert from "node:assert/strict";
import test from "node:test";

import { IMAGE_REMARK_TIMEOUT_MS, runImageRemarkQueue } from "../../scripts/lib/image-remark-queue.mjs";

test("image queue caps concurrent workers at two and continues after a connector failure", async () => {
  let active = 0;
  let peak = 0;
  const seen = [];
  const results = await runImageRemarkQueue(["one", "two", "three"], async image => {
    active += 1;
    peak = Math.max(peak, active);
    seen.push(image);
    await Promise.resolve();
    active -= 1;
    if (image === "two") throw new Error("connector unavailable");
    return { status: "ready" };
  });

  assert.equal(peak, 2);
  assert.deepEqual(seen, ["one", "two", "three"]);
  assert.deepEqual(results.map(result => result.status), ["ready", "connector-failed", "ready"]);
});

test("each image has an independent 90 second timeout boundary", async () => {
  assert.equal(IMAGE_REMARK_TIMEOUT_MS, 90_000);
  const results = await runImageRemarkQueue(["slow", "next"], async (image, { signal }) => {
    if (image === "slow") return new Promise(resolve => signal.addEventListener("abort", () => resolve({ status: "ready" }), { once: true }));
    return { status: "upstream-empty" };
  }, { timeoutMs: 1 });

  assert.deepEqual(results.map(result => result.status), ["timeout", "upstream-empty"]);
});

test("queue clamps requested concurrency and waits for abort-aware workers before freeing a timeout slot", async () => {
  let active = 0;
  let peak = 0;
  const results = await runImageRemarkQueue(["slow", "next", "last"], (_image, { signal }) => new Promise(resolve => {
    active += 1;
    peak = Math.max(peak, active);
    signal.addEventListener("abort", () => setTimeout(() => {
      active -= 1;
      resolve({ status: "timeout" });
    }, 2), { once: true });
  }), { concurrency: 99, timeoutMs: 1 });

  assert.equal(peak, 2);
  assert.deepEqual(results.map(result => result.status), ["timeout", "timeout", "timeout"]);
  assert.equal(active, 0);
});
