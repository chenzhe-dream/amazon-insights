import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as sales from '../../scripts/build-sorftime-sales-trend.mjs';
import {readCachedDataExport} from '../../scripts/lib/sync-cache.mjs';
const asin='B0BWCQHCWX';
const empty={asin,marketplace:'US',fetchedAt:'2026-10-01',status:'empty',volume:[],amount:[],price:[],rank:[]};
const response=type=>({doc:{},data:{asin,type,data:[20260901,10,20260902,11]}});
test('actual repair CLI persists daily evidence rather than retaining an empty cache as a schema failure',async()=>{
  assert.equal(typeof sales.runSalesTrendSync,'function');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sales-repair-'));
  const previousExit=process.exitCode;
  try{
    const target=path.join(directory,'sales.ts');
    await sales.runSalesTrendSync({key:'offline',asins:[asin],marketplace:'US',fetchedAt:'2026-10-12',existing:{[asin]:empty},outPath:target,repair:true,callTool:async(_key,_name,args)=>response(args.type),delayMs:0});
    const record=readCachedDataExport(target,'sorftimeSalesTrendData')[asin];
    assert.equal(record.status,'empty');
    assert.equal(record.dailyObservations.volume.length,2);
    assert.equal(record.volume.length,0);
    assert.match(record.statusMessage,/月度.*待确认/);
    assert.equal(process.exitCode,previousExit);
  } finally {process.exitCode=previousExit;fs.rmSync(directory,{recursive:true,force:true});}
});
test('actual repair CLI keeps valid new observations alongside a failed independent metric',async()=>{
  assert.equal(typeof sales.runSalesTrendSync,'function');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sales-partial-'));
  const previousExit=process.exitCode;
  try{
    const target=path.join(directory,'sales.ts');
    await sales.runSalesTrendSync({key:'offline',asins:[asin],marketplace:'US',fetchedAt:'2026-10-12',existing:{[asin]:empty},outPath:target,repair:true,callTool:async(_key,_name,args)=>{
      if(args.type==='SalesAmount') throw new Error('offline');return response(args.type);
    },delayMs:0});
    const record=readCachedDataExport(target,'sorftimeSalesTrendData')[asin];
    assert.equal(record.status,'error');
    assert.equal(record.dailyObservations.volume.length,2);
    assert.equal(record.dailyObservations.price.length,2);
    assert.equal(record.observationErrors.amount,'Provider request failed');
  } finally {process.exitCode=previousExit;fs.rmSync(directory,{recursive:true,force:true});}
});
test('repair reuses verified daily fields and fetches only missing metrics',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sales-reuse-'));
  const previousExit=process.exitCode;
  try{
    const target=path.join(directory,'sales.ts'),types=[];
    const previous=sales.buildSalesTrendRecord({asin,marketplace:'US',fetchedAt:'2026-10-01',responses:{volume:response('SalesVolume')}});
    await sales.runSalesTrendSync({key:'offline',asins:[asin],marketplace:'US',fetchedAt:'2026-10-12',existing:{[asin]:previous},outPath:target,repair:true,
      callTool:async(_key,_name,args)=>{types.push(args.type);return response(args.type);},delayMs:0});
    assert.deepEqual(types,['SalesAmount','Price','Rank']);
    const record=readCachedDataExport(target,'sorftimeSalesTrendData')[asin];
    assert.equal(record.fieldFetchedAt.volume,'2026-10-01');
    assert.equal(record.fieldFetchedAt.price,'2026-10-12');
  }finally{process.exitCode=previousExit;fs.rmSync(directory,{recursive:true,force:true});}
});
test('a verified empty refresh cannot erase earlier monthly observations',()=>{
  const previous={...empty,status:'ready',volume:[{month:'2026-09',value:123}]};
  const record=sales.buildSalesTrendRecord({asin,marketplace:'US',fetchedAt:'2026-10-12',previous,responses:{volume:{data:{asin,type:'SalesVolume',data:[]}}}});
  assert.deepEqual(record.volume,previous.volume);
  assert.equal(record.fieldFetchedAt.volume,previous.fetchedAt);
});

test('actual repair CLI classifies metric outcomes without leaking provider text',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sales-classes-'));
  const old=process.exitCode;
  try {
    for (const [expected,make] of [
      ['valid-empty',args=>({data:{asin,type:args.type,data:[]}})],
      ['daily-unverified',args=>response(args.type)],
      ['request-failed',()=>{throw new Error('secret provider body');}],
      ['identity-mismatch',args=>({data:{asin:'B000000001',type:args.type,data:[]}})],
      ['malformed-response',args=>({data:{asin,type:args.type,data:[20260901]}})],
    ]) {
      const target=path.join(directory,expected+'.ts');
      await sales.runSalesTrendSync({key:'offline',asins:[asin],marketplace:'US',fetchedAt:'2026-10-12',existing:{},outPath:target,repair:true,callTool:async(_k,_n,args)=>make(args),delayMs:0});
      const record=readCachedDataExport(target,'sorftimeSalesTrendData')[asin];
      assert.equal(record.observationOutcomes.volume.category,expected);
      assert.equal(record.observationOutcomes.volume.fetchedAt,'2026-10-12');
      assert.ok(!JSON.stringify(record).includes('secret provider body'));
    }
  }finally{process.exitCode=old;fs.rmSync(directory,{recursive:true,force:true});}
});

test('saved governed B0B response accepts strict string calendar stamps',()=>{
  const raw=JSON.parse(fs.readFileSync(new URL('../fixtures/sorftime-b0b-monthly-trend.json',import.meta.url),'utf8'));
  const response=raw;
  const record=sales.buildSalesTrendRecord({asin,marketplace:'US',fetchedAt:'2026-10-12',responses:{volume:response}});
  assert.equal(record.volume.length,25);
  assert.deepEqual(record.volume[0],{month:'2024-10',value:1337});
});

test('saved B0B response preserves 25 points through CLI persistence and frozen output',async()=>{
  const {projectStageOutput}=await import('../../scripts/lib/sync-stage-output.mjs');
  const raw=JSON.parse(fs.readFileSync(new URL('../fixtures/sorftime-b0b-monthly-trend.json',import.meta.url),'utf8'));
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sales-replay-')); const old=process.exitCode;
  try {
    const target=path.join(directory,'sales.ts');
    await sales.runSalesTrendSync({key:'offline',asins:[asin],marketplace:'US',fetchedAt:'2026-10-12',existing:{},outPath:target,repair:true,callTool:async(_k,_n,args)=>args.type==='SalesVolume'?raw:{data:{asin,type:args.type,data:[]}},delayMs:0});
    const persisted=readCachedDataExport(target,'sorftimeSalesTrendData');
    const frozen=projectStageOutput('sales_trend',[asin],{readExport:()=>persisted});
    assert.equal(persisted[asin].volume.length,25);
    assert.deepEqual(frozen.data.trendByAsin[asin].volume,persisted[asin].volume);
  }finally{process.exitCode=old;fs.rmSync(directory,{recursive:true,force:true});}
});

test('actual CLI rejects CN and ISO blank or invalid legacy months without erasing previous values',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'legacy-invalid-')), old=process.exitCode;
 try {
 for(const raw of ['2026年09月=','2026-09=   ','2026年13月=12','2026-00=12','2026-09=0,broken']) {
 const target=path.join(directory,'sales.ts');
 const previous={...empty,status:'error',volume:[{month:'2026-09',value:99}]};
 await sales.runSalesTrendSync({key:'offline',asins:[asin],marketplace:'US',fetchedAt:'2026-10-12',existing:{[asin]:previous},outPath:target,repair:false,callTool:async(_k,_n,args)=>args.type==='SalesVolume'?raw:'',delayMs:0});
 const record=readCachedDataExport(target,'sorftimeSalesTrendData')[asin];
 assert.equal(record.observationOutcomes.volume.category,'malformed-response');
 assert.deepEqual(record.volume,previous.volume);assert.equal(record.fieldFetchedAt.volume,'2026-10-01');
 }
 }finally{process.exitCode=old;fs.rmSync(directory,{recursive:true,force:true});}
});

test('actual missing-only repair reuses retained daily volume after empty or unknown-month refresh',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'retained-day-reuse-')), old=process.exitCode;
 try {
 for(const data of [[],['202609',-1]]) {
 const target=path.join(directory,'sales.ts');
 const previous=sales.buildSalesTrendRecord({asin,marketplace:'US',fetchedAt:'2026-10-01',responses:{volume:{data:{asin,type:'SalesVolume',data:['20260901',7]}}}});
 await sales.runSalesTrendSync({key:'offline',asins:[asin],marketplace:'US',fetchedAt:'2026-10-12',existing:{[asin]:previous},outPath:target,repair:false,callTool:async(_k,_n,args)=>({data:{asin,type:args.type,data:args.type==='SalesVolume'?data:[]}}),delayMs:0});
 const refreshed=readCachedDataExport(target,'sorftimeSalesTrendData');
 assert.equal(refreshed[asin].observationPeriods.volume,data.length?'month':null);
 assert.deepEqual(refreshed[asin].dailyObservations.volume,[{date:'2026-09-01',value:7}]);
 const types=[];
 await sales.runSalesTrendSync({key:'offline',asins:[asin],marketplace:'US',fetchedAt:'2026-10-13',existing:refreshed,outPath:target,repair:true,callTool:async(_k,_n,args)=>{types.push(args.type);return {data:{asin,type:args.type,data:[]}};},delayMs:0});
 assert.equal(types.filter(type=>type==='SalesVolume').length,0);
 assert.deepEqual(types,['SalesAmount','Price','Rank']);
 const repaired=readCachedDataExport(target,'sorftimeSalesTrendData')[asin];
 assert.equal(repaired.dailyFieldFetchedAt.volume,'2026-10-01');
 assert.equal(repaired.dailyObservationFetchedAt.volume['2026-09-01'],'2026-10-01');
 if(data.length) assert.deepEqual(repaired.missingMonthlyObservations.volume,[{month:'2026-09',fetchedAt:'2026-10-12'}]);
 }
 }finally{process.exitCode=old;fs.rmSync(directory,{recursive:true,force:true});}
});
