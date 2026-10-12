import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { projectStageOutput } from '../../scripts/lib/sync-stage-output.mjs';
import {
  createImageRemarkCandidate,
  imageCandidateReadiness,
  imageCandidateResultStatuses,
  mergeImageRemarkStageData,
  readImageRemarkCandidate,
  validateImageRemarkCandidate,
  validatePersistedImageStageOutput,
  writeImageRemarkCandidate,
} from '../../scripts/lib/image-remark-job-candidate.mjs';

const asin = 'B000000001';
const url = 'https://images.test/owned.jpg';
const otherUrl = 'https://images.test/other.jpg';
const note = { remark: 'Owned image', imageUrl: url, image_types: ['产品展示'], confidence: 'high' };

function job() {
  const scope = { organizationId: 'org', projectId: 'project', runId: 'run' };
  return {
    jobId: 'job-a', asins: [asin], scope,
    outputs: [projectStageOutput('listing', [asin], {
      ...scope, readExport: () => ({ [asin]: { status: 'ready', galleryImages: [url] } }),
    })],
  };
}

function candidate(sourceJob = job()) {
  return createImageRemarkCandidate({
    jobId: sourceJob.jobId,
    listingContentHash: sourceJob.outputs[0].contentHash,
    asins: [asin],
    listingByAsin: { [asin]: { status: 'ready', galleryImages: [url] } },
    remarksByAsin: { [asin]: [note] },
    outcomesByAsin: { [asin]: [{ status: 'ready', reason: '图片备注已就绪' }] },
  });
}

test('job candidate survives an unrelated global gallery overwrite and projects exact URL/index', () => {
  const sourceJob = job();
  const safe = validateImageRemarkCandidate(candidate(sourceJob), { job: sourceJob, asins: [asin] });
  const projected = projectStageOutput('image_remarks', [asin], {
    ...sourceJob.scope,
    imageRemarksData: safe,
    readExport: () => ({ [asin]: [{ remark: 'other job', imageUrl: otherUrl }] }),
  });
  assert.equal(projected.data.remarksByAsin[asin][0].imageUrl, url);
  assert.equal(projected.data.remarksByAsin[asin][0].remark, 'Owned image');
  assert.doesNotThrow(() => validatePersistedImageStageOutput(sourceJob, projected));
});

test('candidate rejects altered body, wrong image URL, wrong job and changed listing', () => {
  const sourceJob = job();
  const valid = candidate(sourceJob);
  assert.throws(() => validateImageRemarkCandidate({ ...valid, jobId: 'job-b' }, { job: sourceJob, asins: [asin] }), /job/i);
  assert.throws(() => validateImageRemarkCandidate({ ...valid, remarksByAsin: { [asin]: [{ ...note, remark: 'tampered' }] } }, { job: sourceJob, asins: [asin] }), /hash/i);
  assert.throws(() => createImageRemarkCandidate({
    jobId: sourceJob.jobId, listingContentHash: sourceJob.outputs[0].contentHash,
    asins: [asin], listingByAsin: { [asin]: { status: 'ready', galleryImages: [url] } },
    remarksByAsin: { [asin]: [{ ...note, imageUrl: otherUrl }] }, outcomesByAsin: {},
  }), /URL/i);
  sourceJob.outputs[0].data.contentByAsin[asin].galleryImages[0] = otherUrl;
  assert.throws(() => validateImageRemarkCandidate(valid, { job: sourceJob, asins: [asin] }), /hash/i);
});

test('candidate file is read back only with the matching job and canonical hash', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'image-candidate-test-'));
  try {
    const file = path.join(directory, 'candidate.json');
    const sourceJob = job();
    writeImageRemarkCandidate(file, candidate(sourceJob));
    assert.equal(readImageRemarkCandidate(file, { job: sourceJob, asins: [asin] }).remarksByAsin[asin][0].imageUrl, url);
    assert.match(readFileSync(file, 'utf8'), /owned\.jpg/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('candidate readiness and failure causes derive from its own slots', () => {
  const listingByAsin = { [asin]: { status: 'ready', galleryImages: [url] } };
  const ready = validateImageRemarkCandidate(candidate(), { job: job(), asins: [asin] });
  assert.deepEqual(imageCandidateReadiness(ready, listingByAsin, [asin]).missingAsins, []);
  assert.deepEqual(imageCandidateResultStatuses(ready, listingByAsin, [asin]), { [asin]: 'ready' });
  const failed = {
    remarksByAsin: { [asin]: [null] },
    outcomesByAsin: { [asin]: [{ status: 'connector-failed' }] },
  };
  assert.deepEqual(imageCandidateReadiness(failed, listingByAsin, [asin]).missingAsins, [asin]);
  assert.deepEqual(imageCandidateResultStatuses(failed, listingByAsin, [asin]), { [asin]: 'connector-failed' });
  const unsettledRefresh = {
    remarksByAsin: { [asin]: [note] },
    outcomesByAsin: { [asin]: [null] },
  };
  assert.deepEqual(imageCandidateResultStatuses(unsettledRefresh, listingByAsin, [asin]), { [asin]: 'upstream-empty' });
});

test('partial image refresh retains an untouched sibling only from validated job output', () => {
  const secondAsin = 'B000000002';
  const secondUrl = 'https://images.test/second.jpg';
  const sourceJob = job();
  sourceJob.asins.push(secondAsin);
  sourceJob.outputs[0] = projectStageOutput('listing', sourceJob.asins, {
    ...sourceJob.scope,
    readExport: () => ({
      [asin]: { status: 'ready', galleryImages: [url] },
      [secondAsin]: { status: 'ready', galleryImages: [secondUrl] },
    }),
  });
  const previous = projectStageOutput('image_remarks', [asin], {
    ...sourceJob.scope,
    imageRemarksData: {
      remarksByAsin: { [asin]: [note] },
      outcomesByAsin: { [asin]: [{ status: 'ready' }] },
    },
  });
  const nextData = {
    remarksByAsin: { [secondAsin]: [{ remark: 'Second image', imageUrl: secondUrl }] },
    outcomesByAsin: { [secondAsin]: [{ status: 'ready' }] },
  };
  const merged = mergeImageRemarkStageData(sourceJob, previous, [secondAsin], nextData);
  const saved = projectStageOutput('image_remarks', sourceJob.asins, {
    ...sourceJob.scope, imageRemarksData: merged,
    readExport: () => { throw new Error('global notes must not be read'); },
  });
  assert.deepEqual(Object.keys(saved.data.remarksByAsin).sort(), sourceJob.asins);
  assert.equal(saved.data.remarksByAsin[asin][0].imageUrl, url);
  assert.equal(saved.data.remarksByAsin[secondAsin][0].imageUrl, secondUrl);
  assert.doesNotThrow(() => validatePersistedImageStageOutput(sourceJob, saved));
  const altered = projectStageOutput('image_remarks', [asin], {
    ...sourceJob.scope,
    imageRemarksData: {
      remarksByAsin: { [asin]: [{ ...note, imageUrl: otherUrl }] },
      outcomesByAsin: { [asin]: [{ status: 'ready' }] },
    },
  });
  assert.throws(() => mergeImageRemarkStageData(sourceJob, altered, [secondAsin], nextData), /URL/i);
});

import { listingInputFromPersistedJob } from '../../scripts/lib/image-remark-listing-input.mjs';
test('ambiguous duplicated image URL identities are fatal before provider dispatch',()=>{
  const sourceJob=job();
  sourceJob.outputs=[projectStageOutput('listing',[asin],{...sourceJob.scope,readExport:()=>({[asin]:{status:'ready',galleryImages:[url,url]}})})];
  assert.throws(()=>listingInputFromPersistedJob(sourceJob,[asin]),/identity/);
});

test('frozen stage projection retains safe diagnostics from cache and removes secret fields',()=>{
  const diagnostic={stage:'http-response',httpStatus:403,errorClass:'http'};
  const result=projectStageOutput('image_remarks',[asin],{organizationId:'org',projectId:'project',runId:'run',readExport:(file,name)=>name==='listingImageRemarksMeta'?{imageOutcomesByAsin:{[asin]:[{status:'connector-failed',diagnostic:{...diagnostic,token:'secret'},body:'secret'}]}}:{[asin]:[null]}});
  assert.deepEqual(result.data.outcomesByAsin[asin][0].diagnostic,diagnostic);
  assert.equal(JSON.stringify(result).includes('secret'),false);
});
