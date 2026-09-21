import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createAgentService,
  stopAgentServiceResources,
} from "../../server/agent-service";
import type { PutManualAlexaVocInput } from "../../server/db/manual-alexa-voc-repository";
import { openRuntimeAgentRepository } from "../../server/db/open-runtime-repository";
import type { ManualAlexaVocEncryptedRaw } from "../../server/security/manual-alexa-voc-cipher";
import {
  SellerSpriteQuotaRefreshScheduler,
  type ConcurrencyAdminService,
} from "../../server/services/seller-sprite-quota-service";
import type { ConcurrencyAdminResponse } from "../../shared/agent-contracts";

const PROJECTION_PATH_KEY = "publication-path-key-32-bytes!!!";

async function waitFor(check: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for publication worker");
}

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

test('Agent Service closes owned connector sessions after draining and before closing storage even on failure', async () => {
  const calls: string[] = [];
  await assert.rejects(stopAgentServiceResources({
    runtimes: [{ stop: async () => { calls.push('worker'); } }],
    closeApp: async () => { calls.push('app'); },
    closeConnectors: async () => { calls.push('connectors'); throw new Error('close failed'); },
    closeOwnedRepository: async () => { calls.push('repository'); },
  }), /failed to stop cleanly/);
  assert.deepEqual(calls, ['worker', 'app', 'connectors', 'repository']);
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

test("Agent Service starts and stops the explicitly enabled manual VOC publication worker", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "agent-service-publication-"));
  const databasePath = join(directory, "agent.sqlite");
  const projectionRoot = join(directory, "projection");
  const repository = await openRuntimeAgentRepository({
    kind: "sqlite",
    sqlite: {
      path: databasePath,
      busyTimeoutMs: 5_000,
    },
  });
  let service: Awaited<ReturnType<typeof createAgentService>> | null = null;
  t.after(async () => {
    await service?.stop();
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const organizationId = randomUUID();
  const actorId = randomUUID();
  const asin = "B0AAAA0001";
  const createdAt = "2026-08-31T08:00:00.000Z";
  await repository.createUser({
    id: actorId,
    organizationId,
    email: `${actorId}@example.com`,
    displayName: "Publication fixture",
    role: "admin",
    status: "active",
    createdAt,
    updatedAt: createdAt,
  });
  const raw: ManualAlexaVocEncryptedRaw = {
    algVersion: "AES-256-GCM/v1",
    keyId: "fixture-key",
    wrappedDek: Uint8Array.from({ length: 60 }, (_, index) => index),
    nonce: Uint8Array.from({ length: 12 }, (_, index) => index),
    ciphertext: Uint8Array.from([1, 2, 3, 4]),
    tag: Uint8Array.from({ length: 16 }, (_, index) => index),
    aadSha256: "d".repeat(64),
    plaintextBytes: 4,
    plaintextSha256: "e".repeat(64),
  };
  const input: PutManualAlexaVocInput = {
    organizationId,
    marketplace: "US",
    asin,
    createdBy: actorId,
    expectedRevision: "1",
    normalizedRecord: {
      asin,
      attention: ["attention"],
      positives: ["positive"],
      negatives: ["negative"],
      unmet: ["unmet"],
      audiences: ["audience"],
      scenarios: ["scenario"],
      motives: ["motive"],
      captureStatus: "dialog",
      alexaReport: {
        title: "Publication fixture",
        asin,
        rating: 4.5,
        reviewCount: 42,
        prompt: "fixture prompt",
        overallConclusion: "fixture conclusion",
      },
    },
    normalizedSchemaVersion: "alexa-voc-record/v2",
    parserVersion: "deterministic-alexa-parser/v3",
    contentHash: "a".repeat(64),
    raw,
  };
  await repository.transaction(async () => {
    await repository.manualAlexaVoc.lockScopes({
      organizationId,
      marketplace: "US",
      asins: [asin],
    });
    await repository.manualAlexaVoc.put(input);
  });

  service = await createAgentService({
    repository,
    logger: false,
    env: {
      NODE_ENV: "test",
      AGENT_SERVICE_PROXY_TOKEN: "agent-service-publication-proxy-token",
      AGENT_SERVICE_TRUSTED_ORIGINS: "http://127.0.0.1:31900",
      AGENT_MANUAL_ALEXA_VOC_PUBLICATION_ENABLED: "1",
      AGENT_MANUAL_ALEXA_VOC_PROJECTION_ROOT: projectionRoot,
      AGENT_MANUAL_ALEXA_VOC_PROJECTION_PATH_KEY: PROJECTION_PATH_KEY,
      AGENT_MANUAL_ALEXA_VOC_PUBLICATION_OWNER_ID: "agent-service-test-worker",
      AGENT_MANUAL_ALEXA_VOC_PUBLICATION_LEASE_MS: "60000",
      AGENT_MANUAL_ALEXA_VOC_PUBLICATION_POLL_MS: "10",
      AGENT_MANUAL_ALEXA_VOC_PUBLICATION_RECONCILE_MS: "100",
      AGENT_MANUAL_ALEXA_VOC_PUBLICATION_BACKOFF_INITIAL_MS: "10",
      AGENT_MANUAL_ALEXA_VOC_PUBLICATION_BACKOFF_MAX_MS: "100",
      AGENT_MANUAL_ALEXA_VOC_PUBLICATION_MAX_ATTEMPTS: "3",
    },
  });
  await service.start({ host: "127.0.0.1", port: 0 });
  const ownerPartition = createHmac("sha256", PROJECTION_PATH_KEY)
    .update(organizationId)
    .digest("base64url");
  const generationPath = join(
    projectionRoot,
    ownerPartition,
    "US",
    "generation-1.json",
  );
  await waitFor(() => existsSync(generationPath));
  await service.stop();
  assert.equal(existsSync(generationPath), true);
});
