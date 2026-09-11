import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { VocAutomationRecord } from '../../server/db/voc-automation-repository';
import type { CreateRunRequest } from '../../shared/agent-contracts';
import { VocAutomationService } from '../../server/services/voc-automation-service';
type FixtureRun = {run:{id:string;projectId:string;status:string;createdAt:string;updatedAt:string};stages:Array<{stage:string;status:string;lastError?:{code?:string;message?:string}}>;evidenceSelection:NonNullable<CreateRunRequest['evidenceSelection']>&{fingerprint:string}};
function fixture() {
 const organizationId=randomUUID(), projectId=randomUUID(), actorId=randomUUID(), baseSyncRunId=randomUUID();
 const asins=['B08Z36X6B4','B0BVFX154J','B01N6NL766'].sort();
 let record:VocAutomationRecord|null=null, count=2, keywords='ready', fingerprint='a'.repeat(64), creates=0;
 const runs=new Map<string,FixtureRun>();
 const repo={manualAlexaVoc:{listNormalizationStatuses:async():Promise<Array<{asin?:string;status:string}>>=>[]},transaction:async(fn:(r:unknown)=>Promise<unknown>):Promise<unknown>=>fn(repo),findUserById:async()=>({id:actorId,organizationId,status:'active'}),findProjectById:async()=>({id:projectId,organizationId,marketplace:'US',asins}),
 findAnalysisRun:async(id:string)=>id===baseSyncRunId?{id,projectId,idempotencyScope:`sync:${organizationId}:${projectId}`}:runs.get(id)?.run,
 listAnalysisRuns:async()=>[...runs.values()].map(r=>r.run),
 vocAutomations:{lock:async()=>{},get:async(org:string,id:string)=>org===organizationId&&id===projectId?record:null,save:async(r:VocAutomationRecord)=>{record={...r};},list:async()=>record?[record]:[]}};
 const lifecycle={getVocInputs:async()=>({manual:{fingerprint,selectedAsins:asins,keywords:{state:keywords},coverage:asins.map((asin,i)=>({asin,primary:i<count?'manual':'missing',manual:i<count?{}:null}))}}),
 getRun:async(id:string)=>runs.get(id),createRun:async(_p:string,input:CreateRunRequest)=>{creates++;const id=randomUUID();const r={run:{id,projectId,status:'queued',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()},stages:[{stage:'voc-positioning',status:'queued'},{stage:'product-definition',status:'waiting-input'}],evidenceSelection:{...input.evidenceSelection!,fingerprint}};runs.set(id,r);return r;}};
 const service=new VocAutomationService({repository:repo as never,lifecycleFactory:()=>lifecycle as never});
 return {service,repo,runs,scope:{organizationId,actorId,projectId},request:{baseSyncRunId,selectedAsins:asins},ready:()=>{count=3;},setKeywords:(v:string)=>{keywords=v;},change:()=>{fingerprint='b'.repeat(64);},created:()=>creates,record:()=>record!};
}
test('register incomplete manual inputs, then backend tick starts exactly once without browser',async()=>{
 const f=fixture();assert.equal((await f.service.register(f.scope,f.request)).state,'waiting-voc');assert.equal(f.created(),0);
 f.ready();f.setKeywords('missing');await f.service.tick();assert.equal(f.created(),0);assert.equal((await f.service.read(f.scope)).state,'waiting-keywords');
 f.setKeywords('ready');await f.service.tick();await f.service.tick();assert.equal(f.created(),1);assert.equal((await f.service.read(f.scope)).state,'queued');
});
test('failure is visible and repeated registration reuses it; explicit retry creates one new execution',async()=>{
 const f=fixture();f.ready();const first=await f.service.register(f.scope,f.request);const run=f.runs.get(first.runId!)!;run.run.status='waiting-input';run.stages[0]={stage:'voc-positioning',status:'failed',lastError:{code:'QUEUE_TIMEOUT',message:'VOC 处理超时'}};
 assert.equal((await f.service.read(f.scope)).state,'failed');await f.service.tick();await f.service.register(f.scope,f.request);assert.equal(f.created(),1);
 const retry={...f.request,retryKey:randomUUID()};const second=await f.service.register(f.scope,retry);assert.notEqual(second.runId,first.runId);await f.service.register(f.scope,retry);assert.equal(f.created(),2);
});
test('changed input waits active execution then creates new analysis; rejects retry while active',async()=>{
 const f=fixture();f.ready();const first=await f.service.register(f.scope,f.request);f.change();await f.service.tick();assert.equal(f.created(),1);
 await assert.rejects(f.service.register(f.scope,{...f.request,retryKey:randomUUID()}));
 const r=f.runs.get(first.runId!)!;r.run.status='succeeded';r.stages=[{stage:'voc-positioning',status:'succeeded'},{stage:'product-definition',status:'succeeded'}];await f.service.tick();assert.equal(f.created(),2);
});
test('read is side-effect free and tenant mismatch cannot register',async()=>{
 const f=fixture();f.ready();await assert.rejects(f.service.register({...f.scope,organizationId:randomUUID()},f.request));assert.equal(f.created(),0);
 await f.service.register(f.scope,f.request);f.change();await f.service.read(f.scope);assert.equal(f.created(),1);
});
test('changed input becomes waiting state on subsequent read, and retry identity does not leak to new inputs',async()=>{
 const f=fixture();f.ready();const first=await f.service.register(f.scope,f.request);const run=f.runs.get(first.runId!)!;run.run.status='waiting-input';run.stages[0]={stage:'voc-positioning',status:'failed'};
 await f.service.register(f.scope,{...f.request,retryKey:randomUUID()});const current=f.runs.get(f.record().runId!)!;current.run.status='succeeded';current.stages=[{stage:'product-definition',status:'succeeded'}];
 f.change();f.setKeywords('missing');await f.service.tick();assert.equal((await f.service.read(f.scope)).state,'waiting-keywords');assert.equal(f.record().retryKey,null);assert.equal(f.record().runId,null);
});
test('first import persists intent even if immediate creation fails, later backend tick recovers',async()=>{
 const f=fixture();f.ready();let fail=true;
 // A failure after registration must not remove the durable scope.
 const get=f.repo.listAnalysisRuns;f.repo.listAnalysisRuns=async()=>{if(fail)throw new Error('temporary read failure');return get();};
 await assert.rejects(f.service.afterImport(f.scope,f.request.baseSyncRunId));assert.ok(f.record());fail=false;await f.service.tick();assert.equal(f.created(),1);
});
test('pending normalization of new manual text blocks use of an older saved revision',async()=>{
 const f=fixture();f.ready();f.repo.manualAlexaVoc={listNormalizationStatuses:async()=>[{asin:f.request.selectedAsins[0],status:'pending'}]};
 const state=await f.service.register(f.scope,f.request);assert.equal(state.state,'waiting-voc');assert.equal(f.created(),0);
 f.repo.manualAlexaVoc.listNormalizationStatuses=async()=>[];await f.service.tick();assert.equal(f.created(),1);
});

test('retry keeps its target fingerprint while waiting for dependencies',async()=>{
 const f=fixture();f.ready();const first=await f.service.register(f.scope,f.request);const run=f.runs.get(first.runId!)!;run.run.status='waiting-input';run.stages[0]={stage:'voc-positioning',status:'failed'};
 f.repo.manualAlexaVoc.listNormalizationStatuses=async()=>[{status:'pending'}];await f.service.register(f.scope,{...f.request,retryKey:randomUUID()});assert.equal(f.record().fingerprint,'a'.repeat(64));
 f.change();f.repo.manualAlexaVoc.listNormalizationStatuses=async()=>[];await f.service.tick();assert.equal(f.record().retryKey,null);
});
