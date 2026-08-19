import assert from "node:assert/strict";
import test from "node:test";

import { stopAgentServiceResources } from "../../server/agent-service";

test("Agent Service stop drains workers, app, and owned repository before reporting failures", async () => {
  const calls: string[] = [];
  const workerFailure = new Error("worker stop failed");

  await assert.rejects(
    stopAgentServiceResources({
      runtimes: [
        { stop: async () => { calls.push("worker-a"); throw workerFailure; } },
        { stop: async () => { calls.push("worker-b"); } },
      ],
      closeApp: async () => { calls.push("app"); },
      closeOwnedRepository: async () => { calls.push("repository"); },
    }),
    /Agent Service failed to stop cleanly/,
  );

  assert.deepEqual(calls, ["worker-a", "worker-b", "app", "repository"]);
});

