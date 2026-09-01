import assert from "node:assert/strict";
import { test } from "node:test";

import { randomUUID } from "node:crypto";

import { MANUAL_ALEXA_VOC_SEVEN_QUESTION_PROMPT } from "../../shared/agent-contracts";
import { canonicalJsonSha256 } from "../../server/runtime/model-request-accounting";
import { SkillRuntimeError } from "../../server/runtime/skill-runner";
import { AlexaVocNormalizationExecutionService } from "../../server/services/alexa-voc-normalization-execution-service";
import { createAlexaVocNormalizationJobHandler } from "../../server/services/alexa-voc-normalization-worker-handler";

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

test("binds one audited run and committed revision to the encrypted snapshot fingerprint", async () => {
  const report = "private Alexa report";
  const fingerprint = canonicalJsonSha256({ report, model: "fake-model" });
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
    attention: ["1. 质量：耐用。"],
    positives: ["【耐用】约 10% 评论提及（10 条）"],
    negatives: ["【重量】约 1% 评论提及（1 条）"],
    unmet: ["1. 希望更轻。"],
    audiences: ["人群分类｜特征", "家庭用户｜日常使用"],
    scenarios: ["场景｜说明与示例", "家庭｜室内使用"],
    motives: ["动机｜重要性｜说明", "耐用｜⭐⭐⭐⭐⭐｜质量"],
    captureStatus: "dialog" as const,
    alexaReport: {
      title: "顾客评价深度分析" as const,
      asin: ASIN_B,
      rating: 0,
      reviewCount: 0,
      prompt: MANUAL_ALEXA_VOC_SEVEN_QUESTION_PROMPT,
      overallConclusion: "耐用但希望更轻。",
      captureStatus: "dialog" as const,
    },
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
            normalizedRecord: { asin: ASIN_B, ...normalizedRecord },
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
      model: {
        name: "fake-model",
        estimatedInputTokens: 100,
        maxOutputTokens: 200,
        timeoutMs: 1_000,
        pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 },
      },
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
  assert.equal(JSON.stringify(committed).includes(report), false);
  assert.equal((committed[0] as { contentHash: string }).contentHash, fingerprint);
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
