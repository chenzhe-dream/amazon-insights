import { hasUsableImageRemark } from "../../scripts/lib/image-remark-validity.mjs";
import {
  ImageRemarkCandidateManifestSchema,
  ImageRemarkOverlayEntrySchema,
  ImageRemarkSourceSchema,
  type ImageRemarkOverlayEntry,
  type ImageRemarkSource,
} from "../../shared/image-remark-overlay";
import type {
  CurrentProjectDisplayVersion,
  DisplayStageOutput,
} from "../db/postgres/project-display-version-store";

export class ImageRemarkOverlayValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageRemarkOverlayValidationError";
  }
}

type StageOutputs = CurrentProjectDisplayVersion["stageOutputs"];

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stageData(output: DisplayStageOutput): Record<string, unknown> {
  return output.stageStatus === "missing-output" ? {} : record(output.data);
}

function galleryFor(outputs: StageOutputs, asin: string): string[] {
  const listing = record(record(stageData(outputs.listing).contentByAsin)[asin]);
  return Array.isArray(listing.galleryImages)
    ? listing.galleryImages.filter((value): value is string => typeof value === "string") : [];
}

function hasCurrentRemark(outputs: StageOutputs, asin: string, index: number): boolean {
  const notes = record(stageData(outputs.image_remarks).remarksByAsin)[asin];
  const note = Array.isArray(notes) ? record(notes[index]) : {};
  return hasUsableImageRemark(note) &&
    (typeof note.imageUrl !== "string" || note.imageUrl === galleryFor(outputs, asin)[index]);
}

function scopedAsins(candidate: readonly string[], project: readonly string[]): boolean {
  return candidate.length > 0 && candidate.every(asin => project.includes(asin));
}

export function validateImageRemarkCandidate(
  current: CurrentProjectDisplayVersion,
  input: {
    manifest: unknown;
    sourceRef: string;
    sourceManifestSha256: string;
    publishedAt: string;
  },
): ImageRemarkOverlayEntry[] {
  const parsed = ImageRemarkCandidateManifestSchema.safeParse(input.manifest);
  if (!parsed.success) throw new ImageRemarkOverlayValidationError("Image remark candidate format is invalid");
  const manifest = parsed.data;
  if (manifest.organizationId !== current.organizationId || manifest.projectId !== current.projectId ||
      manifest.runId !== current.runId || manifest.originalJobId !== current.jobId ||
      !scopedAsins(manifest.asins, current.asins) ||
      (manifest.projectAsins && (manifest.projectAsins.length !== current.asins.length ||
        manifest.projectAsins.some(asin => !current.asins.includes(asin))))) {
    throw new ImageRemarkOverlayValidationError("Image remark candidate source scope does not match the current report");
  }
  const listing = current.stageOutputs.listing;
  if (listing.stageStatus === "missing-output" || listing.stageStatus === "failed" ||
      listing.contentHash !== manifest.listingStageContentHash) {
    throw new ImageRemarkOverlayValidationError("Image remark candidate listing stage hash does not match");
  }
  if (manifest.sourceKind === "historical-generated-file" &&
      (!manifest.sourceListingSha256 || !manifest.sourceGalleryByAsin)) {
    throw new ImageRemarkOverlayValidationError("Historical remarks require a hashed source gallery");
  }
  if (Date.parse(manifest.capturedAt) > Date.parse(input.publishedAt)) {
    throw new ImageRemarkOverlayValidationError("Image remark candidate was captured after publication");
  }
  if (manifest.staticReady !== manifest.slots.filter(slot => !slot.videoThumbnail).length ||
      manifest.videoThumbnails !== manifest.slots.filter(slot => slot.videoThumbnail).length) {
    throw new ImageRemarkOverlayValidationError("Image remark candidate slot counts do not match");
  }
  const source = ImageRemarkSourceSchema.safeParse({
    sourceKind: manifest.sourceKind,
    sourceRef: input.sourceRef,
    sourceArtifactSha256: manifest.sourceArtifactSha256,
    sourceManifestSha256: input.sourceManifestSha256,
    ...(manifest.sourceUrlBinding ? { sourceUrlBinding: manifest.sourceUrlBinding } : {}),
    ...(manifest.sourceListingSha256 ? { sourceListingSha256: manifest.sourceListingSha256 } : {}),
    listingStageContentHash: manifest.listingStageContentHash,
    originalJobId: manifest.originalJobId,
    capturedAt: manifest.capturedAt,
  });
  if (!source.success) throw new ImageRemarkOverlayValidationError("Image remark source evidence is invalid");

  const seen = new Set<string>();
  const existing = new Map(current.imageRemarkOverlay.map(entry => [`${entry.asin}:${entry.index}`, entry]));
  return manifest.slots.map(slot => {
    const key = `${slot.asin}:${slot.index}`;
    if (!manifest.asins.includes(slot.asin) || seen.has(key)) {
      throw new ImageRemarkOverlayValidationError("Image remark candidate ASIN or slot is duplicated or outside the project");
    }
    seen.add(key);
    if (galleryFor(current.stageOutputs, slot.asin)[slot.index] !== slot.imageUrl ||
        (manifest.sourceKind === "historical-generated-file" &&
         manifest.sourceGalleryByAsin?.[slot.asin]?.[slot.index] !== slot.imageUrl)) {
      throw new ImageRemarkOverlayValidationError(`Image remark candidate gallery URL or index does not match: ${key}`);
    }
    if (hasCurrentRemark(current.stageOutputs, slot.asin, slot.index)) {
      throw new ImageRemarkOverlayValidationError(`Current successful image remark cannot be replaced: ${key}`);
    }
    const prior = existing.get(key);
    if (prior && (prior.source.sourceKind !== "historical-generated-file" ||
        manifest.sourceKind !== "supplemental-analysis" ||
        Date.parse(manifest.capturedAt) <= Date.parse(prior.source.capturedAt))) {
      throw new ImageRemarkOverlayValidationError(`Existing image remark overlay cannot be replaced: ${key}`);
    }
    return ImageRemarkOverlayEntrySchema.parse({ ...slot, source: source.data,
      displayListingStageContentHash: manifest.listingStageContentHash });
  });
}

export function mergedImageRemarkOverlay(
  current: readonly ImageRemarkOverlayEntry[],
  added: readonly ImageRemarkOverlayEntry[],
): ImageRemarkOverlayEntry[] {
  const map = new Map(current.map(entry => [`${entry.asin}:${entry.index}`, entry]));
  for (const entry of added) map.set(`${entry.asin}:${entry.index}`, entry);
  return [...map.values()].sort((a, b) => a.asin.localeCompare(b.asin) || a.index - b.index);
}

export function inheritedImageRemarkOverlay(
  current: readonly ImageRemarkOverlayEntry[],
  candidateOutputs: StageOutputs,
): ImageRemarkOverlayEntry[] {
  const listing = candidateOutputs.listing;
  if (!("contentHash" in listing)) return [];
  return current.filter(entry =>
    galleryFor(candidateOutputs, entry.asin)[entry.index] === entry.imageUrl &&
    !hasCurrentRemark(candidateOutputs, entry.asin, entry.index))
    .map(entry => ({ ...entry, displayListingStageContentHash: listing.contentHash }));
}

export type ImageRemarkEvidenceSummary = Readonly<{
  slotCount: number;
  sources: readonly Readonly<ImageRemarkSource & { slotCount: number }>[];
}>;

export function imageRemarkEvidenceSummary(
  entries: readonly ImageRemarkOverlayEntry[],
): ImageRemarkEvidenceSummary | null {
  if (!entries.length) return null;
  const counts = new Map<string, { source: ImageRemarkSource; count: number }>();
  for (const entry of entries) {
    const key = entry.source.sourceManifestSha256;
    const item = counts.get(key);
    if (item) item.count += 1;
    else counts.set(key, { source: entry.source, count: 1 });
  }
  return {
    slotCount: entries.length,
    sources: [...counts.values()]
      .map(({ source, count }) => ({ ...source, slotCount: count }))
      .sort((a, b) => a.sourceManifestSha256.localeCompare(b.sourceManifestSha256)),
  };
}
