import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import test from 'node:test';import {pathToFileURL} from 'node:url';

test('Windows self identity uses available lock budget beyond CIM cold-start two seconds', {skip:process.platform!=='win32'}, async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'lock-budget-'));
 try{
  const module=pathToFileURL(path.resolve('scripts/lib/interprocess-lock.mjs')).href;
  const source=`import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
   let budget;cp.spawnSync=(cmd,args,opts)=>{budget=opts.timeout;return budget>2000?{status:0,stdout:JSON.stringify({created:'2026-10-22T00:00:00Z',command:'bounded-test-process'})}:{status:null,error:{code:'ETIMEDOUT'}};};syncBuiltinESMExports();
   const {acquireInterprocessLockSync}=await import(${JSON.stringify(module)});
   const release=acquireInterprocessLockSync(${JSON.stringify(path.join(dir,'self.lock'))},{waitMs:5000});release();console.log(JSON.stringify({budget}));`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(child.status,0,child.stderr);const {budget}=JSON.parse(child.stdout);assert.ok(budget>2000&&budget<=5000);
 }finally{await rm(dir,{recursive:true,force:true});}
});
