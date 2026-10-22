import assert from "node:assert/strict";
import test from "node:test";
import { publishCumulativeVocSnapshotAndWake } from "../../server/runtime/alexa-voc-normalization-runtime";
import type { RuntimeAgentRepository } from "../../server/db/repository";

const asin = "B0NORM0001";
const now = "2026-09-27T00:00:00.000Z";
const input = {
  actorId: "10000000-0000-4000-8000-000000000001",
  actorOrganizationId: "10000000-0000-4000-8000-000000000002",
  projectId: "10000000-0000-4000-8000-000000000003",
  runId: "10000000-0000-4000-8000-000000000004",
  asins: [asin], dataCutoffAt: now, createdAt: now,
};

for (const mode of [undefined, "local-rules", "model"] as const) {
  for (const created of [true, false]) {
    test(`cumulative publication keeps snapshot without implicit model jobs: mode=${mode}, new=${created}`, async () => {
      const snapshots: unknown[] = [];
      let stageReads = 0, enqueued = 0;
      const repository = {
        manualAlexaVoc: { async listAtCutoff() { return [{
          organizationId: input.actorOrganizationId, marketplace: "US", asin,
          revision: "1", contentHash: "a".repeat(64), capturedAt: now,
          normalizedSchemaVersion: "alexa-voc-record/v2", parserVersion: "deterministic-alexa-parser/v3",
          normalizedRecord: { asin, captureStatus: "dialog", attention: ["耐用性"], positives: ["质量好"], negatives: ["较重"], unmet: ["更轻"], audiences: ["家庭"], scenarios: ["日常使用"], motives: ["可靠"], alexaReport: { asin, title: "原始 VOC", rating: 4, reviewCount: 20, prompt: "fixture", overallConclusion: "重视耐用性" } },
        }]; } },
        async createDataSnapshotForRun(value: unknown) { snapshots.push(value); return { created }; },
        async listRunStages() { stageReads++; return []; },
        async createRunStage(value: unknown) { return value; },
        async enqueueJob() { enqueued++; },
      } as unknown as RuntimeAgentRepository;
      const result = await publishCumulativeVocSnapshotAndWake(repository, {marketplace: "US",
        ...input, ...(mode ? { positioningMode: mode } : {}),
      });
      assert.equal(snapshots.length, 1, "snapshot persistence is independent of downstream mode");
      assert.match(JSON.stringify(snapshots), /耐用性/);
      assert.equal(result.snapshotCreated, created);
      const expectedWake = mode === "model" && created;
      assert.equal(result.wakeCreated, expectedWake);
      assert.equal(stageReads, Number(expectedWake), "local publication must not touch existing model stages");
      assert.equal(enqueued, Number(expectedWake));
    });
  }
}
