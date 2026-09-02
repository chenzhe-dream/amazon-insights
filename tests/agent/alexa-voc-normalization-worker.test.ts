import assert from "node:assert/strict";
import { test } from "node:test";

import { randomUUID } from "node:crypto";

import { canonicalJsonSha256 } from "../../server/runtime/model-request-accounting";
import { SkillRuntimeError } from "../../server/runtime/skill-runner";
import { AlexaVocNormalizationExecutionService } from "../../server/services/alexa-voc-normalization-execution-service";
import {
  createAlexaVocNormalizationFingerprint,
} from "../../server/domain/voc/alexa-voc-normalization-contracts";
import { createAlexaVocNormalizationJobHandler } from "../../server/services/alexa-voc-normalization-worker-handler";
import * as normalizationRuntime from "../../server/runtime/alexa-voc-normalization-runtime";

const ASIN_A = "B0NORM0001";
const ASIN_B = "B0NORM0002";

test("continues after one ASIN fails and wakes insight only for the committed sibling", async () => {
  const snapshots = [
    { id: "snapshot-a", asin: ASIN_A },
    { id: "snapshot-b", asin: ASIN_B },
  ];
  const states: Array<readonly [string, "failure" | "success"]> = [];
  const revisions: string[] = [];
  const wakes: string[] = [];

  const handler = createAlexaVocNormalizationJobHandler({
    prepare: async () => ({
      snapshots,
      context: {
        actorId: "actor-1",
        organizationId: "org-1",
        projectId: "project-1",
        dataCutoffAt: "2026-09-01T00:00:00.000Z",
      },
      providerName: "local-fixture",
      model: {
        name: "fake-model",
        estimatedInputTokens: 100,
        maxOutputTokens: 200,
        timeoutMs: 1_000,
        pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 },
      },
    }),
    service: {
      async execute(request: { snapshotId: string }) {
        const snapshot = snapshots.find((candidate) => candidate.id === request.snapshotId)!;
        if (snapshot.asin === ASIN_A) {
          throw new SkillRuntimeError("MODEL_OUTPUT_ERROR", "invalid");
        }
        revisions.push(snapshot.asin);
        wakes.push(snapshot.asin);
        return {
          revision: { asin: snapshot.asin },
          agentRunId: `agent-${snapshot.asin}`,
          replayed: false,
        } as never;
      },
    },
    onTerminal: async ({ asin, status }) => {
      states.push([asin, status]);
    },
    finalize: async () => states.length === snapshots.length,
  });

  const result = await handler({
    job: {
      id: "job-1",
      runId: "run-1",
      stageId: "stage-1",
      stage: "alexa-voc-normalization",
      leasedBy: "worker-1",
      leaseGeneration: 1,
      logicalExecutionCycleId: "a".repeat(64),
    } as never,
    signal: new AbortController().signal,
  });

  assert.deepEqual(states, [[ASIN_A, "failure"], [ASIN_B, "success"]]);
  assert.deepEqual(revisions, [ASIN_B]);
  assert.deepEqual(wakes, [ASIN_B]);
  assert.deepEqual(result, { status: "succeeded" });
});

test("worker classifies only strict output contract configuration failures as schema", async () => {
  const categories: Array<[string, string | null]> = [];
  const handler = createAlexaVocNormalizationJobHandler({
    prepare: async () => ({
      snapshots: [
        { id: "snapshot-strict-output", asin: ASIN_A },
        { id: "snapshot-other-configuration", asin: ASIN_B },
      ],
      context: {
        actorId: "actor-1",
        organizationId: "org-1",
        projectId: "project-1",
        dataCutoffAt: "2026-09-01T00:00:00.000Z",
      },
      providerName: "local-fixture",
      model: {
        name: "fake-model",
        estimatedInputTokens: 100,
        maxOutputTokens: 200,
        timeoutMs: 1_000,
        pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 },
      },
    }),
    service: {
      async execute(request) {
        throw new SkillRuntimeError(
          "CONFIGURATION_ERROR",
          request.snapshotId === "snapshot-strict-output"
            ? "Skill output contract cannot produce a strict response format"
            : "Model is not configured",
        );
      },
    },
    onTerminal: async ({ asin, category }) => { categories.push([asin, category]); },
    finalize: async () => true,
  });

  await handler({
    job: {
      id: "job-strict-output",
      runId: "run-1",
      stageId: "stage-1",
      stage: "alexa-voc-normalization",
      leasedBy: "worker-1",
      leaseGeneration: 1,
      logicalExecutionCycleId: "a".repeat(64),
    } as never,
    signal: new AbortController().signal,
  });

  assert.deepEqual(categories, [[ASIN_A, "schema"], [ASIN_B, "persistence"]]);
});

test("binds one audited run and committed revision to the encrypted snapshot fingerprint", async () => {
  const report = "private Alexa report";
  const executionIdentity = {
    providerName: "local-fixture",
    model: {
      name: "fake-model",
      estimatedInputTokens: 100,
      maxOutputTokens: 200,
      timeoutMs: 1_000,
      pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 },
    },
  } as const;
  const fingerprint = createAlexaVocNormalizationFingerprint({
    rawReportSha256: canonicalJsonSha256(report),
    executionIdentity,
  });
  const snapshotId = randomUUID();
  const runId = randomUUID();
  const projectId = randomUUID();
  const actorId = randomUUID();
  const organizationId = randomUUID();
  const stageId = randomUUID();
  const jobAttemptId = randomUUID();
  const agentRunId = randomUUID();
  const committed: unknown[] = [];
  const runnerRequests: unknown[] = [];
  const normalizedRecord = {
    attention: [{ title: "质量", detail: "耐用", dimension: "Quality", mentions: 10 }],
    positives: [{ label: "耐用", detail: "长期稳定", mentions: 10 }],
    negatives: [{ label: "重量", detail: "偏重", mentions: 1 }],
    unmet: [{ detail: "希望更轻" }],
    audiences: [{ category: "家庭用户", detail: "日常使用" }],
    scenarios: [{ name: "家庭", detail: "室内使用" }],
    motives: [{ label: "耐用", importance: 5, detail: "质量", mentions: 10 }],
    overallConclusion: "耐用但希望更轻。",
  };
  const service = new AlexaVocNormalizationExecutionService({
    repository: {
      async findNormalizationInputSnapshot() {
        return {
          id: snapshotId,
          organizationId,
          projectId,
          runId,
          marketplace: "US" as const,
          asin: ASIN_B,
          rawReportSha256: canonicalJsonSha256(report),
          plaintextBytes: Buffer.byteLength(report),
          executionFingerprint: fingerprint,
          executionIdentity,
          envelope: {} as never,
          createdAt: "2026-09-01T00:00:00.000Z",
        };
      },
      async findCommittedNormalizationByFingerprint() {
        return null;
      },
      async commitNormalizationAndWake(input: unknown) {
        committed.push(input);
        return {
          revision: {
            organizationId,
            marketplace: "US" as const,
            asin: ASIN_B,
            revision: "1",
            contentHash: fingerprint,
            capturedAt: "2026-09-01T00:00:00.000Z",
            normalizedRecord: {} as never,
            normalizedSchemaVersion: "alexa-voc-record/v2" as const,
            parserVersion: "deterministic-alexa-parser/v3" as const,
          },
          wakeCreated: true,
        };
      },
    },
    normalizationInputCipher: {
      activeKeyId: "test",
      encrypt() { throw new Error("not used"); },
      decrypt() { return report; },
    },
    auditedRunner: {
      async run(request: unknown) {
        runnerRequests.push(request);
        return {
          value: {
            schemaVersion: "1.0.0" as const,
            kind: "alexa-voc-normalization-result" as const,
            record: normalizedRecord,
          },
          agentRun: { id: agentRunId, executionFingerprint: fingerprint },
          replayed: false,
          logicalExecutionLineage: "lineage",
        };
      },
    } as never,
  });

  const result = await service.execute(
    {
      snapshotId,
      providerName: executionIdentity.providerName,
      model: executionIdentity.model,
    },
    {
      actorId,
      organizationId,
      projectId,
      runId,
      stageId,
      jobAttemptId,
      leaseOwnerId: "worker-1",
      leaseGeneration: 1,
      logicalExecutionCycleId: "a".repeat(64),
      dataCutoffAt: "2026-09-01T00:00:00.000Z",
    },
  );

  assert.equal(result.agentRunId, agentRunId);
  assert.equal(result.revision.contentHash, fingerprint);
  assert.equal(runnerRequests.length, 1);
  assert.equal((runnerRequests[0] as { executionFingerprint: string }).executionFingerprint, fingerprint);
  assert.deepEqual((runnerRequests[0] as { snapshotIds: string[] }).snapshotIds, [snapshotId]);
  assert.equal(
    (runnerRequests[0] as { input: { normalizationInstructions: string } }).input.normalizationInstructions,
    "Return facts only: all seven dimension arrays and overallConclusion; use null for unknown mentions; do not return page-header fields.",
  );
  assert.equal(
    (runnerRequests[0] as { outputContract: { name: string } }).outputContract.name,
    "AlexaVocNormalizationOutput@1.1.0",
  );
  assert.equal(JSON.stringify(committed).includes(report), false);
  assert.equal((committed[0] as { contentHash: string }).contentHash, fingerprint);
  assert.equal(
    (committed[0] as { schemaDigest: string }).schemaDigest,
    canonicalJsonSha256({
      schema: "AlexaVocNormalizationFacts@1.1.0",
      dimensions: ["attention", "positives", "negatives", "unmet", "audiences", "scenarios", "motives"],
      statistics: "nullable-mention-counts-rendered-with-trusted-review-count",
      headers: "renderer-owned",
    }),
  );
  const persistedReport = (committed[0] as {
    normalizedRecord: {
      attention: string[];
      positives: string[];
      audiences: string[];
      alexaReport: Record<string, unknown>;
    };
  }).normalizedRecord;
  assert.deepEqual(persistedReport.attention, ["1. 质量：耐用。"]);
  assert.deepEqual(persistedReport.positives, ["【耐用】暂无数据：长期稳定"]);
  assert.deepEqual(persistedReport.audiences, ["人群分类｜特征", "家庭用户｜日常使用"]);
  assert.equal(persistedReport.alexaReport.asin, ASIN_B);
  assert.equal(persistedReport.alexaReport.rating, 0);
  assert.equal(persistedReport.alexaReport.reviewCount, 0);
  assert.equal("starBreakdown" in persistedReport.alexaReport, false);
  assert.equal("captureNote" in persistedReport.alexaReport, false);
});

test("worker rejects a snapshot whose declared execution identity differs from runtime config", async () => {
  const report = "private Alexa report";
  const declaredIdentity = {
    providerName: "openai:responses-strict",
    model: {
      name: "model-a",
      estimatedInputTokens: 100,
      maxOutputTokens: 200,
      timeoutMs: 1_000,
      pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 },
    },
  } as const;
  const fingerprint = createAlexaVocNormalizationFingerprint({
    rawReportSha256: canonicalJsonSha256(report),
    executionIdentity: declaredIdentity,
  });
  let modelCalls = 0;
  const service = new AlexaVocNormalizationExecutionService({
    repository: {
      async findNormalizationInputSnapshot() {
        return {
          id: randomUUID(), organizationId: "10000000-0000-4000-8000-000000000001",
          projectId: "10000000-0000-4000-8000-000000000002", runId: "10000000-0000-4000-8000-000000000003",
          marketplace: "US" as const, asin: ASIN_A, rawReportSha256: canonicalJsonSha256(report),
          plaintextBytes: Buffer.byteLength(report), executionFingerprint: fingerprint,
          executionIdentity: declaredIdentity, envelope: {} as never, createdAt: "2026-09-01T00:00:00.000Z",
        };
      },
      async findCommittedNormalizationByFingerprint() { return null; },
      async commitNormalizationAndWake() { throw new Error("must not commit"); },
    },
    normalizationInputCipher: {
      activeKeyId: "test", encrypt() { throw new Error("not used"); }, decrypt() { return report; },
    },
    auditedRunner: { async run() { modelCalls += 1; throw new Error("must not dispatch"); } },
  });

  await assert.rejects(service.execute({
    snapshotId: randomUUID(),
    providerName: declaredIdentity.providerName,
    model: { ...declaredIdentity.model, name: "model-b" },
  }, {
    actorId: randomUUID(), organizationId: "10000000-0000-4000-8000-000000000001",
    projectId: "10000000-0000-4000-8000-000000000002", runId: "10000000-0000-4000-8000-000000000003",
    stageId: randomUUID(), jobAttemptId: randomUUID(), leaseOwnerId: "worker", leaseGeneration: 1,
    logicalExecutionCycleId: "a".repeat(64), dataCutoffAt: "2026-09-01T00:00:00.000Z",
  }), /execution identity/i);
  assert.equal(modelCalls, 0);
});

test("worker retries an older failed snapshot but never reprocesses success or the current attempt", () => {
  const shouldProcess = normalizationRuntime.shouldProcessAlexaVocNormalizationSnapshot;
  const failed = {
    snapshotId: "snapshot-retry",
    jobAttemptId: "job-1",
    status: "failure" as const,
  };
  assert.equal(shouldProcess({
    snapshotId: "snapshot-retry",
    jobAttemptId: "job-2",
    terminals: [failed],
  }), true);
  assert.equal(shouldProcess({
    snapshotId: "snapshot-retry",
    jobAttemptId: "job-1",
    terminals: [failed],
  }), false);
  assert.equal(shouldProcess({
    snapshotId: "snapshot-retry",
    jobAttemptId: "job-3",
    terminals: [failed, { ...failed, jobAttemptId: "job-2", status: "success" }],
  }), false);
});

test("drains a snapshot that arrives after the first normalization page", async () => {
  const snapshots = [{ id: "snapshot-a", asin: ASIN_A }];
  let finalizations = 0;
  const executed: string[] = [];
  const handler = createAlexaVocNormalizationJobHandler({
    prepare: async () => ({
      snapshots,
      context: {
        actorId: "actor-1",
        organizationId: "org-1",
        projectId: "project-1",
        dataCutoffAt: "2026-09-01T00:00:00.000Z",
      },
      providerName: "local-fixture",
      model: {
        name: "fake-model",
        estimatedInputTokens: 100,
        maxOutputTokens: 200,
        timeoutMs: 1_000,
        pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 },
      },
    }),
    service: {
      async execute(request) {
        executed.push(request.snapshotId);
        return {
          revision: { asin: request.snapshotId === "snapshot-a" ? ASIN_A : ASIN_B },
          agentRunId: `agent-${request.snapshotId}`,
          replayed: false,
        } as never;
      },
    },
    onTerminal: async () => undefined,
    finalize: async () => {
      finalizations += 1;
      if (finalizations === 1) {
        snapshots.push({ id: "snapshot-b", asin: ASIN_B });
        return false;
      }
      return true;
    },
  });
  await handler({
    job: {
      id: "job-1",
      runId: "run-1",
      stageId: "stage-1",
      stage: "alexa-voc-normalization",
      leasedBy: "worker-1",
      leaseGeneration: 1,
      logicalExecutionCycleId: "a".repeat(64),
    } as never,
    signal: new AbortController().signal,
  });
  assert.deepEqual(executed, ["snapshot-a", "snapshot-b"]);
  assert.equal(finalizations, 2);
});

test("committed fingerprint replay writes success provenance without a model call", async () => {
  let modelCalls = 0;
  const replayed: unknown[] = [];
  const handler = createAlexaVocNormalizationJobHandler({
    prepare: async () => ({
      snapshots: [{
        id: "snapshot-replay",
        asin: ASIN_A,
        executionFingerprint: "f".repeat(64),
        replay: { agentRunId: "agent-original", revision: "7" },
      }],
      context: {
        actorId: "actor-1",
        organizationId: "org-1",
        projectId: "project-1",
        dataCutoffAt: "2026-09-01T00:00:00.000Z",
      },
      providerName: "local-fixture",
      model: {
        name: "fake-model",
        estimatedInputTokens: 100,
        maxOutputTokens: 200,
        timeoutMs: 1_000,
        pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 },
      },
    }),
    service: {
      async execute() {
        modelCalls += 1;
        throw new Error("replay must not execute the model");
      },
    },
    onReplay: async (input: unknown) => { replayed.push(input); },
    onTerminal: async () => undefined,
    finalize: async () => true,
  } as never);

  await handler({
    job: {
      id: "job-replay",
      runId: "run-replay",
      stageId: "stage-replay",
      stage: "alexa-voc-normalization",
      leasedBy: "worker-1",
      leaseGeneration: 1,
      logicalExecutionCycleId: "a".repeat(64),
    } as never,
    signal: new AbortController().signal,
  });

  assert.equal(modelCalls, 0);
  assert.equal(replayed.length, 1);
});

test("new cumulative snapshots durably follow up running and succeeded positioning", async () => {
  const wake = (normalizationRuntime as unknown as {
    wakeVocPositioning: (
      repository: unknown,
      runId: string,
      now: string,
    ) => Promise<boolean>;
  }).wakeVocPositioning;
  assert.equal(typeof wake, "function");

  const now = "2026-09-01T00:00:00.000Z";
  const runningJobs = [{
    id: "job-running",
    stageId: "stage-positioning",
    attemptNumber: 1,
    maxAttempts: 3,
    status: "running",
  }];
  const runningRepository = {
    async listRunStages() {
      return [{ id: "stage-positioning", stage: "voc-positioning", status: "running" }];
    },
    async listJobAttempts() { return runningJobs; },
    async enqueueJob(input: unknown) {
      runningJobs.push({
        ...(input as Record<string, unknown>),
        status: "queued",
      } as never);
      return input;
    },
  };
  assert.equal(await wake(runningRepository, "run-1", now), true);
  assert.equal(runningJobs.filter((job) => job.status === "queued").length, 1);
  assert.equal(await wake(runningRepository, "run-1", now), false);
  assert.equal(runningJobs.filter((job) => job.status === "queued").length, 1);

  const retries: unknown[] = [];
  const succeededRepository = {
    async listRunStages() {
      return [
        { id: "stage-positioning", stage: "voc-positioning", status: "succeeded" },
        { id: "stage-product", stage: "product-definition", status: "succeeded" },
      ];
    },
    async retryFailedRunStage(input: unknown) {
      retries.push(input);
      return { stage: {}, attempt: {} };
    },
  };
  assert.equal(await wake(succeededRepository, "run-1", now), true);
  assert.equal(retries.length, 1);
  assert.deepEqual(
    (retries[0] as { staleStageIds: string[] }).staleStageIds,
    ["stage-product"],
  );
});
