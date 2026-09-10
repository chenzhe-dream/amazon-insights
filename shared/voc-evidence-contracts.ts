import { z } from "zod";
const id = z.uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const asin = z.string().regex(/^[A-Z0-9]{10}$/);
const asins = z.array(asin).min(1).max(10).refine(items => new Set(items).size === items.length);
export const VocSourcePolicySchema = z.enum(["manual-only", "manual-with-review-fallback"]);
export const VocEvidenceSelectionRequestSchema = z.strictObject({
  baseSyncRunId: id,
  selectedAsins: asins,
  sourcePolicy: VocSourcePolicySchema.default("manual-only"),
  expectedInputFingerprint: hash,
});
export type VocEvidenceSelectionRequest = z.infer<typeof VocEvidenceSelectionRequestSchema>;
export const VocEvidenceReferenceSchema = z.strictObject({
  id: z.string().min(1).max(500), version: z.string().min(1).max(100), contentHash: hash,
  capturedAt: z.iso.datetime({ offset: true }),
});
const dimension = z.enum(["attention", "positives", "negatives", "unmet", "audiences", "scenarios", "motives"]);
export const VocEvidenceCoverageSchema = z.strictObject({
  asin, primary: z.enum(["manual", "review", "missing"]),
  manualDimensions: z.array(dimension), reviewDimensions: z.array(dimension), missingDimensions: z.array(dimension),
  reviewSupplementDimensions: z.array(dimension).default([]), conflictDimensions: z.array(dimension).default([]),
  manual: VocEvidenceReferenceSchema.nullable(), review: VocEvidenceReferenceSchema.nullable(),
});
export const VocEvidenceManifestSchema = z.strictObject({
  schemaVersion: z.literal("voc-evidence/v1"), organizationId: id, projectId: id, baseSyncRunId: id,
  marketplace: z.literal("US"), selectedAsins: asins, sourcePolicy: VocSourcePolicySchema,
  fingerprint: hash, sourceMode: z.enum(["manual", "review-fallback"]),
  coverage: z.array(VocEvidenceCoverageSchema).min(1).max(10),
  keywords: z.strictObject({ state: z.enum(["ready", "empty", "failed", "missing"]), source: VocEvidenceReferenceSchema.nullable() }),
});
export type VocEvidenceManifest = z.infer<typeof VocEvidenceManifestSchema>;
export const VocEvidenceInventorySchema = z.strictObject({
  manual: VocEvidenceManifestSchema, fallback: VocEvidenceManifestSchema,
});
export type VocEvidenceInventory = z.infer<typeof VocEvidenceInventorySchema>;

// Organization and project authorization stay server-side; models only need evidence semantics.
export const VocModelEvidenceSchema = VocEvidenceManifestSchema.omit({ organizationId: true, projectId: true, baseSyncRunId: true });
export function toModelEvidenceSelection(manifest: VocEvidenceManifest) {
 const { organizationId, projectId, baseSyncRunId, ...evidence } = manifest;
 void organizationId; void projectId; void baseSyncRunId;
 return VocModelEvidenceSchema.parse(evidence);
}
