import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test, type TestContext } from "node:test";
import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";
import { PostgresAgentRepository } from "../../server/db/postgres-repository";
import { runPostgresMigrations } from "../../server/db/postgres/migrations";
import type { RuntimeAgentRepository } from "../../server/db/repository";
import { startPostgresTestContainer, type PostgresTestContainer } from "./helpers/postgres-test-container";
import type { Pool } from "pg";
import { buildVocSnapshotCandidate, VOC_SOURCE_REFERENCES } from "../../server/data/voc-data-snapshot";
import { createAgentService } from "../../server/agent-service";
import { AnalysisRunService } from "../../server/services/analysis-run-service";
import { UnavailableSyncJobRepository } from "../../server/db/sync-job-repository";
import { resolveVocPositioningRuntimeConfig } from "../../server/config";

const NOW = "2026-09-09T00:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();
let pg: PostgresTestContainer;
before(async () => { pg = await startPostgresTestContainer(); });
after(async () => { await pg?.close(); });

async function fixture(t: TestContext, dialect: "sqlite" | "postgres") {
  let repository: RuntimeAgentRepository;
  let execute: (sql: string, values?: unknown[]) => Promise<void>;
  let pool: Pool | undefined;
  if (dialect === "postgres") {
    const schema = `test_${randomUUID().replaceAll("-", "")}`;
    await pg.pool.query(`CREATE SCHEMA ${schema}`);
    pool = pg.createPool({ searchPath: schema });
    await runPostgresMigrations(pool);
    repository = new PostgresAgentRepository(pool);
    execute = async (sql, values = []) => { let i = 0; await pool!.query(sql.replace(/\?/g, () => `$${++i}`), values); };
  } else {
    const dir = mkdtempSync(join(tmpdir(), "voc-queue-test-"));
    const path = join(dir, "fixture.sqlite");
    const sqlite = openSqliteAgentRepository({ path, busyTimeoutMs: 5000 });
    repository = Object.assign(sqlite, { syncJobs: new UnavailableSyncJobRepository() });
    const db = new DatabaseSync(path);
    execute = async (sql, values = []) => { db.prepare(sql).run(...values as Array<string | number | null>); };
    t.after(() => { db.close(); sqlite.close(); rmSync(dir, { recursive: true, force: true }); });
  }
  const actor = randomUUID(), org = randomUUID(), project = randomUUID();
  await repository.createUser({ id: actor, organizationId: org, email: `${actor}@example.test`, displayName: "Fixture", role: "admin", status: "active", createdAt: NOW, updatedAt: NOW });
  await repository.createProject({ id: project, organizationId: org, name: "Fixture", marketplace: "US", asins: ["B012345678", "B012345679", "B012345680"], createdBy: actor, createdAt: NOW, updatedAt: NOW });
  async function seed(stage: "voc-positioning" | "traffic-analysis" = "voc-positioning", availableAt = NOW) {
    const runId = randomUUID(), stageId = randomUUID(), id = randomUUID();
    await repository.createAnalysisRun({ id: runId, projectId: project, mode: "existing-data", status: "queued", createdBy: actor, dataCutoffAt: NOW, idempotencyScope: runId, idempotencyKey: "fixture", createdAt: NOW, updatedAt: NOW });
    await repository.createRunStage({ id: stageId, runId, stage, status: "queued", progress: 0, attemptCount: 0, startedAt: null, completedAt: null, lastError: null, createdAt: NOW, updatedAt: NOW });
    await repository.enqueueJob({ id, stageId, attemptNumber: 1, maxAttempts: 3, createdAt: NOW, availableAt });
    return { id, stageId, runId };
  }
  const claim = (time = 0, queueTimeoutMs?: number) => repository.claimNextJob({ ownerId: "fixture-worker", stage: "voc-positioning", claimedAt: at(time), leaseDurationMs: 120000, ...(queueTimeoutMs === undefined ? {} : { queueTimeoutMs }) });
  async function audit(item: Awaited<ReturnType<typeof seed>>, validationStatus: "pending" | "passed") {
    const claimed = await claim(1);
    assert.equal(claimed?.id, item.id);
    const hash = "a".repeat(64);
    const skill = await repository.registerSkillVersion({ id: randomUUID(), skillId: "define-amazon-voc-positioning", version: "1.0.0", contentHash: hash,
      manifest: { id: "define-amazon-voc-positioning", version: "1.0.0", entry: "SKILL.md", allowedReferences: ["references/priority-rules.md"], inputSchema: "VocPositioningInput@1.0.0", outputSchema: "VocPositioningOutput@1.0.0", fixtures: ["queue-safety"], contentHash: hash }, createdAt: NOW });
    const asins = ["B012345678", "B012345679", "B012345680"];
    const snapshot = await repository.createDataSnapshotForRun({ actorId: actor, actorOrganizationId: org, runId: item.runId, expectedProjectId: project, expectedMarketplace: "US", expectedAsins: asins, expectedRunCutoffAt: NOW, candidateId: randomUUID(), createdAt: NOW,
      candidate: buildVocSnapshotCandidate({ marketplace: "US", asins, dataCutoffAt: NOW, sourceBundles: [{ sourceId: "alexa-voc", type: "manual-voc", reference: VOC_SOURCE_REFERENCES.alexaVoc, marketplace: "US", capturedAt: NOW, records: [{ asin: asins[0], attention: ["fixture"], positives: ["fixture"], negatives: ["fixture"], unmet: ["fixture"], audiences: ["fixture"], scenarios: ["fixture"], motives: ["fixture"], captureStatus: "dialog", alexaReport: { title: "Fixture", asin: asins[0], rating: 4, reviewCount: 1, prompt: "Fixture", overallConclusion: "Fixture" } }] }] }) });
    const begun = await repository.beginAgentRun({ id: randomUUID(), organizationId: org, runId: item.runId, stageId: item.stageId, jobAttemptId: item.id, skillVersionId: skill.id, snapshotIds: [snapshot.snapshot.id], executionFingerprint: "b".repeat(64), logicalExecutionLineage: "c".repeat(64), logicalExecutionCycleId: claimed!.logicalExecutionCycleId, outputSchemaDigest: "d".repeat(64), provider: "fixture", model: "fixture", inputSummary: { contentHash: hash, recordCount: 0 }, outputSchemaVersion: "1.0.0", dataCutoffAt: NOW, startedAt: at(1), leaseOwnerId: "fixture-worker", leaseGeneration: claimed!.leaseGeneration, claimToken: "fixture-claim", claimAcquiredAt: at(1), claimExpiresAt: at(60000) });
    if (validationStatus === "passed") await repository.finalizeAgentRun({ agentRunId: begun.record.id, organizationId: org, leaseOwnerId: "fixture-worker", leaseGeneration: claimed!.leaseGeneration, claimToken: "fixture-claim", completedAt: at(2), outcome: {
      terminalStatus: "succeeded", validationStatus: "passed", responseId: "fixture-response", output: { status: "complete" }, error: null, inputTokens: 1, outputTokens: 1, estimatedCostMicros: 1, durationMs: 1, attemptCount: 1, usageCompleteness: "complete", attempts: [{ ordinal: 0, kind: "initial", transientRetryCount: 0, formatRepair: false, accounting: "settled", errorClassification: null }], terminalMetadata: { kind: "succeeded" },
    } });
    await repository.releaseJobLease({ jobId: item.id, ownerId: "fixture-worker", leaseGeneration: claimed!.leaseGeneration, releasedAt: at(3) });
    return snapshot.snapshot;
  }
  return { repository, execute, seed, claim, audit, pool, actor, org, project };
}

for (const dialect of ["sqlite", "postgres"] as const) {
  test(`${dialect}: superseded failed predecessor cannot duplicate its successor or starve a new job`, async (t) => {
    const f = await fixture(t, dialect);
    const old = await f.seed();
    await f.execute("UPDATE job_attempts SET status='failed', retryable=TRUE WHERE id=?", [old.id]);
    await f.repository.enqueueJob({ id: randomUUID(), stageId: old.stageId, attemptNumber: 2, maxAttempts: 3, createdAt: at(100), availableAt: at(100) });
    await f.execute("UPDATE job_attempts SET status='succeeded' WHERE stage_id=? AND attempt_number=2", [old.stageId]);
    const fresh = await f.seed("voc-positioning", at(1000));
    assert.equal((await f.claim(1000))?.id, fresh.id);
    const attempts = await f.repository.listJobAttempts(old.stageId);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].retryable, true, "historical evidence is retained, not rewritten");
  });

  test(`${dialect}: cancelled parent excludes legacy retryable failed attempts`, async (t) => {
    const f = await fixture(t, dialect);
    const old = await f.seed();
    await f.execute("UPDATE job_attempts SET status='failed', retryable=TRUE WHERE id=?", [old.id]);
    await f.repository.cancelAnalysisRun({ runId: old.runId, cancelledAt: at(100), error: { code: "CANCELLED", message: "cancel" } });
    assert.equal(await f.claim(1000), null);
  });

  test(`${dialect}: queue expiry is inclusive, durable, idempotent and never auto-retries`, async (t) => {
    const f = await fixture(t, dialect), item = await f.seed();
    assert.equal(typeof f.repository.expireVocQueue, "function");
    assert.equal(await f.repository.expireVocQueue({ checkedAt: at(299999), timeoutMs: 300000 }), 0);
    assert.equal(await f.repository.expireVocQueue({ checkedAt: at(300000), timeoutMs: 300000 }), 1);
    const [attempt] = await f.repository.listJobAttempts(item.stageId);
    assert.equal(attempt.status, "failed");
    assert.equal(attempt.retryable, false);
    assert.equal(attempt.error?.code, "QUEUE_TIMEOUT");
    assert.equal((await f.repository.findRunStage(item.stageId))?.lastError?.code, "QUEUE_TIMEOUT");
    assert.equal((await f.repository.findAnalysisRun(item.runId))?.status, "failed");
    assert.equal(await f.repository.expireVocQueue({ checkedAt: at(900000), timeoutMs: 300000 }), 0);
    assert.equal(await f.claim(900000, 300000), null);
    assert.equal((await f.repository.listJobAttempts(item.stageId)).length, 1);
  });

  test(`${dialect}: claim cannot dispatch expired VOC during the interval before sweep`, async (t) => {
    const f = await fixture(t, dialect);
    await f.seed();
    assert.equal(await f.claim(300000, 300000), null);
  });

  test(`${dialect}: expired old model retry is stopped but unrelated and running jobs survive`, async (t) => {
    const f = await fixture(t, dialect);
    const old = await f.seed();
    await f.execute("UPDATE job_attempts SET status='failed', retryable=TRUE WHERE id=?", [old.id]);
    const other = await f.seed("traffic-analysis");
    const running = await f.seed("voc-positioning", at(1));
    await f.execute("UPDATE job_attempts SET retry_scheduled_at=? WHERE id=?", [at(1), old.id]);
    assert.equal((await f.claim(2))?.id, running.id);
    await f.execute("UPDATE job_attempts SET retry_scheduled_at=NULL WHERE id=?", [old.id]);
    assert.equal(typeof f.repository.expireVocQueue, "function");
    assert.equal(await f.repository.expireVocQueue({ checkedAt: at(300000), timeoutMs: 300000 }), 1);
    assert.equal((await f.repository.listJobAttempts(old.stageId))[0].retryable, false);
    assert.equal((await f.repository.listJobAttempts(other.stageId))[0].status, "queued");
    assert.equal((await f.repository.listJobAttempts(running.stageId))[0].status, "running");
  });

  test(`${dialect}: latest historical retry alone expires and explicit retry gets a fresh cycle and deadline`, async (t) => {
    const f = await fixture(t, dialect), old = await f.seed();
    await f.execute("UPDATE job_attempts SET status='failed', retryable=TRUE WHERE id=?", [old.id]);
    await f.repository.enqueueJob({ id: randomUUID(), stageId: old.stageId, attemptNumber: 2, maxAttempts: 3, createdAt: at(1), availableAt: at(1) });
    await f.execute("UPDATE job_attempts SET status='failed', retryable=TRUE WHERE stage_id=?", [old.stageId]);
    assert.equal(await f.repository.expireVocQueue({ checkedAt: at(400000), timeoutMs: 300000 }), 1);
    const prior = await f.repository.listJobAttempts(old.stageId);
    assert.equal(prior[0].retryable, true);
    assert.equal(prior[1].error?.code, "QUEUE_TIMEOUT");
    const retried = await f.repository.retryFailedRunStage({ runId: old.runId, stageId: old.stageId, jobId: randomUUID(), staleStageIds: [], maxAutomaticAttempts: 3, retriedAt: at(500000) });
    assert.ok(retried);
    assert.notEqual(retried.attempt.logicalExecutionCycleId, prior[1].logicalExecutionCycleId);
    assert.equal(await f.repository.expireVocQueue({ checkedAt: at(500001), timeoutMs: 300000 }), 0);
    assert.equal((await f.claim(500001, 300000))?.id, retried.attempt.id);
    assert.deepEqual((await f.repository.listJobAttempts(old.stageId)).slice(0, 2), prior);
  });

  for (const status of ["pending", "passed"] as const) test(`${dialect}: ${status} durable audit protects queued and failed publication recovery`, async (t) => {
    const f = await fixture(t, dialect), item = await f.seed();
    const snapshot = await f.audit(item, status);
    for (const queued of [true, false]) {
      if (!queued) await f.execute("UPDATE job_attempts SET status='failed', retryable=TRUE WHERE id=?", [item.id]);
      const before = await f.repository.listJobAttempts(item.stageId);
      assert.equal(await f.repository.expireVocQueue({ checkedAt: at(900000), timeoutMs: 300000 }), 0);
      assert.deepEqual(await f.repository.listJobAttempts(item.stageId), before);
      assert.deepEqual(await f.repository.findDataSnapshotById({ actorOrganizationId: f.org, snapshotId: snapshot.id }), snapshot);
    }
  });

  test(`${dialect}: publication policy protects a wait without relying on audit validity`, async (t) => {
    const f = await fixture(t, dialect), item = await f.seed();
    await f.execute("UPDATE job_attempts SET status='succeeded' WHERE id=?", [item.id]);
    await f.execute(`INSERT INTO job_attempts (id, stage_id, attempt_number, max_attempts, retry_cycle_start_attempt, logical_execution_cycle_id, report_publication_cycle, report_publication_attempt_count, report_publication_max_attempts, report_publication_initial_delay_ms, report_publication_max_delay_ms, report_publication_retry_at, status, available_at, lease_generation, retryable, created_at, updated_at)
      VALUES (?, ?, 2, 3, 2, ?, 2, 1, 3, 1000, 4000, ?, 'failed', ?, 1, TRUE, ?, ?)`, [randomUUID(), item.stageId, "a".repeat(64), NOW, NOW, NOW, NOW]);
    const before = await f.repository.listJobAttempts(item.stageId);
    assert.equal(await f.repository.expireVocQueue({ checkedAt: at(900000), timeoutMs: 300000 }), 0);
    assert.deepEqual(await f.repository.listJobAttempts(item.stageId), before);
  });

  test(`${dialect}: expiry batch and run scope are bounded`, async (t) => {
    const f = await fixture(t, dialect), first = await f.seed(), second = await f.seed();
    assert.equal(await f.repository.expireVocQueue({ checkedAt: at(300000), timeoutMs: 300000, runId: second.runId, limit: 1 }), 1);
    assert.equal((await f.repository.listJobAttempts(first.stageId))[0].status, "queued");
    assert.equal(await f.repository.expireVocQueue({ checkedAt: at(300000), timeoutMs: 300000, limit: 1 }), 1);
  });

  test(`${dialect}: a prior cycle passed audit cannot shield an expired manual retry`, async (t) => {
    const f = await fixture(t, dialect), item = await f.seed();
    await f.audit(item, "passed");
    await f.execute("UPDATE job_attempts SET status='failed', retryable=FALSE WHERE id=?", [item.id]);
    await f.execute("UPDATE run_stages SET status='failed' WHERE id=?", [item.stageId]);
    const retried = await f.repository.retryFailedRunStage({ runId: item.runId, stageId: item.stageId, jobId: randomUUID(), staleStageIds: [], maxAutomaticAttempts: 3, retriedAt: at(1000) });
    assert.ok(retried);
    assert.equal(await f.repository.expireVocQueue({ checkedAt: at(301000), timeoutMs: 300000 }), 1);
    assert.equal((await f.repository.listJobAttempts(item.stageId))[1].error?.code, "QUEUE_TIMEOUT");
    assert.equal((await f.repository.listDataSnapshotsByRun({ actorOrganizationId: f.org, runId: item.runId })).length, 1);
  });
}

for (const operation of ["retry", "cancel", "claim"] as const) test(`postgres: expiry skips ${operation} transaction locks and rechecks after commit`, async (t) => {
  const f = await fixture(t, "postgres"), item = await f.seed();
  if (operation === "retry") {
    await f.execute("UPDATE job_attempts SET status='failed', retryable=TRUE WHERE id=?", [item.id]);
    await f.execute("UPDATE run_stages SET status='failed' WHERE id=?", [item.stageId]);
  }
  let unlock!: () => void, locked!: () => void;
  const barrier = new Promise<void>((resolve) => { unlock = resolve; });
  const acquired = new Promise<void>((resolve) => { locked = resolve; });
  const mutation = f.repository.transaction(async (repo) => {
    if (operation === "retry") await repo.retryFailedRunStage({ runId: item.runId, stageId: item.stageId, jobId: randomUUID(), staleStageIds: [], maxAutomaticAttempts: 3, retriedAt: at(500000) });
    if (operation === "cancel") await repo.cancelAnalysisRun({ runId: item.runId, cancelledAt: at(500000), error: { code: "CANCELLED", message: "fixture" } });
    if (operation === "claim") await repo.claimNextJob({ ownerId: "fixture", claimedAt: at(299999), leaseDurationMs: 120000 });
    locked();
    await barrier;
  });
  // A failed mutation must release the test barrier rather than leave a hanging test.
  await Promise.race([acquired, mutation.then(() => { throw new Error("lock not acquired"); })]);
  try {
    assert.equal(await f.repository.expireVocQueue({ checkedAt: at(500000), timeoutMs: 300000 }), 0);
  } finally { unlock(); await mutation; }
  assert.equal(await f.repository.expireVocQueue({ checkedAt: at(500001), timeoutMs: 300000 }), 0);
  assert.equal((await f.repository.findRunStage(item.stageId))?.status, operation === "retry" ? "queued" : operation === "cancel" ? "cancelled" : "running");
});

test("Agent Service expires queued VOC with absent or invalid model configuration and exposes Chinese API status", async (t) => {
  for (const invalid of [false, true]) {
    const f = await fixture(t, "sqlite"), item = await f.seed();
    let calls = 0;
    const runtimeEnv = invalid ? { OPENAI_API_KEY: "fixture", AGENT_VOC_MODEL: "fixture", AGENT_VOC_ESTIMATED_INPUT_TOKENS: "4000", AGENT_VOC_MAX_OUTPUT_TOKENS: "4000", AGENT_VOC_TIMEOUT_MS: "300000", AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS: "1", AGENT_VOC_OUTPUT_USD_PER_MILLION_TOKENS: "2", AGENT_VOC_CALL_MAX_TOKENS: "50000", AGENT_VOC_CALL_MAX_COST_MICROS: "50000", AGENT_VOC_RUN_MAX_TOKENS: "50000", AGENT_VOC_RUN_MAX_COST_MICROS: "50000", AGENT_VOC_DAILY_MAX_TOKENS: "50000", AGENT_VOC_DAILY_MAX_COST_MICROS: "50000", AGENT_VOC_WORKER_OWNER_ID: "fixture", AGENT_VOC_RETRY_JITTER_RATIO: "Infinity" } : {};
    assert.equal(resolveVocPositioningRuntimeConfig(runtimeEnv).status, invalid ? "invalid" : "incomplete");
    const service = await createAgentService({ repository: f.repository, clock: () => new Date(at(300000)), provider: { generateStructured: async () => { calls++; throw new Error("must not execute"); } }, env: {
      NODE_ENV: "test", AGENT_SERVICE_HOST: "127.0.0.1", AGENT_SERVICE_PROXY_TOKEN: "queue-test-proxy", AGENT_SERVICE_TRUSTED_ORIGINS: "http://127.0.0.1:31900", AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK: "1",
      ...runtimeEnv,
    } });
    try {
      await service.start({ host: "127.0.0.1", port: 0 });
      for (let i = 0; i < 100 && (await f.repository.findRunStage(item.stageId))?.status === "queued"; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal((await f.repository.findRunStage(item.stageId))?.lastError?.code, "QUEUE_TIMEOUT");
      assert.equal((await service.app.inject({ method: "GET", url: "/health" })).statusCode, 200);
      assert.equal(calls, 0);
      const api = new AnalysisRunService({ repository: f.repository, executionContext: { actorId: f.actor, organizationId: f.org } });
      const result = await api.getRun(item.runId);
      assert.equal(result.stages[0].lastError?.code, "QUEUE_TIMEOUT");
      assert.equal(result.stages[0].lastError?.message, "VOC 排队超时，已停止自动重试，请稍后手动重试。");
    } finally { await service.stop(); }
  }
});
