import { createHash } from "node:crypto";
import { canonicalJsonSha256 } from '../runtime/model-request-accounting';

import { z } from "zod";
import { TrafficListingCollectionSchema, type TrafficListingCollection } from '../../shared/traffic-listing-contract';

import {
  AsinSchema,
  DateTimeSchema,
  EntityIdSchema,
  MarketplaceSchema,
  Sha256Schema,
} from "../../shared/agent-contracts";
import {
  TrafficAnalysisInputSchema,
  type TrafficAnalysisInput,
} from "../domain/traffic/traffic-analysis-contracts";

export const TRAFFIC_SNAPSHOT_KIND = "traffic" as const;
export const TRAFFIC_SNAPSHOT_SCHEMA_VERSION = "1.0.0" as const;

const LegacyTrafficSnapshotSourceSchema = z.strictObject({
  id: z.enum(["sif-listing-traffic", "sif-monthly-traffic-trend"]),
  type: z.literal("connector"),
  reference: z.enum([
    "app/sif-listing-traffic-raw-data.ts#sifListingTrafficRawByAsin",
    "app/sif-monthly-traffic-trend-raw-data.ts#sifMonthlyTrafficRawByAsin",
  ]),
  capturedAt: DateTimeSchema,
  checksum: Sha256Schema,
});

const SifTrafficOperationSchema = z.enum([
  "ops_get_listing_traffic_overview",
  "ops_get_listing_traffic_structure",
  "ops_get_asin_traffic_trend",
]);

const CollectedTrafficSnapshotSourceSchema = z.strictObject({
  id: z.enum(["sif-listing-traffic", "sif-monthly-traffic-trend"]),
  type: z.literal("connector"),
  connectorId: z.literal("sif"),
  capturedAt: DateTimeSchema,
  checksum: Sha256Schema,
  requests: z.array(z.strictObject({
    asin: AsinSchema,
    operation: SifTrafficOperationSchema,
    fetchedAt: DateTimeSchema,
    attemptCount: z.number().int().positive().max(2),
    checksum: Sha256Schema,
  })).min(1).max(20),
});

export const TrafficSnapshotSourceSchema = z.union([
  LegacyTrafficSnapshotSourceSchema,
  CollectedTrafficSnapshotSourceSchema,
]);
export type TrafficSnapshotSource = z.infer<
  typeof TrafficSnapshotSourceSchema
>;

export const TrafficSnapshotCandidateSchema = z.strictObject({
  kind: z.literal(TRAFFIC_SNAPSHOT_KIND),
  schemaVersion: z.literal(TRAFFIC_SNAPSHOT_SCHEMA_VERSION),
  marketplace: MarketplaceSchema,
  asins: z.array(AsinSchema).min(1).max(10),
  dataCutoffAt: DateTimeSchema,
  sources: z.array(TrafficSnapshotSourceSchema).length(2),
  payload: z.strictObject({
    input: TrafficAnalysisInputSchema,
    listingCollection: TrafficListingCollectionSchema.optional(),
  }),
  contentHash: Sha256Schema,
});
export type TrafficSnapshotCandidate = z.infer<
  typeof TrafficSnapshotCandidateSchema
>;

export const TrafficDataSnapshotRecordSchema = TrafficSnapshotCandidateSchema
  .extend({
    id: EntityIdSchema,
    runId: EntityIdSchema,
    createdAt: DateTimeSchema,
  })
  .superRefine((snapshot, context) => {
    if (snapshot.payload.input.marketplace !== snapshot.marketplace) {
      context.addIssue({ code: "custom", path: ["payload", "input", "marketplace"], message: "Traffic snapshot marketplace mismatch" });
    }
    if (snapshot.payload.input.dataCutoffAt !== snapshot.dataCutoffAt) {
      context.addIssue({ code: "custom", path: ["payload", "input", "dataCutoffAt"], message: "Traffic snapshot cutoff mismatch" });
    }
    const unsigned = {
      kind: snapshot.kind,
      schemaVersion: snapshot.schemaVersion,
      marketplace: snapshot.marketplace,
      asins: snapshot.asins,
      dataCutoffAt: snapshot.dataCutoffAt,
      sources: snapshot.sources,
      payload: snapshot.payload,
    };
    // JSONB reorders object keys. New hashes cover canonical JSON; existing
    // snapshots may still carry the original order-sensitive hash.
    const expected = trafficSnapshotContentHash(unsigned);
    const legacy = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
    if (snapshot.contentHash !== expected && snapshot.contentHash !== legacy) {
      context.addIssue({ code: "custom", path: ["contentHash"], message: "Traffic snapshot content hash mismatch" });
    }
  });
export type TrafficDataSnapshotRecord = z.infer<
  typeof TrafficDataSnapshotRecordSchema
>;

export function buildTrafficSnapshotCandidate(input: {
  asins: readonly string[];
  trafficInput: TrafficAnalysisInput;
  sources?: readonly TrafficSnapshotSource[];
  listingCollection?: TrafficListingCollection;
}): TrafficSnapshotCandidate {
  const unsigned = {
    kind: TRAFFIC_SNAPSHOT_KIND,
    schemaVersion: TRAFFIC_SNAPSHOT_SCHEMA_VERSION,
    marketplace: input.trafficInput.marketplace,
    asins: input.asins.map((asin) => AsinSchema.parse(asin)),
    dataCutoffAt: input.trafficInput.dataCutoffAt,
    sources: input.sources ?? [
      {
        id: "sif-listing-traffic" as const,
        type: "connector" as const,
        reference: "app/sif-listing-traffic-raw-data.ts#sifListingTrafficRawByAsin" as const,
        capturedAt: input.trafficInput.dataCutoffAt,
        checksum: input.trafficInput.inputDigest,
      },
      {
        id: "sif-monthly-traffic-trend" as const,
        type: "connector" as const,
        reference: "app/sif-monthly-traffic-trend-raw-data.ts#sifMonthlyTrafficRawByAsin" as const,
        capturedAt: input.trafficInput.dataCutoffAt,
        checksum: input.trafficInput.inputDigest,
      },
    ],
    payload: { input: input.trafficInput, ...(input.listingCollection ? { listingCollection: input.listingCollection } : {}) },
  };
  return TrafficSnapshotCandidateSchema.parse({
    ...unsigned,
    contentHash: trafficSnapshotContentHash(unsigned),
  });
}

function trafficSnapshotContentHash(value: unknown) {
  return canonicalJsonSha256(value);
}
