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
 for(const [name,hash] of Object.entries(hashes)) assert.equal(createHash('sha256').update(readFileSync(new URL(`../../server/domain/market-research/original-overview/sellersprite-market-${name}.ts`,import.meta.url),'utf8').replace(/\r?\n/g,'\r\n').replace(/  \/\/ @ts-expect-error Original v6[^\r\n]*\r\n/,'')).digest('hex'),hash);
});

import {randomUUID} from 'node:crypto';
import {createMarketSourceEvidence} from '../../server/domain/market-research/source-evidence';
import {projectMarketOverviewOriginalSynthesis} from '../../server/domain/market-research/overview-original-synthesis';
import {mapNiche,distRows} from '../../server/domain/market-research/original-overview/original-mappers';
import {buildMarketOverviewSynthesis} from '../../server/domain/market-research/original-overview/sellersprite-market-overview-synthesis';
import {normalizeTrendPoints,buildSeasonalPhrase,rankConcentrationRows} from '../../server/domain/market-research/overview-original-synthesis';
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
 assert.equal(result.chapters?.length,15);
 assert.equal(result.chapters?.map(chapter=>chapter.id).join(','),'overview,demand-keywords,sales-trend,product-crn,brand-crn,seller-crn,seller-type,ebc,seller-country,product-demand,listing-age,listing-trend,rating-count,rating-value,price');
 assert.ok(result.chapters?.every(chapter=>chapter.status==='insufficient'));
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

test('chapter explanations follow original dynamic demand, maturity, rating and price rules',()=>{
 const rising=Array.from({length:12},(_,i)=>({month:`2025-${String(i+1).padStart(2,'0')}`,value:i<6?100:180}));
 const main={topProducts:100,totalUnits:120000,avgPrice:80,avgUnits:100,top10ProductCrn:.25,top10BrandCrn:.3,top10SellerCrn:.2,l6NewRatio:.2,l6NewAvgSales:90,ebcProportion:.2,fbaProportion:.7,amazonSelfProportion:.1};
 const stats={avgUnits:100};
 const prices=[{label:'50-100',products:100,unitsRatio:1,asinRatio:1,items:[{asin:'B000000001',price:80,profit:65}]}];
 const ratingCounts=[{label:'1-50',products:40,unitsRatio:.4,asinRatio:.4},{label:'500+',products:60,unitsRatio:.6,asinRatio:.6}];
 const ratingValues=[{label:'4.0-4.3',products:60,unitsRatio:.6,asinRatio:.6},{label:'4.4+',products:40,unitsRatio:.4,asinRatio:.4}];
 const listingAge=[{label:'3年以上',products:60,unitsRatio:.6,asinRatio:.6},{label:'1年以内',products:40,unitsRatio:.4,asinRatio:.4}];
 const listingTrend=[{label:'近6个月',products:40,unitsRatio:.4,asinRatio:.4},{label:'更早',products:60,unitsRatio:.6,asinRatio:.6}];
 const sellerTypes=[{label:'品牌卖家',products:70,unitsRatio:.7,asinRatio:.7},{label:'个人卖家',products:30,unitsRatio:.3,asinRatio:.3}];
 const ebc=[{label:'有A+有视频',products:20,unitsRatio:.2,asinRatio:.2},{label:'无A+无视频',products:80,unitsRatio:.8,asinRatio:.8}];
 const countries=[{label:'美国',products:60,unitsRatio:.6,asinRatio:.6},{label:'中国',products:40,unitsRatio:.4,asinRatio:.4}];
 const demand={seed:null,referenceMonth:scope.toMonth,status:'ready' as const,series:[{keyword:'scooter',searches:100000,points:rising,status:'ready' as const,sourceRef:'market-source:'+('a'.repeat(64)),errorCode:null}],issues:[]};
 const ready={status:'ready' as const,points:rising,sourceRefs:['market-source:'+('b'.repeat(64))],errorCode:null};
 const externalData={referenceMonth:scope.toMonth,salesTrend:ready,salesAmountTrend:ready,asinProfits:{status:'ready' as const,items:{B000000001:{profit:65,price:80,fba:null}},requestedAsins:['B000000001'],missingAsins:[],sourceRefs:['market-source:'+('c'.repeat(64))],errorCode:null}};
 const actual=projectMarketOverviewOriginalSynthesis({scope,parameters,sources:[source('market_research',main),source('market_research_statistics',stats),source('market_price_distribution',prices),source('market_listing_date_distribution',listingAge),source('market_listing_trend_distribution',listingTrend),source('market_ratings_count_distribution',ratingCounts),source('market_rating_distribution',ratingValues),source('market_seller_type_concentration',sellerTypes),source('market_ebc_distribution',ebc),source('market_seller_country_distribution',countries)],industryDemand:demand,externalData});
 const chapters=Object.fromEntries(actual.chapters!.map(chapter=>[chapter.id,chapter]));
 assert.match(chapters['demand-keywords'].conclusion,/增长|强增长/);
 assert.match(chapters['sales-trend'].conclusion,/增长|抬升/);
 assert.match(chapters['listing-age'].conclusion,/老品|成熟|新品/);
 assert.match(chapters['rating-count'].conclusion,/评论|Review/);
 assert.match(chapters['seller-type'].conclusion,/经营效率|履约/);
 assert.match(chapters.ebc.conclusion,/A\+|视频/);
 assert.match(chapters['seller-country'].conclusion,/效率|集中|供应链/);
 assert.match(chapters['listing-trend'].conclusion,/成长|竞争|吸引力/);
 assert.match(chapters.price.conclusion,/市场均价/);
 assert.doesNotMatch(chapters['demand-keywords'].conclusion,/成熟型需求市场/);
 assert.match(chapters['demand-keywords'].performance,/关键词 1 个/);
});

test('stable keyword demand does not infer market maturity',()=>{
 const points=Array.from({length:6},(_,index)=>({month:`2026-${String(index+1).padStart(2,'0')}`,value:100}));
 const demand={seed:null,referenceMonth:scope.toMonth,status:'ready' as const,series:[{keyword:'scooter',searches:100000,points,status:'ready' as const,sourceRef:'market-source:'+('a'.repeat(64)),errorCode:null}],issues:[]};
 const actual=projectMarketOverviewOriginalSynthesis({scope,parameters,sources:[source('market_research',{topProducts:100,totalUnits:120000})],industryDemand:demand});
 const chapter=actual.chapters!.find(item=>item.id==='demand-keywords')!;
 assert.doesNotMatch(chapter.conclusion,/成熟型需求市场/);
 assert.match(chapter.conclusion,/成熟度需结合上架年龄/);
});

test('keyword trend normalization aggregates duplicate months before seasonal conclusions',()=>{
 const points=[
  {month:'2026-03',value:20},{month:'2026-01',value:100},{month:'2026-01',value:30},
  {month:'2026-02',value:10},{month:'2026-04',value:80},{month:'2026-05',value:70},{month:'2026-06',value:60},
 ];
 assert.deepEqual(normalizeTrendPoints(points,'sum'),[
  {month:'2026-01',value:130},{month:'2026-02',value:10},{month:'2026-03',value:20},
  {month:'2026-04',value:80},{month:'2026-05',value:70},{month:'2026-06',value:60},
 ]);
 const phrase=buildSeasonalPhrase(normalizeTrendPoints(points,'sum'),'搜索需求');
 assert.doesNotMatch(phrase,/01、01/);
 assert.ok(phrase.includes('01月')&&phrase.indexOf('01月')<phrase.indexOf('02月'));
});

test('seasonal conclusions cap long month lists without repeating months',()=>{
 const points=Array.from({length:18},(_,index)=>({
  month:`${2025+Math.floor(index/12)}-${String(index%12+1).padStart(2,'0')}`,
  value:index%2===0?100:10,
 }));
 const phrase=buildSeasonalPhrase(points,'搜索需求');
 assert.ok(phrase.includes('等'));
 assert.ok(phrase.length<90);
 assert.doesNotMatch(phrase,/01月、01月/);
});

test('seasonal conclusions refuse non-contiguous month sequences',()=>{
 const points=['2025-01','2025-02','2025-03','2025-04','2025-06','2025-07']
  .map((month,index)=>({month,value:index%2?10:100}));
 const phrase=buildSeasonalPhrase(points,'搜索需求');
 assert.match(phrase,/月份不连续/);
 assert.doesNotMatch(phrase,/旺季集中|淡季集中/);
});

test('seasonal conclusions normalize cross-year months and show coverage years',()=>{
 const points=Array.from({length:24},(_,index)=>{
  const year=2024+Math.floor(index/12),month=String(index%12+1).padStart(2,'0');
  return {month:`${year}-${month}`,value:month==='11'||month==='12'?100:10};
 });
 const phrase=buildSeasonalPhrase(points,'搜索需求');
 assert.match(phrase,/11月（2年）/);
 assert.match(phrase,/12月（2年）/);
 assert.doesNotMatch(phrase,/2024-11|2025-11/);
});

test('concentration conclusions rank by validated unit share instead of provider row order',()=>{
 const rows: Array<{label:string;units:number;unitsShare:number;products:number;asinRatio:number}>=[
  {label:'B',units:80,unitsShare:20,products:1,asinRatio:20},
  {label:'A',units:100,unitsShare:60,products:1,asinRatio:60},
  {label:'C',units:50,unitsShare:20,products:1,asinRatio:20},
 ];
 assert.deepEqual(rankConcentrationRows(rows).map(row=>row.label),['A','B','C']);
});
