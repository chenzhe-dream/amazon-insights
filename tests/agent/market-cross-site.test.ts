import assert from 'node:assert/strict';
import test from 'node:test';
import {MarketAnalysisScopeSchema} from '../../shared/market-analysis-contracts';
import {MarketStudyRequestSchema} from '../../shared/market-module-contracts';
import {collectMarketKeywordPage} from '../../server/services/market-keyword-collector';
import {collectMarketKeywordAba} from '../../server/services/market-keyword-aba-collector';
import {createMarketSourceEvidence} from '../../server/domain/market-research/source-evidence';
import type {RemoteMcpConnector, ConnectorRequest} from '../../server/connectors/connector-contract';
import {collectMarketCustomerThemes} from '../../server/services/market-customer-themes-collector';
import {collectMarketProductPool} from '../../server/services/market-product-pool-collector';
import {projectMarketOverviewDistribution} from '../../server/services/market-overview-distribution-collector';
import {createMarketInputSnapshot} from '../../server/domain/market-research/snapshot';
import {marketKeywordMemberId} from '../../server/domain/market-research/keyword-source-normalization';
import {createMarketShapeRevision,buildMarketShapePriceCatalog} from '../../server/domain/market-research/shape-price-catalog';
import {canonicalJsonSha256 as digest} from '../../server/runtime/model-request-accounting';

const now = new Date('2026-09-15T00:00:00Z');
const scope = {organizationId:'site-test',researchId:'11111111-1111-4111-8111-111111111111',marketplace:'UK',currency:'GBP',nodeIdPath:'1:2',fromMonth:'2026-08',toMonth:'2026-08'} as const;
test('market scopes accept supported currency pairs and reject mismatches',()=>{
  for(const [marketplace,currency] of [['US','USD'],['UK','GBP'],['DE','EUR'],['FR','EUR'],['IT','EUR'],['ES','EUR'],['JP','JPY'],['CA','CAD']]){
    assert.equal(MarketAnalysisScopeSchema.safeParse({...scope,marketplace,currency}).success,true);
  }
  assert.equal(MarketAnalysisScopeSchema.safeParse({...scope,currency:'USD'}).success,false);
  const {organizationId,researchId,...study}=scope;
  assert.equal(MarketStudyRequestSchema.safeParse(study).success,true);
  assert.equal(MarketStudyRequestSchema.safeParse({...study,currency:'USD'}).success,false);
  for(const marketplace of ['IN','MX'])assert.equal(MarketAnalysisScopeSchema.safeParse({...scope,marketplace}).success,false);
});
test('UK keyword collection sends GB while preserving the raw echo and USD bid unit',async()=>{
  const calls:ConnectorRequest[]=[];
  const connector:RemoteMcpConnector={id:'sorftime',async probe(){throw Error('no probe');},async execute(request){calls.push(request);return {data:{site:'GB',data:[{keyword:'lamp',weekly_search_volume:10,weekly_search_rank:2,monthly_search_volume:40,recommended_cpc_bid:'1.25',seasonality:'Peak season of search volume: 11月'}]},source:{connectorId:'sorftime',operation:request.operation,fetchedAt:'2026-09-14T00:00:00Z',attemptCount:1}};}};
  const result=await collectMarketKeywordPage({scope,jobId:'job',seed:'lamp',page:1,connector},now);
  assert.equal(result.status,'ready');
  assert.equal((calls[0].input as any).keyword_support_site,'GB');
  assert.equal((result.evidence.payload as any).site,'GB');
  assert.equal(result.evidence.scope.marketplace,'UK');
  assert.equal((result.evidence.units.recommendedCpcUsd as any).currency,'USD');
});
test('cross currency exception is restricted to the documented Sorftime page bid',()=>{
  const input={scope,provider:'sellerSprite',operation:'market_product_concentration',requestIdentity:{marketplace:'UK'},responseIdentityPaths:{},payload:{},fetchedAt:'2026-09-14T00:00:00Z',observationPeriod:{kind:'unknown',reason:'not supplied'},units:{price:{status:'known',unit:'currency',currency:'USD',rawUnit:'USD'}},coverage:{receivedCount:0,expectedCount:null,truncation:{status:'unknown',reason:'not supplied'}}};
  assert.throws(()=>createMarketSourceEvidence(input,now),/currency conflicts/);
});
test('unverified non-US ABA support makes no supplier call and returns an explicit limitation',async()=>{
  let calls=0;
  const connector:RemoteMcpConnector={id:'sif',async probe(){throw Error('no probe');},async execute(){calls++;throw Error('no supplier call');}};
  const result=await collectMarketKeywordAba({scope,keywords:['lamp'],referenceMonth:'2026-08',jobId:'job',connector},now);
  assert.equal(result.status,'failed');
  if(result.status==='failed')assert.equal(result.failure.code,'unsupported-marketplace');
  assert.equal(calls,0);
});
test('UK Customers Say uses GB and rejects another site without changing raw evidence',async()=>{
  const calls:ConnectorRequest[]=[];
  let site='GB';
  const connector:RemoteMcpConnector={id:'sorftime',async probe(){throw Error('no probe');},async execute(request){calls.push(request);return {data:{site,asin:'B000000001',data:{customer_say:'Assembly summary',details:[{keyword:'assembly',content:'Easy assembly',mention:10,positive:8,negative:2,update_time:'2026-09-03'}]}},source:{connectorId:'sorftime',operation:request.operation,fetchedAt:'2026-09-14T00:00:00Z',attemptCount:1}};}};
  const input={scope,asin:'B000000001',jobId:'job',connector,now:()=>now};
  const result=await collectMarketCustomerThemes(input);
  assert.equal(result.result.status,'success');assert.equal(calls[0].input.site,'GB');
  assert.equal((result.evidence?.payload as Record<string,unknown>).site,'GB');
  assert.equal(result.evidence?.responseIdentity.marketplace.status,'verified');
  site='DE';const rejected=await collectMarketCustomerThemes(input);
  assert.equal(rejected.result.status,'failed');assert.equal(rejected.evidence,null);
});
test('Japanese product evidence replays into yen price bands with the documented site policy',async()=>{
  const jp={...scope,marketplace:'JP' as const,currency:'JPY' as const},calls:ConnectorRequest[]=[];
  const cutoff='2026-09-14T00:00:00Z',asin='B000000001';
  const connector:RemoteMcpConnector={id:'sellerSprite',async probe(){throw Error('no probe');},async execute(request){calls.push(request);return {data:{code:'OK',data:[{asin,title:'Fixture lamp',brand:'Fixture',price:2500,totalUnits:20,totalRevenue:50000,ranking:1,sellerName:'Fixture',sellerType:'FBA',shelfDate:'2025-01-01',rating:4,ratings:20}]},source:{connectorId:'sellerSprite',operation:request.operation,fetchedAt:cutoff,attemptCount:1}};}};
  const result=await collectMarketProductPool({scope:jp,month:'2026-08',poolSize:100,newProductMonths:6,jobId:'job',connector,now:()=>now});
  assert.equal(result.status,'ready');assert.ok(result.evidence);assert.equal((calls[0].input.request as Record<string,unknown>).marketplace,'JP');
  const source=result.evidence,sourceRef='market-source:'+digest(source);
  const snapshot=createMarketInputSnapshot({scope:jp,kind:'products',sourceVersion:'market-source-handlers/v1',ruleVersion:'source-normalization/v1',collectedAt:cutoff,expectedRecordIds:[asin],records:result.products.map(product=>({id:asin,scope:jp,data:{collection:'product-month',month:'2026-08',product,sourceRef}}))});
  const reference={month:'2026-08',snapshot,sourceRef};
  const revision=createMarketShapeRevision({scope:jp,basisSnapshotId:snapshot.snapshotId,selectedAsins:[asin],taxonomyVersion:'fixture/v1',labels:[],assignments:[],authorId:'fixture-author',createdAt:cutoff,parentRevisionId:null});
  const catalog=await buildMarketShapePriceCatalog({reference,history:[],sources:{[sourceRef]:source},revision,bands:[{id:'all',minInclusive:0,maxExclusive:null}],dataCutoffAt:cutoff,version:'market-shape-price-catalog/v3'});
  assert.equal(catalog.sourcePolicy?.marketplace,'JP');assert.equal(catalog.sourcePolicy?.currency,'JPY');
  assert.equal(catalog.products[0].referencePrice.currency,'JPY');assert.equal(catalog.products[0].referencePrice.value,2500);
  assert.equal(source.units.price.status,'unknown');assert.equal(source.responseIdentity.currency.status,'unverified');
  assert.equal(calls.length,1,'replay must not contact the supplier');
});
test('German distribution money stays EUR and foreign currency echoes are rejected',()=>{
  const de={...scope,marketplace:'DE' as const,currency:'EUR' as const};
  const input={scope:de,month:'2026-08',operation:'market_price_distribution' as const,headTopN:10 as const,newProductMonths:6 as const,fetchedAt:'2026-09-14T00:00:00Z',now,payload:{code:'OK',currency:'EUR',data:[{name:'10-20',products:1,units:20,revenue:300,asins:['B000000001']}]}};
  const result=projectMarketOverviewDistribution(input);
  assert.equal(result.distribution?.currency,'EUR');assert.equal(result.distribution?.rows[0].revenue,300);
  assert.equal((result.evidence?.units.revenue as {currency:string}).currency,'EUR');
  assert.throws(()=>projectMarketOverviewDistribution({...input,payload:{...input.payload,currency:'USD'}}));
});
test('same category and word at another site cannot reuse keyword or snapshot identities',()=>{
  const de={...scope,marketplace:'DE' as const,currency:'EUR' as const};
  assert.notEqual(marketKeywordMemberId(scope,'lamp'),marketKeywordMemberId(de,'lamp'));
  const input={scope,kind:'keywords' as const,sourceVersion:'fixture/v1',ruleVersion:'fixture/v1',collectedAt:'2026-09-14T00:00:00Z',expectedRecordIds:[],records:[]};
  assert.notEqual(createMarketInputSnapshot(input).snapshotId,createMarketInputSnapshot({...input,scope:de}).snapshotId);
});
