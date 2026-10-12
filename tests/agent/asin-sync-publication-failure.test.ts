import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AsinSyncFunnel, type SyncJob } from '../../app/asin-sync-funnel';

function renderJob(status: string) {
  const job: SyncJob = {jobId:'job',status,message:'Candidate would lose verified data: price provenance',currentStageId:'build',stages:[],asinProgress:{},
    publication:{status:'applied',artifactId:'b'.repeat(64),requestId:'a'.repeat(64),requestedAt:'2026-10-12T00:00:00.000Z',appliedAt:'2026-10-12T00:00:01.000Z'}};
  return renderToStaticMarkup(createElement(AsinSyncFunnel,{asins:['B000000001'],marketplace:'US',resumeJobId:'job',terminalJob:job}));
}

test('failed canonical job never claims report published from applied Web artifact',()=>{
  const html=renderJob('failed');
  assert.doesNotMatch(html,/\u6570\u636e\u5df2\u53d1\u5e03\u3002/);
  assert.match(html,/\u65b0\u62a5\u544a\u672a\u53d1\u5e03/);
  assert.match(html,/\u4fdd\u7559\u539f\u62a5\u544a/);
  assert.match(html,/Candidate would lose verified data/);
});
for(const status of ['completed','completed-with-gaps']) test(`successful canonical ${status} retains applied publication message`,()=>{
  assert.match(renderJob(status),/\u6570\u636e\u5df2\u53d1\u5e03\u3002/);
});
test('running canonical job cannot claim artifact-only report publication',()=>{
  assert.doesNotMatch(renderJob('running'),/\u6570\u636e\u5df2\u53d1\u5e03\u3002/);
});
