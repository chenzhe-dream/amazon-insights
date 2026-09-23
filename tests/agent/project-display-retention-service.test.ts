import assert from "node:assert/strict";
import test from "node:test";

import { ProjectDisplayRetentionService } from "../../server/services/project-display-retention-service";

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
