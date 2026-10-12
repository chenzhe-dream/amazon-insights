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
