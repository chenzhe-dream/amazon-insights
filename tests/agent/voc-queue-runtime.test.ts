import assert from "node:assert/strict";
import { test } from "node:test";
import { loadVocQueueTimeoutMs, VocQueueDeadlineRuntime } from "../../server/runtime/voc-queue-deadline-runtime";

test("queue timeout configuration is independent of model credentials and bounded", () => {
  assert.equal(loadVocQueueTimeoutMs({}), 300000);
  for (const value of ["1000", "3600000", "300000"]) assert.equal(loadVocQueueTimeoutMs({ AGENT_VOC_QUEUE_TIMEOUT_MS: value }), Number(value));
  for (const value of ["0", "999", "3600001", "-1", "NaN", "1.5", "", "Infinity"]) assert.throws(() => loadVocQueueTimeoutMs({ AGENT_VOC_QUEUE_TIMEOUT_MS: value }));
});

test("sweep does not overlap, sends bounded batches, and stop drains owned work", async () => {
  let release!: (value: number) => void;
  const calls: unknown[] = [];
  const runtime = new VocQueueDeadlineRuntime({ timeoutMs: 300000, clock: () => new Date("2026-09-09T01:00:00Z"),
    repository: { expireVocQueue: async (input) => { calls.push(input); return new Promise<number>((resolve) => { release = resolve; }); } },
  });
  const first = runtime.runOnce(), second = runtime.runOnce();
  assert.equal(calls.length, 1);
  let stopped = false;
  const stopping = runtime.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release(1);
  assert.equal(await first, 1);
  assert.equal(await second, 1);
  await stopping;
  assert.deepEqual(calls, [{ checkedAt: "2026-09-09T01:00:00.000Z", timeoutMs: 300000, limit: 100 }]);
  assert.equal(await runtime.runOnce(), 0);
});

test("background sweep starts immediately without a model and safely logs database failure", async () => {
  let count = 0;
  const logs: unknown[] = [];
  let observed!: () => void;
  const attempted = new Promise<void>((resolve) => { observed = resolve; });
  const runtime = new VocQueueDeadlineRuntime({ timeoutMs: 300000,
    repository: { expireVocQueue: async () => { count++; throw new Error("secret SQL password"); } },
    logger: { warn: (metadata, event) => { logs.push({ metadata, event }); observed(); } },
  });
  runtime.start();
  await attempted;
  await runtime.stop();
  assert.equal(count, 1);
  assert.equal(JSON.stringify(logs).includes("secret"), false);
  assert.equal(JSON.stringify(logs).includes("queue-expiry-failed"), true);
});
