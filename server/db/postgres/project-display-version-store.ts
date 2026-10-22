import { createHash, randomUUID } from "node:crypto";

import { EntityIdSchema, MarketplaceSchema, LocalDataStageOutputResponseSchema } from "../../../shared/agent-contracts";
import { validIndependentReviewRatings } from "../../../scripts/lib/sync-stage-output.mjs";
import { hasUsableImageRemark, isUnavailableImageRemark } from "../../../scripts/lib/image-remark-validity.mjs";
import { ImageRemarkOverlayEntrySchema, type ImageRemarkOverlayEntry } from "../../../shared/image-remark-overlay";
import {
  imageRemarkEvidenceSummary,
  inheritedImageRemarkOverlay,
  mergedImageRemarkOverlay,
  validateImageRemarkCandidate,
  type ImageRemarkEvidenceSummary,
} from "../../services/project-image-remark-overlay";
import type { PostgresQueryContext } from "./query-context";
import type { ProjectableSyncStage, StageOutputProjection, SyncCatalogCapture } from "../sync-job-repository";

const stages: readonly ProjectableSyncStage[] = [
  "keywords", "reviews", "sales_trend", "fba", "listing", "category", "traffic",
  "child_sales", "price_strategy", "image_remarks",
];
const perAsinFields: Partial<Record<ProjectableSyncStage, readonly string[]>> = {
  keywords: ["analysisByAsin"],
  reviews: ["analysisByAsin", "ratingByAsin"],
  sales_trend: ["trendByAsin"],
  fba: ["feeByAsin"],
  listing: ["contentByAsin"],
  traffic: ["listingByAsin", "monthlyByAsin"],
  child_sales: ["rowsByAsin"],
  price_strategy: ["strategyByAsin"],
  image_remarks: ["remarksByAsin"],
};
const catalogFields = ["brand", "title", "image", "price", "sales", "rating", "reviews"] as const;

export type MissingDisplayStageOutput = Readonly<{
  stage: ProjectableSyncStage;
  stageStatus: "missing-output";
  reasonCode: "OUTPUT_UNAVAILABLE";
}>;
export type DisplayStageOutput = StageOutputProjection | MissingDisplayStageOutput;
export type ProjectDisplayGap = Readonly<{
  asin: string;
  field: string;
  reasonCode: string;
}>;
export type ProjectCatalogEvidence = SyncCatalogCapture["evidence"];
export type CurrentProjectDisplayVersion = Readonly<{
  versionId: string;
  organizationId: string;
  projectId: string;
  runId: string;
  jobId: string;
  marketplace: string;
  asins: readonly string[];
  catalog: readonly Record<string, unknown>[];
  catalogEvidence: ProjectCatalogEvidence | null;
  revisionKind: "job-publication" | "catalog-revision" | "image-remarks-revision";
  imageRemarkOverlay: readonly ImageRemarkOverlayEntry[];
  imageRemarkEvidence: ImageRemarkEvidenceSummary | null;
  stageOutputs: Readonly<Record<ProjectableSyncStage, DisplayStageOutput>>;
  gaps: readonly ProjectDisplayGap[];
  contentHash: string;
  sourceCompletedAt: string;
  publishedAt: string;
}>;
export type PublishProjectDisplayVersionInput = Readonly<{
  organizationId: string;
  projectId: string;
  jobId: string;
  expectedCurrentVersionId: string | null;
  catalog?: readonly unknown[];
  catalogEvidence?: ProjectCatalogEvidence;
  publishedAt?: string;
}>;
export type ReviseCurrentCatalogInput = Readonly<{
  organizationId: string;
  projectId: string;
  expectedCurrentVersionId: string;
  catalog: readonly unknown[];
  evidence: ProjectCatalogEvidence;
  publishedAt?: string;
}>;
export type ReviseCurrentImageRemarksInput = Readonly<{
  organizationId: string;
  projectId: string;
  expectedCurrentVersionId: string;
  manifest: unknown;
  sourceRef: string;
  sourceManifestSha256: string;
  publishedAt?: string;
}>;

type ProjectRow = { id: string; organization_id: string; marketplace: string; asins_json: unknown; current_display_version_id: string | null };
type JobRow = { job_id: string; organization_id: string; project_id: string; run_id: string; marketplace: string; asins: unknown; status: string; created_at: Date | string; completed_at: Date | string | null };
type OutputRow = { job_id: string; organization_id: string; project_id: string; run_id: string; stage_id: string; stage_status: string; output_version: number; job_version: number; content_hash: string; data_json: unknown; gap_json: unknown; updated_at: Date | string };
type VersionRow = { id: string; organization_id: string; project_id: string; source_run_id: string; source_job_id: string; marketplace: string; asins_json: unknown; content_hash: string; body_json: unknown; source_completed_at: Date | string; published_at: Date | string; revision_kind: "job-publication" | "catalog-revision" | "image-remarks-revision"; supersedes_version_id: string | null; catalog_evidence_json: unknown; image_remark_evidence_json?: unknown };

export class ProjectDisplayVersionConflictError extends Error {
  constructor(message: string) { super(message); this.name = "ProjectDisplayVersionConflictError"; }
}
export class StaleProjectDisplayCandidateError extends ProjectDisplayVersionConflictError {
  constructor() { super("Older sync job cannot replace the current display version"); this.name = "StaleProjectDisplayCandidateError"; }
}
export class ProjectDisplayCoverageRegressionError extends ProjectDisplayVersionConflictError {
  constructor(readonly field: string) {
    super(`Candidate would lose verified data: ${field}`);
    this.name = "ProjectDisplayCoverageRegressionError";
  }
}
export type ExpiredDisplayBodyCleanup = Readonly<{ purgedCount: number; imageUrls: readonly string[] }>;

function dateTime(value: Date | string | null): string {
  if (!value || Number.isNaN(new Date(value).getTime())) throw new ProjectDisplayVersionConflictError("Invalid display version timestamp");
  return new Date(value).toISOString();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asins(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10 ||
      value.some(item => typeof item !== "string" || !/^[A-Z0-9]{10}$/.test(item)) ||
      new Set(value).size !== value.length) {
    throw new ProjectDisplayVersionConflictError("Display version ASIN scope is invalid");
  }
  return value;
}

function sameSet(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every(item => right.includes(item));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  const item = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])]));
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function scopedCatalog(value: readonly unknown[] | undefined, requestedAsins: readonly string[]) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ProjectDisplayVersionConflictError("Catalog must be an array");
  const seen = new Set<string>();
  return value.map(item => {
    const entry = record(item);
    const asin = entry.asin;
    if (typeof asin !== "string" || !requestedAsins.includes(asin) || seen.has(asin)) {
      throw new ProjectDisplayVersionConflictError("Catalog record is outside the project ASIN scope or duplicated");
    }
    seen.add(asin);
    return entry;
  });
}

function catalogEvidence(value: ProjectCatalogEvidence): ProjectCatalogEvidence {
  if (value.sourceKind !== "generated-file" || value.sourceRef !== "app/competitor-data.ts#refreshedCatalog" ||
      !/^[a-f0-9]{64}$/.test(value.sourceSha256)) {
    throw new ProjectDisplayVersionConflictError("Catalog evidence source is invalid");
  }
  if (Date.parse(dateTime(value.sourceUpdatedAt)) > Date.parse(dateTime(value.capturedAt)) + 60_000) {
    throw new ProjectDisplayVersionConflictError("Catalog source time is after capture");
  }
  return { sourceKind: value.sourceKind, sourceRef: value.sourceRef,
    sourceSha256: value.sourceSha256, sourceUpdatedAt: dateTime(value.sourceUpdatedAt),
    capturedAt: dateTime(value.capturedAt), ...(value.sourceJobId ? { sourceJobId: value.sourceJobId } : {}) };
}

function outputFromRow(row: OutputRow, expected: { organizationId: string; projectId: string; runId: string; jobId: string;
  asins: readonly string[]; marketplace: string }): StageOutputProjection {
  if (row.organization_id !== expected.organizationId || row.project_id !== expected.projectId ||
      row.run_id !== expected.runId || row.job_id !== expected.jobId ||
      !stages.includes(row.stage_id as ProjectableSyncStage) ||
      !["done", "partial", "failed"].includes(row.stage_status)) {
    throw new ProjectDisplayVersionConflictError("Stage output ownership or state is invalid");
  }
  const data = row.data_json === null ? undefined : record(row.data_json);
  const gap = row.gap_json === null ? undefined : record(row.gap_json);
  if ((row.stage_status === "done" && (!data || gap)) ||
      (row.stage_status === "partial" && (!data || !gap || gap.state !== "partial")) ||
      (row.stage_status === "failed" && (data || !gap || gap.state !== "failed"))) {
    throw new ProjectDisplayVersionConflictError("Stage output branch is invalid");
  }
  const branch = { stage: row.stage_id, ...(data ? { data } : {}), ...(gap ? { gap } : {}) };
  if (hash(branch) !== row.content_hash) throw new ProjectDisplayVersionConflictError("Stage output hash mismatch");
  if (row.stage_id === "reviews" && row.stage_status === "partial"
    && !validIndependentReviewRatings(data, { ...expected, updatedAt: dateTime(row.updated_at) })) {
    throw new ProjectDisplayVersionConflictError("Independent review rating evidence is invalid");
  }
  return LocalDataStageOutputResponseSchema.parse({
    stage: row.stage_id as ProjectableSyncStage,
    stageStatus: row.stage_status as StageOutputProjection["stageStatus"],
    projectId: expected.projectId, runId: expected.runId, jobId: expected.jobId,
    jobVersion: Number(row.job_version), outputVersion: Number(row.output_version),
    contentHash: row.content_hash, updatedAt: dateTime(row.updated_at),
    ...(data ? { data } : {}), ...(gap ? { gap: gap as StageOutputProjection["gap"] } : {}),
  }) as StageOutputProjection;
}

/** Derive display metadata from a verified capture, without changing the immutable source output. */
export function bindCapturedPriceStrategyProjection(input: Readonly<{
  output: unknown;
  sourceOrganizationId: string;
  scope: Readonly<{ organizationId: string; projectId: string; runId: string; jobId: string;
    marketplace: string; asins: readonly string[] }>;
}>): StageOutputProjection {
  const fail = (message: string): never => { throw new ProjectDisplayVersionConflictError(message); };
  const parsed = LocalDataStageOutputResponseSchema.safeParse(input.output);
  if (!parsed.success) return fail('Captured price stage schema is invalid');
  const output = parsed.data;
  const scope = input.scope;
  const requested = asins(scope.asins);
  if (output.stage !== 'price_strategy' || output.jobId !== scope.jobId || output.projectId !== scope.projectId
    || output.runId !== scope.runId || input.sourceOrganizationId !== scope.organizationId
    || !EntityIdSchema.safeParse(scope.organizationId).success || !MarketplaceSchema.safeParse(scope.marketplace).success
    || output.outputVersion > output.jobVersion) {
    return fail('Captured price stage ownership is invalid');
  }
  const branch = { stage: output.stage, ...('data' in output ? { data: output.data } : {}),
    ...('gap' in output ? { gap: output.gap } : {}) };
  if (hash(branch) !== output.contentHash) return fail('Captured price stage hash mismatch');
  if (output.stageStatus === 'failed') return output as StageOutputProjection;
  let changed = false;
  const strategyByAsin = Object.fromEntries(Object.entries(output.data.strategyByAsin).map(([asin, value]) => {
    const price = record(value);
    if (!requested.includes(asin)) return fail('Captured price record is outside the requested scope');
    // Other provider/legacy record shapes keep their original validation and coverage behavior.
    if (price.source !== 'Sorftime') return [asin, value];
    if (price.asin !== asin || price.marketplace !== scope.marketplace
      || price.status !== 'ready' || typeof price.currentPrice !== 'number'
      || !Number.isFinite(price.currentPrice) || price.currentPrice <= 0 || typeof price.fetchedAt !== 'string'
      || !Number.isFinite(Date.parse(price.fetchedAt)) || Date.parse(price.fetchedAt) > Date.parse(output.updatedAt)) return fail('Captured price record is invalid');
    let provenance = record(price.provenance);
    if (price.provenance != null) {
      if (provenance.asin !== asin || provenance.marketplace !== scope.marketplace || provenance.connector !== 'sorftime'
        || !['jobId', 'operation', 'tool', 'fetchedAt'].every(key => typeof provenance[key] === 'string' && (provenance[key] as string).trim())
        || Date.parse(provenance.fetchedAt as string) !== Date.parse(price.fetchedAt)) {
        return fail('Captured price provenance is invalid');
      }
    } else {
      provenance = { jobId: scope.jobId, asin, marketplace: scope.marketplace, fetchedAt: price.fetchedAt,
        connector: 'sorftime', operation: 'persisted_stage_output', tool: 'persisted_stage_output' };
    }
    const boundProvenance = {
      ...provenance,
      stageId: provenance.stageId ?? 'price_strategy',
      trendType: provenance.trendType ?? 'not-recorded', observationPeriod: provenance.observationPeriod ?? 'not-recorded',
      sourceContentHash: output.contentHash, captureJobId: scope.jobId,
      organizationId: scope.organizationId, projectId: scope.projectId, runId: scope.runId,
    };
    changed ||= hash(boundProvenance) !== hash(price.provenance ?? null);
    return [asin, { ...price, provenance: boundProvenance }];
  }));
  if (!changed) return output as StageOutputProjection;
  const data = { strategyByAsin };
  return LocalDataStageOutputResponseSchema.parse({ ...output, data,
    contentHash: hash({ stage: output.stage, data, ...('gap' in output ? { gap: output.gap } : {}) }),
  }) as StageOutputProjection;
}

export function gapsFor(asins: readonly string[], catalog: readonly Record<string, unknown>[], stageOutputs: Record<ProjectableSyncStage, DisplayStageOutput>): ProjectDisplayGap[] {
  const result: ProjectDisplayGap[] = [];
  const catalogByAsin = new Map(catalog.map(item => [item.asin, item]));
  for (const asin of asins) {
    const entry = catalogByAsin.get(asin);
    if (!entry) result.push({ asin, field: "catalog", reasonCode: "OUTPUT_UNAVAILABLE" });
    else if (entry.synced !== true || entry.catalogSource !== "sellerSprite") {
      result.push({ asin, field: "catalog.sellerSprite", reasonCode: "UPSTREAM_EMPTY" });
    }
    for (const field of catalogFields) {
      const value = entry?.[field];
      if (value === undefined || value === null || value === "" || value === "—" ||
          (field === "title" && value === asin)) {
        result.push({ asin, field: `catalog.${field}`, reasonCode: entry ? "UPSTREAM_EMPTY" : "OUTPUT_UNAVAILABLE" });
      }
    }
  }
  for (const stage of stages) {
    const output = stageOutputs[stage];
    const fields = perAsinFields[stage] ?? [];
    if (output.stageStatus === "missing-output") {
      for (const asin of asins) result.push({ asin, field: stage, reasonCode: "OUTPUT_UNAVAILABLE" });
      continue;
    }
    if (output.stageStatus === "failed") {
      for (const asin of asins) result.push({ asin, field: stage, reasonCode: gapReason(output.gap, asin) });
      continue;
    }
    for (const field of fields) {
      const values = record(output.data?.[field]);
      for (const asin of asins) {
        const explicitGap = output.gap?.items?.some(item => item.asin === asin);
        const salesRecord = stage === "sales_trend" ? record(values[asin]) : null;
        const nonreadySales = salesRecord && typeof salesRecord.status === "string" && salesRecord.status !== "ready";
        // Review sample gaps do not erase separately validated product ratings.
        const reviewRating = stage === "reviews" && field === "ratingByAsin";
        const ratingRecord = reviewRating ? record(values[asin]) : null;
        const missingRating = ratingRecord && !(typeof ratingRecord.rating === "number"
          && Number.isFinite(ratingRecord.rating) && ratingRecord.rating >= 0 && ratingRecord.rating <= 5
          && (ratingRecord.status === undefined || ratingRecord.status === "ready"));
        if (!Object.hasOwn(values, asin) || (explicitGap && !reviewRating) || nonreadySales || missingRating) {
          result.push({ asin, field: `${stage}.${field}`, reasonCode: gapReason(output.gap, asin) });
        }
      }
    }
    if (!fields.length) {
      for (const asin of asins) if (output.gap?.items?.some(item => item.asin === asin)) {
        result.push({ asin, field: stage, reasonCode: gapReason(output.gap, asin) });
      }
    }
  }
  return result.sort((left, right) => left.asin.localeCompare(right.asin) || left.field.localeCompare(right.field));
}

function gapReason(gap: StageOutputProjection["gap"] | undefined, asin: string): string {
  const item = gap?.items?.find(item => item.asin === asin);
  return typeof item?.causeCode === "string" ? item.causeCode : gap?.reasonCode ?? "OUTPUT_UNAVAILABLE";
}

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return !["", "—", "等待同步"].includes(value.trim());
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function lostCoverage(previous: unknown, candidate: unknown, field: string): string | null {
  if (!hasValue(previous)) return null;
  if (!hasValue(candidate)) return field;
  if (Array.isArray(previous)) {
    if (!Array.isArray(candidate) || candidate.length < previous.length) return field;
    for (let index = 0; index < previous.length; index += 1) {
      const lost = lostCoverage(previous[index], candidate[index], `${field}[${index}]`);
      if (lost) return lost;
    }
  } else if (previous && typeof previous === "object") {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return field;
    const oldRecord = record(previous), nextRecord = record(candidate);
    if (oldRecord.status === "ready" && nextRecord.status !== "ready") return `${field}.status`;
    if (oldRecord.synced === true && nextRecord.synced !== true) return `${field}.synced`;
    for (const [key, value] of Object.entries(oldRecord)) {
      const lost = lostCoverage(value, nextRecord[key], `${field}.${key}`);
      if (lost) return lost;
    }
  }
  return null;
}

function salesCoverageEvidence(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  // These describe the latest request attempt, not verified observations. A
  // successful retry or a verified source-unavailable result may clear them.
  // Filter only this sales-record level; keep the persisted source unchanged,
  // including observations, their timestamps, provenance and readiness status.
  const evidence = { ...record(value) };
  delete evidence.observationErrors;
  delete evidence.sourceAvailabilityError;
  delete evidence.statusMessage;
  return evidence;
}

function stageData(output: DisplayStageOutput): Record<string, unknown> {
  return output.stageStatus === "missing-output" ? {} : record(output.data);
}

function galleryFor(outputs: Readonly<Record<ProjectableSyncStage, DisplayStageOutput>>, asin: string): string[] {
  const listing = record(record(stageData(outputs.listing).contentByAsin)[asin]);
  return Array.isArray(listing.galleryImages)
    ? listing.galleryImages.filter((url): url is string => typeof url === "string") : [];
}

function assertRemarkCoverage(current: CurrentProjectDisplayVersion,
  candidate: Record<ProjectableSyncStage, DisplayStageOutput>, asin: string): void {
  const oldNotes = record(stageData(current.stageOutputs.image_remarks).remarksByAsin)[asin];
  if (!Array.isArray(oldNotes) || !oldNotes.length) return;
  const newNotes = record(stageData(candidate.image_remarks).remarksByAsin)[asin];
  const field = `image_remarks.remarksByAsin.${asin}`;
  if (!Array.isArray(newNotes) || newNotes.length < oldNotes.length) {
    throw new ProjectDisplayCoverageRegressionError(field);
  }
  const oldGallery = galleryFor(current.stageOutputs, asin);
  const newGallery = galleryFor(candidate, asin);
  for (let index = 0; index < oldNotes.length; index += 1) {
    const oldNote = record(oldNotes[index]);
    if (isUnavailableImageRemark(oldNote.remark)) continue;
    const oldUrl = typeof oldNote.imageUrl === "string" ? oldNote.imageUrl : oldGallery[index];
    if (!oldUrl) {
      const lost = lostCoverage(oldNote, newNotes[index], `${field}[${index}]`);
      if (lost) throw new ProjectDisplayCoverageRegressionError(lost);
      continue;
    }
    const newIndex = newGallery.indexOf(oldUrl);
    if (newIndex < 0) continue;
    const matched = newNotes[newIndex];
    const matchedUrl = record(matched).imageUrl;
    if (hasValue(matchedUrl) && matchedUrl !== oldUrl) {
      throw new ProjectDisplayCoverageRegressionError(`${field}[${newIndex}].imageUrl`);
    }
    const lost = lostCoverage(oldNote, matched, `${field}[${newIndex}]`);
    if (lost) throw new ProjectDisplayCoverageRegressionError(lost);
  }
}

function assertNoCoverageRegression(current: CurrentProjectDisplayVersion | null,
  catalog: readonly Record<string, unknown>[], candidate: Record<ProjectableSyncStage, DisplayStageOutput>,
  requestedAsins: readonly string[]): void {
  if (!current) return;
  const oldCatalog = new Map(current.catalog.map(item => [item.asin, item]));
  const newCatalog = new Map(catalog.map(item => [item.asin, item]));
  for (const asin of requestedAsins) {
    if (!current.asins.includes(asin)) continue;
    const oldProduct = oldCatalog.get(asin);
    if (oldProduct?.catalogSource === "sellerSprite" && oldProduct.synced === true) {
      const lost = lostCoverage(oldProduct, newCatalog.get(asin), `catalog.${asin}`);
      if (lost) throw new ProjectDisplayCoverageRegressionError(lost);
    }
    for (const stage of stages) {
      const fields = perAsinFields[stage] ?? [];
      for (const field of fields) {
        if (stage === "image_remarks" && field === "remarksByAsin") continue;
        const previous = record(stageData(current.stageOutputs[stage])[field])[asin];
        const next = record(stageData(candidate[stage])[field])[asin];
        const sales = stage === "sales_trend" && field === "trendByAsin";
        const lost = lostCoverage(sales ? salesCoverageEvidence(previous) : previous,
          sales ? salesCoverageEvidence(next) : next, `${stage}.${field}.${asin}`);
        if (lost) throw new ProjectDisplayCoverageRegressionError(lost);
      }
    }
    assertRemarkCoverage(current, candidate, asin);
  }
  const oldCategory = stageData(current.stageOutputs.category).trendByNode;
  if (hasValue(oldCategory) && !hasValue(stageData(candidate.category).trendByNode)) {
    throw new ProjectDisplayCoverageRegressionError("category.trendByNode");
  }
}

/** Stage outputs keep the original job gap; the current display gap reflects supplement coverage. */
function effectiveImageRemarkGaps(gaps: readonly ProjectDisplayGap[],
  outputs: Readonly<Record<ProjectableSyncStage, DisplayStageOutput>>,
  overlay: readonly ImageRemarkOverlayEntry[]): ProjectDisplayGap[] {
  const notesByAsin = record(stageData(outputs.image_remarks).remarksByAsin);
  const supplemental = new Map(overlay.map(entry => [`${entry.asin}:${entry.index}`, entry]));
  return gaps.filter(gap => {
    if (gap.field !== "image_remarks" && gap.field !== "image_remarks.remarksByAsin") return true;
    const gallery = galleryFor(outputs, gap.asin);
    if (!gallery.length) return true;
    const notes = notesByAsin[gap.asin];
    const fullyCovered = gallery.every((url, index) => {
      const note = record(Array.isArray(notes) ? notes[index] : null);
      if (hasUsableImageRemark(note) && (typeof note.imageUrl !== "string" || note.imageUrl === url)) return true;
      return supplemental.get(`${gap.asin}:${index}`)?.imageUrl === url;
    });
    return !fullyCovered;
  });
}

function imageUrls(value: unknown): Set<string> {
  const urls = new Set<string>();
  const visit = (item: unknown, key = "") => {
    if (typeof item === "string") {
      if (/^https?:\/\/[^\s]+$/i.test(item) &&
          (/\.(?:jpe?g|png|webp|gif|avif)(?:[?#]|$)/i.test(item) ||
           /image|gallery|thumbnail|photo|media|^src$|^url$/i.test(key))) urls.add(item);
    } else if (Array.isArray(item)) item.forEach(entry => visit(entry, key));
    else if (item && typeof item === "object") {
      for (const [childKey, child] of Object.entries(item)) visit(child, childKey);
    }
  };
  visit(value);
  return urls;
}

function fromRow(row: VersionRow): CurrentProjectDisplayVersion {
  if (!row.body_json) throw new ProjectDisplayVersionConflictError("Current display version body was purged");
  const body = record(row.body_json);
  const overlay = Array.isArray(body.imageRemarkOverlay)
    ? body.imageRemarkOverlay.map(entry => ImageRemarkOverlayEntrySchema.parse(entry)) : [];
  const imageEvidence = imageRemarkEvidenceSummary(overlay);
  const view: CurrentProjectDisplayVersion = {
    versionId: row.id, organizationId: row.organization_id, projectId: row.project_id,
    runId: row.source_run_id, jobId: row.source_job_id, marketplace: row.marketplace,
    asins: asins(row.asins_json),
    catalog: Array.isArray(body.catalog) ? body.catalog as Record<string, unknown>[] : [],
    catalogEvidence: body.catalogEvidence ? catalogEvidence(body.catalogEvidence as ProjectCatalogEvidence) : null,
    revisionKind: row.revision_kind,
    imageRemarkOverlay: overlay,
    imageRemarkEvidence: imageEvidence,
    stageOutputs: body.stageOutputs as CurrentProjectDisplayVersion["stageOutputs"],
    gaps: body.gaps as ProjectDisplayGap[],
    contentHash: row.content_hash,
    sourceCompletedAt: dateTime(row.source_completed_at), publishedAt: dateTime(row.published_at),
  };
  if (!view.stageOutputs || !Array.isArray(view.gaps) ||
      hash(row.catalog_evidence_json) !== hash(view.catalogEvidence) ||
      hash(row.image_remark_evidence_json ?? null) !== hash(imageEvidence) ||
      (body.imageRemarkEvidence !== undefined && hash(body.imageRemarkEvidence) !== hash(imageEvidence)) || hash({
    organizationId: view.organizationId, projectId: view.projectId, runId: view.runId, jobId: view.jobId,
    marketplace: view.marketplace, asins: view.asins, catalog: view.catalog,
    ...(view.catalogEvidence ? { catalogEvidence: view.catalogEvidence } : {}),
    ...(body.imageRemarkOverlay !== undefined ? { imageRemarkOverlay: overlay } : {}),
    ...(body.imageRemarkEvidence !== undefined ? { imageRemarkEvidence: imageEvidence } : {}),
    stageOutputs: view.stageOutputs, gaps: view.gaps, sourceCompletedAt: view.sourceCompletedAt,
  }) !== view.contentHash) throw new ProjectDisplayVersionConflictError("Current display version hash mismatch");
  return view;
}

export class PostgresProjectDisplayVersionStore {
  constructor(private readonly queries: PostgresQueryContext) {}

  private async validatedEvidence(input: ProjectCatalogEvidence, scope: {
    organizationId: string; projectId: string; marketplace: string; asins: readonly string[];
  }): Promise<ProjectCatalogEvidence> {
    const evidence = catalogEvidence(input);
    if (evidence.sourceJobId) {
      const source = (await this.queries.query<JobRow>(`SELECT job_id,organization_id,project_id,run_id,marketplace,asins,
        status,created_at,completed_at FROM sync_jobs WHERE job_id=$1 AND organization_id=$2 AND project_id=$3`,
      [evidence.sourceJobId,scope.organizationId,scope.projectId])).rows[0];
      if (!source || source.status !== "completed" || !source.completed_at ||
          source.marketplace !== scope.marketplace || !sameSet(asins(source.asins), scope.asins) ||
          Date.parse(evidence.sourceUpdatedAt) < Date.parse(dateTime(source.created_at)) - 60_000 ||
          Date.parse(evidence.sourceUpdatedAt) > Date.parse(dateTime(source.completed_at)) + 60_000) {
        throw new ProjectDisplayVersionConflictError("Catalog source job does not match the project, scope, or file time");
      }
    }
    return evidence;
  }

  async readCurrent(scope: { organizationId: string; projectId: string }): Promise<CurrentProjectDisplayVersion | null> {
    const result = await this.queries.query<VersionRow>(`SELECT version.* FROM projects project
      JOIN project_display_versions version ON version.id = project.current_display_version_id
      WHERE project.id = $1 AND project.organization_id = $2 AND version.organization_id = $2 AND version.project_id = $1`,
    [scope.projectId, scope.organizationId]);
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }

  async previewImageRemarkRevision(input: ReviseCurrentImageRemarksInput): Promise<Readonly<{
    currentVersionId: string; addedSlots: number; totalOverlaySlots: number;
    evidence: ImageRemarkEvidenceSummary | null;
  }>> {
    const current = await this.readCurrent({ organizationId: input.organizationId, projectId: input.projectId });
    if (!current || current.versionId !== input.expectedCurrentVersionId) {
      throw new ProjectDisplayVersionConflictError("Current display version changed");
    }
    const added = validateImageRemarkCandidate(current, { ...input,
      publishedAt: dateTime(input.publishedAt ?? new Date().toISOString()) });
    const merged = mergedImageRemarkOverlay(current.imageRemarkOverlay, added);
    return { currentVersionId: current.versionId, addedSlots: added.length,
      totalOverlaySlots: merged.length, evidence: imageRemarkEvidenceSummary(merged) };
  }

  async reviseCurrentImageRemarks(input: ReviseCurrentImageRemarksInput): Promise<CurrentProjectDisplayVersion> {
    return this.queries.transaction(async () => {
      const project = (await this.queries.query<ProjectRow>(`SELECT id,organization_id,marketplace,asins_json,current_display_version_id
        FROM projects WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [input.projectId,input.organizationId])).rows[0];
      if (!project || project.current_display_version_id !== input.expectedCurrentVersionId) {
        throw new ProjectDisplayVersionConflictError("Current display version changed");
      }
      const current = await this.readCurrent({ organizationId: input.organizationId, projectId: input.projectId });
      if (!current || current.versionId !== input.expectedCurrentVersionId ||
          current.marketplace !== project.marketplace || !sameSet(current.asins, asins(project.asins_json))) {
        throw new ProjectDisplayVersionConflictError("Current display version scope changed");
      }
      const publishedAt = dateTime(input.publishedAt ?? new Date().toISOString());
      const added = validateImageRemarkCandidate(current, { ...input, publishedAt });
      const overlay = mergedImageRemarkOverlay(current.imageRemarkOverlay, added);
      const imageEvidence = imageRemarkEvidenceSummary(overlay);
      const gaps = effectiveImageRemarkGaps(current.gaps, current.stageOutputs, overlay);
      const body = { catalog: current.catalog, stageOutputs: current.stageOutputs, gaps,
        ...(current.catalogEvidence ? { catalogEvidence: current.catalogEvidence } : {}),
        imageRemarkOverlay: overlay, imageRemarkEvidence: imageEvidence };
      const contentHash = hash({ organizationId: current.organizationId, projectId: current.projectId,
        runId: current.runId, jobId: current.jobId, marketplace: current.marketplace, asins: current.asins,
        ...body, sourceCompletedAt: current.sourceCompletedAt });
      const versionId = randomUUID();
      await this.queries.query(`INSERT INTO project_display_versions
        (id,organization_id,project_id,source_run_id,source_job_id,marketplace,asins_json,content_hash,body_json,
          source_completed_at,published_at,revision_kind,supersedes_version_id,catalog_evidence_json,image_remark_evidence_json)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11,'image-remarks-revision',$12,$13::jsonb,$14::jsonb)`,
      [versionId,current.organizationId,current.projectId,current.runId,current.jobId,current.marketplace,
        JSON.stringify(current.asins),contentHash,JSON.stringify(body),current.sourceCompletedAt,publishedAt,
        current.versionId,current.catalogEvidence ? JSON.stringify(current.catalogEvidence) : null,
        JSON.stringify(imageEvidence)]);
      const expired = await this.queries.query(`UPDATE project_display_versions SET body_expires_at=$2::timestamptz + interval '24 hours'
        WHERE id=$1 AND project_id=$3 AND organization_id=$4 AND body_json IS NOT NULL AND body_expires_at IS NULL`,
      [current.versionId,publishedAt,input.projectId,input.organizationId]);
      if (expired.rowCount !== 1) throw new ProjectDisplayVersionConflictError("Current report cannot be retained for rollback");
      const switched = await this.queries.query(`UPDATE projects SET current_display_version_id=$1
        WHERE id=$2 AND organization_id=$3 AND current_display_version_id=$4 RETURNING id`,
      [versionId,input.projectId,input.organizationId,input.expectedCurrentVersionId]);
      if (switched.rowCount !== 1) throw new ProjectDisplayVersionConflictError("Current display version changed");
      return fromRow({ id: versionId, organization_id: current.organizationId, project_id: current.projectId,
        source_run_id: current.runId, source_job_id: current.jobId, marketplace: current.marketplace,
        asins_json: current.asins, content_hash: contentHash, body_json: body,
        source_completed_at: current.sourceCompletedAt, published_at: publishedAt,
        revision_kind: "image-remarks-revision", supersedes_version_id: current.versionId,
        catalog_evidence_json: current.catalogEvidence, image_remark_evidence_json: imageEvidence });
    });
  }

  async publishFromCompletedJob(input: PublishProjectDisplayVersionInput): Promise<CurrentProjectDisplayVersion> {
    return this.queries.transaction(async () => {
      const project = (await this.queries.query<ProjectRow>(`SELECT id,organization_id,marketplace,asins_json,current_display_version_id
        FROM projects WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [input.projectId, input.organizationId])).rows[0];
      if (!project) throw new ProjectDisplayVersionConflictError("Project not found in organization");
      if (project.current_display_version_id !== input.expectedCurrentVersionId) {
        throw new ProjectDisplayVersionConflictError("Current display version changed");
      }
      const job = (await this.queries.query<JobRow>(`SELECT job.job_id,job.organization_id,job.project_id,job.run_id,job.marketplace,
        job.asins,job.status,job.created_at,job.completed_at FROM sync_jobs job
        JOIN analysis_runs run ON run.id=job.run_id AND run.project_id=job.project_id
        WHERE job.job_id=$1 AND job.organization_id=$2 AND job.project_id=$3
        FOR UPDATE OF job`, [input.jobId, input.organizationId, input.projectId])).rows[0];
      if (!job || job.status !== "completed" || !job.completed_at || !job.run_id ||
          job.marketplace !== project.marketplace || !sameSet(asins(job.asins), asins(project.asins_json))) {
        throw new ProjectDisplayVersionConflictError("Completed sync job does not match the project scope");
      }
      const sourceCompletedAt = dateTime(job.completed_at);
      let current: CurrentProjectDisplayVersion | null = null;
      if (project.current_display_version_id) {
        current = await this.readCurrent({ organizationId: input.organizationId, projectId: input.projectId });
        const currentJob = current && (await this.queries.query<{ created_at: Date | string }>(`SELECT created_at FROM sync_jobs
          WHERE job_id=$1 AND organization_id=$2 AND project_id=$3`,
        [current.jobId,input.organizationId,input.projectId])).rows[0];
        if (!current || !currentJob ||
            Date.parse(dateTime(job.created_at)) < Date.parse(dateTime(currentJob.created_at)) ||
            Date.parse(sourceCompletedAt) < Date.parse(current.sourceCompletedAt)) {
          throw new StaleProjectDisplayCandidateError();
        }
      }
      const prior = (await this.queries.query<VersionRow>(`SELECT * FROM project_display_versions
        WHERE project_id=$1 AND source_job_id=$2 AND revision_kind='job-publication'`, [input.projectId, input.jobId])).rows[0];
      if (prior) {
        const current = await this.readCurrent({ organizationId: input.organizationId, projectId: input.projectId });
        if (current?.jobId === input.jobId) return current;
        throw new ProjectDisplayVersionConflictError("A retired sync job cannot be republished");
      }
      const outputs = (await this.queries.query<OutputRow>(`SELECT output.*,job.job_version FROM sync_job_stage_outputs output
        JOIN sync_jobs job ON job.job_id=output.job_id WHERE output.job_id=$1 ORDER BY output.stage_id`, [input.jobId])).rows;
      if (outputs.length !== stages.length) {
        throw new ProjectDisplayVersionConflictError("Completed sync job must have all 10 stage outputs");
      }
      if (!outputs.some(output => output.stage_status === "done" || output.stage_status === "partial")) {
        throw new ProjectDisplayVersionConflictError("Completed sync job has no usable stage data");
      }
      const stageOutputs = {} as Record<ProjectableSyncStage, DisplayStageOutput>;
      for (const stage of stages) stageOutputs[stage] = { stage, stageStatus: "missing-output", reasonCode: "OUTPUT_UNAVAILABLE" };
      for (const output of outputs) {
        const projection = outputFromRow(output, {
          organizationId: input.organizationId, projectId: input.projectId,
          runId: job.run_id, jobId: input.jobId,
          asins: asins(job.asins), marketplace: job.marketplace,
        });
        stageOutputs[output.stage_id as ProjectableSyncStage] = projection.stage === 'price_strategy'
          ? bindCapturedPriceStrategyProjection({ output: projection, sourceOrganizationId: output.organization_id,
            scope: { organizationId: input.organizationId, projectId: input.projectId,
              runId: job.run_id, jobId: input.jobId, marketplace: job.marketplace, asins: asins(job.asins) } })
          : projection;
      }
      const catalog = scopedCatalog(input.catalog, asins(job.asins));
      const evidence = input.catalogEvidence
        ? await this.validatedEvidence(input.catalogEvidence, { organizationId: input.organizationId,
          projectId: input.projectId, marketplace: job.marketplace, asins: asins(job.asins) })
        : null;
      assertNoCoverageRegression(current, catalog, stageOutputs, asins(job.asins));
      const overlay = inheritedImageRemarkOverlay(current?.imageRemarkOverlay ?? [], stageOutputs);
      const gaps = effectiveImageRemarkGaps(gapsFor(asins(job.asins), catalog, stageOutputs), stageOutputs, overlay);
      const imageEvidence = imageRemarkEvidenceSummary(overlay);
      const body = { catalog, stageOutputs, gaps, ...(evidence ? { catalogEvidence: evidence } : {}),
        ...(imageEvidence ? { imageRemarkOverlay: overlay, imageRemarkEvidence: imageEvidence } : {}) };
      const contentHash = hash({ organizationId: input.organizationId, projectId: input.projectId,
        runId: job.run_id, jobId: input.jobId, marketplace: job.marketplace, asins: asins(job.asins),
        ...body, sourceCompletedAt });
      const publishedAt = dateTime(input.publishedAt ?? new Date().toISOString());
      const versionId = randomUUID();
      await this.queries.query(`INSERT INTO project_display_versions
        (id,organization_id,project_id,source_run_id,source_job_id,marketplace,asins_json,content_hash,body_json,source_completed_at,published_at,revision_kind,catalog_evidence_json,image_remark_evidence_json)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11,'job-publication',$12::jsonb,$13::jsonb)`,
      [versionId,input.organizationId,input.projectId,job.run_id,input.jobId,job.marketplace,JSON.stringify(job.asins),contentHash,JSON.stringify(body),sourceCompletedAt,publishedAt,evidence ? JSON.stringify(evidence) : null,imageEvidence ? JSON.stringify(imageEvidence) : null]);
      if (project.current_display_version_id) {
        await this.queries.query(`UPDATE project_display_versions SET body_expires_at=$2::timestamptz + interval '24 hours'
          WHERE id=$1 AND organization_id=$3 AND project_id=$4 AND body_expires_at IS NULL`,
        [project.current_display_version_id,publishedAt,input.organizationId,input.projectId]);
      }
      const switched = await this.queries.query(`UPDATE projects SET current_display_version_id=$1
        WHERE id=$2 AND organization_id=$3 AND current_display_version_id IS NOT DISTINCT FROM $4 RETURNING id`,
      [versionId,input.projectId,input.organizationId,input.expectedCurrentVersionId]);
      if (switched.rowCount !== 1) throw new ProjectDisplayVersionConflictError("Current display version changed");
      return fromRow({ id: versionId, organization_id: input.organizationId, project_id: input.projectId,
        source_run_id: job.run_id, source_job_id: input.jobId, marketplace: job.marketplace,
        asins_json: job.asins, content_hash: contentHash, body_json: body,
        source_completed_at: sourceCompletedAt, published_at: publishedAt,
        revision_kind: "job-publication", supersedes_version_id: null, catalog_evidence_json: evidence,
        image_remark_evidence_json: imageEvidence });
    });
  }

  async reviseCurrentCatalog(input: ReviseCurrentCatalogInput): Promise<CurrentProjectDisplayVersion> {
    return this.queries.transaction(async () => {
      const project = (await this.queries.query<ProjectRow>(`SELECT id,organization_id,marketplace,asins_json,current_display_version_id
        FROM projects WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [input.projectId,input.organizationId])).rows[0];
      if (!project || project.current_display_version_id !== input.expectedCurrentVersionId) {
        throw new ProjectDisplayVersionConflictError("Current display version changed");
      }
      const current = await this.readCurrent({ organizationId: input.organizationId, projectId: input.projectId });
      if (!current || current.versionId !== input.expectedCurrentVersionId ||
          current.marketplace !== project.marketplace || !sameSet(current.asins, asins(project.asins_json)) ||
          stages.some(stage => current.stageOutputs[stage]?.stageStatus === "missing-output")) {
        throw new ProjectDisplayVersionConflictError("Current display version is unavailable or incomplete");
      }
      const catalog = scopedCatalog(input.catalog, current.asins);
      const evidence = await this.validatedEvidence(input.evidence, { organizationId: input.organizationId,
        projectId: input.projectId, marketplace: current.marketplace, asins: current.asins });
      const publishedAt = dateTime(input.publishedAt ?? new Date().toISOString());
      if (Date.parse(evidence.capturedAt) > Date.parse(publishedAt)) {
        throw new ProjectDisplayVersionConflictError("Catalog evidence was captured after publication");
      }
      const stageOutputs = current.stageOutputs as Record<ProjectableSyncStage, DisplayStageOutput>;
      assertNoCoverageRegression(current, catalog, stageOutputs, current.asins);
      const gaps = effectiveImageRemarkGaps(gapsFor(current.asins, catalog, stageOutputs), stageOutputs,
        current.imageRemarkOverlay);
      const imageEvidence = current.imageRemarkEvidence;
      const body = { catalog, stageOutputs, gaps, catalogEvidence: evidence,
        ...(imageEvidence ? { imageRemarkOverlay: current.imageRemarkOverlay, imageRemarkEvidence: imageEvidence } : {}) };
      const contentHash = hash({ organizationId: current.organizationId, projectId: current.projectId,
        runId: current.runId, jobId: current.jobId, marketplace: current.marketplace, asins: current.asins,
        ...body, sourceCompletedAt: current.sourceCompletedAt });
      const versionId = randomUUID();
      await this.queries.query(`INSERT INTO project_display_versions
        (id,organization_id,project_id,source_run_id,source_job_id,marketplace,asins_json,content_hash,body_json,
          source_completed_at,published_at,revision_kind,supersedes_version_id,catalog_evidence_json,image_remark_evidence_json)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11,'catalog-revision',$12,$13::jsonb,$14::jsonb)`,
      [versionId,current.organizationId,current.projectId,current.runId,current.jobId,current.marketplace,
        JSON.stringify(current.asins),contentHash,JSON.stringify(body),current.sourceCompletedAt,publishedAt,
        current.versionId,JSON.stringify(evidence),imageEvidence ? JSON.stringify(imageEvidence) : null]);
      const expired = await this.queries.query(`UPDATE project_display_versions SET body_expires_at=$2::timestamptz + interval '24 hours'
        WHERE id=$1 AND project_id=$3 AND organization_id=$4 AND body_json IS NOT NULL AND body_expires_at IS NULL`,
      [current.versionId,publishedAt,input.projectId,input.organizationId]);
      if (expired.rowCount !== 1) throw new ProjectDisplayVersionConflictError("Current report cannot be retained for rollback");
      const switched = await this.queries.query(`UPDATE projects SET current_display_version_id=$1
        WHERE id=$2 AND organization_id=$3 AND current_display_version_id=$4 RETURNING id`,
      [versionId,input.projectId,input.organizationId,input.expectedCurrentVersionId]);
      if (switched.rowCount !== 1) throw new ProjectDisplayVersionConflictError("Current display version changed");
      return fromRow({ id: versionId, organization_id: current.organizationId, project_id: current.projectId,
        source_run_id: current.runId, source_job_id: current.jobId, marketplace: current.marketplace,
        asins_json: current.asins, content_hash: contentHash, body_json: body,
        source_completed_at: current.sourceCompletedAt, published_at: publishedAt,
        revision_kind: "catalog-revision", supersedes_version_id: current.versionId,
        catalog_evidence_json: evidence, image_remark_evidence_json: imageEvidence });
    });
  }

  async cleanupExpiredBodies(input: { now?: string; limit?: number } = {}): Promise<ExpiredDisplayBodyCleanup> {
    const now = dateTime(input.now ?? new Date().toISOString());
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError("Invalid cleanup limit");
    return this.queries.transaction(async () => {
      await this.queries.query(`WITH stale_unversioned AS (
        SELECT output.job_id,output.stage_id FROM sync_job_stage_outputs output
        JOIN sync_jobs job ON job.job_id=output.job_id AND job.organization_id=output.organization_id
          AND job.project_id=output.project_id AND job.status='completed'
        JOIN projects project ON project.id=job.project_id AND project.organization_id=job.organization_id
        LEFT JOIN LATERAL (
          SELECT min(initial.published_at) AS published_at FROM project_display_versions initial
          WHERE initial.project_id=project.id AND initial.revision_kind='job-publication'
        ) first_publication ON true
        WHERE project.current_display_version_id IS NOT NULL AND first_publication.published_at IS NOT NULL
          AND greatest(coalesce(job.completed_at,job.updated_at),first_publication.published_at) + interval '24 hours' <= $1
          AND NOT EXISTS (SELECT 1 FROM project_display_versions version WHERE version.source_job_id=job.job_id)
        ORDER BY job.completed_at,output.job_id,output.stage_id LIMIT $2
        FOR UPDATE OF output SKIP LOCKED
      ) DELETE FROM sync_job_stage_outputs output USING stale_unversioned stale
        WHERE output.job_id=stale.job_id AND output.stage_id=stale.stage_id`, [now,limit]);
      const expired = await this.queries.query<{ id: string; source_job_id: string; body_json: unknown }>(`SELECT version.id,version.source_job_id,version.body_json
        FROM project_display_versions version JOIN projects project ON project.id=version.project_id
        JOIN sync_jobs job ON job.job_id=version.source_job_id AND job.organization_id=version.organization_id
          AND job.project_id=version.project_id AND job.status='completed'
        WHERE version.body_json IS NOT NULL AND version.body_expires_at <= $1
          AND project.current_display_version_id IS DISTINCT FROM version.id
        ORDER BY version.body_expires_at,version.id LIMIT $2 FOR UPDATE OF version,job SKIP LOCKED`, [now,limit]);
      if (!expired.rows.length) return { purgedCount: 0, imageUrls: [] };
      const candidates = new Set(expired.rows.flatMap(row => [...imageUrls(row.body_json)]));
      const ids = expired.rows.map(row => row.id);
      const jobIds = expired.rows.map(row => row.source_job_id);
      const purged = await this.queries.query<{ id: string }>(`UPDATE project_display_versions version
        SET body_json=NULL,body_purged_at=$1 WHERE version.id=ANY($2::text[]) RETURNING version.id`, [now,ids]);
      await this.queries.query(`DELETE FROM sync_job_stage_outputs output WHERE output.job_id=ANY($1::text[])
        AND NOT EXISTS (SELECT 1 FROM project_display_versions version
          WHERE version.source_job_id=output.job_id AND version.body_json IS NOT NULL)`, [jobIds]);
      const retained = await this.queries.query<{ body_json: unknown }>(`SELECT body_json FROM project_display_versions WHERE body_json IS NOT NULL`);
      for (const row of retained.rows) for (const url of imageUrls(row.body_json)) candidates.delete(url);
      return { purgedCount: purged.rowCount ?? 0, imageUrls: [...candidates].sort() };
    });
  }
}
