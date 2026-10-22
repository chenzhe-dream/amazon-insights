import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readdir,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import test from 'node:test';
import {publishWebBuild} from '../../scripts/run-asin-sync-job.mjs';
import {publishImmutableWebArtifact,createWebArtifactStore} from '../../scripts/lib/web-artifact-store.mjs';
import {createWebReloadTarget,readPendingWebReloadRequests} from '../../scripts/lib/web-reload-request.mjs';

test('normal ASIN publications hand reservations to durable requests without exhausting eight-artifact quota',async()=>{
 const worktree=await mkdtemp(path.join(os.tmpdir(),'asin-publication-reservation-'));
 const spoolDir=path.join(worktree,'data/web-reload-requests');
 try{
  const store=createWebArtifactStore({worktree});
  for(let i=1;i<=9;i++){
   const contentHash='a'.repeat(64),artifactId=i.toString(16).repeat(64);
   const job={jobId:'job-'+i,jobVersion:1,asins:['B000000001'],stages:[{id:'keywords',status:'done'}],outputs:[{stage:'keywords',stageStatus:'done',contentHash}],persistedStageContentHashes:{keywords:contentHash}};
   await publishWebBuild(job.jobId,{worktree,spoolDir,createArtifactId:()=>artifactId,readJob:()=>job,projectOutput:()=>({contentHash}),completeBuildStage:()=>{},patchJob:()=>{},configuredTarget:()=>createWebReloadTarget({worktree,webHost:'127.0.0.1',webPort:43123}),publishArtifact:input=>publishImmutableWebArtifact({...input,captureSourceIdentity:false}),build:async()=>{await mkdir(path.join(worktree,'dist'),{recursive:true});await writeFile(path.join(worktree,'dist/index.html'),'build '+i);}});
   assert.deepEqual(await readdir(path.join(worktree,'data/web-runtime-artifacts/.reservations')),[],'completed publication must release its temporary reservation');
   const pending=await readPendingWebReloadRequests({spoolDir});assert.equal(pending.length,1);assert.equal(pending[0].payload.artifactId,artifactId);
   await store.prune();assert.ok(store.candidate({artifactId}),'durable pending request protects the artifact');
   await rm(pending[0].path);await store.prune();
  }
 }finally{assert.ok(path.resolve(worktree).startsWith(path.resolve(os.tmpdir())+path.sep));await rm(worktree,{recursive:true,force:true});}
});
