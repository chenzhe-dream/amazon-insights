import assert from "node:assert/strict";
import test from "node:test";

import { stopAgentServiceResources } from "../../server/agent-service";
import {
  SellerSpriteQuotaRefreshScheduler,
  type ConcurrencyAdminService,
} from "../../server/services/seller-sprite-quota-service";
import type { ConcurrencyAdminResponse } from "../../shared/agent-contracts";

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

test("SellerSprite quota scheduler starts only for explicit complete config and stops one bounded timer", async () => {
  const refreshCalls: Array<{ organizationId: string; actorUserId: string | null }> = [];
  const intervals: Array<{ callback: () => void; ms: number }> = [];
  const cleared: unknown[] = [];
  const service: Pick<ConcurrencyAdminService, "refreshQuota"> = {
    async refreshQuota(input) {
      refreshCalls.push(input);
      return {} as ConcurrencyAdminResponse;
    },
  };

  const disabled = new SellerSpriteQuotaRefreshScheduler({
    service,
    organizationId: "20000000-0000-4000-8000-000000000001",
    enabled: false,
    setInterval: (callback, ms) => {
      intervals.push({ callback, ms });
      return { timer: intervals.length };
    },
    clearInterval: (handle) => cleared.push(handle),
  });
  disabled.start();
  disabled.start();
  await disabled.stop();
  assert.equal(intervals.length, 0);
  assert.equal(cleared.length, 0);

  const scheduler = new SellerSpriteQuotaRefreshScheduler({
    service,
    organizationId: "20000000-0000-4000-8000-000000000001",
    enabled: true,
    intervalMs: 45 * 60 * 1000,
    setInterval: (callback, ms) => {
      intervals.push({ callback, ms });
      return { timer: intervals.length };
    },
    clearInterval: (handle) => cleared.push(handle),
  });
  scheduler.start();
  scheduler.start();
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0]?.ms, 45 * 60 * 1000);

  intervals[0]!.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(refreshCalls, [{
    organizationId: "20000000-0000-4000-8000-000000000001",
    actorUserId: null,
  }]);

  await scheduler.stop();
  await scheduler.stop();
  assert.equal(cleared.length, 1);
});
