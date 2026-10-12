import assert from 'node:assert/strict';
import test from 'node:test';
import * as price from '../../scripts/build-sorftime-price-strategy.mjs';
const asin = 'B0CSFDX9HM';
const scope = { asin, marketplace: 'US', jobId: 'current-job', fetchedAt: '2026-10-12T09:00:00.000Z' };
const old = { asin, marketplace: 'US', status: 'ready', currentPrice: 59.99, anchor: 'verified old price', promotion: 'old promotion', psychology: 'old psychology', evidence: 'old detail', fetchedAt: '2026-10-11T09:00:00.000Z' };
async function run(overrides = {}) {
  let source='';
  const calls=[];
  const previousExit=process.exitCode;
  try {
    const result=await price.runSorftimePriceStrategyCli({ ...scope, asins:[asin], existing:{}, key:'fixture', repair:true, forceRefresh:false, wait:async()=>{}, writeFileSync:(_path,value)=>{source=value;}, readEvidence:()=>({}), callTool:async(_key,tool,args)=>{
      calls.push({tool,args});
      return tool==='product_detail'?{doc:{price:'USD'},data:{asin,price:59.99,coupon:0}}:{data:{asin,type:'Price',data:[20261011,61.99,20261012,59.99]}};
    }, ...overrides });
    return {result,source,calls,exitCode:process.exitCode};
  } finally { process.exitCode=previousExit; }
}
test('direct price CLI result exports truthful detail and Price trend provenance',async()=>{
  const {result,source,calls}=await run();
  const record=result.records[asin];
  assert.deepEqual(calls.map(call=>call.tool),['product_detail','product_trend']);
  assert.equal(calls[1].args.type,'Price');
  assert.equal(record.provenance.jobId,scope.jobId);
  assert.equal(record.provenance.asin,asin);
  assert.equal(record.provenance.marketplace,'US');
  assert.equal(record.provenance.connector,'sorftime');
  assert.equal(record.provenance.stageId,'price_strategy');
  assert.equal(record.provenance.fetchedAt,scope.fetchedAt);
  assert.equal(record.provenance.operation,'product_detail+product_trend');
  assert.equal(record.provenance.tool,'product_detail+product_trend');
  assert.equal(record.provenance.trendType,'Price');
  assert.equal(record.provenance.observationPeriod,'day');
  assert.match(source,/"provenance"/);
});
test('scoped repair recaptures a ready price cache lacking provenance',async()=>{
  const {result,calls}=await run({existing:{[asin]:old}});
  assert.equal(calls.length,2);
  assert.equal(result.records[asin].provenance.jobId,'current-job');
});
test('valid prior scoped provenance is reused without relabeling its job or timestamp',async()=>{
  const provenance={jobId:'older-job',asin,marketplace:'US',connector:'sorftime',operation:'product_detail',tool:'product_detail',fetchedAt:old.fetchedAt};
  const {result,calls}=await run({existing:{[asin]:{...old,source:'Sorftime',provenance}}});
  assert.equal(calls.length,0);
  assert.deepEqual(result.records[asin].provenance,provenance);
  assert.equal(result.records[asin].fetchedAt,old.fetchedAt);
});
test('scope mismatches and incomplete provenance force scoped price recapture',async()=>{
  const valid={jobId:'old-job',asin,marketplace:'US',connector:'sorftime',operation:'product_detail',tool:'product_detail',fetchedAt:old.fetchedAt};
  for(const provenance of [{...valid,asin:'B0BWCQHCWX'},{...valid,marketplace:'UK'},{...valid,jobId:''},{...valid,tool:''},{...valid,fetchedAt:'invalid'}]) {
    const {calls}=await run({existing:{[asin]:{...old,source:'Sorftime',provenance}}});
    assert.equal(calls.length,2);
  }
});
test('uncertifiable cache with no key is retained honestly and flagged for recapture',async()=>{
  const {result,calls,exitCode}=await run({existing:{[asin]:old},key:null});
  assert.equal(calls.length,0);
  assert.equal(result.records[asin].provenance,undefined);
  assert.deepEqual(result.needsRecapture,[asin]);
  assert.equal(exitCode,1);
});
test('failed recapture keeps previous content and reports missing provenance instead of certifying it',async()=>{
  const {result,exitCode}=await run({existing:{[asin]:old},callTool:async()=>{throw new Error('fixture failure');}});
  assert.equal(result.records[asin],old);
  assert.equal(result.records[asin].provenance,undefined);
  assert.deepEqual(result.needsRecapture,[asin]);
  assert.equal(exitCode,1);
});
test('same-job current-price fallback uses actual detail evidence provenance without claiming a trend call',async()=>{
  const evidence={jobId:'current-job',marketplace:'US',asin,fetchedAt:'2026-10-12T08:00:00.000Z',source:'Sorftime',operation:'product_detail',data:{price:49.99,coupon:0}};
  const {result,calls}=await run({key:null,readEvidence:()=>({product_detail:evidence})});
  assert.equal(calls.length,0);
  assert.equal(result.records[asin].provenance.operation,'product_detail');
  assert.equal(result.records[asin].provenance.fetchedAt,evidence.fetchedAt);
  assert.deepEqual(result.needsRecapture,[]);
});
test('unscoped legacy use can retain a ready cache without inventing provenance',async()=>{
  const {result,calls}=await run({jobId:null,env:{},existing:{[asin]:old},repair:false,key:null});
  assert.equal(calls.length,0);
  assert.equal(result.records[asin],old);
  assert.equal(result.records[asin].provenance,undefined);
});
