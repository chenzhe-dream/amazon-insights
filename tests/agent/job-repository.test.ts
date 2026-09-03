import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";

test("SQLite claims, releases, reclaims, and completes Alexa normalization jobs", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "alexa-normalization-job-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const now = "2026-09-01T00:00:00.000Z";
  const userId = randomUUID();
  const organizationId = randomUUID();
  const projectId = randomUUID();
  const runId = randomUUID();
  const stageId = randomUUID();
  const jobId = randomUUID();
  await repository.createUser({
    id: userId,
    organizationId,
    email: "alexa-normalization@example.test",
    displayName: "Alexa normalization",
    role: "member",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  await repository.createProject({
    id: projectId,
    organizationId,
    name: "Alexa normalization",
    marketplace: "US",
    asins: ["B07VY9Q95Q"],
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  });
  await repository.createAnalysisRun({
    id: runId,
    projectId,
    mode: "existing-data",
    status: "queued",
    createdBy: userId,
    dataCutoffAt: now,
    idempotencyScope: "alexa-normalization-job",
    idempotencyKey: "create",
    createdAt: now,
    updatedAt: now,
  });
  await repository.createRunStage({
    id: stageId,
    runId,
    stage: "alexa-voc-normalization",
    status: "queued",
    progress: 0,
    attemptCount: 0,
    startedAt: null,
    completedAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  });
  await repository.enqueueJob({
    id: jobId,
    stageId,
    attemptNumber: 1,
    maxAttempts: 3,
    availableAt: now,
    createdAt: now,
  });

  const first = await repository.claimNextJob({
    ownerId: "normalizer-1",
    stage: "alexa-voc-normalization",
    claimedAt: "2026-09-01T00:00:01.000Z",
    leaseDurationMs: 30_000,
  });
  assert.equal(first?.id, jobId);
  await repository.releaseJobLease({
    jobId,
    ownerId: "normalizer-1",
    leaseGeneration: first!.leaseGeneration,
    releasedAt: "2026-09-01T00:00:02.000Z",
  });
  const second = await repository.claimNextJob({
    ownerId: "normalizer-2",
    stage: "alexa-voc-normalization",
    claimedAt: "2026-09-01T00:00:02.000Z",
    leaseDurationMs: 30_000,
  });
  assert.equal(second?.id, jobId);
  assert.ok(second!.leaseGeneration > first!.leaseGeneration);
  assert.equal((await repository.completeJob({
    jobId,
    ownerId: "normalizer-2",
    leaseGeneration: second!.leaseGeneration,
    completedAt: "2026-09-01T00:00:03.000Z",
  })).status, "succeeded");
});
