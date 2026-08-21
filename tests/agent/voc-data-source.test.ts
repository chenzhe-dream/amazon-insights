import assert from "node:assert/strict";
import test from "node:test";

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

const validAlexaRecord = {
  asin: "B07VY9Q95Q",
  captureStatus: "dialog" as const,
  alexaReport: {
    title: "Customer review analysis",
    asin: "B07VY9Q95Q",
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

const validReviewRecord = {
  asin: "B07VY9Q95Q",
  marketplace: "US",
  sampledReviews: 10,
  fetchedAt: "2026-08-10",
  status: "ready" as const,
  blocks: [
    {
      key: "positives" as const,
      label: "Positive themes",
      rows: [{ label: "stable", sharePct: 20, reason: "review evidence" }],
    },
  ],
};

function validPayload() {
  return {
    schemaVersion: VOC_SNAPSHOT_SCHEMA_VERSION,
    kind: "voc" as const,
    marketplace: "US",
    asins: ["B07VY9Q95Q"],
    records: {
      alexaVoc: [validAlexaRecord],
      sorftimeReviewAnalysis: [validReviewRecord],
      sellerSpriteReviewAnalysis: [],
    },
  };
}

test("repository date-only values use the end of their UTC calendar day", () => {
  assert.equal(
    normalizeRepositoryDateOnlyUtc("2026-08-13"),
    "2026-08-13T23:59:59.999Z",
  );
  assert.throws(
    () => normalizeRepositoryDateOnlyUtc("2026-8-13"),
    /date-only/i,
  );
  assert.throws(
    () => normalizeRepositoryDateOnlyUtc("2026-02-30"),
    /date-only/i,
  );
});

test("VOC snapshot payload is a strict versioned closed contract", () => {
  assert.equal(VOC_SNAPSHOT_SCHEMA_VERSION, "1.0.0");
  assert.equal(VocSnapshotPayloadSchema.safeParse(validPayload()).success, true);
  assert.equal(
    VocSnapshotPayloadSchema.safeParse({ ...validPayload(), extra: true }).success,
    false,
  );
  assert.equal(
    VocSnapshotPayloadSchema.safeParse({
      ...validPayload(),
      records: {
        ...validPayload().records,
        alexaVoc: [{ ...validAlexaRecord, extra: true }],
      },
    }).success,
    false,
  );
  assert.equal(
    VocSnapshotPayloadSchema.safeParse({
      ...validPayload(),
      records: {
        ...validPayload().records,
        sorftimeReviewAnalysis: [
          {
            ...validReviewRecord,
            blocks: [
              {
                ...validReviewRecord.blocks[0],
                rows: [
                  {
                    ...validReviewRecord.blocks[0]!.rows[0],
                    hidden: "not persisted",
                  },
                ],
              },
            ],
          },
        ],
      },
    }).success,
    false,
  );
});

test("VOC snapshot payload rejects malformed source data and target identity", () => {
  assert.equal(
    VocSnapshotPayloadSchema.safeParse({
      ...validPayload(),
      asins: ["b07vy9q95q"],
    }).success,
    false,
  );
  assert.equal(
    VocSnapshotPayloadSchema.safeParse({
      ...validPayload(),
      asins: ["B07VY9Q95Q", "B07VY9Q95Q"],
    }).success,
    false,
  );
  assert.equal(
    VocSnapshotPayloadSchema.safeParse({
      ...validPayload(),
      records: {
        ...validPayload().records,
        alexaVoc: [{ ...validAlexaRecord, captureStatus: "pending" }],
      },
    }).success,
    false,
  );
  assert.equal(
    VocSnapshotPayloadSchema.safeParse({
      ...validPayload(),
      records: {
        ...validPayload().records,
        sorftimeReviewAnalysis: [
          {
            ...validReviewRecord,
            blocks: [
              {
                ...validReviewRecord.blocks[0],
                rows: [{ label: "bad", sharePct: 100.01, reason: "invalid" }],
              },
            ],
          },
        ],
      },
    }).success,
    false,
  );
  assert.equal(
    VocSnapshotPayloadSchema.safeParse({
      ...validPayload(),
      records: {
        ...validPayload().records,
        sellerSpriteReviewAnalysis: [
          { ...validReviewRecord, asin: "B09V5RW2VK" },
        ],
      },
    }).success,
    false,
  );
});

test("persisted VOC snapshot record locks metadata and payload to schema 1.0.0", () => {
  const candidate = new RepositoryVocSourceReader().read({
    marketplace: "US",
    asins: ["B09V5RW2VK", "B07VY9Q95Q", "B0BPXRVWYK"],
    dataCutoffAt: "2026-08-15T00:00:00.000Z",
  }).candidate!;
  const record = {
    ...candidate,
    id: "60000000-0000-4000-8000-000000000001",
    runId: "60000000-0000-4000-8000-000000000002",
    createdAt: "2026-08-15T00:00:00.000Z",
  };

  assert.equal(VocDataSnapshotRecordSchema.safeParse(record).success, true);
  assert.equal(
    VocDataSnapshotRecordSchema.safeParse({
      ...record,
      schemaVersion: "2.0.0",
    }).success,
    false,
  );
});

test("real repository sources are filtered by ordered target ASINs with provenance", () => {
  const reader = new RepositoryVocSourceReader();
  const result = reader.read({
    marketplace: " us ",
    asins: ["b09v5rw2vk", " B07VY9Q95Q ", "b0bpxrvwyk"],
    dataCutoffAt: "2026-08-15T00:00:00.000Z",
  });

  assert.ok(result.candidate);
  assert.deepEqual(result.candidate.asins, [
    "B09V5RW2VK",
    "B07VY9Q95Q",
    "B0BPXRVWYK",
  ]);
  assert.deepEqual(
    result.candidate.payload.records.alexaVoc.map(({ asin }) => asin),
    result.candidate.asins,
  );
  assert.deepEqual(
    result.candidate.payload.records.sorftimeReviewAnalysis.map(
      ({ asin }) => asin,
    ),
    result.candidate.asins,
  );
  assert.deepEqual(
    result.candidate.payload.records.sellerSpriteReviewAnalysis.map(
      ({ asin }) => asin,
    ),
    result.candidate.asins,
  );
  assert.equal(result.recordCount, 9);
  assert.deepEqual(result.missingSources, []);
  assert.deepEqual(
    result.candidate.sources.map(({ type, reference, capturedAt }) => ({
      type,
      reference,
      capturedAt,
    })),
    [
      {
        type: "manual-voc",
        reference: VOC_SOURCE_REFERENCES.alexaVoc,
        capturedAt: "2026-08-12T23:59:59.999Z",
      },
      {
        type: "connector",
        reference: VOC_SOURCE_REFERENCES.sorftimeReviewAnalysis,
        capturedAt: "2026-08-10T23:59:59.999Z",
      },
      {
        type: "connector",
        reference: VOC_SOURCE_REFERENCES.sellerSpriteReviewAnalysis,
        capturedAt: "2026-08-10T23:59:59.999Z",
      },
    ],
  );
  result.candidate.sources.forEach((source) =>
    assert.match(source.checksum, /^[a-f0-9]{64}$/),
  );
  assert.match(result.candidate.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.candidate.payload.records.alexaVoc[0]), true);
  assert.doesNotThrow(() => assertVocSnapshotCandidateIntegrity(result.candidate!));
});

test("Alexa provenance is trusted US-only and never relabeled for another marketplace", () => {
  const asins = ["B09V5RW2VK", "B07VY9Q95Q", "B0BPXRVWYK"];
  const us = new RepositoryVocSourceReader().read({
    marketplace: "US",
    asins,
    dataCutoffAt: "2026-08-15T00:00:00.000Z",
  });
  assert.ok(us.candidate);
  assert.equal(us.candidate.payload.records.alexaVoc.length, 3);

  const ca = new RepositoryVocSourceReader().read({
    marketplace: "CA",
    asins,
    dataCutoffAt: "2026-08-15T00:00:00.000Z",
  });
  assert.equal(ca.candidate, null);
  assert.deepEqual(
    ca.missingSources.filter(({ sourceId }) => sourceId === "alexa-voc"),
    asins.map((asin) => ({
      sourceId: "alexa-voc" as const,
      asin,
      reason: "marketplace-mismatch" as const,
    })),
  );
});

test("source checksums cover selected records and the overall hash covers provenance", () => {
  const reader = new RepositoryVocSourceReader();
  const first = reader.read({
    marketplace: "US",
    asins: ["B09V5RW2VK", "B07VY9Q95Q", "B0BPXRVWYK"],
    dataCutoffAt: "2026-08-15T00:00:00.000Z",
  }).candidate!;
  const replay = reader.read({
    marketplace: "US",
    asins: ["B09V5RW2VK", "B07VY9Q95Q", "B0BPXRVWYK"],
    dataCutoffAt: "2026-08-15T00:00:00.000Z",
  }).candidate!;

  assert.deepEqual(replay, first);
  assert.equal(
    first.sources[0]!.checksum,
    canonicalJsonSha256({
      sourceId: "alexa-voc",
      marketplace: "US",
      records: first.payload.records.alexaVoc,
    }),
  );
  assert.equal(
    first.sources[1]!.checksum,
    canonicalJsonSha256({
      sourceId: "sorftime-review-analysis",
      marketplace: "US",
      records: first.payload.records.sorftimeReviewAnalysis,
    }),
  );
  assert.equal(
    first.sources[2]!.checksum,
    canonicalJsonSha256({
      sourceId: "seller-sprite-review-analysis",
      marketplace: "US",
      records: first.payload.records.sellerSpriteReviewAnalysis,
    }),
  );
  assert.notEqual(
    canonicalJsonSha256({
      sourceId: "alexa-voc",
      marketplace: "CA",
      records: first.payload.records.alexaVoc,
    }),
    first.sources[0]!.checksum,
  );

  const changed = buildVocSnapshotCandidate({
    marketplace: first.marketplace,
    asins: first.asins,
    dataCutoffAt: first.dataCutoffAt,
    sourceBundles: [
      {
        sourceId: "alexa-voc",
        type: "manual-voc",
        reference: VOC_SOURCE_REFERENCES.alexaVoc,
        marketplace: first.sources[0]!.marketplace,
        capturedAt: first.sources[0]!.capturedAt,
        records: [
          {
            ...first.payload.records.alexaVoc[0]!,
            positives: ["changed source text"],
          },
          ...first.payload.records.alexaVoc.slice(1),
        ],
      },
      {
        sourceId: "sorftime-review-analysis",
        type: "connector",
        reference: VOC_SOURCE_REFERENCES.sorftimeReviewAnalysis,
        marketplace: first.sources[1]!.marketplace,
        capturedAt: first.sources[1]!.capturedAt,
        records: first.payload.records.sorftimeReviewAnalysis,
      },
      {
        sourceId: "seller-sprite-review-analysis",
        type: "connector",
        reference: VOC_SOURCE_REFERENCES.sellerSpriteReviewAnalysis,
        marketplace: first.sources[2]!.marketplace,
        capturedAt: first.sources[2]!.capturedAt,
        records: first.payload.records.sellerSpriteReviewAnalysis,
      },
    ],
  });

  assert.notEqual(changed.sources[0]!.checksum, first.sources[0]!.checksum);
  assert.equal(changed.sources[1]!.checksum, first.sources[1]!.checksum);
  assert.notEqual(changed.contentHash, first.contentHash);
});

test("pending, error, unavailable, and after-cutoff inputs use closed missing reasons", () => {
  const reader = new RepositoryVocSourceReader({
    alexa: {
      meta: { capturedAt: "2026-08-12", marketplace: "US" },
      data: {
        B07VY9Q95Q: validAlexaRecord,
        B09V5RW2VK: {
          ...validAlexaRecord,
          asin: undefined,
          captureStatus: "pending",
          alexaReport: {
            ...validAlexaRecord.alexaReport,
            asin: "B09V5RW2VK",
            captureStatus: "pending",
          },
        },
      },
    },
    sorftime: {
      meta: { marketplace: "US" },
      data: {
        B07VY9Q95Q: { ...validReviewRecord, fetchedAt: "2026-08-12" },
        B09V5RW2VK: {
          ...validReviewRecord,
          asin: "B09V5RW2VK",
          status: "error",
          blocks: [],
        },
      },
    },
    sellerSprite: {
      meta: { marketplace: "CA" },
      data: {
        B07VY9Q95Q: { ...validReviewRecord, marketplace: "CA" },
      },
    },
  });
  const result = reader.read({
    marketplace: "US",
    asins: ["B07VY9Q95Q", "B09V5RW2VK", "B0BPXRVWYK"],
    dataCutoffAt: "2026-08-12T12:00:00.000Z",
  });

  assert.equal(result.candidate, null);
  assert.equal(result.recordCount, 0);
  assert.deepEqual(result.missingSources, [
    { sourceId: "alexa-voc", asin: "B07VY9Q95Q", reason: "after-cutoff" },
    { sourceId: "alexa-voc", asin: "B09V5RW2VK", reason: "pending" },
    { sourceId: "alexa-voc", asin: "B0BPXRVWYK", reason: "not-found" },
    {
      sourceId: "sorftime-review-analysis",
      asin: "B07VY9Q95Q",
      reason: "after-cutoff",
    },
    {
      sourceId: "sorftime-review-analysis",
      asin: "B09V5RW2VK",
      reason: "source-error",
    },
    {
      sourceId: "sorftime-review-analysis",
      asin: "B0BPXRVWYK",
      reason: "not-found",
    },
    {
      sourceId: "seller-sprite-review-analysis",
      asin: "B07VY9Q95Q",
      reason: "marketplace-mismatch",
    },
    {
      sourceId: "seller-sprite-review-analysis",
      asin: "B09V5RW2VK",
      reason: "not-found",
    },
    {
      sourceId: "seller-sprite-review-analysis",
      asin: "B0BPXRVWYK",
      reason: "not-found",
    },
  ]);
});

test("partial repository availability writes only real records and reports missing inputs", () => {
  const result = new RepositoryVocSourceReader().read({
    marketplace: "US",
    asins: ["B0D48BPKRH", "B08Z36X6B4", "B0D77D5WKD"],
    dataCutoffAt: "2026-08-15T00:00:00.000Z",
  });

  assert.ok(result.candidate);
  assert.equal(result.candidate.sources.length, 1);
  assert.equal(
    result.candidate.sources[0]!.reference,
    VOC_SOURCE_REFERENCES.sorftimeReviewAnalysis,
  );
  assert.equal(result.candidate.payload.records.alexaVoc.length, 0);
  assert.equal(result.candidate.payload.records.sorftimeReviewAnalysis.length, 3);
  assert.equal(result.candidate.payload.records.sellerSpriteReviewAnalysis.length, 0);
  assert.deepEqual(
    result.missingSources.map(({ sourceId, reason }) => ({ sourceId, reason })),
    [
      { sourceId: "alexa-voc", reason: "pending" },
      { sourceId: "alexa-voc", reason: "pending" },
      { sourceId: "alexa-voc", reason: "pending" },
      { sourceId: "seller-sprite-review-analysis", reason: "not-found" },
      { sourceId: "seller-sprite-review-analysis", reason: "not-found" },
      { sourceId: "seller-sprite-review-analysis", reason: "not-found" },
    ],
  );
});
