import assert from 'node:assert/strict';
import test from 'node:test';
import {buildItemCheckedOverviewSynthesis} from '../../server/domain/market-research/overview-item-scoring';
import {buildCheckedOverviewSynthesis} from '../../server/domain/market-research/overview-score-readiness';
import {buildMarketOverviewSynthesis} from '../../server/domain/market-research/original-overview/sellersprite-market-overview-synthesis';
import {completeScoreFixture} from './helpers/overview-score-complete-fixture';

test('complete observations retain every v6 score and total across thresholds',()=>{
 for(let i=0;i<26;i++){
  const {niche,report}=completeScoreFixture();
  niche.productCrn=i*4;niche.brandCrn=100-i*4;niche.sellerCrn=i*3;niche.newRatio=i;niche.totalUnits=i*10000;
  niche.ebcProportion=i*4;report.prices[0].items![0].profit=i*4-5;report.prices[1].items![0].profit=100-i*4;
  const result=buildItemCheckedOverviewSynthesis(niche,report),raw=buildMarketOverviewSynthesis(niche,report);
  assert.deepEqual(result.summary.scores,raw.scores,`sample ${i}`);assert.equal(result.summary.score,raw.score);assert.equal(result.summary.gradeLabel,raw.gradeLabel);assert.equal(result.evaluation.status,'ready');
 }
});
test('missing trends preserve scale, product evidence and structural price score without defaults',()=>{
 const {niche,report}=completeScoreFixture();niche.totalUnits=297651;report.keywordTrends=[];report.salesTrend=[];report.productDemand!.pageViews=[];
 for(const row of report.prices)for(const item of row.items??[])item.profit=null;
 const result=buildItemCheckedOverviewSynthesis(niche,report);
 assert.equal(result.summary.scores.marketDemand,6);assert.equal(result.evaluation.dimensions.marketDemand.status,'partial');
 assert.notEqual(result.summary.scores.productOpportunity,null);assert.notEqual(result.summary.scores.priceOpportunity,null);
 assert.equal(result.summary.score,null);assert.equal(result.summary.gradeLabel,null);
 assert.doesNotMatch(JSON.stringify(result.summary),/需求结构相对稳定|广告前毛利|新增商品增速快于需求/);
 assert.equal(buildCheckedOverviewSynthesis(niche,report).summary.scores.marketDemand,null,'v1 stays frozen');
});
test('missing one concentration preserves independent concentration items',()=>{
 const {niche,report}=completeScoreFixture();niche.productCrn=0;niche.brandCrn=null;niche.sellerCrn=0;
 const result=buildItemCheckedOverviewSynthesis(niche,report);
 assert.equal(result.summary.scores.marketCompetition,13);assert.equal(result.evaluation.dimensions.marketCompetition.status,'partial');assert.equal(result.summary.score,null);
 assert.equal(result.evaluation.dimensions.marketCompetition.items?.filter(i=>i.status==='missing').length,1);
});
test('a real zero is known while an absent fact receives no points',()=>{
 const {niche,report}=completeScoreFixture();niche.totalUnits=0;
 const result=buildItemCheckedOverviewSynthesis(niche,report);assert.equal(result.evaluation.dimensions.marketDemand.items?.find(i=>i.id==='scale')?.score,2);
 niche.totalUnits=null;const missing=buildItemCheckedOverviewSynthesis(niche,report);assert.equal(missing.evaluation.dimensions.marketDemand.items?.find(i=>i.id==='scale')?.score,null);
});
test('invalid or conflicting trends never receive the non-declining bonus',()=>{
 const {niche,report}=completeScoreFixture();const result=buildItemCheckedOverviewSynthesis(niche,report,{sales:['来源冲突']});
 assert.equal(result.evaluation.dimensions.marketDemand.items?.find(i=>i.id==='not-declining')?.score,null);
 assert.equal(result.evaluation.dimensions.marketDemand.items?.find(i=>i.id==='sales-growth')?.score,null);
 assert.notEqual(result.summary.scores.marketDemand,null);assert.equal(result.summary.score,null);
});
test('monthly keyword volume remains observed when the separate history request fails',()=>{
 const {niche,report}=completeScoreFixture();report.keywordTrends[0].points=[];
 const result=buildItemCheckedOverviewSynthesis(niche,report,{keywords:['history-timeout']});
 assert.equal(result.evaluation.dimensions.marketDemand.items?.find(i=>i.id==='searches')?.score,4);
 assert.equal(result.evaluation.dimensions.marketDemand.items?.find(i=>i.id==='keyword-growth')?.score,null);
 const failed=buildItemCheckedOverviewSynthesis(niche,report,{keywordSearches:['query-failed']});
 assert.equal(failed.evaluation.dimensions.marketDemand.items?.find(i=>i.id==='searches')?.score,null);
});
test('a missing monthly keyword volume does not invalidate its observed historical trend',()=>{
 const {niche,report}=completeScoreFixture();report.keywordTrends[0].searches=null;
 const result=buildItemCheckedOverviewSynthesis(niche,report);
 assert.equal(result.evaluation.dimensions.marketDemand.items?.find(i=>i.id==='searches')?.score,null);
 assert.equal(result.evaluation.dimensions.marketDemand.items?.find(i=>i.id==='keyword-growth')?.score,6);
 assert.equal(result.evaluation.dimensions.marketDemand.items?.find(i=>i.id==='not-declining')?.score,4);
});
test('all unavailable inputs have no confirmed baseline or phantom grade',()=>{
 const {niche,report}=completeScoreFixture();for(const key of Object.keys(niche))if(typeof (niche as any)[key]==='number')(niche as any)[key]=null;
 for(const key of Object.keys(report))if(Array.isArray((report as any)[key]))(report as any)[key]=[];
 report.productDemand=null;report.asinProfits={};
 const result=buildItemCheckedOverviewSynthesis(niche,report);
 assert.ok(Object.values(result.summary.scores).every(s=>s===null));assert.equal(result.evaluation.status,'insufficient');assert.equal(result.summary.score,null);
});
