import { readCachedDataExport } from "../../scripts/lib/sync-cache.mjs";
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

function copyInstrumentedCollector(fixture) {
  const source = fs.readFileSync(path.join(sourceRoot, 'scripts/build-listing-image-remarks.mjs'), 'utf8');
  // Fixture-only closed instrumentation. Production fatal handling remains untouched.
  const instrumented = source.replace('main().catch(() => {', `main().catch(error => {
    const cause = error?.message === "Unable to establish Windows interprocess lock owner identity"
      ? "windows-lock-owner-identity-unavailable" : "other-integrity-error";
    console.error("TEST_IMAGE_INTEGRITY_CAUSE " + cause);`);
  fs.writeFileSync(path.join(fixture, 'scripts/build-listing-image-remarks.mjs'), instrumented);
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
  copyInstrumentedCollector(fixture);
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
  copyInstrumentedCollector(fixture);
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

import { finalizeProcessedStageCohort, finalizeRepairCachedStages, imageRemarkScheduling } from '../../scripts/run-asin-sync-job.mjs';
import { imageCandidateReadiness, imageCandidateResultStatuses } from '../../scripts/lib/image-remark-job-candidate.mjs';
test('fresh repair captures ten cached families, keeps nontransient failure, and retries one transient missing image',async t=>{
  const fixture=fs.mkdtempSync(path.join(sourceRoot,'.tmp-image-fresh-capture-'));t.after(()=>fs.rmSync(fixture,{recursive:true,force:true}));
  fs.mkdirSync(path.join(fixture,'scripts'));fs.mkdirSync(path.join(fixture,'app'));copyInstrumentedCollector(fixture);
  fs.cpSync(path.join(sourceRoot,'scripts/lib'),path.join(fixture,'scripts/lib'),{recursive:true});
  const asins=Array.from({length:10},(_,i)=>`B00000000${i}`);const target=asins[9];
  const galleries=Object.fromEntries(asins.map(a=>[a,Array.from({length:6},(_,i)=>`https://images.test/${a}/${i}`)]));
  for(const a of asins.slice(0,5))galleries[a].push(`https://images.test/${a}/PKplay-button-video`);
  const listing=Object.fromEntries(asins.map(a=>[a,{status:'ready',galleryImages:a===target?[...galleries[a]].reverse():galleries[a]}]));
  const notes=Object.fromEntries(asins.map(a=>[a,galleries[a].map((url,i)=>a===target&&[1,4].includes(i)?null:{remark:`saved ${url}`,imageUrl:url,image_types:[],confidence:'high'})]));
  const outcomes=Object.fromEntries(asins.map(a=>[a,galleries[a].map((url,i)=>url.includes('PKplay-button')?null:notes[a][i]?{status:'ready'}:{status:'connector-failed',attemptJobId:'previous-job'})]));
  fs.writeFileSync(path.join(fixture,'app/competitor-data.ts'),'export const refreshedCatalog = [];');
  fs.writeFileSync(path.join(fixture,'app/listing-image-remarks.ts'),`export const listingImageRemarksMeta = ${JSON.stringify({imageUrlsByAsin:galleries,imageOutcomesByAsin:outcomes})};\nexport const listingImageRemarks = ${JSON.stringify(notes)};`);
  const requests=[];let retry=false;
  const server=createServer(async(req,res)=>{let body='';for await(const b of req)body+=b;const url=JSON.parse(body).messages[0].content[1].image_url.url;requests.push(url);res.setHeader('Content-Type','application/json');const remark=url===galleries[target][1]&&!retry?'':`new ${url}`;res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({remark,image_types:[],confidence:'high'})}}]}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
  const scope={organizationId:'org',projectId:'project',runId:'fresh-run'};
  const job={jobId:'fresh-capture-job',asins,scope,stages:[{id:'image_remarks',status:'pending',repairAsins:[target]}],asinProgress:Object.fromEntries(asins.map(a=>[a,{image_remarks:{status:'pending'},traffic:{status:'ready'}}])),outputs:[projectStageOutput('listing',asins,{...scope,readExport:()=>listing})]};
  async function collect(job,extraEnv={}) {
    const schedule=imageRemarkScheduling(job,job,asins);assert.equal(schedule.shouldRun,true);
    const listingFile=path.join(fixture,`${job.jobId}-listing.json`);const candidateFile=path.join(fixture,`${job.jobId}-candidate.json`);fs.writeFileSync(listingFile,JSON.stringify({jobId:job.jobId,job}));
    const child=spawn(process.execPath,[path.join(fixture,'scripts/build-listing-image-remarks.mjs')],{cwd:fixture,env:{...process.env,AGENT_FORMAL_WORKTREE_ROOT:'',AGENT_CHILD_RESOURCE_GOVERNOR_REQUIRED:'0',AGENT_SYNC_JOB_ID:job.jobId,AGENT_SYNC_LISTING_STAGE_FILE:listingFile,AGENT_SYNC_LISTING_STAGE_HASH:job.outputs[0].contentHash,AGENT_SYNC_IMAGE_CANDIDATE_FILE:candidateFile,REMARK_ASINS:schedule.analysisAsins.join(','),AGENT_SYNC_IMAGE_CAPTURE_ASINS:schedule.captureAsins.join(','),OPENAI_API_KEY:'fixture-key',OPENAI_BASE_URL:`http://127.0.0.1:${server.address().port}`,...extraEnv},stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);const [code]=await once(child,'close');return {code,log,candidateFile};
  }
  const first=await collect(job);assert.equal(first.code,1,first.log);
  const candidate=readImageRemarkCandidate(first.candidateFile,{job,asins});
  assert.equal(requests.length,2);assert.deepEqual(requests.sort(),[galleries[target][1],galleries[target][4]].sort());
  const current=structuredClone(job);let committed;
  finalizeProcessedStageCohort(job.jobId,'image_remarks',asins,asins,{initialJob:job,commandSucceeded:false,imageRemarksData:candidate,resultStatusesByAsin:imageCandidateResultStatuses(candidate,listing,asins),readReadiness:(_s,cohort)=>imageCandidateReadiness(candidate,listing,cohort),readJob:()=>current,markModule:(_j,a,_s,patch)=>{current.asinProgress[a].image_remarks=patch;},commitStage:(_j,input)=>{committed=input.output;current.outputs.push(committed);},projectOutput:(stage,cohort,options)=>projectStageOutput(stage,cohort,{...options,...scope,readExport:()=>{throw Error('global projection forbidden');}})});
  assert.equal(Object.keys(committed.data.remarksByAsin).length,10);
  assert.equal(Object.values(committed.data.outcomesByAsin).flat().filter(o=>o?.status==='ready').length,59);
  assert.equal(Object.values(committed.data.remarksByAsin).flat().filter(Boolean).length,64);
  assert.equal(committed.gap.items.find(item=>item.asin===target).causeCode,'CONNECTOR_FAILED');
  assert.deepEqual(committed.data.outcomesByAsin[target][4].diagnostic,{stage:'response-output',httpStatus:200,errorClass:'invalid-output'});
  for(const a of asins.slice(0,9)){assert.equal(current.asinProgress[a].image_remarks.status,'ready');assert.deepEqual(committed.data.remarksByAsin[a],notes[a]);}
  assert.doesNotThrow(()=>validatePersistedImageStageOutput(current,committed));
  const next=structuredClone(job);next.jobId='fresh-nontransient-job';
  const second=await collect(next);
  assert.equal(second.code,1,second.log);assert.equal(requests.length,2);
  const retained=readImageRemarkCandidate(second.candidateFile,{job:next,asins});
  assert.deepEqual(retained.outcomesByAsin[target][4].diagnostic,{stage:'response-output',httpStatus:200,errorClass:'invalid-output'});
  const cacheFile=path.join(fixture,'app/listing-image-remarks.ts');
  const cacheNotes=readCachedDataExport(cacheFile,'listingImageRemarks');const cacheMeta=readCachedDataExport(cacheFile,'listingImageRemarksMeta');
  cacheMeta.imageOutcomesByAsin[target][4]={status:'connector-failed',attemptJobId:'fresh-capture-job',diagnostic:{stage:'fetch',httpStatus:null,errorClass:'network'}};
  fs.writeFileSync(cacheFile,`export const listingImageRemarksMeta = ${JSON.stringify(cacheMeta)};\nexport const listingImageRemarks = ${JSON.stringify(cacheNotes)};`);
  retry=true;const transient=structuredClone(job);transient.jobId='fresh-transient-job';
  const third=await collect(transient);assert.equal(third.code,0,third.log);
  assert.deepEqual(requests.slice(2),[galleries[target][1]]);
  const captured=readImageRemarkCandidate(third.candidateFile,{job:transient,asins});
  assert.equal(Object.keys(captured.remarksByAsin).length,10);
  for(const a of asins.slice(0,9))assert.deepEqual(captured.remarksByAsin[a],notes[a]);
  const explicit=structuredClone(job);explicit.jobId='fresh-explicit-job';
  const fourth=await collect(explicit,{AGENT_SYNC_IMAGE_ACTION:'analyze'});assert.equal(fourth.code,0,fourth.log);
  assert.equal(requests.slice(3).length,6);assert.equal(requests.slice(3).every(url=>galleries[target].includes(url)),true);
  const zero=structuredClone(job);zero.jobId='fresh-zero-dispatch-job';zero.outputs=[projectStageOutput('listing',asins,{...scope,stageStatus:'partial',dataAsins:asins.slice(0,9),readExport:()=>listing})];
  zero.stages=[{id:'image_remarks',status:'pending',repairAsins:[target],imageAction:'refresh'}];
  for(const a of asins)zero.asinProgress[a].traffic={status:'ready'};
  zero.asinProgress[target].listing={status:'connector-failed'};zero.asinProgress[target].image_remarks.status='connector-failed';
  zero.outputs.push(projectStageOutput('image_remarks',asins,{...scope,stageStatus:'partial',dataAsins:[],imageRemarksData:{remarksByAsin:{},outcomesByAsin:{}}}));
  const zeroPlan=imageRemarkScheduling(zero,zero,asins);assert.equal(zeroPlan.shouldRun,true);assert.deepEqual(zeroPlan.analysisAsins,[]);
  const before=requests.length;
  const fifth=await collect(zero,{REMARK_ASINS:zeroPlan.analysisAsins.join(','),AGENT_SYNC_IMAGE_CAPTURE_ASINS:zeroPlan.captureAsins.join(',')});assert.equal(fifth.code,0,fifth.log);assert.equal(requests.length,before);
  const zeroData=readImageRemarkCandidate(fifth.candidateFile,{job:zero,asins:asins.slice(0,9)});
  const zeroCurrent=structuredClone(zero);let zeroOutput;
  finalizeProcessedStageCohort(zero.jobId,'image_remarks',asins,asins,{initialJob:zero,commandSucceeded:false,imageRemarksData:zeroData,resultStatusesByAsin:{[target]:'connector-failed'},readJob:()=>zeroCurrent,markModule:(_j,a,_s,patch)=>{zeroCurrent.asinProgress[a].image_remarks=patch;},commitStage:(_j,input)=>{zeroOutput=input.output;},projectOutput:(stage,cohort,options)=>projectStageOutput(stage,cohort,{...options,...scope,readExport:()=>{throw Error('global projection forbidden');}})});
  assert.equal(zeroCurrent.asinProgress[target].image_remarks.status,'connector-failed');assert.equal(zeroOutput.gap.items.find(i=>i.asin===target).causeCode,'CONNECTOR_FAILED');
  assert.equal(Object.values(zeroOutput.data.outcomesByAsin).flat().filter(o=>o?.status==='ready').length,54);
  for(const a of asins.slice(0,9))assert.equal(zeroCurrent.asinProgress[a].image_remarks.status,'ready');
  const refresh=structuredClone(job);refresh.jobId='fresh-refresh-job';
  const countBeforeRefresh=requests.length;const refreshResult=await collect(refresh,{AGENT_SYNC_IMAGE_ACTION:'refresh'});assert.equal(refreshResult.code,0,refreshResult.log);
  assert.equal(requests.slice(countBeforeRefresh).length,6);assert.equal(requests.slice(countBeforeRefresh).every(url=>galleries[target].includes(url)),true);
  const cachedOnly=structuredClone(job);cachedOnly.jobId='fresh-cached-only-job';cachedOnly.stages=[{id:'image_remarks',status:'partial',repairAsins:[]}];
  for(const a of asins)cachedOnly.asinProgress[a].traffic={status:'ready'};
  finalizeRepairCachedStages(cachedOnly.jobId,cachedOnly,()=>{throw Error('cached image must defer until capture');});
  const cachedPlan=imageRemarkScheduling(cachedOnly,cachedOnly,asins);assert.equal(cachedPlan.shouldRun,true);assert.deepEqual(cachedPlan.analysisAsins,[]);
  const beforeCached=requests.length;const cachedResult=await collect(cachedOnly,{REMARK_ASINS:cachedPlan.analysisAsins.join(','),AGENT_SYNC_IMAGE_CAPTURE_ASINS:cachedPlan.captureAsins.join(',')});assert.equal(cachedResult.code,0,cachedResult.log);assert.equal(requests.length,beforeCached);
  const fullCached=readImageRemarkCandidate(cachedResult.candidateFile,{job:cachedOnly,asins});const cachedCurrent=structuredClone(cachedOnly);let cachedOutput;
  finalizeProcessedStageCohort(cachedOnly.jobId,'image_remarks',asins,asins,{initialJob:cachedOnly,imageRemarksData:fullCached,readJob:()=>cachedCurrent,markModule:(_j,a,_s,patch)=>{cachedCurrent.asinProgress[a].image_remarks=patch;},commitStage:(_j,input)=>{cachedOutput=input.output;cachedCurrent.outputs.push(cachedOutput);},projectOutput:(stage,cohort,options)=>projectStageOutput(stage,cohort,{...options,...scope,readExport:()=>{throw Error('global projection forbidden');}})});
  assert.equal(cachedOutput.stageStatus,'done');assert.equal(Object.keys(cachedOutput.data.remarksByAsin).length,10);assert.equal(cachedOutput.gap,undefined);assert.equal(Object.values(cachedOutput.data.outcomesByAsin).flat().filter(o=>o?.status==='ready').length,60);assert.doesNotThrow(()=>validatePersistedImageStageOutput(cachedCurrent,cachedOutput));
  assert.equal(imageRemarkScheduling(cachedOnly,cachedCurrent,asins).shouldRun,false);
  const beforeRejections=requests.length;
  for(const invalidEnv of [
    {REMARK_ASINS:target,AGENT_SYNC_IMAGE_CAPTURE_ASINS:asins.slice(0,9).join(',')},
    {AGENT_SYNC_LISTING_STAGE_HASH:'0'.repeat(64)},
    {AGENT_SYNC_IMAGE_CANDIDATE_FILE:''},
  ]) {const rejected=await collect(job,invalidEnv);assert.equal(rejected.code,1);assert.match(rejected.log,/integrity-failed/);assert.equal(requests.length,beforeRejections);}
  const capturedOnlyMeta=readCachedDataExport(cacheFile,'listingImageRemarksMeta');const capturedOnlyNotes=readCachedDataExport(cacheFile,'listingImageRemarks');
  capturedOnlyMeta.imageOutcomesByAsin[asins[0]][0]={status:'connector-failed',attemptJobId:'preserved-attempt',diagnostic:{stage:'http-response',httpStatus:403,errorClass:'http'}};
  fs.writeFileSync(cacheFile,`export const listingImageRemarksMeta = ${JSON.stringify(capturedOnlyMeta)};\nexport const listingImageRemarks = ${JSON.stringify(capturedOnlyNotes)};`);
  const cacheBeforeCapture=fs.readFileSync(cacheFile,'utf8');const onlyCapture=structuredClone(zero);onlyCapture.jobId='capture-only-failure-job';
  const sixth=await collect(onlyCapture,{REMARK_ASINS:'',AGENT_SYNC_IMAGE_CAPTURE_ASINS:asins.slice(0,9).join(',')});assert.equal(sixth.code,1,sixth.log);assert.equal(requests.length,beforeRejections);
  const failureCapture=readImageRemarkCandidate(sixth.candidateFile,{job:onlyCapture,asins:asins.slice(0,9)});
  assert.equal(failureCapture.outcomesByAsin[asins[0]][0].attemptJobId,'preserved-attempt');assert.deepEqual(failureCapture.outcomesByAsin[asins[0]][0].diagnostic,{stage:'http-response',httpStatus:403,errorClass:'http'});
  assert.equal(fs.readFileSync(cacheFile,'utf8'),cacheBeforeCapture);

});
