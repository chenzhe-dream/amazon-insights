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
    result[asin] = record;
  }
  return result;
}

export function readListingInputFile(filePath, jobId, asins) {
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (payload?.jobId !== jobId || !payload?.job || !Array.isArray(asins)) {
    throw new Error("Image listing input identity mismatch");
  }
  return listingInputFromPersistedJob(payload.job, asins);
}
