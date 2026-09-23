import assert from "node:assert/strict";
import test from "node:test";

import {
  PROJECT_DISPLAY_RETENTION_SWEEP_INTERVAL_MS,
  ProjectDisplayRetentionService,
} from "../../server/services/project-display-retention-service";

test("retired report bodies are checked every minute by default", () => {
  assert.equal(PROJECT_DISPLAY_RETENTION_SWEEP_INTERVAL_MS, 60_000);
});

test("retention sweeps on start and waits for the in-flight sweep on stop", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let sweeps = 0;
  const retention = new ProjectDisplayRetentionService({
    cleanup: async ({ limit }) => {
      assert.equal(limit, 100);
      sweeps += 1;
      await gate;
      return { purgedCount: 1 };
    },
  });
  retention.start();
  retention.start();
  assert.equal(sweeps, 1);
  const stopped = retention.stop();
  release();
  await stopped;
  assert.equal(sweeps, 1);
});

test("periodic retention sweeps never overlap and stop prevents further scans", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let sweeps = 0;
  let activeSweeps = 0;
  let maxActiveSweeps = 0;
  const retention = new ProjectDisplayRetentionService({
    intervalMs: 5,
    cleanup: async () => {
      sweeps += 1;
      activeSweeps += 1;
      maxActiveSweeps = Math.max(maxActiveSweeps, activeSweeps);
      if (sweeps === 1) await gate;
      activeSweeps -= 1;
      return { purgedCount: 0 };
    },
  });
  try {
    retention.start();
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(sweeps, 1);
    release();
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("periodic sweep did not run")), 250);
      const poll = () => {
        if (sweeps >= 2) { clearTimeout(deadline); resolve(); }
        else setTimeout(poll, 5);
      };
      poll();
    });
    await retention.stop();
    assert.equal(maxActiveSweeps, 1);
    const stoppedAt = sweeps;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(sweeps, stoppedAt);
  } finally {
    release();
    await retention.stop();
  }
});
