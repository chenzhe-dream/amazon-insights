import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {runSorftimePriceStrategyCli} from '../../scripts/build-sorftime-price-strategy.mjs';
import {attachSourceMetadata} from '../../scripts/lib/sorftime-source-policy.mjs';

const missingAsin='B0DLB22T15';
const sibling='B0DQCF6ZVZ';
const missingDetail=JSON.parse(fs.readFileSync(new URL('../fixtures/sorftime-uk-missing-detail.json',import.meta.url),'utf8'));
async function run(overrides={}) {
  const calls=[];
  const oldExit=process.exitCode;
  try {
    process.exitCode=0;
    const result=await runSorftimePriceStrategyCli({key:'offline',jobId:'candidate-job',asins:[missingAsin],
      marketplace:'GB',fetchedAt:'2026-10-21',existing:{},repair:true,forceRefresh:false,
      env:{AGENT_SORFTIME_PRODUCT_AVAILABILITY_PREFLIGHT:'1'},wait:async()=>{},
      readEvidence:()=>({}),writeFileSync:()=>{},callTool:async(_key,name,args)=>{
        calls.push({name,args});
        if(name==='product_detail') return attachSourceMetadata({data:missingDetail},{fetchedAt:'2026-10-20T08:00:00Z'});
        throw new Error('dependent Price trend should not be called');
      },...overrides});
    return {result,calls,exitCode:process.exitCode};
  } finally {process.exitCode=oldExit;}
}

test('price strategy stops after exact missing-product detail with explicit source provenance',async()=>{
  const {result,calls,exitCode}=await run();
  assert.deepEqual(calls.map(call=>call.name),['product_detail']);
  assert.equal(result.records[missingAsin].status,'empty');
  assert.equal(result.records[missingAsin].reasonCode,'SORFTIME_PRODUCT_NOT_FOUND');
  assert.equal(result.records[missingAsin].provenance.operation,'product_detail');
  assert.equal(result.records[missingAsin].provenance.fetchedAt,'2026-10-20');
  assert.equal(result.records[missingAsin].currentPrice,undefined);
  assert.deepEqual(result.uiRecords,{});
  assert.equal(exitCode,0);
});

test('missing product does not starve valid sibling with unknown Price observations',async()=>{
  const seen=[];
  const {result}=await run({asins:[missingAsin,sibling],callTool:async(_key,name,args)=>{
    seen.push({name,args});
    if(name==='product_detail') return args.asin===missingAsin?{data:missingDetail}:
      {data:{asin:sibling,title:'Real product',price:29.99,coupon:0}};
    return {data:{asin:args.asin,type:'Price',data:[202609,-1]}};
  }});
  assert.deepEqual(seen.map(call=>`${call.name}:${call.args.asin}`),[
    `product_detail:${missingAsin}`,`product_detail:${sibling}`,`product_trend:${sibling}`]);
  assert.equal(result.records[sibling].status,'ready');
  assert.equal(result.records[sibling].currentPrice,29.99);
  assert.equal(result.records[sibling].observationCount,0);
});

test('wrong identity and partial placeholder continue to normal Price trend validation',async()=>{
  for(const detail of [{...missingDetail,asin:'#B000000001'},
    {...missingDetail,title:'Possible real product'}]) {
    const seen=[];
    await run({callTool:async(_key,name,args)=>{
      seen.push({name,args});
      return name==='product_detail'?{data:detail}:{data:{asin:args.asin,type:'Price',data:[]}};
    }});
    assert.deepEqual(seen.map(call=>call.name),['product_detail','product_trend']);
  }
});

test('detail auth and quota failures remain failed without dependent Price calls',async()=>{
  for(const kind of ['auth','quota']) {
    const error=Object.assign(new Error(kind),{kind});
    const seen=[];
    const {exitCode}=await run({callTool:async(_key,name,args)=>{
      seen.push({name,args});throw error;
    }});
    assert.deepEqual(seen.map(call=>call.name),['product_detail']);
    assert.equal(exitCode,1);
  }
});

test('repair retains previous usable price and never relabels it as new detail evidence',async()=>{
  const previous={asin:missingAsin,marketplace:'GB',status:'ready',source:'Sorftime',currentPrice:25,
    anchor:'old verified price',promotion:'old',psychology:'old',evidence:'old',fetchedAt:'2026-10-18'};
  const {result,calls,exitCode}=await run({existing:{[missingAsin]:previous}});
  assert.deepEqual(calls.map(call=>call.name),['product_detail']);
  assert.deepEqual(result.records[missingAsin],previous);
  assert.deepEqual(result.needsRecapture,[missingAsin]);
  assert.equal(exitCode,1);
});

test('price availability preflight defaults off',async()=>{
  const seen=[];
  await run({env:{},callTool:async(_key,name,args)=>{
    seen.push({name,args});
    return name==='product_detail'?{data:missingDetail}:{data:{asin:args.asin,type:'Price',data:[]}};
  }});
  assert.deepEqual(seen.map(call=>call.name),['product_detail','product_trend']);
});
