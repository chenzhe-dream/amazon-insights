import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const asin = z.string().regex(/^[A-Z0-9]{10}$/);
const sourceKind = z.enum(["supplemental-analysis", "historical-generated-file"]);
const safeSourceRef = z.string().min(1).max(240).refine(value =>
  !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes(".."),
  "Source reference must be relative");

export const ImageRemarkSourceSchema = z.object({
  sourceKind,
  sourceRef: safeSourceRef,
  sourceArtifactSha256: sha256,
  sourceManifestSha256: sha256,
  sourceListingSha256: sha256.optional(),
  sourceUrlBinding: z.enum(["source-artifact-url", "persisted-listing-index"]).optional(),
  listingStageContentHash: sha256,
  originalJobId: z.string().uuid(),
  capturedAt: z.string().datetime(),
});

export const ImageRemarkCandidateSlotSchema = z.object({
  asin,
  index: z.number().int().min(0).max(8),
  imageUrl: z.string().url().refine(value => value.startsWith("https://")),
  remark: z.string().trim().min(1),
  imageTypes: z.array(z.string().trim().min(1)).max(12),
  confidence: z.enum(["high", "medium", "low"]),
  videoThumbnail: z.boolean(),
});

export const ImageRemarkCandidateManifestSchema = z.object({
  schemaVersion: z.literal(1),
  organizationId: z.string().uuid(),
  projectId: z.string().uuid(),
  runId: z.string().uuid(),
  originalJobId: z.string().uuid(),
  listingStageContentHash: sha256,
  sourceKind,
  capturedAt: z.string().datetime(),
  sourceArtifactSha256: sha256,
  sourceUrlBinding: z.enum(["source-artifact-url", "persisted-listing-index"]).optional(),
  sourceListingSha256: sha256.optional(),
  sourceGalleryByAsin: z.record(asin, z.array(z.string().url())).optional(),
  asins: z.array(asin).min(1).max(10).refine(items => new Set(items).size === items.length),
  projectAsins: z.array(asin).min(1).max(10).refine(items => new Set(items).size === items.length).optional(),
  staticReady: z.number().int().min(0),
  videoThumbnails: z.number().int().min(0),
  slots: z.array(ImageRemarkCandidateSlotSchema).min(1),
});

export const ImageRemarkOverlayEntrySchema = ImageRemarkCandidateSlotSchema.extend({
  source: ImageRemarkSourceSchema,
  displayListingStageContentHash: sha256,
});

export type ImageRemarkCandidateManifest = z.infer<typeof ImageRemarkCandidateManifestSchema>;
export type ImageRemarkOverlayEntry = z.infer<typeof ImageRemarkOverlayEntrySchema>;
export type ImageRemarkSource = z.infer<typeof ImageRemarkSourceSchema>;
