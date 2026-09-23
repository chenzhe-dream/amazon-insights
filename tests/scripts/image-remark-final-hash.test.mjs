import assert from 'node:assert/strict';
import test from 'node:test';
import { projectFinalStageHashes } from '../../scripts/run-asin-sync-job.mjs';
import { projectStageOutput } from '../../scripts/lib/sync-stage-output.mjs';

const asin = 'B000000001';
const url = 'https://images.test/job.jpg';
const scope = { organizationId: 'org', projectId: 'project', runId: 'run' };

function fixture(remarkUrl = url) {
  const listing = projectStageOutput('listing', [asin], {
    ...scope, readExport: () => ({ [asin]: { status: 'ready', galleryImages: [url] } }),
  });
  const image = projectStageOutput('image_remarks', [asin], {
    ...scope,
    imageRemarksData: {
      remarksByAsin: { [asin]: [{ remark: 'Image', imageUrl: remarkUrl }] },
      outcomesByAsin: { [asin]: [{ status: 'ready' }] },
    },
  });
  return {
    jobId: 'job-a', jobVersion: 1, asins: [asin], scope,
    stages: [{ id: 'listing', status: 'done' }, { id: 'image_remarks', status: 'done' }],
    outputs: [listing, image],
  };
}

test('final image hash rechecks saved image data against job listing without shared file replay', () => {
  const job = fixture();
  let imageReplay = 0;
  const hashes = projectFinalStageHashes(job.jobId, job, (stage, asins, options) => {
    if (stage === 'image_remarks') {
      imageReplay += 1;
      throw new Error('shared image file must not be replayed');
    }
    return projectStageOutput(stage, asins, {
      ...options, readExport: () => ({ [asin]: { status: 'ready', galleryImages: [url] } }),
    });
  });
  assert.equal(imageReplay, 0);
  assert.equal(hashes.image_remarks, job.outputs[1].contentHash);
});

test('final image hash rejects a correctly hashed remark attached to another URL', () => {
  const job = fixture('https://images.test/other.jpg');
  assert.throws(() => projectFinalStageHashes(job.jobId, job, (stage, asins, options) =>
    stage === 'image_remarks'
      ? job.outputs[1]
      : projectStageOutput(stage, asins, {
        ...options, readExport: () => ({ [asin]: { status: 'ready', galleryImages: [url] } }),
      })), /image|URL/i);
});

test('final image hash rejects an extra remark index even when its stage hash matches', () => {
  const job = fixture();
  job.outputs[1] = projectStageOutput('image_remarks', [asin], {
    ...scope, imageRemarksData: {
      remarksByAsin: { [asin]: [
        { remark: 'Image', imageUrl: url },
        { remark: 'Extra', imageUrl: 'https://images.test/extra.jpg' },
      ] },
      outcomesByAsin: { [asin]: [{ status: 'ready' }, { status: 'ready' }] },
    },
  });
  assert.throws(() => projectFinalStageHashes(job.jobId, job, (stage, asins, options) =>
    stage === 'image_remarks' ? job.outputs[1] : projectStageOutput(stage, asins, {
      ...options, readExport: () => ({ [asin]: { status: 'ready', galleryImages: [url] } }),
    })), /image|index/i);
});

test('final image hash rejects an empty projection for an ASIN marked ready', () => {
  const job = fixture();
  job.asinProgress = { [asin]: { image_remarks: { status: 'ready' } } };
  job.outputs[1] = projectStageOutput('image_remarks', [asin], {
    ...scope, imageRemarksData: { remarksByAsin: {}, outcomesByAsin: {} },
  });
  assert.throws(() => projectFinalStageHashes(job.jobId, job, (stage, asins, options) =>
    stage === 'image_remarks' ? job.outputs[1] : projectStageOutput(stage, asins, {
      ...options, readExport: () => ({ [asin]: { status: 'ready', galleryImages: [url] } }),
    })), /image/i);
});
