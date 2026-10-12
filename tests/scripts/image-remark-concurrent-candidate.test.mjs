import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';

import { readImageRemarkCandidate, validatePersistedImageStageOutput } from '../../scripts/lib/image-remark-job-candidate.mjs';
import { projectStageOutput } from '../../scripts/lib/sync-stage-output.mjs';

const sourceRoot = path.resolve(import.meta.dirname, '../..');
const asin = 'B000000001';
const urls = {
  'job-a': 'https://images.test/job-a.jpg',
  'job-b': 'https://images.test/job-b.jpg',
};

function makeJob(jobId) {
  const scope = { organizationId: 'org', projectId: 'project', runId: `run-${jobId}` };
  return {
    jobId, asins: [asin], scope,
    outputs: [projectStageOutput('listing', [asin], {
      ...scope, readExport: () => ({ [asin]: { status: 'ready', galleryImages: [urls[jobId]] } }),
    })],
  };
}

function runBuilder(fixture, job, endpoint) {
  const listingFile = path.join(fixture, `${job.jobId}-listing.json`);
  const candidateFile = path.join(fixture, `${job.jobId}-candidate.json`);
  fs.writeFileSync(listingFile, JSON.stringify({ jobId: job.jobId, job }));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(fixture, 'scripts/build-listing-image-remarks.mjs')], {
      cwd: fixture,
      env: {
        ...process.env,
        AGENT_FORMAL_WORKTREE_ROOT: '',
        AGENT_CHILD_RESOURCE_GOVERNOR_REQUIRED: '0',
        AGENT_SYNC_JOB_ID: job.jobId,
        AGENT_SYNC_LISTING_STAGE_FILE: listingFile,
        AGENT_SYNC_LISTING_STAGE_HASH: job.outputs[0].contentHash,
        AGENT_SYNC_IMAGE_CANDIDATE_FILE: candidateFile,
        REMARK_ASINS: asin,
        OPENAI_API_KEY: 'fixture-key',
        OPENAI_BASE_URL: endpoint,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, output, candidateFile }));
  });
}

test('two jobs for one ASIN keep separate candidate remarks after shared file races', async t => {
  const fixture = fs.mkdtempSync(path.join(sourceRoot, '.tmp-image-concurrent-candidate-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fixture, 'scripts'));
  fs.mkdirSync(path.join(fixture, 'app'));
  fs.copyFileSync(path.join(sourceRoot, 'scripts/build-listing-image-remarks.mjs'), path.join(fixture, 'scripts/build-listing-image-remarks.mjs'));
  fs.cpSync(path.join(sourceRoot, 'scripts/lib'), path.join(fixture, 'scripts/lib'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'app/competitor-data.ts'), 'export const refreshedCatalog = [];\n');
  fs.writeFileSync(path.join(fixture, 'app/sorftime-listing-content-data.ts'),
    `export const sorftimeListingContentData = ${JSON.stringify({ [asin]: { status: 'ready', galleryImages: [urls['job-b']] } })};\n`);
  fs.writeFileSync(path.join(fixture, 'app/listing-image-remarks.ts'),
    'export const listingImageRemarksMeta = {};\nexport const listingImageRemarks = {};\n');

  const requests = [];
  const provider = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const requested = JSON.parse(Buffer.concat(chunks).toString()).messages[0].content[1].image_url.url;
    requests.push(requested);
    if (requested === urls['job-a']) await new Promise(resolve => setTimeout(resolve, 250));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      remark: requested.includes('job-a') ? 'Job A' : 'Job B',
      image_types: ['产品展示'], confidence: 'high',
    }) } }] }));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  t.after(() => provider.close());
  const endpoint = `http://127.0.0.1:${provider.address().port}`;
  const jobA = makeJob('job-a');
  const jobB = makeJob('job-b');
  const [resultA, resultB] = await Promise.all([
    runBuilder(fixture, jobA, endpoint), runBuilder(fixture, jobB, endpoint),
  ]);
  assert.equal(resultA.code, 0, resultA.output);
  assert.equal(resultB.code, 0, resultB.output);
  assert.deepEqual(requests.sort(), Object.values(urls).sort());

  for (const [job, result] of [[jobA, resultA], [jobB, resultB]]) {
    const data = readImageRemarkCandidate(result.candidateFile, { job, asins: [asin] });
    const projected = projectStageOutput('image_remarks', [asin], {
      ...job.scope, imageRemarksData: data,
      readExport: () => { throw new Error('shared file projection'); },
    });
    assert.equal(projected.data.remarksByAsin[asin][0].imageUrl, urls[job.jobId]);
    assert.equal(projected.data.remarksByAsin[asin][0].remark, job.jobId === 'job-a' ? 'Job A' : 'Job B');
    assert.doesNotThrow(() => validatePersistedImageStageOutput(job, projected));
  }
});

test('collector retries two URL identities and preserves all 58 ready notes after gallery reorder', async t => {
  const fixture = fs.mkdtempSync(path.join(sourceRoot, '.tmp-image-targeted-'));
  t.after(() => fs.rmSync(fixture, { recursive:true,force:true }));
  fs.mkdirSync(path.join(fixture,'scripts'));fs.mkdirSync(path.join(fixture,'app'));
  fs.copyFileSync(path.join(sourceRoot,'scripts/build-listing-image-remarks.mjs'),path.join(fixture,'scripts/build-listing-image-remarks.mjs'));
  fs.cpSync(path.join(sourceRoot,'scripts/lib'),path.join(fixture,'scripts/lib'),{recursive:true});
  const asins=Array.from({length:10},(_,i)=>`B00000000${i}`);
  const galleries=Object.fromEntries(asins.map(a=>[a,Array.from({length:6},(_,i)=>`https://images.test/${a}/${i}`)]));
  const remarks=Object.fromEntries(asins.map(a=>[a,galleries[a].map((url,i)=>a===asins[9]&&[1,4].includes(i)?null:{remark:`saved ${url}`,imageUrl:url,image_types:[],confidence:'high'})]));
  const outcomes=Object.fromEntries(asins.map(a=>[a,galleries[a].map((url,i)=>remarks[a][i]?{status:'ready'}:{status:'connector-failed',attemptJobId:'old',diagnostic:{stage:'http-response',httpStatus:429,errorClass:'http'}})]));
  const listing=Object.fromEntries(asins.map(a=>[a,{status:'ready',galleryImages:a===asins[9]?[...galleries[a]].reverse():galleries[a]}]));
  const scope={organizationId:'org',projectId:'project',runId:'run'};
  const job={jobId:'targeted-job',asins,scope,outputs:[projectStageOutput('listing',asins,{...scope,readExport:()=>listing})]};
  fs.writeFileSync(path.join(fixture,'app/competitor-data.ts'),'export const refreshedCatalog = [];');
  fs.writeFileSync(path.join(fixture,'app/listing-image-remarks.ts'),`export const listingImageRemarksMeta = ${JSON.stringify({imageUrlsByAsin:galleries,imageOutcomesByAsin:outcomes})};\nexport const listingImageRemarks = ${JSON.stringify(remarks)};`);
  const listingFile=path.join(fixture,'listing.json');const candidateFile=path.join(fixture,'candidate.json');
  fs.writeFileSync(listingFile,JSON.stringify({jobId:job.jobId,job}));
  const requests=[];
  const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const payload=JSON.parse(body);const url=payload.messages[0].content[1].image_url.url;requests.push(url);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({remark:`new ${url}`,image_types:[],confidence:'high'})}}]}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
  const child=spawn(process.execPath,[path.join(fixture,'scripts/build-listing-image-remarks.mjs')],{cwd:fixture,env:{...process.env,AGENT_FORMAL_WORKTREE_ROOT:'',AGENT_CHILD_RESOURCE_GOVERNOR_REQUIRED:'0',AGENT_SYNC_JOB_ID:job.jobId,AGENT_SYNC_LISTING_STAGE_FILE:listingFile,AGENT_SYNC_LISTING_STAGE_HASH:job.outputs[0].contentHash,AGENT_SYNC_IMAGE_CANDIDATE_FILE:candidateFile,REMARK_ASINS:asins.join(','),OPENAI_API_KEY:'fixture-key',OPENAI_BASE_URL:`http://127.0.0.1:${server.address().port}`},stdio:['ignore','pipe','pipe']});
  let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);const [code]=await once(child,'close');assert.equal(code,0,log);
  const candidate=JSON.parse(fs.readFileSync(candidateFile,'utf8'));
  assert.equal(requests.length,2);
  assert.deepEqual(requests.sort(),[galleries[asins[9]][1],galleries[asins[9]][4]].sort());
  let preserved=0;
  for(const a of asins) for(const note of candidate.remarksByAsin[a]) {
    assert.equal(listing[a].galleryImages.includes(note.imageUrl),true);
    if(note.remark.startsWith('saved ')){preserved++;assert.equal(note.remark,`saved ${note.imageUrl}`);}
  }
  assert.equal(preserved,58);
  assert.equal(candidate.outcomesByAsin[asins[9]].every(outcome=>outcome.status==='ready'),true);
});
