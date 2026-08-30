import assert from "node:assert/strict";
import test from "node:test";

import {
  ManualAlexaVocRepositoryError,
  type ManualAlexaVocRepositoryErrorKind,
  type ManualAlexaVocRevision,
} from "../../server/db/manual-alexa-voc-repository";
import {
  VOC_SNAPSHOT_SCHEMA_VERSION,
  VOC_SOURCE_REFERENCES,
  VocDataSnapshotRecordSchema,
  VocSnapshotPayloadSchema,
  assertVocSnapshotCandidateIntegrity,
  buildVocSnapshotCandidate,
  normalizeRepositoryDateOnlyUtc,
} from "../../server/data/voc-data-snapshot";
import { RepositoryVocSourceReader } from "../../server/data/repository-voc-source";
import { canonicalJsonSha256 } from "../../server/runtime/model-request-accounting";

const ORGANIZATION_ID = "org-task-7";
const ASINS = ["B0TEST0001", "B0TEST0002", "B0TEST0003"] as const;
const CUTOFF = "2026-08-31T12:00:00.000Z";

function validAlexaRecord(asin: string = ASINS[0]) {
  return {
    asin,
    captureStatus: "dialog" as const,
    alexaReport: {
      title: "Customer review analysis",
      asin,
      rating: 4.6,
      reviewCount: 99,
      prompt: "Summarize customer concerns",
      overallConclusion: "Customers value stability.",
      captureStatus: "dialog" as const,
    },
    attention: ["stability"],
    positives: ["easy assembly"],
    negatives: ["hard steering"],
    unmet: ["better brake"],
    audiences: ["parents"],
    scenarios: ["outdoors"],
    motives: ["gift"],
  };
}

function validReviewRecord(asin: string = ASINS[0]) {
  return {
    asin,
    marketplace: "US",
    sampledReviews: 10,
    fetchedAt: "2026-08-10",
    status: "ready" as const,
    blocks: [{
      key: "positives" as const,
      label: "Positive themes",
      rows: [{ label: "stable", sharePct: 20, reason: "review evidence" }],
    }],
  };
}

function dynamicRevision(
  asin: string,
  capturedAt = "2026-08-31T10:11:12.345Z",
  organizationId = ORGANIZATION_ID,
): ManualAlexaVocRevision {
  return {
    organizationId,
    marketplace: "US",
    asin,
    revision: "7",
    contentHash: "a".repeat(64),
    capturedAt,
    normalizedRecord: validAlexaRecord(asin),
    normalizedSchemaVersion: "alexa-voc-record/v2",
    parserVersion: "deterministic-alexa-parser/v3",
  };
}

function dynamicRepository(
  records: readonly ManualAlexaVocRevision[],
  failure?: ManualAlexaVocRepositoryErrorKind,
) {
  const calls: unknown[] = [];
  return {
    calls,
    async listAtCutoff(input: unknown) {
      calls.push(input);
      if (failure) throw new ManualAlexaVocRepositoryError(failure);
      return records;
    },
  };
}

function legacySource(
  records: Readonly<Record<string, ReturnType<typeof validAlexaRecord>>> = {},
) {
  const calls: Array<Readonly<Record<string, unknown>>> = [];
  return {
    calls,
    async readIfEligible(input: Readonly<Record<string, unknown>>) {
      calls.push(input);
      const asin = String(input.asin);
      const normalizedRecord = records[asin];
      return normalizedRecord
        ? {
            status: "ready" as const,
            source: "legacy-static-stale" as const,
            record: {
              asin,
              marketplace: "US" as const,
              revision: "3",
              normalizedRecord,
              source: "legacy-static-stale" as const,
              generation: "9",
              capturedAt: "2026-08-30T09:08:07.654Z",
            },
          }
        : { status: "missing" as const, reason: "not-found" as const };
    },
  };
}

function reader(input: Readonly<{
  dynamic?: readonly ManualAlexaVocRevision[];
  failure?: ManualAlexaVocRepositoryErrorKind;
  legacy?: ReturnType<typeof legacySource>;
  reviewSources?: ConstructorParameters<typeof RepositoryVocSourceReader>[0]["reviewSources"];
}> = {}) {
  const manualVoc = dynamicRepository(input.dynamic ?? [], input.failure);
  const legacy = input.legacy ?? legacySource();
  return {
    manualVoc,
    legacy,
    value: new RepositoryVocSourceReader({
      manualVoc,
      legacySource: legacy,
      ...(input.reviewSources ? { reviewSources: input.reviewSources } : {}),
    }),
  };
}

function readInput() {
  return {
    organizationId: ORGANIZATION_ID,
    marketplace: "US",
    asins: ASINS,
    dataCutoffAt: CUTOFF,
  } as const;
}

function validPayload() {
  return {
    schemaVersion: VOC_SNAPSHOT_SCHEMA_VERSION,
    kind: "voc" as const,
    marketplace: "US",
    asins: [ASINS[0]],
    records: {
      alexaVoc: [validAlexaRecord()],
      sorftimeReviewAnalysis: [validReviewRecord()],
      sellerSpriteReviewAnalysis: [],
    },
  };
}

test("repository date-only values use the end of their UTC calendar day", () => {
  assert.equal(normalizeRepositoryDateOnlyUtc("2026-08-13"), "2026-08-13T23:59:59.999Z");
  assert.throws(() => normalizeRepositoryDateOnlyUtc("2026-8-13"), /date-only/i);
  assert.throws(() => normalizeRepositoryDateOnlyUtc("2026-02-30"), /date-only/i);
});

test("VOC snapshot payload is a strict versioned closed contract", () => {
  assert.equal(VOC_SNAPSHOT_SCHEMA_VERSION, "1.0.0");
  assert.equal(VocSnapshotPayloadSchema.safeParse(validPayload()).success, true);
  assert.equal(VocSnapshotPayloadSchema.safeParse({ ...validPayload(), extra: true }).success, false);
  assert.equal(VocSnapshotPayloadSchema.safeParse({
    ...validPayload(),
    records: { ...validPayload().records, alexaVoc: [{ ...validAlexaRecord(), extra: true }] },
  }).success, false);
});

test("VOC snapshot payload rejects malformed source data and target identity", () => {
  assert.equal(VocSnapshotPayloadSchema.safeParse({
    ...validPayload(), asins: [ASINS[0].toLowerCase()],
  }).success, false);
  assert.equal(VocSnapshotPayloadSchema.safeParse({
    ...validPayload(), asins: [ASINS[0], ASINS[0]],
  }).success, false);
  assert.equal(VocSnapshotPayloadSchema.safeParse({
    ...validPayload(),
    records: {
      ...validPayload().records,
      alexaVoc: [{ ...validAlexaRecord(), captureStatus: "pending" }],
    },
  }).success, false);
});

test("RepositoryVocSourceReader is async, organization scoped, and DB-first", async () => {
  const subject = reader({
    dynamic: ASINS.map((asin, index) =>
      dynamicRevision(asin, `2026-08-31T10:11:1${index}.345Z`),
    ),
  });
  const result = await subject.value.read(readInput());

  assert.deepEqual(subject.manualVoc.calls, [{
    organizationId: ORGANIZATION_ID,
    marketplace: "US",
    asins: [...ASINS],
    dataCutoffAt: CUTOFF,
  }]);
  assert.equal(subject.legacy.calls.length, 0);
  assert.deepEqual(result.candidate?.payload.records.alexaVoc.map(record => record.asin), [...ASINS]);
  assert.equal(result.candidate?.sources[0]?.capturedAt, "2026-08-31T10:11:12.345Z");
  assert.doesNotThrow(() => assertVocSnapshotCandidateIntegrity(result.candidate!));
});

test("only successful tenant misses invoke owner-gated legacy per missing ASIN", async () => {
  const legacy = legacySource({ [ASINS[1]]: validAlexaRecord(ASINS[1]) });
  const subject = reader({ dynamic: [dynamicRevision(ASINS[0])], legacy });
  const result = await subject.value.read(readInput());

  assert.deepEqual(legacy.calls.map(call => call.asin), [ASINS[1], ASINS[2]]);
  assert.deepEqual(
    result.candidate?.payload.records.alexaVoc.map(record => record.asin),
    [ASINS[0], ASINS[1]],
  );
  assert.deepEqual(
    result.missingSources.filter(missing => missing.sourceId === "alexa-voc"),
    [{ sourceId: "alexa-voc", asin: ASINS[2], reason: "not-found" }],
  );
});

test("typed repository failures fail closed without touching legacy", async () => {
  for (const kind of ["connection", "timeout", "permission", "schema", "deserialize"] as const) {
    const subject = reader({ failure: kind });
    await assert.rejects(
      () => subject.value.read(readInput()),
      (error: unknown) => error instanceof ManualAlexaVocRepositoryError && error.kind === kind,
    );
    assert.equal(subject.legacy.calls.length, 0, `${kind} must not consult legacy`);
  }
});

test("cross-organization dynamic records fail closed", async () => {
  const subject = reader({ dynamic: [dynamicRevision(ASINS[0], undefined, "org-other")] });
  await assert.rejects(
    () => subject.value.read(readInput()),
    (error: unknown) =>
      error instanceof ManualAlexaVocRepositoryError && error.kind === "deserialize",
  );
  assert.equal(subject.legacy.calls.length, 0);
});

test("persisted VOC snapshot record locks metadata and payload to schema 1.0.0", async () => {
  const candidate = (await reader({
    dynamic: ASINS.map(asin => dynamicRevision(asin)),
  }).value.read(readInput())).candidate!;
  const record = {
    ...candidate,
    id: "60000000-0000-4000-8000-000000000001",
    runId: "60000000-0000-4000-8000-000000000002",
    createdAt: CUTOFF,
  };
  assert.equal(VocDataSnapshotRecordSchema.safeParse(record).success, true);
  assert.equal(VocDataSnapshotRecordSchema.safeParse({
    ...record, schemaVersion: "2.0.0",
  }).success, false);
});

test("injected sources retain target order and provenance", async () => {
  const reviewSources = {
    sorftime: {
      meta: { marketplace: "US" },
      data: Object.fromEntries(ASINS.map(asin => [asin, validReviewRecord(asin)])),
    },
    sellerSprite: {
      meta: { marketplace: "US" },
      data: Object.fromEntries(ASINS.map(asin => [asin, validReviewRecord(asin)])),
    },
  };
  const result = await reader({
    dynamic: ASINS.map(asin => dynamicRevision(asin)), reviewSources,
  }).value.read({
    ...readInput(),
    marketplace: " us ",
    asins: ASINS.map(asin => ` ${asin.toLowerCase()} `),
  });

  assert.ok(result.candidate);
  assert.deepEqual(result.candidate.asins, [...ASINS]);
  assert.equal(result.recordCount, 9);
  assert.deepEqual(result.missingSources, []);
  assert.deepEqual(result.candidate.sources.map(({ type, reference }) => ({ type, reference })), [
    { type: "manual-voc", reference: VOC_SOURCE_REFERENCES.alexaVoc },
    { type: "connector", reference: VOC_SOURCE_REFERENCES.sorftimeReviewAnalysis },
    { type: "connector", reference: VOC_SOURCE_REFERENCES.sellerSpriteReviewAnalysis },
  ]);
  assert.equal(Object.isFrozen(result), true);
});

test("source checksums cover selected records and the overall hash covers provenance", async () => {
  const subject = reader({ dynamic: ASINS.map(asin => dynamicRevision(asin)) });
  const first = (await subject.value.read(readInput())).candidate!;
  const replay = (await subject.value.read(readInput())).candidate!;
  assert.deepEqual(replay, first);
  assert.equal(first.sources[0]!.checksum, canonicalJsonSha256({
    sourceId: "alexa-voc", marketplace: "US", records: first.payload.records.alexaVoc,
  }));

  const changed = buildVocSnapshotCandidate({
    marketplace: first.marketplace,
    asins: first.asins,
    dataCutoffAt: first.dataCutoffAt,
    sourceBundles: [{
      sourceId: "alexa-voc",
      type: "manual-voc",
      reference: VOC_SOURCE_REFERENCES.alexaVoc,
      marketplace: first.sources[0]!.marketplace,
      capturedAt: first.sources[0]!.capturedAt,
      records: [
        { ...first.payload.records.alexaVoc[0]!, positives: ["changed source text"] },
        ...first.payload.records.alexaVoc.slice(1),
      ],
    }],
  });
  assert.notEqual(changed.sources[0]!.checksum, first.sources[0]!.checksum);
  assert.notEqual(changed.contentHash, first.contentHash);
});

test("review failures keep closed missing reasons", async () => {
  const result = await reader({
    reviewSources: {
      sorftime: {
        meta: { marketplace: "US" },
        data: {
          [ASINS[0]]: { ...validReviewRecord(ASINS[0]), fetchedAt: "2026-09-01" },
          [ASINS[1]]: { ...validReviewRecord(ASINS[1]), status: "error", blocks: [] },
        },
      },
      sellerSprite: {
        meta: { marketplace: "CA" },
        data: { [ASINS[0]]: { ...validReviewRecord(ASINS[0]), marketplace: "CA" } },
      },
    },
  }).value.read(readInput());
  assert.equal(result.candidate, null);
  assert.deepEqual(result.missingSources.filter(missing => missing.sourceId !== "alexa-voc"), [
    { sourceId: "sorftime-review-analysis", asin: ASINS[0], reason: "after-cutoff" },
    { sourceId: "sorftime-review-analysis", asin: ASINS[1], reason: "source-error" },
    { sourceId: "sorftime-review-analysis", asin: ASINS[2], reason: "not-found" },
    { sourceId: "seller-sprite-review-analysis", asin: ASINS[0], reason: "marketplace-mismatch" },
    { sourceId: "seller-sprite-review-analysis", asin: ASINS[1], reason: "not-found" },
    { sourceId: "seller-sprite-review-analysis", asin: ASINS[2], reason: "not-found" },
  ]);
});
