import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {readCachedDataExport} from '../../scripts/lib/sync-cache.mjs';
const root=path.resolve(import.meta.dirname,'../..');
const asin='B000000001',other='B000000002',a='https://m.media-amazon.com/images/I/a.jpg',b='https://m.media-amazon.com/images/I/b.jpg',c='https://m.media-amazon.com/images/I/c.jpg';
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'image-action-fixture-'));
  fs.mkdirSync(path.join(dir,'scripts'));fs.mkdirSync(path.join(dir,'app'));
  for (const sub of ['config','connectors']) fs.cpSync(path.join(root,'server',sub),path.join(dir,'server',sub),{recursive:true});
  fs.symlinkSync(path.join(root,'node_modules'),path.join(dir,'node_modules'),'junction');
  fs.cpSync(path.join(root,'scripts/lib'),path.join(dir,'scripts/lib'),{recursive:true});
  for(const script of ['build-sorftime-listing-content.mjs','build-listing-image-remarks.mjs'])fs.copyFileSync(path.join(root,'scripts',script),path.join(dir,'scripts',script));
  const listing={asin,marketplace:'US',fetchedAt:'2026-01-01',status:'ready',mainImage:a,galleryImages:[a,b],secondaryImages:[b],imageCount:2,hasAplus:true,hasEbc:true,hasVideo:false,lqs:99,source:'Sorftime'};
  const records={[asin]:listing,[other]:{...listing,asin:other}};
  const note=text=>({remark:text,image_types:['产品展示'],confidence:'high'});
  fs.writeFileSync(path.join(dir,'app/sorftime-listing-content-data.ts'),'export const sorftimeListingContentData = '+JSON.stringify(records)+';');
  fs.writeFileSync(path.join(dir,'app/listing-image-remarks.ts'),'export const listingImageRemarksMeta = {};\nexport const listingImageRemarks = '+JSON.stringify({[asin]:[note('A'),note('B')],[other]:[note('other')]})+';');
  const diagnosticScript=path.join(dir,'scripts/build-listing-image-remarks.mjs');
  fs.writeFileSync(diagnosticScript,fs.readFileSync(diagnosticScript,'utf8').replace('main().catch(() => {','main().catch(error => { console.error("TEST_DIAGNOSTIC", error.stack);'));
  const preload=path.join(dir,'mock.mjs');
  fs.writeFileSync(preload,`import fs from 'node:fs';globalThis.fetch=async(url,init)=>{const body=JSON.parse(init.body);fs.appendFileSync(process.env.CALL_LOG,JSON.stringify({url:String(url),body})+'\\n');if(body.jsonrpc){return Response.json({jsonrpc:'2.0',id:body.id,result:{content:[{type:'text',text:JSON.stringify({main_image:JSON.parse(process.env.NEXT_IMAGES),...(process.env.OMIT_APLUS ? {} : {a_plus:true})})}]}});}if(process.env.FAIL_AI==='1')return Response.json({error:'fixture failure'},{status:503});return Response.json({choices:[{message:{content:JSON.stringify({remark:'new C',image_types:['产品展示'],confidence:'high'})}}]});};`);
  const log=path.join(dir,'calls.jsonl');
  const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:dir,TMP:dir,AGENT_FORMAL_WORKTREE_ROOT:dir,AGENT_DATA_DIR:path.join(dir,'data'),AGENT_SYNC_JOB_ID:'image-action-fixture',AGENT_SYNC_REPAIR_INCOMPLETE:'1',AGENT_SYNC_IMAGE_ACTION:'refresh',AGENT_CHILD_RESOURCE_GOVERNOR_REQUIRED:'0',SORFTIME_MCP_KEY:'fixture',SORFTIME_ASINS:asin,SORFTIME_MARKETPLACE:'US',REMARK_ASINS:asin,OPENAI_API_KEY:'fixture',CALL_LOG:log,NEXT_IMAGES:JSON.stringify([b,a,c])};
  const run=(script,overrides={})=>spawnSync(process.execPath,['--import',pathToFileURL(preload).href,path.join(dir,'scripts',script)],{cwd:dir,encoding:'utf8',env:{...env,...overrides},timeout:20000});
  const read=(file,name)=>readCachedDataExport(path.join(dir,'app',file),name);
  t.after(()=>{const resolved=path.resolve(dir);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(resolved,{recursive:true,force:true});});
  return {dir,records,run,read,calls:()=>fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)):[]};
}
test('actual generators refresh one ready gallery, reanalyze every static image after refresh',t=>{
  const f=fixture(t);
  const refreshed=f.run('build-sorftime-listing-content.mjs',{AGENT_SYNC_STAGE_ID:'listing'});
  assert.equal(refreshed.status,0,refreshed.stdout+refreshed.stderr);
  const records=f.read('sorftime-listing-content-data.ts','sorftimeListingContentData');
  assert.deepEqual(records[asin].galleryImages,[b,a,c]);assert.deepEqual(records[asin].previousGalleryImages,[a,b]);assert.deepEqual(records[other],f.records[other]);
  const analyzed=f.run('build-listing-image-remarks.mjs',{AGENT_SYNC_STAGE_ID:'image_remarks'});
  assert.equal(analyzed.status,0,analyzed.stdout+analyzed.stderr);
  const notes=f.read('listing-image-remarks.ts','listingImageRemarks');
  assert.deepEqual(notes[asin].map(x=>x?.remark),['new C','new C','new C']);assert.equal(notes[other][0].remark,'other');
  assert.equal(f.calls().filter(x=>x.body.jsonrpc).length,1);assert.equal(f.calls().filter(x=>!x.body.jsonrpc).length,3);
  const retry=f.run('build-listing-image-remarks.mjs',{AGENT_SYNC_STAGE_ID:'image_remarks',AGENT_SYNC_IMAGE_ACTION:'analyze'});
  assert.equal(retry.status,0,retry.stdout+retry.stderr);assert.equal(f.calls().length,7);
});
test('empty refresh preserves previous gallery and its timestamp and reports failure',t=>{
  const f=fixture(t),result=f.run('build-sorftime-listing-content.mjs',{AGENT_SYNC_STAGE_ID:'listing',NEXT_IMAGES:'[]'});
  assert.notEqual(result.status,0,result.stdout+result.stderr);
  assert.deepEqual(f.read('sorftime-listing-content-data.ts','sorftimeListingContentData'),f.records);
  assert.equal(f.calls().length,1);
});

test('valid one-image refresh replaces the gallery while absent unrelated metadata survives',t=>{
  const f=fixture(t),result=f.run('build-sorftime-listing-content.mjs',{NEXT_IMAGES:JSON.stringify([c]),OMIT_APLUS:'1'});
  assert.equal(result.status,0,result.stdout+result.stderr);
  const record=f.read('sorftime-listing-content-data.ts','sorftimeListingContentData')[asin];
  assert.deepEqual(record.galleryImages,[c]);assert.deepEqual(record.secondaryImages,[]);
  assert.equal(record.hasAplus,true);assert.equal(record.hasEbc,true);assert.equal(record.lqs,99);
});
test('analysis after interrupted refresh uses the previous gallery to identify legacy notes',t=>{
  const f=fixture(t),result=f.run('build-sorftime-listing-content.mjs',{NEXT_IMAGES:JSON.stringify([b,c])});
  assert.equal(result.status,0,result.stdout+result.stderr);
  const analyzed=f.run('build-listing-image-remarks.mjs',{AGENT_SYNC_IMAGE_ACTION:'analyze',AGENT_SYNC_STAGE_ID:'image_remarks'});
  assert.equal(analyzed.status,0,analyzed.stdout+analyzed.stderr);
  assert.deepEqual(f.read('listing-image-remarks.ts','listingImageRemarks')[asin].map(x=>x?.remark),['new C','new C']);
});

test('analyze reruns ready images without fetching a gallery and preserves other ASINs',t=>{
  const f=fixture(t),result=f.run('build-listing-image-remarks.mjs',{AGENT_SYNC_IMAGE_ACTION:'analyze',AGENT_SYNC_STAGE_ID:'image_remarks'});
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.equal(f.calls().filter(x=>x.body.jsonrpc).length,0);assert.equal(f.calls().length,2);
  const notes=f.read('listing-image-remarks.ts','listingImageRemarks');
  assert.deepEqual(notes[asin].map(x=>x?.remark),['new C','new C']);assert.equal(notes[other][0].remark,'other');
  assert.deepEqual(f.read('sorftime-listing-content-data.ts','sorftimeListingContentData'),f.records);
});
test('failed reanalysis retains old notes but reports failure instead of cached success',t=>{
  const f=fixture(t),result=f.run('build-listing-image-remarks.mjs',{AGENT_SYNC_IMAGE_ACTION:'analyze',AGENT_SYNC_STAGE_ID:'image_remarks',FAIL_AI:'1'});
  assert.notEqual(result.status,0,result.stdout+result.stderr);
  assert.deepEqual(f.read('listing-image-remarks.ts','listingImageRemarks')[asin].map(x=>x?.remark),['A','B']);
  const meta=f.read('listing-image-remarks.ts','listingImageRemarksMeta');
  assert.ok(meta.pendingAsins.includes(asin));assert.ok(meta.imageOutcomesByAsin[asin].every(x=>x.status==='connector-failed'));
});
