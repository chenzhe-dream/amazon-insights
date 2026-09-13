import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizeMarketOverviewDistribution} from '../../server/domain/market-research/overview-distributions';
const price='market_price_distribution' as const;
const row=(label:string,asin:string,units:unknown)=>({label,asins:[asin],products:1,units,revenue:20,unitsRatio:0.99});
test('distribution shares use returned sample counts, never ambiguous upstream rates or another endpoint',()=>{
  const result=normalizeMarketOverviewDistribution(price,{code:'OK',data:[row('0-15','B000000001',10),row('15-30','B000000002',30)]});
  assert.equal(result.groups[0].products,2);assert.equal(result.groups[0].units,40);
  assert.equal(result.rows[0].unitsSharePct,25);assert.equal(result.rows[0].productsSharePct,50);
  assert.equal(result.rows[0].reportedRates.unitsRatio,0.99);assert.equal(result.rows[0].revenue,null);assert.equal(result.scopeBasis,'request-bound');
});
test('content combinations split whole sample, new subset and overlapping summaries without double counting',()=>{
  const labels=['有A+有视频','有A+无视频','无A+有视频','无A+无视频'];
  const data=labels.flatMap((label,i)=>[{label,products:i+1,units:10*(i+1),unitsRatio:999},{label:`新品${label}`,products:1,units:5,unitsRatio:999}]);data.push({label:'A+',products:3,units:30,unitsRatio:30});
  const result=normalizeMarketOverviewDistribution('market_ebc_distribution',{data});
  assert.deepEqual(result.groups.map(g=>[g.id,g.products,g.units]),[['sample',10,100],['new-products',4,20]]);
  assert.equal(result.rows.find(r=>r.label==='有A+有视频')!.unitsSharePct,10);assert.equal(result.rows.find(r=>r.label==='新品有A+有视频')!.unitsSharePct,25);
  assert.equal(result.rows.find(r=>r.label==='A+')!.group,'summary');assert.equal(result.rows.find(r=>r.label==='A+')!.unitsSharePct,null);
});
test('one missing or invalid amount blocks its group denominator while zero remains a real observation',()=>{
  for(const bad of [null,undefined,-1,Infinity,'',true,'NaN']){
    const r=normalizeMarketOverviewDistribution(price,{data:[row('a','B000000001',0),row('b','B000000002',bad)]});
    assert.equal(r.rows[0].units,0);assert.equal(r.groups[0].units,null);assert.equal(r.rows[0].unitsSharePct,null);assert.equal(r.status,'partial');
  }
  const zero=normalizeMarketOverviewDistribution(price,{data:[row('a','B000000001',0)]});assert.equal(zero.groups[0].units,0);assert.equal(zero.rows[0].unitsSharePct,null);
});
test('overlapping or mismatched ASIN membership cannot be normalized into a complete distribution',()=>{
  for(const data of [[row('a','B000000001',10),row('b','B000000001',20)],[{...row('a','B000000001',10),products:2}],[{...row('a','B000000001',10),asins:['bad']}],[row('a','B000000001',10),row('a','B000000002',20)]]){
    const r=normalizeMarketOverviewDistribution(price,{data});assert.equal(r.status,'partial');assert.equal(r.groups[0].products,null);assert.equal(r.rows[0].unitsSharePct,null);
  }
});
test('all ten endpoint field mappings retain original buckets and separate count aliases',()=>{
  for(const operation of ['market_price_distribution','market_ratings_count_distribution','market_rating_distribution','market_listing_date_distribution','market_listing_trend_distribution','market_seller_country_distribution','market_brand_concentration','market_seller_concentration'] as const){
    const r=normalizeMarketOverviewDistribution(operation,{data:[{...row('bucket','B000000001',10),brand:'brand',sellerName:'seller',totalUnits:10,totalRevenue:20}]});
    assert.equal(r.groups[0].units,10);assert.equal(r.rows[0].unitsSharePct,100);
  }
  const types=normalizeMarketOverviewDistribution('market_seller_type_concentration',{data:[{label:'NA',asinNum:2,productNum:2,units:4},{label:'FBA',asinNum:3,productNum:3,units:6}]});assert.equal(types.rows[0].productsSharePct,40);
  const bad=normalizeMarketOverviewDistribution('market_seller_type_concentration',{data:[{label:'FBA',asinNum:2,productNum:3,units:4}]});assert.equal(bad.groups[0].products,null);
});
test('missing combinations, unexpected content groups and unsafe totals remain explicit partial results',()=>{
  const r=normalizeMarketOverviewDistribution('market_ebc_distribution',{data:[{label:'有A+有视频',products:1,units:2},{label:'unrecognized',products:2,units:3}]});assert.equal(r.status,'partial');assert.equal(r.groups[0].units,null);assert.equal(r.rows[1].group,'unclassified');
  const big=normalizeMarketOverviewDistribution(price,{data:[row('a','B000000001',Number.MAX_SAFE_INTEGER),row('b','B000000002',1)]});assert.equal(big.groups[0].units,null);
  assert.equal(normalizeMarketOverviewDistribution(price,{data:[]}).status,'empty');
  assert.throws(()=>normalizeMarketOverviewDistribution(price,{data:{}}));assert.throws(()=>normalizeMarketOverviewDistribution(price,{isError:true,data:[]}));
});
