import assert from 'node:assert/strict';
import test from 'node:test';
import { projectStageOutput } from '../../scripts/lib/sync-stage-output.mjs';
import { validatePersistedImageStageOutput } from '../../scripts/lib/image-remark-job-candidate.mjs';
import { deriveFinalSyncJobStatus } from '../../scripts/lib/sync-job-store.mjs';
import * as runner from '../../scripts/run-asin-sync-job.mjs';

const asins = ['B000000001', 'B000000002'];
function jobWithGallery(gallery = false) {
  return { jobId: 'job', asins, scope: { organizationId: 'org', projectId: 'project', runId: 'run' },
    asinProgress: Object.fromEntries(asins.map(asin => [asin, { image_remarks: { status: 'pending' } }])),
    stages: [{ id: 'image_remarks', status: 'active' }],
    outputs: [projectStageOutput('listing', asins, { organizationId: 'org', projectId: 'project', runId: 'run',
      stageStatus: 'partial', readExport: () => gallery ? { [asins[0]]: { status: 'ready', galleryImages: ['https://example.test/image.jpg'] } } : {} })] };
}
for (const mixed of [false, true]) test(`${mixed ? 'mixed' : 'all missing'} galleries finalize persisted gaps without aborting the runner`, async () => {
  const job = jobWithGallery(mixed);
  let dispatches = 0;
  const result = await runner.runGalleryReadyImageProcess(job, asins, async readyAsins => {
    dispatches++;
    assert.deepEqual(readyAsins, [asins[0]]);
    return { succeeded: true };
  });
  assert.equal(dispatches, mixed ? 1 : 0);
  const data = { remarksByAsin: {}, outcomesByAsin: {} };
  if (mixed) {
    data.remarksByAsin[asins[0]] = [{ imageUrl: 'https://example.test/image.jpg', remark: 'A product image' }];
    data.outcomesByAsin[asins[0]] = [{ status: 'ready' }];
  }
  const { imageCandidateReadiness, imageCandidateResultStatuses } = await import('../../scripts/lib/image-remark-job-candidate.mjs');
  runner.applyPersistedStagePostcondition('job', 'image_remarks', asins, {
    commandSucceeded: result.process.succeeded, imageRemarksData: data,
    resultReasonsByAsin: Object.fromEntries(result.missingAsins.map(asin => [asin, 'IMAGE_GALLERY_UNAVAILABLE'])),
    readReadiness: (_stage, cohort) => imageCandidateReadiness(data, result.listingByAsin, cohort),
    resultStatusesByAsin: imageCandidateResultStatuses(data, result.listingByAsin, asins),
    readJob: () => job,
    markModule: (_id, asin, stage, value) => { job.asinProgress[asin][stage] = value; },
    commitStage: (_id, { output, stagePatch }) => { job.outputs.push(output); job.stages[0] = { id: 'image_remarks', ...stagePatch }; },
    projectOutput: (stage, scope, options) => projectStageOutput(stage, scope, { ...options, ...job.scope }),
  });
  const output = job.outputs.find(output => output.stage === 'image_remarks');
  validatePersistedImageStageOutput(job, output);
  assert.equal(output.stageStatus, 'partial');
  assert.equal(output.gap.items.length, mixed ? 1 : 2);
  assert.equal(job.asinProgress[asins[1]].image_remarks.status, 'upstream-empty');
  assert.equal(job.asinProgress[asins[1]].image_remarks.reason, 'IMAGE_GALLERY_UNAVAILABLE');
  assert.equal(deriveFinalSyncJobStatus(job.asinProgress), 'completed-with-gaps');
});

test('scope or hash corruption prevents image dispatch and finalization', async () => {
  for (const corrupt of [job => { job.outputs[0].projectId = 'other'; }, job => { job.outputs[0].contentHash = 'bad'; }]) {
    const job = jobWithGallery(); corrupt(job);
    await assert.rejects(() => runner.runGalleryReadyImageProcess(job, asins, () => assert.fail('must not dispatch')), /scope|hash/i);
  }
});
