import { persistedStageOutputContentHash } from "./sync-stage-output.mjs";
import fs from "node:fs";

/** The image worker must analyze the listing captured by this job, not a later code checkout. */
export function listingInputFromPersistedJob(job, asins) {
  const outputs = (job?.outputs ?? []).filter(output => output?.stage === "listing");
  if (outputs.length !== 1) throw new Error("Image listing stage output is missing or ambiguous");
  const output = outputs[0];
  const scope = job?.scope;
  if (!scope || output.organizationId !== scope.organizationId ||
      output.projectId !== scope.projectId || output.runId !== scope.runId) {
    throw new Error("Image listing stage scope mismatch");
  }
  if (output.stageStatus !== "done" && output.stageStatus !== "partial") {
    throw new Error("Image listing stage has no usable data");
  }
  if (persistedStageOutputContentHash(output) !== output.contentHash) {
    throw new Error("Image listing stage content hash mismatch");
  }
  const records = output.data?.contentByAsin;
  if (!records || typeof records !== "object" || Array.isArray(records)) {
    throw new Error("Image listing stage data is missing");
  }
  const allowed = new Set(job.asins ?? []);
  const result = {};
  for (const asin of asins) {
    if (!allowed.has(asin)) throw new Error("Image listing ASIN scope mismatch");
    const record = records[asin];
    if (record?.status !== "ready" || !Array.isArray(record.galleryImages) ||
        !record.galleryImages.length || record.galleryImages.some(url =>
          typeof url !== "string" || !/^https:\/\//.test(url))) {
      throw new Error(`Image listing gallery unavailable for ${asin}`);
    }
    if (new Set(record.galleryImages).size !== record.galleryImages.length) throw new Error(`Image listing URL identity is ambiguous for ${asin}`);
    result[asin] = record;
  }
  return result;
}

export function readListingInputFile(filePath, jobId, asins, expectedHash) {
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (payload?.jobId !== jobId || !payload?.job || !Array.isArray(asins)) {
    throw new Error("Image listing input identity mismatch");
  }
  const listing = listingInputFromPersistedJob(payload.job, asins);
  if (expectedHash && payload.job.outputs.find(output => output.stage === "listing").contentHash !== expectedHash) throw new Error("Image listing input content hash mismatch");
  return listing;
}

/** Validate the immutable source first; absence of a usable gallery is a local gap. */
export function partitionImageListingInput(job, asins) {
  listingInputFromPersistedJob(job, []);
  const listingByAsin = {};
  const missingAsins = [];
  for (const asin of asins) {
    try {
      Object.assign(listingByAsin, listingInputFromPersistedJob(job, [asin]));
    } catch (error) {
      if (error.message !== `Image listing gallery unavailable for ${asin}`) throw error;
      missingAsins.push(asin);
    }
  }
  return { listingByAsin, readyAsins: asins.filter(asin => !missingAsins.includes(asin)), missingAsins };
}

/** No model call occurred: retain the dependency failure instead of claiming empty data. */
export function missingGalleryStatuses(job, asins) {
  return Object.fromEntries(asins.map(asin => {
    const progress = job?.asinProgress?.[asin];
    const status = [progress?.listing?.status, progress?.image_remarks?.status]
      .find(value => ['connector-failed', 'timeout'].includes(value));
    return [asin, status ?? 'upstream-empty'];
  }));
}

/** Capturing cache evidence never authorizes analysis outside the dispatch scope. */
export function imageRemarkCaptureScope(analysisAsins, captureAsins, options = {}) {
  if (!Array.isArray(analysisAsins) || !Array.isArray(captureAsins) ||
      [analysisAsins, captureAsins].some(asins => new Set(asins).size !== asins.length || asins.some(asin => !/^[A-Z0-9]{10}$/.test(asin)))) {
    throw new Error("Image capture ASIN scope is invalid");
  }
  if (!options.jobId || !options.candidateFile || !options.listingFile || !/^[a-f0-9]{64}$/.test(options.listingHash ?? "")) throw new Error("Image capture requires a scoped job candidate and persisted listing");
  const captured = new Set(captureAsins);
  if (analysisAsins.some(asin => !captured.has(asin))) throw new Error("Image analysis ASIN is outside capture scope");
  return [...captureAsins];
}
