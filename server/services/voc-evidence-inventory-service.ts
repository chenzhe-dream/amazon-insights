import { ProjectMarketplaceSchema } from "../../shared/project-marketplaces";
import { z } from "zod";
import { LocalDataStageOutputResponseSchema } from "../../shared/agent-contracts";
import { VocEvidenceManifestSchema, type VocEvidenceManifest, type VocEvidenceInventory } from "../../shared/voc-evidence-contracts";
import type { RuntimeAgentRepository, ProjectRecord } from "../db/repository";
import { RepositoryVocSourceReader } from "../data/repository-voc-source";
import { buildVocSnapshotCandidate, type VocSnapshotSourceBundle, type VocSnapshotCandidate } from "../data/voc-data-snapshot";
import { buildKeywordAnalysisSnapshotCandidate } from "../data/keyword-analysis-snapshot";
import { manualEvidenceDimensions, reviewEvidenceDimensions, selectEvidenceDimensions } from "../data/voc-evidence-selection";
import { canonicalJsonSha256 } from "../runtime/model-request-accounting";

const QueryWindowSchema = z.object({ time_type: z.string(), time_value: z.string(), listingSearch: z.boolean() });
const KeywordRecordSchema = z.object({ asin: z.string(), marketplace: ProjectMarketplaceSchema, status: z.enum(["ready", "empty", "error"]), fetchedAt: z.string(),
  queryWindow: QueryWindowSchema.nullable().optional(),
  currentEmpty: z.object({ queryWindow: QueryWindowSchema, observedAt: z.string(), terminalReason: z.literal("valid-empty") }).optional(),
  keywords: z.array(z.object({ keyword: z.string().trim().min(1), searchVolume: z.number().finite().nonnegative().nullable() })) });
type Input = { repository: RuntimeAgentRepository; project: ProjectRecord; baseSyncRunId: string; selectedAsins: readonly string[]; dataCutoffAt: string };
export async function buildVocEvidenceInventory(input: Input) {
  const { repository, project, dataCutoffAt, baseSyncRunId } = input;
  const selectedAsins = [...input.selectedAsins].sort();
  if (!ProjectMarketplaceSchema.safeParse(project.marketplace).success || !selectedAsins.length || new Set(selectedAsins).size !== selectedAsins.length || selectedAsins.some(asin => !project.asins.includes(asin))) throw new Error("Invalid evidence scope");
  const baseRun = await repository.findAnalysisRun(baseSyncRunId);
  if (!baseRun || baseRun.projectId !== project.id || baseRun.idempotencyScope !== `sync:${project.organizationId}:${project.id}`) throw new Error("Evidence source run is unavailable");
  const job = await repository.syncJobs.findById(baseRun.idempotencyKey);
  if (!job || job.organizationId !== project.organizationId || job.projectId !== project.id || job.runId !== baseRun.id || job.marketplace !== project.marketplace || selectedAsins.some(asin => !job.asins.includes(asin))) throw new Error("Evidence source job scope mismatch");
  const read = async (stage: "keywords" | "reviews") => {
    const raw = await repository.syncJobs.readStageOutput({ organizationId: project.organizationId, projectId: project.id, runId: baseRun.id, jobId: job.jobId, stage });
    if (!raw) return null;
    const output = LocalDataStageOutputResponseSchema.parse(raw);
    if (output.stage !== stage || output.projectId !== project.id || output.runId !== baseRun.id || output.jobId !== job.jobId || output.updatedAt > dataCutoffAt || output.outputVersion > output.jobVersion || output.contentHash !== canonicalJsonSha256({ stage, ...("data" in output ? { data: output.data } : {}), ...("gap" in output ? { gap: output.gap } : {}) })) throw new Error("Evidence source integrity mismatch");
    return output;
  };
  const [reviews, keywords] = await Promise.all([read("reviews"), read("keywords")]);
  const reviewData = reviews && reviews.stage === "reviews" && "data" in reviews ? reviews.data.analysisByAsin : {};
  const reader = new RepositoryVocSourceReader({ manualVoc: repository.manualAlexaVoc, legacyFallbackEnabled: false, reviewSources: { sorftime: { meta: { marketplace: project.marketplace }, ...(reviews ? { publishedAt: reviews.updatedAt } : {}), data: reviewData }, sellerSprite: { meta: { marketplace: project.marketplace }, data: {} } } });
  const source = await reader.read({ organizationId: project.organizationId, marketplace: project.marketplace, asins: selectedAsins, dataCutoffAt, sourcePolicy: "manual-with-review-fallback" });
  const payload = source.candidate?.payload;
  const manualRecords = (payload?.records.alexaVoc ?? []).filter(record => manualEvidenceDimensions(record).length);
  const reviewRecords = payload?.records.sorftimeReviewAnalysis ?? [];
  const sourceRef = (stage: NonNullable<typeof reviews>) => ({ id: `repository://sync/${baseRun.id}/${stage.stage}/${stage.jobId}`, version: String(stage.outputVersion), contentHash: stage.contentHash, capturedAt: stage.updatedAt });
  const manualSource = source.candidate?.sources.find(item => item.type === "manual-voc");
  let keywordInvalid = false, keywordMissing = false;
  const stageDate = keywords?.updatedAt ? new Date(keywords.updatedAt) : null;
  const previousMonth = stageDate && Number.isFinite(stageDate.getTime())
    ? new Date(Date.UTC(stageDate.getUTCFullYear(), stageDate.getUTCMonth() - 1, 1)).toISOString().slice(0, 10) : null;
  const observedKeywordRecords: Array<z.infer<typeof KeywordRecordSchema>> = [];
  const keywordRows = keywords && keywords.stage === "keywords" && "data" in keywords ? selectedAsins.flatMap(asin => {
    const parsed = KeywordRecordSchema.safeParse(keywords.data.analysisByAsin[asin]);
    const record = parsed.success ? parsed.data : null;
    if (!keywords.data.analysisByAsin[asin]) keywordMissing = true;
    else if (!record || record.asin !== asin || record.marketplace !== project.marketplace || record.status === "error" || !Number.isFinite(Date.parse(record.fetchedAt)) || Date.parse(record.fetchedAt) > Date.parse(keywords.updatedAt) ||
      (record.status === "ready" && record.queryWindow?.time_type === "month" && (
        project.marketplace !== "UK" || record.queryWindow.time_value !== previousMonth || !record.queryWindow.listingSearch ||
        !record.currentEmpty || record.currentEmpty.queryWindow.time_type !== "lately" || record.currentEmpty.queryWindow.time_value !== "30" ||
        !record.currentEmpty.queryWindow.listingSearch || !Number.isFinite(Date.parse(record.currentEmpty.observedAt)) ||
        Date.parse(record.currentEmpty.observedAt) > Date.parse(keywords.updatedAt)))) keywordInvalid = true;
    if (record && !keywordInvalid) observedKeywordRecords.push(record);
    return !keywordInvalid && record && record.asin === asin && record.marketplace === project.marketplace && record.status === "ready" ? record.keywords.map(row => ({ asin, row })) : [];
  }) : [];
  const usableRows = keywordRows.filter(({ row }) => row.keyword.trim());
  const keywordState: VocEvidenceManifest["keywords"]["state"] = keywordInvalid ? "failed" : keywordMissing ? "missing" : usableRows.length ? "ready" : !keywords ? "missing" : keywords.stageStatus === "failed" ? (keywords.gap.reasonCode === "UPSTREAM_EMPTY" ? "empty" : "failed") : "empty";
  const makeManifest = (fallback: boolean): VocEvidenceManifest => {
    const coverage = selectedAsins.map(asin => {
      const manual = manualRecords.find(record => record.asin === asin);
      const review = reviewRecords.find(record => record.asin === asin);
      const provenance = manualSource?.recordProvenance?.find(record => record.asin === asin);
      const manualDimensions = manual ? manualEvidenceDimensions(manual) : [];
      const reviewDimensions = fallback && review ? reviewEvidenceDimensions(review) : [];
      return { asin, primary: manual ? "manual" as const : reviewDimensions.length ? "review" as const : "missing" as const,
        manualDimensions, ...selectEvidenceDimensions(manualDimensions, reviewDimensions, fallback),
        manual: manual && provenance ? { id: `repository://manual-voc/${asin}`, version: provenance.revision, contentHash: provenance.contentHash, capturedAt: provenance.capturedAt } : null,
        review: fallback && review && reviews ? sourceRef(reviews) : null };
    });
    const unsigned = { schemaVersion: "voc-evidence/v1" as const, organizationId: project.organizationId, projectId: project.id, baseSyncRunId, marketplace: project.marketplace, selectedAsins,
      sourcePolicy: fallback ? "manual-with-review-fallback" as const : "manual-only" as const,
      sourceMode: fallback && coverage.some(row => row.review) ? "review-fallback" as const : "manual" as const,
      coverage, keywords: { state: keywordState, source: keywords ? sourceRef(keywords) : null } };
    return VocEvidenceManifestSchema.parse({ ...unsigned, fingerprint: canonicalJsonSha256(unsigned) });
  };
  const inventory: VocEvidenceInventory = { manual: makeManifest(false), fallback: makeManifest(true) };
  const candidate = (manifest: VocEvidenceManifest): VocSnapshotCandidate | null => {
    const bundles: VocSnapshotSourceBundle[] = [];
    if (manualRecords.length && manualSource?.recordProvenance) {
      const provenance = manualSource.recordProvenance.filter(p => manualRecords.some(r => r.asin === p.asin));
      bundles.push({ sourceId: "alexa-voc", type: "manual-voc", reference: "repository://manual-alexa-voc/selected-revisions", marketplace: project.marketplace, capturedAt: provenance.map(p => p.capturedAt).sort().at(-1)!, records: manualRecords, recordProvenance: provenance });
    }
    if (manifest.sourcePolicy === "manual-with-review-fallback" && reviewRecords.length) {
      const reviewSource = source.candidate!.sources.find(item => item.type === "connector")!;
      bundles.push({ sourceId: "sorftime-review-analysis", type: "connector", reference: "app/sorftime-review-analysis-data.ts#sorftimeReviewAnalysisData", marketplace: project.marketplace, capturedAt: reviewSource.capturedAt, records: reviewRecords });
    }
    return bundles.length ? buildVocSnapshotCandidate({ marketplace: project.marketplace, asins: selectedAsins, dataCutoffAt, sourceBundles: bundles, evidenceSelection: manifest }) : null;
  };
  const keywordCandidate = keywordState === "ready" && usableRows.length && keywords ? buildKeywordAnalysisSnapshotCandidate({ marketplace: project.marketplace, asins: selectedAsins, dataCutoffAt,
    groups: usableRows.slice(0, 100).map(({ asin, row }, index) => ({ id: `keyword-${index}`, label: row.keyword, keywords: [row.keyword], demand: "unknown", trend: "unknown", seasonality: "unknown", evidenceIds: [`${asin}-keyword-${index}`] })),
    evidence: usableRows.slice(0, 100).map(({ asin, row }, index) => {
      const record = observedKeywordRecords.find(item => item.asin === asin)!;
      return { id: `${asin}-keyword-${index}`, sourceId: `${sourceRef(keywords).id}@${keywords.outputVersion}#${keywords.contentHash}`, capturedAt: keywords.updatedAt,
        searchVolume: row.searchVolume, purchaseRate: null,
        ...(record.queryWindow ? { queryWindow: record.queryWindow } : {}),
        ...(record.currentEmpty ? { currentEmpty: record.currentEmpty } : {}) };
    }),
    coverage: observedKeywordRecords.map(record => ({ asin: record.asin, status: record.status as "ready" | "empty",
      queryWindow: record.queryWindow ?? null, ...(record.currentEmpty ? { currentEmpty: record.currentEmpty } : {}) })),
  }) : null;
  return { inventory, manualCandidate: candidate(inventory.manual), fallbackCandidate: candidate(inventory.fallback), keywordCandidate };
}
