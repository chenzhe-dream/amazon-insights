import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {collectPluginShapeCategoryPool,replayPluginShapeCategoryPool} from '../../server/services/plugin-shape-category-pool';
import type {PluginCategoryPoolSource} from '../../shared/plugin-category-pool-contracts';
import type {MarketAnalysisScope} from '../../shared/market-analysis-contracts';
import {describeShapePoolAcquisition} from '../../shared/plugin-category-pool-contracts';
const asins=Array.from({length:150},(_,i)=>`B${String(i).padStart(9,'0')}`),now=new Date('2026-10-19T04:00:00Z');
function fixture(site:'US'|'CA'|'UK'|'DE'='US',node='34'){
 const currency=({US:'USD',CA:'CAD',UK:'GBP',DE:'EUR'} as const)[site];
 const scope:MarketAnalysisScope={organizationId:randomUUID(),researchId:randomUUID(),nodeIdPath:`12:${node}`,marketplace:site,currency,fromMonth:'2026-08',toMonth:'2026-09'};
 const source:PluginCategoryPoolSource={snapshotId:'plugin-source:'+'a'.repeat(64),jobId:randomUUID(),node,marketplace:site,collectedAt:'2026-10-19T03:00:00Z',asins,basic:Object.fromEntries(asins.slice(0,149).map((asin,i)=>[asin,{asin,currency,price:20,units:0,amount:0,profit:99,brand:'Synthetic',title:`Product ${i}`,bsr:999,bsrList:[{id:node,rank:i+1,label:'Synthetic category'}],history:{shouldNotCopy:true}}])),membershipProvider:'amazon-page'};
 return {scope,source,now,poolSize:150};
}
test('four sites and two categories preserve ordered plugin members, currency and unknown fields',()=>{
 for(const site of ['US','CA','UK','DE'] as const)for(const node of ['34','567']){
  const input=fixture(site,node),result=collectPluginShapeCategoryPool(input);
  assert.equal(result.products.length,150);assert.deepEqual(result.products.map(p=>p.asin),asins);
  assert.equal(result.products[0].units,0);assert.equal(result.products[0].revenue,0);assert.equal(result.products[0].grossProfitMargin,null);
  assert.equal(result.products[149].title,null);assert.equal(result.products[149].price,null);assert.equal(result.products[149].units,null);
  assert.equal(result.evidence.provider,'sellerSprite');assert.equal(result.evidence.operation,'plugin_category_pool');
  assert.equal(JSON.stringify(result.evidence.payload).includes('shouldNotCopy'),false);
  assert.deepEqual(replayPluginShapeCategoryPool(input.scope,result.evidence),result);
  assert.equal(collectPluginShapeCategoryPool({...input,poolSize:100}).products.length,100);
 }
});

test('collector missing-basic placeholder is not an observed product title',()=>{
 const input=fixture('CA');input.source.basic[asins[149]]={asin:asins[149],title:'基础信息缺失'};
 const result=collectPluginShapeCategoryPool(input);
 assert.equal(result.products[149].title,null);assert.equal(result.products.length,150);
 assert.equal((result.evidence.payload as {source:PluginCategoryPoolSource}).source.basic[asins[149]].title,'基础信息缺失','retain original collector evidence');
 assert.deepEqual(replayPluginShapeCategoryPool(input.scope,result.evidence),result);
});
test('category lookup cannot hide conflicting identities, currencies, dates or duplicate members',()=>{
 const input=fixture();
 for(const scope of [{...input.scope,nodeIdPath:'12:999'},{...input.scope,marketplace:'CA',currency:'CAD'}] satisfies MarketAnalysisScope[])assert.throws(()=>collectPluginShapeCategoryPool({...input,scope}),/scope/);
 for(const currency of ['EUR',null,0]){const copy=structuredClone(input);copy.source.basic[asins[0]].currency=currency;assert.throws(()=>collectPluginShapeCategoryPool(copy),/currency/);}
 assert.throws(()=>collectPluginShapeCategoryPool({...input,notBefore:now.toISOString()}),/stale/);
 assert.throws(()=>collectPluginShapeCategoryPool({...input,now:new Date('2026-10-20')}),/stale/);
 assert.throws(()=>collectPluginShapeCategoryPool({...input,poolSize:151}));
 const duplicate=structuredClone(input);duplicate.source.asins[1]=duplicate.source.asins[0];assert.throws(()=>collectPluginShapeCategoryPool(duplicate));
 const ready=collectPluginShapeCategoryPool(input);assert.throws(()=>replayPluginShapeCategoryPool(input.scope,{...ready.evidence,provider:'sorftime'}),/source/);
 assert.match(describeShapePoolAcquisition({kind:'mcp-fallback',reason:'invalid-source',membershipProvider:'sorftime'}),/币种校验/);
});

test('Canadian CDN$ export symbol is accepted only under verified CAD scope',()=>{
 const canada=fixture('CA');canada.source.basic[asins[0]].currency='CDN$';
 assert.equal(collectPluginShapeCategoryPool(canada).products[0].price,20);
 const us=fixture('US');us.source.basic[asins[0]].currency='CDN$';
 assert.throws(()=>collectPluginShapeCategoryPool(us),/currency/);
});
