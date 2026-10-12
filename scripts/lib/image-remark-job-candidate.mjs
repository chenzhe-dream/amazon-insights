import { imageRemarkOutcome } from "./image-remark-outcome.mjs";
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { listingInputFromPersistedJob } from './image-remark-listing-input.mjs';
import { hasCompleteImageRemarks } from './asin-data-status.mjs';
import { persistedStageOutputContentHash } from './sync-stage-output.mjs';

const outcomeStatuses = new Set(['ready', 'upstream-empty', 'timeout', 'connector-failed']);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

function contentHash(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`Image candidate ${label} ASIN scope mismatch`);
  }
}

function validateSlots(asins, galleries, remarksByAsin, outcomesByAsin) {
  exactKeys(galleries, asins, 'gallery');
  exactKeys(remarksByAsin, asins, 'remarks');
  exactKeys(outcomesByAsin, asins, 'outcomes');
  for (const asin of asins) {
    const gallery = galleries[asin];
    const remarks = remarksByAsin[asin];
    const outcomes = outcomesByAsin[asin];
    if (!Array.isArray(gallery) || !gallery.length ||
        gallery.some(url => typeof url !== 'string' || !url.startsWith('https://')) ||
        !Array.isArray(remarks) || remarks.length !== gallery.length ||
        !Array.isArray(outcomes) || outcomes.length !== gallery.length) {
      throw new Error(`Image candidate gallery/index mismatch for ${asin}`);
    }
    if (new Set(gallery).size !== gallery.length) throw new Error(`Image candidate URL identity is ambiguous for ${asin}`);
    gallery.forEach((url, index) => {
      const remark = remarks[index];
      const outcome = outcomes[index];
      if (remark != null &&
          (typeof remark !== 'object' || Array.isArray(remark) ||
           typeof remark.remark !== 'string' || !remark.remark.trim() || remark.imageUrl !== url)) {
        throw new Error(`Image candidate remark URL/index mismatch for ${asin}:${index}`);
      }
      if (outcome != null &&
          (typeof outcome !== 'object' || Array.isArray(outcome) || !outcomeStatuses.has(outcome.status))) {
        throw new Error(`Image candidate outcome/index mismatch for ${asin}:${index}`);
      }
      if (outcome?.status === 'ready' && !remark) {
        throw new Error(`Image candidate ready outcome has no remark for ${asin}:${index}`);
      }
    });
  }
}

export function createImageRemarkCandidate({
  jobId, listingContentHash, asins, listingByAsin, remarksByAsin, outcomesByAsin,
}) {
  if (!jobId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(jobId) ||
      !/^[a-f0-9]{64}$/.test(listingContentHash ?? '') || !Array.isArray(asins)) {
    throw new Error('Image candidate job/listing identity is invalid');
  }
  const scopedAsins = [...new Set(asins)].sort();
  if (!scopedAsins.length || scopedAsins.length !== asins.length) {
    throw new Error('Image candidate ASIN scope is invalid');
  }
  const galleries = Object.fromEntries(scopedAsins.map(asin => [asin, listingByAsin?.[asin]?.galleryImages]));
  const remarks = Object.fromEntries(scopedAsins.map(asin => [asin,
    Array.from(galleries[asin] ?? [], (_, index) => remarksByAsin?.[asin]?.[index] ?? null),
  ]));
  const outcomes = Object.fromEntries(scopedAsins.map(asin => [asin,
    Array.from(galleries[asin] ?? [], (_, index) => outcomesByAsin?.[asin]?.[index] ?? null),
  ]));
  validateSlots(scopedAsins, galleries, remarks, outcomes);
  for (const slots of Object.values(outcomes)) {
    slots.forEach((outcome, index) => { if (outcome) slots[index] = imageRemarkOutcome(outcome.status, outcome); });
  }
  const body = {
    schemaVersion: 1,
    jobId,
    listingContentHash,
    asins: scopedAsins,
    imageUrlsByAsin: galleries,
    remarksByAsin: remarks,
    outcomesByAsin: outcomes,
  };
  return { ...body, contentHash: contentHash(body) };
}

export function validateImageRemarkCandidate(candidate, { job, asins }) {
  if (!candidate || candidate.schemaVersion !== 1 || candidate.jobId !== job?.jobId) {
    throw new Error('Image candidate job identity mismatch');
  }
  const scopedAsins = [...new Set(asins)].sort();
  if (JSON.stringify(candidate.asins) !== JSON.stringify(scopedAsins)) {
    throw new Error('Image candidate ASIN scope mismatch');
  }
  const listing = listingInputFromPersistedJob(job, scopedAsins);
  const listingOutput = job.outputs.find(output => output.stage === 'listing');
  if (candidate.listingContentHash !== listingOutput.contentHash) {
    throw new Error('Image candidate listing content hash mismatch');
  }
  const body = Object.fromEntries(Object.entries(candidate).filter(([key]) => key !== 'contentHash'));
  if (contentHash(body) !== candidate.contentHash) {
    throw new Error('Image candidate content hash mismatch');
  }
  validateSlots(scopedAsins, candidate.imageUrlsByAsin, candidate.remarksByAsin, candidate.outcomesByAsin);
  for (const asin of scopedAsins) {
    if (JSON.stringify(candidate.imageUrlsByAsin[asin]) !== JSON.stringify(listing[asin].galleryImages)) {
      throw new Error(`Image candidate listing URL/index mismatch for ${asin}`);
    }
  }
  return {
    remarksByAsin: candidate.remarksByAsin,
    outcomesByAsin: Object.fromEntries(Object.entries(candidate.outcomesByAsin).map(([asin, slots]) => [asin, slots.map(outcome => outcome == null ? null : imageRemarkOutcome(outcome.status, outcome))])),
  };
}

export function writeImageRemarkCandidate(filePath, candidate) {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${process.pid}-${randomUUID()}`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(candidate), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
}

export function readImageRemarkCandidate(filePath, context) {
  return validateImageRemarkCandidate(JSON.parse(fs.readFileSync(filePath, 'utf8')), context);
}

export function imageCandidateResultStatuses(data, listingByAsin, asins) {
  return Object.fromEntries(asins.map(asin => {
    const listing = listingByAsin?.[asin];
    const outcomes = data?.outcomesByAsin?.[asin] ?? [];
    const staticStatuses = (listing?.galleryImages ?? [])
      .flatMap((url, index) => /play-button|PKplay-button/i.test(url) ? [] : [outcomes[index]?.status]);
    const complete = hasCompleteImageRemarks(listing, data?.remarksByAsin?.[asin]);
    const status = staticStatuses.includes('timeout') ? 'timeout'
      : staticStatuses.includes('connector-failed') ? 'connector-failed'
        : complete && staticStatuses.every(value => value === 'ready') ? 'ready'
          : 'upstream-empty';
    return [asin, status];
  }));
}

export function imageCandidateReadiness(data, listingByAsin, asins) {
  const statuses = imageCandidateResultStatuses(data, listingByAsin, asins);
  const items = asins.map(asin => ({ asin, imageRemarks: statuses[asin] === 'ready' ? 'ready' : 'missing' }));
  const missingAsins = items.filter(item => item.imageRemarks !== 'ready').map(item => item.asin);
  return { stageId: 'image_remarks', items, ready: asins.length > 0 && !missingAsins.length, missingAsins };
}

/** Preserve untouched ASINs only from this job's previously verified stage output. */
export function mergeImageRemarkStageData(job, previousOutput, processedAsins, candidateData) {
  if (previousOutput) validatePersistedImageStageOutput(job, previousOutput);
  const processed = new Set(processedAsins);
  for (const field of ['remarksByAsin', 'outcomesByAsin']) {
    const entries = candidateData?.[field] ?? {};
    if (!entries || typeof entries !== 'object' || Array.isArray(entries) ||
        Object.keys(entries).some(asin => !processed.has(asin))) {
      throw new Error('Image candidate processed ASIN scope mismatch');
    }
  }
  const previous = previousOutput?.data ?? {};
  return {
    remarksByAsin: {
      ...Object.fromEntries(Object.entries(previous.remarksByAsin ?? {})
        .filter(([asin]) => !processed.has(asin))),
      ...(candidateData?.remarksByAsin ?? {}),
    },
    outcomesByAsin: {
      ...Object.fromEntries(Object.entries(previous.outcomesByAsin ?? {})
        .filter(([asin]) => !processed.has(asin))),
      ...(candidateData?.outcomesByAsin ?? {}),
    },
  };
}

/** Recheck persisted output against this job's listing, independent of the candidate file. */
export function validatePersistedImageStageOutput(job, output) {
  if (output?.stage !== 'image_remarks' ||
      persistedStageOutputContentHash(output) !== output.contentHash) {
    throw new Error('Persisted image stage content hash mismatch');
  }
  const scope = job?.scope;
  if (scope && (output.organizationId !== scope.organizationId ||
      output.projectId !== scope.projectId || output.runId !== scope.runId)) {
    throw new Error('Persisted image stage scope mismatch');
  }
  if (output.stageStatus === 'failed') return;
  const data = output.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Persisted image stage data is missing');
  }
  const remarksByAsin = data.remarksByAsin;
  const outcomesByAsin = data.outcomesByAsin;
  if (!remarksByAsin || typeof remarksByAsin !== 'object' || Array.isArray(remarksByAsin) ||
      !outcomesByAsin || typeof outcomesByAsin !== 'object' || Array.isArray(outcomesByAsin)) {
    throw new Error('Persisted image stage maps are invalid');
  }
  const asins = [...new Set([
    ...Object.keys(remarksByAsin ?? {}), ...Object.keys(outcomesByAsin ?? {}),
  ])].sort();
  if (asins.some(asin => !job.asins?.includes(asin))) {
    throw new Error('Persisted image stage ASIN scope mismatch');
  }
  const readyAsins = (job.asins ?? []).filter(asin =>
    job.asinProgress?.[asin]?.image_remarks?.status === 'ready');
  if (readyAsins.some(asin => !asins.includes(asin))) {
    throw new Error('Persisted image stage omits a ready ASIN');
  }
  if (!asins.length) return;
  const listing = listingInputFromPersistedJob(job, asins);
  const galleries = Object.fromEntries(asins.map(asin => [asin, listing[asin].galleryImages]));
  validateSlots(asins, galleries, remarksByAsin, outcomesByAsin);
  if (readyAsins.some(asin => imageCandidateResultStatuses(data, listing, [asin])[asin] !== 'ready')) {
    throw new Error('Persisted image stage is incomplete for a ready ASIN');
  }
}
