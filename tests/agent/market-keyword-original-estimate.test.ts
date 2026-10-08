import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {existsSync,readFileSync} from 'node:fs';
import {buildKeywordOriginalEstimate, originalEstimateInput} from '../../server/domain/market-research/keyword-original-estimate';
import {buildAmazonKeywordDemandReport} from '../../server/domain/market-research/keyword-original-demand';
import {MarketKeywordOriginalEstimateSchema} from '../../shared/market-keyword-original-estimate-contracts';
import {keywordRuleFixture} from './helpers/market-keyword-rule-fixture';
import {canonicalJsonSha256 as digest} from '../../server/runtime/model-request-accounting';
import {buildMarketKeywordRevision} from '../../server/domain/market-research/keyword-revision';

function fixture(){const facts=structuredClone(keywordRuleFixture().response.run.facts!);facts.members.forEach((m,i)=>{m.pageMetrics.monthlySearchVolume={value:i?null:100,reason:i?'missing':null};m.pageMetrics.recommendedCpcUsd={value:1.5,reason:null};});const {factsId:_,...basis}=facts;facts.factsId=`market-keyword-facts:${digest(basis)}`;return facts;}
test('original sample uses page volume, not reference-month coverage; estimates never mutate facts',()=>{
 const facts=fixture(),before=JSON.stringify(facts),result=buildKeywordOriginalEstimate({facts,productSeed:'lamp'});
 assert.equal(result.report.scope.sampleCount,1);assert.equal(result.report.scope.totalMonthlyVolume,100);
 assert.equal(result.excludedKeywordIds.length,facts.members.length-1);
 assert.ok(result.report.synthesis.clusters.length);
 for(const c of result.report.synthesis.clusters){assert.equal(c.computed.s3,50);assert.equal(c.computed.s5,50);assert.ok(Number.isFinite(c.computed.pvs));}
 assert.deepEqual(MarketKeywordOriginalEstimateSchema.parse(result),result);assert.equal(JSON.stringify(facts),before);
 assert.throws(()=>buildKeywordOriginalEstimate({facts:{...facts,factsId:`market-keyword-facts:${'0'.repeat(64)}`},productSeed:'lamp'}),/identity/i);
});
test('empty effective pool retains an explicit insufficient-data report',()=>{
 const facts=fixture();facts.members.forEach(m=>m.pageMetrics.monthlySearchVolume={value:null,reason:'missing'});const {factsId:_,...basis}=facts;facts.factsId=`market-keyword-facts:${digest(basis)}`;
 const result=buildKeywordOriginalEstimate({facts,productSeed:'lamp'});assert.equal(result.report.status,'insufficient_data');assert.equal(result.report.synthesis.clusters.length,0);
});
test('multiple zero-volume members with history never break report with division by zero',()=>{
 const facts=fixture();facts.members.forEach((m,i)=>{m.keyword=i?'led lamp':'lamp';m.pageMetrics.monthlySearchVolume={value:0,reason:null};const base=m.trend.months[0];m.trend.historyMonths=Array.from({length:12},(_,j)=>({...base,month:`2025-${String(j+1).padStart(2,'0')}`,searchVolume:{value:10+j,reason:null}}));});
 const {factsId:_,...basis}=facts;facts.factsId=`market-keyword-facts:${digest(basis)}`;
 const result=buildKeywordOriginalEstimate({facts,productSeed:'lamp'});
 assert.equal(result.report.scope.sampleCount,2);assert.ok(result.report.synthesis.clusters.every(c=>Number.isFinite(c.computed.pvs)));
 const revision=buildMarketKeywordRevision({facts,request:{factsId:facts.factsId,expectedParentRevisionId:null,labels:{W1:[],W2:[],W3:[],W4:[]},clusters:[{clusterId:'zero-group',label:'零搜索量组',definition:'合法零值回归'}],assignments:facts.members.map(m=>({keywordId:m.keywordId,W1:[],W2:[],W3:[],W4:[],clusterId:'zero-group'})),note:''},authorId:keywordRuleFixture().revision.catalog.revision.authorId,createdAt:'2026-09-28T00:00:00.000Z'});
 assert.ok(buildKeywordOriginalEstimate({facts,productSeed:'lamp',revision}).report.synthesis.clusters.every(c=>Number.isFinite(c.computed.pvs)));
});
test('manual classification remains authoritative and estimate binds its identity',()=>{
 const {revision}=keywordRuleFixture();const result=buildKeywordOriginalEstimate({facts:revision.catalog.facts,productSeed:'lamp',revision:revision.catalog});
 assert.equal(result.classificationId,revision.catalog.revision.revisionId);
 assert.ok(result.report.synthesis.clusters.every(c=>c.name==='人工灯具组'));
 assert.throws(()=>buildKeywordOriginalEstimate({facts:fixture(),productSeed:'lamp',revision:revision.catalog}),/facts/i);
});
test('manual W1 labels feed the full estimate dimensions and synthesis',()=>{
 const facts=fixture();facts.members.forEach(member=>member.pageMetrics.monthlySearchVolume={value:100,reason:null});const {factsId:_,...basis}=facts;facts.factsId=`market-keyword-facts:${digest(basis)}`;
 const labels={W1:[{labelId:'shape-a',label:'形态甲',definition:'人工确认形态甲'},{labelId:'shape-b',label:'形态乙',definition:'人工确认形态乙'}],W2:[],W3:[],W4:[]};
 const revision=buildMarketKeywordRevision({facts,request:{factsId:facts.factsId,expectedParentRevisionId:null,labels,clusters:[],assignments:facts.members.map((member,index)=>({keywordId:member.keywordId,W1:[index?'shape-b':'shape-a'],W2:[],W3:[],W4:[],clusterId:null})),note:'人工形态校对'},authorId:keywordRuleFixture().revision.catalog.revision.authorId,createdAt:'2026-09-29T00:00:00.000Z'});
 const report=buildKeywordOriginalEstimate({facts,productSeed:'lamp',revision}).report;
 assert.deepEqual(report.dimensions.w1.rows.map(row=>row.label),['形态甲','形态乙']);
 assert.match(report.synthesis.headline,/形态甲/);
});
test('original engine matches supplied archive across missing inputs, merging and validation recommendations',async t=>{
 const path='C:/Users/EDY/.codex/project-notes/amazon-insights/ui-parity-20260914/reference/app/lib/product-keyword-demand-analysis.ts';
 if(!existsSync(path)){t.skip('Archive comparison requires the supplied reference checkout');return;}
 const reference=await import(pathToFileURL(path).href);
 const row=(keyword:string,volume:number|null,bid:number|null,months=24)=>({keyword,weeklySearchRank:null,weeklySearchVolume:null,monthlySearchVolume:volume,cpcExactBid:bid,peakSeason:null,yearlySearchVolume:{},trend:Array.from({length:months},(_,i)=>({month:`${2024+Math.floor(i/12)}-${String(i%12+1).padStart(2,'0')}`,volume:100+i*8,abaRank:null,cpc:null}))});
 for(const keywords of [[],[row('floor lamp',100,null,0)],[row('floor lamp',0,0),row('floor lamp for bedroom',null,2)],[row('floor lamp',100000,1),row('standing lamp for bedroom',3000,2,6),row('floor lamp for kids',1,null,0),row('led floor lamp',200,3)]]){
  const input={productName:'floor lamp',marketplace:'US',queryMode:'keyword_extends' as const,totalCount:keywords.length,fetchedPages:1,trendEnrichedCount:keywords.filter(k=>k.trend.length).length,keywords};
  assert.deepEqual(buildAmazonKeywordDemandReport(input),reference.buildAmazonKeywordDemandReport(input));
 }
});
test('saved real source replay matches archive output exactly and keeps finite scores',async t=>{
 if(!existsSync('test-results/keyword-recovered-real.json')||!existsSync('C:/Users/EDY/.codex/project-notes/amazon-insights/ui-parity-20260914/reference/app/lib/product-keyword-demand-analysis.ts')){t.skip('Requires local saved real response and supplied archive');return;}
 const facts=JSON.parse(readFileSync('test-results/keyword-recovered-real.json','utf8')).run.facts;
 const reference=await import(pathToFileURL('C:/Users/EDY/.codex/project-notes/amazon-insights/ui-parity-20260914/reference/app/lib/product-keyword-demand-analysis.ts').href);
 const input=originalEstimateInput(facts,'floor lamp');const estimate=buildKeywordOriginalEstimate({facts,productSeed:'floor lamp'});
 assert.deepEqual(estimate.report,JSON.parse(JSON.stringify(reference.buildAmazonKeywordDemandReport(input))));
 assert.ok(estimate.report.synthesis.clusters.length>0);assert.ok(estimate.report.synthesis.clusters.every(c=>Number.isFinite(c.computed.pvs)));
});
