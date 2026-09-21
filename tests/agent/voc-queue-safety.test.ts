import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
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
import { createAlexaVocNormalizationInputCipher } from "../../server/security/alexa-voc-normalization-input-cipher";
import { createAlexaVocNormalizationFingerprint } from "../../server/domain/voc/alexa-voc-normalization-contracts";

import { wakeVocPositioning } from "../../server/runtime/alexa-voc-normalization-runtime";

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
  async function seed(stage: "voc-positioning" | "traffic-analysis" | "alexa-voc-normalization" | "product-definition" = "voc-positioning", availableAt = NOW, enqueue = true) {
    const runId = randomUUID(), stageId = randomUUID(), id = randomUUID();
    await repository.createAnalysisRun({ id: runId, projectId: project, mode: "existing-data", status: "queued", createdBy: actor, dataCutoffAt: NOW, idempotencyScope: runId, idempotencyKey: "fixture", createdAt: NOW, updatedAt: NOW });
    await repository.createRunStage({ id: stageId, runId, stage, status: "queued", progress: 0, attemptCount: 0, startedAt: null, completedAt: null, lastError: null, createdAt: NOW, updatedAt: NOW });
    if (enqueue) await repository.enqueueJob({ id, stageId, attemptNumber: 1, maxAttempts: 3, createdAt: NOW, availableAt });
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
  for (const stage of ["alexa-voc-normalization", "voc-positioning", "product-definition"] as const) {
    test(`${dialect}: all-step deadline revokes running ${stage} and blocks late completion`, async (t) => {
      const f = await fixture(t, dialect), item = await f.seed(stage);
      const job = await f.repository.claimNextJob({ ownerId: "deadline-worker", stage, claimedAt: at(1), leaseDurationMs: 600000 });
      assert.equal(job?.id, item.id);
      assert.equal(await f.repository.expireVocQueue({ checkedAt: at(299999), timeoutMs: 300000 }), 0);
      assert.equal(await f.repository.expireVocQueue({ checkedAt: at(300000), timeoutMs: 300000 }), 1);
      const [expired] = await f.repository.listJobAttempts(item.stageId);
      assert.equal(expired.status, "failed");
      assert.equal(expired.retryable, false);
      assert.equal(expired.leasedBy, null);
      assert.equal(expired.error?.code, "QUEUE_TIMEOUT");
      await assert.rejects(f.repository.completeJob({ jobId: job!.id, ownerId: "deadline-worker", leaseGeneration: job!.leaseGeneration, completedAt: at(300001) }), /lease/i);
      assert.equal(await f.repository.claimNextJob({ ownerId: "late", stage, claimedAt: at(300001), leaseDurationMs: 1000, queueTimeoutMs: 300000 }), null);
    });
  }

  test(`${dialect}: all-step deadline closes old normalization chains without failing a fresh submission`, async (t) => {
    const f = await fixture(t, dialect), item = await f.seed("alexa-voc-normalization", NOW, false);
    const asin = "B012345678", snapshotId = randomUUID();
    const cipher = createAlexaVocNormalizationInputCipher({
      MANUAL_VOC_RAW_REPORT_KEYRING: JSON.stringify({ activeKeyId: "fixture", keys: { fixture: randomBytes(32).toString("base64url") } }),
    });
    const envelope = cipher.encrypt({ identity: { organizationId: f.org, projectId: f.project, runId: item.runId, snapshotId, marketplace: "US", asin, schema: "alexa-voc-normalization-input/v1" }, plaintext: "ASIN B012345678 timeout preservation fixture" });
    const executionIdentity = { providerName: "fixture", model: { name: "fixture", estimatedInputTokens: 100, maxOutputTokens: 100, timeoutMs: 1000, pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 } } };
    await f.repository.transaction(scoped => (scoped as RuntimeAgentRepository).manualAlexaVoc.queueNormalizationInput({
      actorUserId: f.actor, actorOrganizationId: f.org, projectId: f.project, runId: item.runId, marketplace: "US", asin, snapshotId, stageId: item.stageId, jobId: item.id,
      rawReportSha256: envelope.plaintextSha256, plaintextBytes: envelope.plaintextBytes, envelope, executionIdentity,
      executionFingerprint: createAlexaVocNormalizationFingerprint({ marketplace: "US", asin, rawReportSha256: envelope.plaintextSha256, executionIdentity }), queuedAt: NOW,
    }));
    const readStatus = () => f.repository.manualAlexaVoc.listNormalizationStatuses({ actorOrganizationId: f.org, projectId: f.project, runId: item.runId, marketplace: "US", asins: [asin] });
    const freshId = randomUUID();
    const freshAsin = "B012345679", freshSnapshot = randomUUID();
    const freshEnvelope = cipher.encrypt({ identity: { organizationId: f.org, projectId: f.project, runId: item.runId, snapshotId: freshSnapshot, marketplace: "US", asin: freshAsin, schema: "alexa-voc-normalization-input/v1" }, plaintext: "independent fresh ASIN input" });
    const queueFresh = () => f.repository.transaction(scoped => (scoped as RuntimeAgentRepository).manualAlexaVoc.queueNormalizationInput({
      actorUserId: f.actor, actorOrganizationId: f.org, projectId: f.project, runId: item.runId, marketplace: "US", asin: freshAsin, snapshotId: freshSnapshot, stageId: item.stageId, jobId: freshId,
      rawReportSha256: freshEnvelope.plaintextSha256, plaintextBytes: freshEnvelope.plaintextBytes, envelope: freshEnvelope, executionIdentity,
      executionFingerprint: createAlexaVocNormalizationFingerprint({ marketplace: "US", asin: freshAsin, rawReportSha256: freshEnvelope.plaintextSha256, executionIdentity }), queuedAt: at(299000),
    }));
    assert.equal((await queueFresh()).jobId, freshId, "a genuinely new ASIN cannot inherit the nearly expired queue origin");
    assert.equal((await queueFresh()).jobCreated, false, "identical submission remains idempotent");
    const readInputs = () => f.repository.manualAlexaVoc.listNormalizationInputSnapshots({ actorOrganizationId: f.org, projectId: f.project, runId: item.runId });
    const savedInputs = await readInputs();
    assert.equal(savedInputs.length, 2);
    assert.equal(await f.repository.expireVocQueue({ checkedAt: at(300000), timeoutMs: 300000 }), 1);
    assert.equal((await f.repository.findRunStage(item.stageId))?.status, "queued");
    assert.equal((await readStatus())[0]?.error, "timeout", "the old input reports its own deadline, independently of a newer sibling");
    assert.equal((await f.repository.listJobAttempts(item.stageId))[0].retryable, false);
    assert.equal((await f.repository.claimNextJob({ ownerId: "fresh", stage: "alexa-voc-normalization", claimedAt: at(300001), leaseDurationMs: 600000, queueTimeoutMs: 300000 }))?.id, freshId);
    assert.equal(await f.repository.expireVocQueue({ checkedAt: at(598999), timeoutMs: 300000 }), 0);
    assert.equal(await f.repository.expireVocQueue({ checkedAt: at(599000), timeoutMs: 300000 }), 1);
    assert.equal((await f.repository.findRunStage(item.stageId))?.status, "failed");
    assert.equal((await readStatus())[0]?.error, "timeout");
    assert.deepEqual(await readInputs(), savedInputs, "encrypted submitted input remains unchanged");
    assert.equal(await f.repository.expireVocQueue({ checkedAt: at(900000), timeoutMs: 300000 }), 0);
    const other = await f.seed("alexa-voc-normalization");
    await assert.rejects(f.execute("INSERT INTO alexa_voc_normalization_input_jobs(snapshot_id, origin_job_id) VALUES (?, ?)", [snapshotId, other.id]), /scope/i);
    const retried = await f.repository.retryFailedRunStage({ runId: item.runId, stageId: item.stageId, jobId: randomUUID(), staleStageIds: [], maxAutomaticAttempts: 3, retriedAt: at(900000) });
    assert.ok(retried);
    assert.deepEqual((await f.repository.manualAlexaVoc.listNormalizationInputSnapshots({ actorOrganizationId: f.org, projectId: f.project, runId: item.runId, jobAttemptId: retried.attempt.id })).map(input => input.asin), [freshAsin], "manual retry copies only the failed chain's owned input");
  });

  test(`${dialect}: all-step automatic retry inherits the first enqueue deadline`, async (t) => {
    const f = await fixture(t, dialect), item = await f.seed();
    await f.execute("UPDATE job_attempts SET status='failed', retryable=TRUE, retry_scheduled_at=? WHERE id=?", [at(200000), item.id]);
    const next = randomUUID();
    await f.repository.enqueueJob({ id: next, stageId: item.stageId, attemptNumber: 2, maxAttempts: 3, createdAt: at(200000), availableAt: at(800000) });
    await f.execute("UPDATE job_attempts SET retry_cycle_start_attempt=1 WHERE id=?", [next]);
    assert.equal(await f.repository.expireVocQueue({ checkedAt: at(300000), timeoutMs: 300000 }), 1);
    assert.equal((await f.repository.listJobAttempts(item.stageId))[1].error?.code, "QUEUE_TIMEOUT");
  });

  test(`${dialect}: completing one normalization chain leaves a queued sibling eligible for timeout`, async (t) => {
    const f = await fixture(t, dialect), item = await f.seed("alexa-voc-normalization");
    const sibling = randomUUID();
    await f.repository.enqueueJob({ id: sibling, stageId: item.stageId, attemptNumber: 2, maxAttempts: 4, createdAt: at(100), availableAt: at(100) });
    const a = await f.repository.claimNextJob({ ownerId: "first", stage: "alexa-voc-normalization", claimedAt: at(1), leaseDurationMs: 1000 });
    await f.repository.completeJob({ jobId: a!.id, ownerId: "first", leaseGeneration: a!.leaseGeneration, completedAt: at(2) });
    assert.equal((await f.repository.findRunStage(item.stageId))?.status, "queued");
    assert.notEqual((await f.repository.findAnalysisRun(item.runId))?.status, "succeeded");
    assert.equal(await f.repository.expireVocQueue({ checkedAt: at(300100), timeoutMs: 300000 }), 1);
    assert.equal((await f.repository.listJobAttempts(item.stageId)).find(job => job.id === sibling)?.error?.code, "QUEUE_TIMEOUT");
  });

  for (const expired of [false, true]) test(`${dialect}: normalization ${expired ? "expired" : "failed"} predecessor skips occupied attempt numbers without increasing retry budget`, async (t) => {
    const f = await fixture(t, dialect);
    const item = await f.seed("alexa-voc-normalization", NOW, false);
    const cipher = createAlexaVocNormalizationInputCipher({
      MANUAL_VOC_RAW_REPORT_KEYRING: JSON.stringify({ activeKeyId: "fixture", keys: { fixture: randomBytes(32).toString("base64url") } }),
    });
    const snapshotId = randomUUID(), asin = "B012345678";
    const envelope = cipher.encrypt({ identity: { organizationId: f.org, projectId: f.project, runId: item.runId, snapshotId, marketplace: "US", asin, schema: "alexa-voc-normalization-input/v1" }, plaintext: "ASIN B012345678 模拟测试输入" });
    const executionIdentity = { providerName: "fixture", model: { name: "fixture", estimatedInputTokens: 100, maxOutputTokens: 100, timeoutMs: 1000, pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 } } };
    await f.repository.transaction(scoped => (scoped as RuntimeAgentRepository).manualAlexaVoc.queueNormalizationInput({
      actorUserId: f.actor, actorOrganizationId: f.org, projectId: f.project, runId: item.runId, marketplace: "US", asin, snapshotId, stageId: item.stageId, jobId: item.id,
      rawReportSha256: envelope.plaintextSha256, plaintextBytes: envelope.plaintextBytes, envelope, executionIdentity,
      executionFingerprint: createAlexaVocNormalizationFingerprint({ marketplace: "US", asin, rawReportSha256: envelope.plaintextSha256, executionIdentity }), queuedAt: NOW,
    }));
    const first = await f.repository.claimNextJob({ ownerId: "normalization-first", stage: "alexa-voc-normalization", claimedAt: at(1), leaseDurationMs: 100 });
    assert.equal(first?.id, item.id);
    if (!expired) await f.repository.failJob({ jobId: first!.id, ownerId: "normalization-first", leaseGeneration: first!.leaseGeneration, failedAt: at(2), error: { classification: "upstream-temporary", message: "publication retry" }, retryable: true, retryAt: at(3) });
    const successorId = randomUUID();
    await f.repository.enqueueJob({ id: successorId, stageId: item.stageId, attemptNumber: 2, maxAttempts: 4, createdAt: at(4), availableAt: at(10000) });
    const before = (await f.repository.listJobAttempts(item.stageId)).find(job => job.id === successorId);
    const recovered = await f.repository.claimNextJob({ ownerId: "normalization-recovery", stage: "alexa-voc-normalization", claimedAt: at(200), leaseDurationMs: 1000 });
    assert.ok(recovered);
    assert.equal(recovered.attemptNumber, 3);
    assert.equal(recovered.maxAttempts - recovered.attemptNumber, first!.maxAttempts - first!.attemptNumber - 1, "one recovery consumes exactly one remaining attempt even when another cycle occupies a number");
    assert.equal(recovered.logicalExecutionCycleId, first!.logicalExecutionCycleId);
    assert.equal(recovered.retryCycleStartAttempt, first!.retryCycleStartAttempt);
    assert.deepEqual((await f.repository.manualAlexaVoc.listNormalizationInputSnapshots({ actorOrganizationId: f.org, projectId: f.project, runId: item.runId, jobAttemptId: recovered.id })).map(input => input.asin), [asin], "automatic retry retains original input ownership");
    assert.deepEqual((await f.repository.listJobAttempts(item.stageId)).find(job => job.id === successorId), before, "the queued sibling is unchanged");
    await assert.rejects(f.repository.completeJob({ jobId: first!.id, ownerId: "normalization-first", leaseGeneration: first!.leaseGeneration, completedAt: at(201) }), /lease/i);
    await f.repository.failJob({ jobId: recovered.id, ownerId: "normalization-recovery", leaseGeneration: recovered.leaseGeneration, failedAt: at(210), error: { classification: "upstream-temporary", message: "retry still unavailable" }, retryable: true, retryAt: at(211) });
    const finalTry = await f.repository.claimNextJob({ ownerId: "normalization-final", stage: "alexa-voc-normalization", claimedAt: at(212), leaseDurationMs: 1000 });
    assert.ok(finalTry);
    assert.equal(finalTry.attemptNumber, finalTry.maxAttempts);
    await f.repository.failJob({ jobId: finalTry.id, ownerId: "normalization-final", leaseGeneration: finalTry.leaseGeneration, failedAt: at(215), error: { classification: "upstream-temporary", message: "retry exhausted" }, retryable: true, retryAt: at(216) });
    assert.equal(await f.repository.claimNextJob({ ownerId: "normalization-extra", stage: "alexa-voc-normalization", claimedAt: at(217), leaseDurationMs: 1000 }), null);
    const settled = await f.repository.listJobAttempts(item.stageId);
    assert.equal(settled.length, 4, "no unbounded recovery attempts are allocated");
    assert.equal(settled.find(job => job.id === finalTry.id)?.retryable, false);
    assert.equal((await f.repository.claimNextJob({ ownerId: "normalization-sibling", stage: "alexa-voc-normalization", claimedAt: at(10001), leaseDurationMs: 1000 }))?.id, successorId, "independent queued work remains claimable after predecessor exhaustion");
  });

  test(`${dialect}: new VOC input revokes the running predecessor without consuming the new deadline`, async (t) => {
    const f = await fixture(t, dialect), old = await f.seed();
    const running = await f.claim(1);
    assert.equal(running?.id, old.id);
    assert.equal(await wakeVocPositioning(f.repository, old.runId, at(100000)), true);
    const attempts = await f.repository.listJobAttempts(old.stageId);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].status, "cancelled");
    assert.equal(attempts[0].error?.code, "SUPERSEDED");
    assert.equal(attempts[0].leasedBy, null);
    assert.equal(attempts[0].retryable, false);
    assert.equal(attempts[1].retryCycleStartAttempt, 2);
    assert.equal((await f.repository.findRunStage(old.stageId))?.status, "queued");
    await assert.rejects(f.repository.renewJobLease({ jobId: old.id, ownerId: "fixture-worker", leaseGeneration: running!.leaseGeneration, renewedAt: at(100001), leaseDurationMs: 120000 }), /lease/i);
    await assert.rejects(f.repository.completeJob({ jobId: old.id, ownerId: "fixture-worker", leaseGeneration: running!.leaseGeneration, completedAt: at(100001) }), /lease/i);
    assert.equal(await wakeVocPositioning(f.repository, old.runId, at(100002)), false);
    assert.equal((await f.repository.listJobAttempts(old.stageId)).length, 2);
    assert.equal((await f.claim(100003, 300000))?.id, attempts[1].id);
    assert.equal(await f.repository.expireVocQueue({ checkedAt: at(300000), timeoutMs: 300000 }), 0);
    assert.equal(await f.repository.expireVocQueue({ checkedAt: at(400000), timeoutMs: 300000 }), 1);
    assert.equal((await f.repository.listJobAttempts(old.stageId))[0].error?.code, "SUPERSEDED");
  });

  test(`${dialect}: concurrent VOC wakeups coalesce and cancelled runs cannot be resurrected`, async (t) => {
    const f = await fixture(t, dialect), old = await f.seed();
    await f.claim(1);
    await Promise.all([wakeVocPositioning(f.repository, old.runId, at(1000)), wakeVocPositioning(f.repository, old.runId, at(1000))]);
    const attempts = await f.repository.listJobAttempts(old.stageId);
    assert.equal(attempts.length, 2);
    assert.equal(attempts.filter(job => job.status === "queued").length, 1);
    await f.repository.cancelAnalysisRun({ runId: old.runId, cancelledAt: at(2000), error: { code: "CANCELLED", message: "cancel" } });
    await assert.rejects(f.repository.enqueueJob({ id: randomUUID(), stageId: old.stageId, attemptNumber: 3, maxAttempts: 5, createdAt: at(2001), availableAt: at(2001), supersedeVocPredecessors: true }));
    assert.equal((await f.repository.listJobAttempts(old.stageId)).length, 2);
    assert.equal((await f.repository.findAnalysisRun(old.runId))?.status, "cancelled");
  });

  for (const releaseBeforeWake of [true, false]) test(`${dialect}: new input replaces a requeued predecessor, releaseBeforeWake=${releaseBeforeWake}`, async (t) => {
    const f = await fixture(t, dialect), old = await f.seed();
    const running = (await f.claim(1))!;
    const release = () => f.repository.releaseJobLease({ jobId: old.id, ownerId: "fixture-worker", leaseGeneration: running.leaseGeneration, releasedAt: at(1000) });
    if (releaseBeforeWake) await release();
    else {
      const enqueue = f.repository.enqueueJob.bind(f.repository);
      f.repository.enqueueJob = async input => { await release(); return enqueue(input); };
    }
    await wakeVocPositioning(f.repository, old.runId, at(2000));
    const attempts = await f.repository.listJobAttempts(old.stageId);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].status, "cancelled");
    assert.equal(attempts[1].status, "queued");
    assert.equal(attempts[1].retryCycleStartAttempt, 2);
    assert.notEqual(attempts[0].logicalExecutionCycleId, attempts[1].logicalExecutionCycleId);
  });

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
    await f.execute("UPDATE job_attempts SET created_at=? WHERE id=?", [at(1), running.id]);
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

  for (const status of ["pending", "passed"] as const) test(`${dialect}: ${status} durable audit is preserved while overdue publication releases occupancy`, async (t) => {
    const f = await fixture(t, dialect), item = await f.seed();
    const snapshot = await f.audit(item, status);
    for (const queued of [true, false]) {
      if (!queued) await f.execute("UPDATE job_attempts SET status='failed', retryable=TRUE WHERE id=?", [item.id]);
      assert.equal(await f.repository.expireVocQueue({ checkedAt: at(900000), timeoutMs: 300000 }), 1);
      const [expired] = await f.repository.listJobAttempts(item.stageId);
      assert.equal(expired.status, "failed");
      assert.equal(expired.retryable, false);
      assert.equal(expired.error?.code, "QUEUE_TIMEOUT");
      assert.deepEqual(await f.repository.findDataSnapshotById({ actorOrganizationId: f.org, snapshotId: snapshot.id }), snapshot);
    }
  });

  test(`${dialect}: publication policy cannot exempt overdue work forever`, async (t) => {
    const f = await fixture(t, dialect), item = await f.seed();
    await f.execute("UPDATE job_attempts SET status='succeeded' WHERE id=?", [item.id]);
    await f.execute(`INSERT INTO job_attempts (id, stage_id, attempt_number, max_attempts, retry_cycle_start_attempt, logical_execution_cycle_id, report_publication_cycle, report_publication_attempt_count, report_publication_max_attempts, report_publication_initial_delay_ms, report_publication_max_delay_ms, report_publication_retry_at, status, available_at, lease_generation, retryable, created_at, updated_at)
      VALUES (?, ?, 2, 3, 2, ?, 2, 1, 3, 1000, 4000, ?, 'failed', ?, 1, TRUE, ?, ?)`, [randomUUID(), item.stageId, "a".repeat(64), NOW, NOW, NOW, NOW]);
    const before = await f.repository.listJobAttempts(item.stageId);
    assert.equal(await f.repository.expireVocQueue({ checkedAt: at(900000), timeoutMs: 300000 }), 1);
    const after = await f.repository.listJobAttempts(item.stageId);
    assert.deepEqual(after[0], before[0], "completed historical work is unchanged");
    assert.equal(after[1].status, "failed");
    assert.equal(after[1].retryable, false);
    assert.equal(after[1].reportPublicationAttemptCount, before[1].reportPublicationAttemptCount);
  });

  test(`${dialect}: expiry batch and run scope are bounded`, async (t) => {
    const f = await fixture(t, dialect), first = await f.seed(), second = await f.seed();
    assert.equal(await f.repository.expireVocQueue({ checkedAt: at(300000), timeoutMs: 300000, runId: second.runId, limit: 1 }), 1);
    assert.equal((await f.repository.listJobAttempts(first.stageId))[0].status, "queued");
    assert.equal(await f.repository.expireVocQueue({ checkedAt: at(300000), timeoutMs: 300000, limit: 1 }), 1);
  });

  test(`${dialect}: new input after waiting receives a fresh full deadline`, async (t) => {
    const f = await fixture(t, dialect), item = await f.seed();
    await f.execute("UPDATE job_attempts SET status='failed', retryable=FALSE WHERE id=?", [item.id]);
    await f.execute("UPDATE run_stages SET status='waiting-input' WHERE id=?", [item.stageId]);
    assert.equal(await f.repository.expireVocQueue({ checkedAt: at(900000), timeoutMs: 300000 }), 0);
    const resumed = await f.repository.resumeWaitingInputRunStage({ runId: item.runId, stageId: item.stageId, resumedAt: at(900000) });
    assert.ok(resumed);
    assert.equal(await f.repository.expireVocQueue({ checkedAt: at(1199999), timeoutMs: 300000 }), 0);
    assert.equal(await f.repository.expireVocQueue({ checkedAt: at(1200000), timeoutMs: 300000 }), 1);
  });

  test(`${dialect}: manual overdue publication retry preserves audit and restarts only its deadline`, async (t) => {
    const f = await fixture(t, dialect), item = await f.seed();
    const snapshot = await f.audit(item, "passed");
    await f.execute(`UPDATE job_attempts SET status='failed', retryable=TRUE,
      report_publication_attempt_count=1, report_publication_max_attempts=3,
      report_publication_initial_delay_ms=1000, report_publication_max_delay_ms=4000,
      report_publication_retry_at=? WHERE id=?`, [at(4000), item.id]);
    const audits = await f.repository.listAgentRuns({ organizationId: f.org, runId: item.runId });
    assert.equal(await f.repository.expireVocQueue({ checkedAt: at(300000), timeoutMs: 300000 }), 1);
    const retry = await f.repository.retryFailedRunStage({ runId: item.runId, stageId: item.stageId, jobId: randomUUID(), staleStageIds: [], maxAutomaticAttempts: 3, retriedAt: at(900000) });
    assert.equal(retry?.attempt.id, item.id, "reuse durable model output without allocating a model execution");
    assert.equal(retry?.attempt.reportPublicationAttemptCount, 0);
    assert.equal(retry?.attempt.reportPublicationCycle, 2);
    assert.equal(await f.repository.expireVocQueue({ checkedAt: at(1199999), timeoutMs: 300000 }), 0);
    assert.equal(await f.repository.expireVocQueue({ checkedAt: at(1200000), timeoutMs: 300000 }), 1);
    assert.deepEqual(await f.repository.listAgentRuns({ organizationId: f.org, runId: item.runId }), audits);
    assert.deepEqual(await f.repository.findDataSnapshotById({ actorOrganizationId: f.org, snapshotId: snapshot.id }), snapshot);
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
  assert.equal(await f.repository.expireVocQueue({ checkedAt: at(500001), timeoutMs: 300000 }), operation === "claim" ? 1 : 0);
  assert.equal((await f.repository.findRunStage(item.stageId))?.status, operation === "retry" ? "queued" : operation === "cancel" ? "cancelled" : "failed");
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
      assert.equal(result.stages[0].lastError?.message, "VOC 处理超时，已释放任务占用并停止自动重试；原文和已保存结果保留，请稍后手动重试。");
    } finally { await service.stop(); }
  }
});
