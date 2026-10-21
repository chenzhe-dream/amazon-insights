import assert from 'node:assert/strict';
import test from 'node:test';
import * as trend from '../../scripts/lib/sorftime-trend-parse.mjs';
import { parsePriceStrategyResponse } from '../../scripts/build-sorftime-price-strategy.mjs';
import {createProductDetailEvidence} from '../../scripts/lib/scoped-sorftime-evidence.mjs';
import {buildScopedSorftimeModuleResult} from '../../scripts/lib/scoped-sorftime-fallbacks.mjs';
import {collectSalesTrendResponses} from '../../scripts/build-sorftime-sales-trend.mjs';

const asin='B0BWCQHCWX';
const current=(type,data,identity=asin)=>({doc:{data:'flat observations'},data:{asin:identity,type,data}});
const read=(raw,type)=>{assert.equal(typeof trend.parseSorftimeProductTrend,'function');return trend.parseSorftimeProductTrend(raw,{asin,type});};

test('current monthly observations normalize to months and retain observed zero',()=>{
  const result=read(current('SalesVolume',[202608,0,202609,123,202610,-1]),'SalesVolume');
  assert.equal(result.period,'month');
  assert.deepEqual(result.monthly,[{month:'2026-08',value:0},{month:'2026-09',value:123}]);
  assert.deepEqual(result.daily,[]);
});
test('daily observations remain daily and never become monthly totals',()=>{
  const raw=current('SalesVolume',[20260901,10,20260902,11]);
  const result=read(raw,'SalesVolume');
  assert.equal(result.period,'day');
  assert.deepEqual(result.monthly,[]);
  assert.deepEqual(result.daily,[{date:'2026-09-01',value:10},{date:'2026-09-02',value:11}]);
  assert.deepEqual(trend.parseSorftimeTrend(raw,{asin,type:'SalesVolume'}),[]);
});
test('current identity metric malformed pairs and mixed periods reject',()=>{
  assert.equal(typeof trend.parseSorftimeProductTrend,'function');
  for(const raw of [
    current('Price',[202609,20],'B000000000'),
    current('SalesVolume',[202609,20]),
    current('Price',[202609,20,20260902,21]),
    current('Price',[202609,20,202610]),
    current('Price',[20260230,20]),
    current('Price',[202609,'bad']),
    current('Price',[202609,-2]),
    current('Price',[202609,20,202609,21]),
  ]) assert.throws(()=>read(raw,'Price'));
});
test('current price detail requires matching product identity',()=>{
  assert.throws(()=>parsePriceStrategyResponse({asin,detailRaw:{doc:{},data:{price:59.99}},priceRaw:current('Price',[])}));
});
test('current monthly pairs are available through the legacy month consumer',()=>{
  assert.deepEqual(trend.parseSorftimeTrend(current('Rank',[202608,3,202609,4]),{asin,type:'Rank'}),[
    {month:'2026-08',value:3},{month:'2026-09',value:4},
  ]);
});
test('daily price observations support prices without describing them as months',()=>{
  const result=parsePriceStrategyResponse({asin,detailRaw:{doc:{coupon:'positive amount; negative percentage'},data:{asin,price:59.99,coupon:0}},priceRaw:current('Price',[20260901,55.99,20260902,59.99])});
  assert.equal(result.currentPrice,59.99);
  assert.equal(result.priceMin,55.99);
  assert.equal(result.observationPeriod,'day');
  assert.equal(result.observationCount,2);
  assert.equal(result.months,0);
  assert.doesNotMatch(result.anchor,/2 个月/);
  assert.match(result.anchor,/2.*观测/);
});
test('current coupon signs retain fixed amount versus percentage semantics',()=>{
  const detail=coupon=>({doc:{coupon:'positive amount; negative percentage'},data:{asin,price:59.99,coupon}});
  const raw=current('Price',[]);
  const amount=parsePriceStrategyResponse({asin,detailRaw:detail(5),priceRaw:raw});
  const percentage=parsePriceStrategyResponse({asin,detailRaw:detail(-10),priceRaw:raw});
  assert.match(amount.promotion,/固定金额/);
  assert.match(percentage.promotion,/10%/);
});
test('coupon semantics follow detail contract even with legacy or absent trend data',()=>{
  const detailRaw={doc:{coupon:'signed'},data:{asin,price:59.99,coupon:5}};
  assert.match(parsePriceStrategyResponse({asin,detailRaw,priceRaw:[]}).promotion,/固定金额/);
  const evidence=createProductDetailEvidence({jobId:'coupon-test',marketplace:'US',asin,
    detail:{...detailRaw,data:{...detailRaw.data,coupon:-10}}});
  assert.equal(evidence.data.coupon,-10);
  const fallback=buildScopedSorftimeModuleResult({module:'price_strategy',evidenceByOperation:{product_detail:evidence}});
  assert.match(fallback.promotion,/10%/);
  const missing=createProductDetailEvidence({jobId:'coupon-test',marketplace:'US',asin,detail:{doc:{},data:{asin,price:59.99}}});
  assert.match(buildScopedSorftimeModuleResult({module:'price_strategy',evidenceByOperation:{product_detail:missing}}).promotion,/暂未返回/);
});
test('ASIN sales and price requests send the current type parameter',async()=>{
  for(const file of ['sales-trend','price-strategy']){
    const calls=[];
    const callTool=async(_key,name,args)=>{if(name==='product_trend')calls.push(args);return {};};
    if(file==='sales-trend') await collectSalesTrendResponses({key:'fixture',asin,marketplace:'US',callTool});
    else {
      const {runSorftimePriceStrategyCli}=await import('../../scripts/build-sorftime-price-strategy.mjs');
      const oldExit=process.exitCode;
      try {
        await runSorftimePriceStrategyCli({key:'fixture',jobId:'test-job',asins:[asin],marketplace:'US',
          fetchedAt:'2026-10-12',existing:{},repair:true,env:{},wait:async()=>{},readEvidence:()=>({}),
          writeFileSync:()=>{},callTool:async(_key,name,args)=>{
            if(name==='product_detail') return {data:{asin,price:59.99,coupon:0}};
            return callTool(_key,name,args);
          }});
      } finally {process.exitCode=oldExit;}
    }
    assert.ok(calls.length);
    assert.deepEqual(calls.map(c=>c.type),file==='sales-trend'?['SalesVolume','SalesAmount','Price','Rank']:['Price']);
    assert.ok(calls.every(c=>!Object.hasOwn(c,'product_trend_type')));
  }
});
