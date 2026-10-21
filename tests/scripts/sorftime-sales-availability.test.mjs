import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {buildSalesTrendRecord, collectSalesTrendResponses, runSalesTrendSync} from '../../scripts/build-sorftime-sales-trend.mjs';
import {readCachedDataExport} from '../../scripts/lib/sync-cache.mjs';
import {projectStageOutput} from '../../scripts/lib/sync-stage-output.mjs';
import {attachSourceMetadata} from '../../scripts/lib/sorftime-source-policy.mjs';

const missingAsin = 'B0DLB22T15';
const sibling = 'B0DQCF6ZVZ';
const placeholder = asin => ({data:{asin:`#${asin}`,parent_asin:null,title:null,sub_title:null,brand:null,
  store_name:null,seller_name:null,seller_id:null,category:null,sub_category:null,online_date:null,
  listing_date:null,days_on_shelf:0,price:0,list_price:0,coupon:0,star_rating:0,review_count:0,
  a_plus:false,has_video:false,has_brand_store:false,monthly_sales_volume:0,monthly_sales_amount:0,
  yearly_sales_volume:0,is_fba:false,fba_fee:0,ship_cost:0,ships_from:null,platform_fee:0,
  profit:0,profit_rate:0,seller_country:null,seller_count:0,variation_count:0,
  extra_savings:null,peak_season:null,package_size_cm:null,weight_g:0}});
const trend = (asin,type,data=[]) => ({data:{asin,type,data}});

test('exact missing-product detail skips dependent trends and records unavailable source evidence', async () => {
  const calls=[];
  const collected=await collectSalesTrendResponses({key:'offline',asin:missingAsin,marketplace:'GB',
    productAvailabilityPreflight:true,callTool:async (_key,name,args)=>{
      calls.push([name,args]);
      if(name==='product_detail') return placeholder(args.asin);
      throw new Error('product_trend must not be called');
    }});
  assert.deepEqual(calls.map(([name])=>name),['product_detail']);
  const record=buildSalesTrendRecord({asin:missingAsin,marketplace:'GB',fetchedAt:'2026-10-21',...collected});
  assert.equal(record.status,'empty');
  assert.deepEqual(record.volume,[]);
  assert.equal(record.observationOutcomes.volume.category,'source-unavailable');
  assert.equal(record.observationOutcomes.volume.sourceTool,'product_detail');
  assert.equal(record.observationOutcomes.volume.reasonCode,'SORFTIME_PRODUCT_NOT_FOUND');
  assert.deepEqual(record.observationErrors,{});
  assert.equal(JSON.stringify(record).includes('"value":0'),false);
  const output=projectStageOutput('sales_trend',[missingAsin],{stageStatus:'partial',dataAsins:[],
    readExport:()=>({[missingAsin]:record})});
  assert.equal(output.data.trendByAsin[missingAsin].observationOutcomes.volume.reasonCode,'SORFTIME_PRODUCT_NOT_FOUND');
  assert.deepEqual(output.gap.items.map(item=>item.asin),[missingAsin]);
});

test('missing-product detail retains prior numeric observations and uses source collection date', async () => {
  const prior=buildSalesTrendRecord({asin:missingAsin,marketplace:'GB',fetchedAt:'2026-10-18',
    responses:{volume:trend(missingAsin,'SalesVolume',[202609,7])}});
  const collected=await collectSalesTrendResponses({key:'offline',asin:missingAsin,marketplace:'GB',fields:['volume'],
    productAvailabilityPreflight:true,callTool:async ()=>attachSourceMetadata(placeholder(missingAsin),
      {fetchedAt:'2026-10-20T09:00:00Z',cacheHit:true})});
  const record=buildSalesTrendRecord({asin:missingAsin,marketplace:'GB',fetchedAt:'2026-10-21',
    previous:prior,...collected});
  assert.deepEqual(record.volume,[{month:'2026-09',value:7}]);
  assert.equal(record.fieldFetchedAt.volume,'2026-10-18');
  assert.equal(record.observationOutcomes.volume.fetchedAt,'2026-10-20');
  assert.equal(record.status,'ready');
});

test('missing product does not starve valid sibling and valid detail keeps minus-one unknown', async () => {
  const calls=[];
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sales-availability-'));
  const oldExit=process.exitCode;
  try {
    const outPath=path.join(directory,'sales.ts');
    await runSalesTrendSync({key:'offline',asins:[missingAsin,sibling],marketplace:'GB',fetchedAt:'2026-10-21',
      existing:{},outPath,repair:true,delayMs:0,productAvailabilityPreflight:true,
      callTool:async (_key,name,args)=>{
        calls.push(`${name}:${args.asin}:${args.type??''}`);
        if(name==='product_detail') return args.asin===missingAsin?placeholder(args.asin):{data:{asin:args.asin,title:'Real darts'}};
        return trend(args.asin,args.type,[202609,-1]);
      }});
    const records=readCachedDataExport(outPath,'sorftimeSalesTrendData');
    assert.deepEqual(calls.filter(call=>call.startsWith('product_trend:')).map(call=>call.split(':')[1]),Array(4).fill(sibling));
    assert.equal(records[missingAsin].observationOutcomes.rank.category,'source-unavailable');
    assert.equal(records[sibling].observationOutcomes.volume.category,'source-unknown');
    assert.deepEqual(records[sibling].missingMonthlyObservations.volume,[{month:'2026-09',fetchedAt:'2026-10-21'}]);
    assert.deepEqual(records[sibling].volume,[]);
  } finally {process.exitCode=oldExit;fs.rmSync(directory,{recursive:true,force:true});}
});

test('wrong identity and partial placeholder shape do not suppress trend requests', async () => {
  for(const detail of [{...placeholder(missingAsin),data:{...placeholder(missingAsin).data,asin:'#B000000001'}},
    {...placeholder(missingAsin),data:{...placeholder(missingAsin).data,title:'Possibly real'}}]) {
    const calls=[];
    await collectSalesTrendResponses({key:'offline',asin:missingAsin,marketplace:'GB',fields:['volume'],
      productAvailabilityPreflight:true,callTool:async (_key,name,args)=>{
        calls.push(name);return name==='product_detail'?detail:trend(args.asin,args.type,[]);
      }});
    assert.deepEqual(calls,['product_detail','product_trend']);
  }
});

test('preflight transport and quota errors remain failures and never call trends', async () => {
  for(const error of [Object.assign(new Error('auth'),{kind:'auth'}),Object.assign(new Error('quota'),{kind:'quota'})]) {
    const calls=[];
    await assert.rejects(collectSalesTrendResponses({key:'offline',asin:missingAsin,marketplace:'GB',
      productAvailabilityPreflight:true,callTool:async (_key,name)=>{calls.push(name);throw error;}}),error);
    assert.deepEqual(calls,['product_detail']);
  }
});

test('disabled preflight and complete repair cache do not add detail requests', async () => {
  const calls=[];
  await collectSalesTrendResponses({key:'offline',asin:missingAsin,marketplace:'GB',fields:['volume'],
    callTool:async (_key,name,args)=>{calls.push(name);return trend(args.asin,args.type,[]);}});
  assert.deepEqual(calls,['product_trend']);
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sales-availability-cache-'));
  const oldExit=process.exitCode;
  try {
    const previous={asin:missingAsin,marketplace:'GB',fetchedAt:'2026-10-20',status:'ready',
      volume:[{month:'2026-09',value:2}],amount:[{month:'2026-09',value:3}],
      price:[{month:'2026-09',value:4}],rank:[{month:'2026-09',value:5}]};
    await runSalesTrendSync({key:'offline',asins:[missingAsin],marketplace:'GB',existing:{[missingAsin]:previous},
      outPath:path.join(directory,'sales.ts'),repair:true,delayMs:0,productAvailabilityPreflight:true,
      callTool:async ()=>{throw new Error('complete cache must not query');}});
    assert.deepEqual(readCachedDataExport(path.join(directory,'sales.ts'),'sorftimeSalesTrendData')[missingAsin],previous);
  } finally {process.exitCode=oldExit;fs.rmSync(directory,{recursive:true,force:true});}
});
