import assert from "node:assert/strict";
import test from "node:test";

import {
  VocDataSnapshotRecordSchema,
  type VocDataSnapshotRecord,
} from "../../server/data/voc-data-snapshot";
import { RepositoryVocSourceReader } from "../../server/data/repository-voc-source";
import {
  VocDeterministicPreprocessingResultSchema,
  preprocessVocSnapshot,
} from "../../server/domain/voc/preprocess-voc-snapshot";

const IDS = {
  scooterSnapshot: "11111111-1111-4111-8111-111111111111",
  lightingSnapshot: "22222222-2222-4222-8222-222222222222",
  run: "33333333-3333-4333-8333-333333333333",
} as const;

function realSnapshot(
  asins: readonly string[],
  id: string,
): VocDataSnapshotRecord {
  const read = new RepositoryVocSourceReader().read({
    marketplace: "US",
    asins,
    dataCutoffAt: "2026-08-15T23:59:59.999Z",
  });
  assert.ok(read.candidate);
  return VocDataSnapshotRecordSchema.parse({
    ...read.candidate,
    id,
    runId: IDS.run,
    createdAt: "2026-08-15T23:59:59.999Z",
  });
}

function dimension(
  result: ReturnType<typeof preprocessVocSnapshot>,
  key: string,
) {
  const found = result.dimensions.find((item) => item.key === key);
  assert.ok(found);
  return found;
}

test("real scooter snapshot produces strict source-scoped facts and resolvable evidence", () => {
  const snapshot = realSnapshot(
    ["B07VY9Q95Q", "B0BPXRVWYK", "B07DYG1C9B"],
    IDS.scooterSnapshot,
  );
  const result = preprocessVocSnapshot(snapshot);

  assert.equal(result.schemaVersion, "1.0.0");
  assert.equal(result.kind, "voc-deterministic-preprocessing");
  assert.deepEqual(result.snapshot.asins, snapshot.asins);
  assert.deepEqual(
    result.availability.map((source) => [
      source.sourceId,
      source.status,
      source.recordCount,
    ]),
    [
      ["alexa-voc", "available", 3],
      ["sorftime-review-analysis", "available", 3],
      ["seller-sprite-review-analysis", "available", 3],
    ],
  );
  assert.deepEqual(
    result.dimensions.map((item) => item.key),
    [
      "attention",
      "positives",
      "negatives",
      "unmet",
      "audiences",
      "scenarios",
      "motives",
    ],
  );

  const durability = dimension(result, "positives").themes.find(
    (theme) => theme.label === "耐用性 / 结构强度",
  );
  assert.ok(durability);
  assert.deepEqual(
    durability.metrics
      .filter(
        (metric) =>
          metric.asin === "B07VY9Q95Q" && metric.sourceId !== "alexa-voc",
      )
      .map((metric) => [
        metric.sourceId,
        metric.mentionCount,
        metric.sampleCount,
        metric.mentionPct,
      ]),
    [
      ["sorftime-review-analysis", null, 100, 12.1],
      ["seller-sprite-review-analysis", null, 99, 13.13],
    ],
  );
  const evidenceIds = new Set(result.evidenceIndex.map((evidence) => evidence.id));
  assert.equal(
    result.dimensions.every((item) =>
      item.themes.every((theme) =>
        theme.evidenceIds.every((id) => evidenceIds.has(id)),
      ),
    ),
    true,
  );
  assert.equal(
    result.evidenceIndex.every(
      (evidence) =>
        evidence.snapshotId === snapshot.id &&
        evidence.runId === snapshot.runId &&
        evidence.marketplace === snapshot.marketplace &&
        snapshot.asins.includes(evidence.asin),
    ),
    true,
  );
  assert.deepEqual(
    VocDeterministicPreprocessingResultSchema.parse(result),
    result,
  );
  assert.equal(Object.isFrozen(result), true);
  assert.match(result.canonicalDigest, /^[a-f0-9]{64}$/);
});

test("real lighting snapshot reports unavailable sources without fabricating zero facts", () => {
  const snapshot = realSnapshot(
    ["B08Z36X6B4", "B0D77D5WKD", "B0BVFX154J"],
    IDS.lightingSnapshot,
  );
  const result = preprocessVocSnapshot(snapshot);

  assert.deepEqual(
    result.availability.map((source) => [
      source.sourceId,
      source.status,
      source.recordCount,
      source.comparability,
    ]),
    [
      ["alexa-voc", "unavailable", 0, "unknown"],
      ["sorftime-review-analysis", "available", 3, "not-comparable"],
      ["seller-sprite-review-analysis", "unavailable", 0, "unknown"],
    ],
  );
  const facts = result.dimensions.flatMap((item) =>
    item.themes.flatMap((theme) => theme.metrics),
  );
  assert.equal(facts.some((metric) => metric.sourceId === "alexa-voc"), false);
  assert.equal(
    facts.every(
      (metric) =>
        metric.sourceId !== "sorftime-review-analysis" ||
        (metric.mentionCount === null && metric.sampleCount !== null),
    ),
    true,
  );
  assert.equal(
    facts.some(
      (metric) =>
        metric.mentionCount === 0 ||
        metric.sampleCount === 0 ||
        metric.mentionPct === 0,
    ),
    false,
  );
  assert.deepEqual(
    VocDeterministicPreprocessingResultSchema.parse(result),
    result,
  );
});
