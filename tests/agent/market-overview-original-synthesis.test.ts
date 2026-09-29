import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const hashes={
 'overview-synthesis':'63e600da48dd435db1f2cd6c6a39eb7748b10d8b4db806f3ec20c48c3a9d8727',
 'price-analysis':'ba6a3bd54b98c4af3b13306e408a0d2faf4d1ce5720878e045b7513af8177495',
 'niche':'d3f0adf7646614007113fde71dd16ed5c13b7ab6fe8b6b123f1add1028b5fbfc',
};
test('pure original synthesis, price rules and niche types retain exact reference bytes',()=>{
 for(const [name,hash] of Object.entries(hashes)) assert.equal(createHash('sha256').update(readFileSync(new URL(`../../server/domain/market-research/original-overview/sellersprite-market-${name}.ts`,import.meta.url),'utf8').replace(/  \/\/ @ts-expect-error Original v6[^\n]*\n/,'')).digest('hex'),hash);
});

import {randomUUID} from 'node:crypto';
import {createMarketSourceEvidence} from '../../server/domain/market-research/source-evidence';
import {projectMarketOverviewOriginalSynthesis} from '../../server/domain/market-research/overview-original-synthesis';
import {mapNiche,distRows} from '../../server/domain/market-research/original-overview/original-mappers';
import {buildMarketOverviewSynthesis} from '../../server/domain/market-research/original-overview/sellersprite-market-overview-synthesis';
import {analyzePriceBands,interpretProfitMargin} from '../../server/domain/market-research/original-overview/sellersprite-market-price-analysis';
import type {SellerSpriteMarketReport} from '../../server/domain/market-research/original-overview/sellersprite-market-niche';
const scope={organizationId:randomUUID(),researchId:randomUUID(),marketplace:'US' as const,nodeIdPath:'123:456',fromMonth:'2026-07',toMonth:'2026-08',currency:'USD' as const};
const parameters={headTopN:10 as const,newProductMonths:6 as const};
const emptyReport=():SellerSpriteMarketReport=>({sampleSize:100,concentrationSampleSize:100,productDemand:null,products:[],brands:[],sellers:[],sellerTypes:[],ebc:[],countries:[],listingAge:[],listingTrend:[],ratingCounts:[],ratingValues:[],prices:[],keywordTrends:[],salesTrend:[],salesAmountTrend:[]});
const niche=(main:Record<string,unknown>={},stats:Record<string,unknown>={})=>mapNiche(main,stats,{marketplace:'US',topN:10,newProductMonths:6,fetchedAt:''});
function source(operation:string,values:Record<string,unknown>|Record<string,unknown>[],month='2026-08',currency='USD'){
 const data=Array.isArray(values)?{items:values}:{...values};
 const raw={nodeIdPath:scope.nodeIdPath,month,marketplace:'US',...(currency?{currency}:{}),...data};
 const path=operation==='market_research'?['data','items',0]:['data'];
 return createMarketSourceEvidence({scope,provider:'sellerSprite',operation,requestIdentity:{nodeIdPath:scope.nodeIdPath,marketplace:'US',month},responseIdentityPaths:{nodeIdPath:[[...path,'nodeIdPath']],month:[[...path,'month']],...(currency==='USD'?{currency:[[...path,'currency']]}:{})},payload:{code:'OK',data:operation==='market_research'?{items:[raw]}:raw},fetchedAt:'2026-09-12T00:00:00.000Z',observationPeriod:{kind:'calendar-months',fromMonth:month,toMonth:month},units:{},coverage:{receivedCount:1,expectedCount:1,truncation:{status:'not-truncated'}}});
}
const project=(sources:ReturnType<typeof source>[])=>projectMarketOverviewOriginalSynthesis({scope,parameters,sources});
test('v4 synthesis excludes exactly the same conflicting and future demand months as the visible projection',()=>{
 const items=Array.from({length:12},(_,i)=>({date:`2025-${String(i+1).padStart(2,'0')}-01`,glanceViews:100}));items.push({date:'2025-12-01',glanceViews:999999},{date:'2026-09-01',glanceViews:999999});
 const emptySeries={status:'not-collected' as const,points:[],sourceRefs:[],errorCode:null},externalData={referenceMonth:scope.toMonth,salesTrend:emptySeries,salesAmountTrend:emptySeries,asinProfits:{status:'not-collected' as const,items:{},requestedAsins:[],missingAsins:[],sourceRefs:[],errorCode:null}};
 const actual=projectMarketOverviewOriginalSynthesis({scope,parameters,sources:[source('market_product_demand_trend',{items,returnRatio:null})],externalData});
 const report=emptyReport();report.productDemand={asinCount:null,returnRatio:null,avgReturnRatio:null,searchToPurchaseRatio:null,avgSearchToPurchaseRatio:null,pageViews:items.slice(0,11).map(r=>({month:r.date,value:r.glanceViews})),updatedAt:'2025-11-01'};
 assert.equal(actual.summary.score,null);assert.equal(actual.summary.scores.marketDemand,null);assert.ok(actual.inputGaps.some(g=>g.includes('conflicting-demand-month')));
 assert.ok(actual.evaluation!.dimensions.productOpportunity.missing.some(g=>g.includes('conflicting-demand-month')));
});

test('no sources never publishes original default scores or entry recommendation',()=>{
 const result=project([]);
 assert.equal(result.summary.score,null);
 assert.equal(result.summary.gradeLabel,null);
 assert.deepEqual(Object.values(result.summary.scores),[null,null,null,null,null,null]);
 assert.ok(result.inputGaps.some(g=>g.includes('Sorftime')));
 assert.deepEqual(result.sourceRefs,[]);
});

test('aggregate mapping preserves real zero and selected windows while null remains unknown',()=>{
 const main={totalUnits:0,avgUnits:0,avgPrice:0,avgRating:0,ebcProportion:0,amazonSelfProportion:0,fbaProportion:0,returnRatio:0,avgReturnRatio:0,searchToPurchaseRatio:0,top10ProductCrn:0,top10BrandCrn:null,top10SellerCrn:.55,l6NewRatio:0,l6NewAvgSales:0,top10ProductSales:0};
 const stats={avgUnits:100,avgPrice:100,hlAvgUnits:100};
 const result=project([source('market_research',main),source('market_research_statistics',stats)]);
 assert.equal(result.summary.score,null);assert.equal(result.summary.scores.marketCompetition,null);
 assert.equal(niche(main,stats).hlAvgUnits,0);
 assert.equal(niche(main,stats).brandCrn,null); // Missing concentration cannot become observed zero.
 for(const topN of [5,10,20] as const)for(const months of [1,3,6,12] as const){
  const raw={top5ProductCrn:.2,top10ProductCrn:.4,top20ProductCrn:.6,l1NewRatio:.01,l3NewRatio:.03,l6NewRatio:.06,l12NewRatio:.12};
  const actual=projectMarketOverviewOriginalSynthesis({scope,parameters:{headTopN:topN,newProductMonths:months},sources:[source('market_research',raw)]});
  const mapped=mapNiche(raw,{}, {marketplace:'US',topN,newProductMonths:months,fetchedAt:''});assert.equal(mapped.productCrn,topN===5?20:topN===10?40:60);assert.equal(mapped.newRatio,months);assert.equal(actual.summary.scores.marketCompetition,null);
 }
});

test('adapter uses original raw ratios rather than derived shares or aggregate profit',()=>{
 const raw=[{label:'0-10',products:50,units:1,unitsRatio:.8,unitsSharePct:1,asinRatio:.5,avgProfit:99,items:[{asin:'B000000001',price:8,profit:49.9}]},{label:'10-20',products:50,units:99,totalUnitsRatio:.2,unitsSharePct:99,asinRatio:.5,avgProfit:1,items:[{asin:'B000000002',price:15,profit:65.1}]}];
 const report=emptyReport();report.prices=distRows(raw,r=>String(r.label));
 const main={totalUnits:10000,avgPrice:20,avgProfit:99};
 const actual=project([source('market_research',main),source('market_price_distribution',raw)]);
 assert.equal(actual.summary.score,null);assert.equal(actual.summary.scores.priceOpportunity,buildMarketOverviewSynthesis(niche(main),report).scores.priceOpportunity);
 assert.equal(report.prices[0].unitsShare,80);
 const noProfits=raw.map(r=>({...r,items:r.items.map(({profit,...p})=>p)}));
 const missing=project([source('market_research',main),source('market_price_distribution',noProfits)]);
 assert.ok(missing.inputGaps.some(g=>g.includes('毛利率样本缺失')));
 assert.notEqual(actual.summary.sections.priceOpportunity,missing.summary.sections.priceOpportunity);
});

test('wrong research, month and monetary currency cannot feed the original summary',()=>{
 const good=source('market_research',{totalUnits:900000,avgPrice:200});
 const foreign={...good,scope:{...good.scope,researchId:randomUUID()}};
 assert.deepEqual(project([foreign]).summary,project([]).summary);
 assert.deepEqual(project([source('market_research',{totalUnits:900000},'2026-07')]).summary,project([]).summary);
 const prices=[{label:'0-20',products:100,unitsRatio:1,asinRatio:1,items:[{asin:'B000000001',profit:90,price:10}]}];
 const wrong=project([source('market_price_distribution',prices,'2026-08','EUR')]);
 assert.deepEqual(wrong.summary,project([]).summary);
 assert.ok(wrong.inputGaps.some(g=>g.includes('币种未确认')));
});

test('original exact price thresholds are preserved at 50, 65 and 70',()=>{
 assert.equal(interpretProfitMargin(49.999).tier,'low');
 assert.equal(interpretProfitMargin(50).tier,'medium');
 assert.equal(interpretProfitMargin(70).tier,'excellent');
 const rows=(profit:number)=>distRows([{label:'10-20',products:50,unitsRatio:.5,asinRatio:.5,items:[{asin:'B000000001',price:15,profit}]},{label:'20-30',products:50,unitsRatio:.5,asinRatio:.5,items:[{asin:'B000000002',price:25,profit:40}]}],r=>String(r.label));
 assert.notDeepEqual(analyzePriceBands(rows(65),niche()),analyzePriceBands(rows(65.001),niche()));
});

test('saved product demand points and fallback retain original complete summary',()=>{
 const items=Array.from({length:12},(_,i)=>({month:`2025-${String(i+1).padStart(2,'0')}`,glanceViews:i<6?100:200}));
 const raw={items};
 const report=emptyReport();report.productDemand={asinCount:null,returnRatio:null,avgReturnRatio:null,searchToPurchaseRatio:null,avgSearchToPurchaseRatio:null,pageViews:items.map(r=>({month:r.month,value:r.glanceViews})),updatedAt:'2025-12'};
 const actual=project([source('market_product_demand_trend',raw)]);
 assert.equal(actual.summary.score,null);assert.equal(actual.summary.scores.marketDemand,null);
 assert.ok(!actual.inputGaps.some(g=>g.includes('商品浏览量')));
 const empty=project([source('market_product_demand_trend',{items:[]})]);
 assert.ok(empty.inputGaps.some(g=>g.includes('商品浏览量趋势来源返回空数据')));
});

test('original request-bound currency keeps price rows without echoes, but rejects explicit conflict',()=>{
 const raw=[{label:'0-10',products:50,unitsRatio:.8,asinRatio:.5,items:[{asin:'B000000001',price:8,profit:70}]},{label:'10-20',products:50,unitsRatio:.2,asinRatio:.5,items:[{asin:'B000000002',price:15,profit:40}]}];
 const withoutEcho=project([source('market_price_distribution',raw,'2026-08','')]);
 const echoed=project([source('market_price_distribution',raw)]);
 assert.deepEqual(withoutEcho.summary,echoed.summary);
 assert.ok(!withoutEcho.inputGaps.some(g=>g.includes('币种未确认')));
 const conflict=project([source('market_price_distribution',raw,'2026-08','EUR')]);
 assert.deepEqual(conflict.summary,project([]).summary);
});

test('original brand and seller ranking labels and raw shares appear in complete competition prose',()=>{
 const brands=[{brand:'Brand One',totalUnitsRatio:.35,unitsRatio:.9}],sellers=[{sellerName:'Seller One',totalUnitsRatio:.25,unitsRatio:.8}];
 const actual=project([source('market_research',{top10ProductCrn:.3,top10BrandCrn:.35,top10SellerCrn:.25}),source('market_brand_concentration',brands),source('market_seller_concentration',sellers)]);
 assert.match(actual.summary.sections.competition,/Top 品牌 Brand One 占 35.0%/);
 assert.match(actual.summary.sections.competition,/头部卖家 Seller One 占 25.0%/);
});
