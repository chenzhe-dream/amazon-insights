import assert from 'node:assert/strict';
import test from 'node:test';
import {buildCheckedOverviewSynthesis} from '../../server/domain/market-research/overview-score-readiness';
import {buildMarketOverviewSynthesis} from '../../server/domain/market-research/original-overview/sellersprite-market-overview-synthesis';
import {mapNiche} from '../../server/domain/market-research/original-overview/original-mappers';
import {completeScoreFixture} from './helpers/overview-score-complete-fixture';

test('complete inputs preserve the original scores, prose and final decision exactly',()=>{
 const {niche,report}=completeScoreFixture();const result=buildCheckedOverviewSynthesis(niche,report);
 assert.deepEqual(result.summary,buildMarketOverviewSynthesis(niche,report));
 assert.equal(result.evaluation.status,'ready');
});
test('zero is observed; null, blank, boolean and invalid values are not numeric observations',()=>{
 for(const value of [null,undefined,'','  ',false,[],{},NaN,Infinity]){
  const result=mapNiche({totalUnits:value,top10ProductCrn:value},{},{marketplace:'US',topN:10,newProductMonths:6,fetchedAt:''});
  assert.equal(result.totalUnits,null,String(value));assert.equal(result.productCrn,null);
 }
 const {niche,report}=completeScoreFixture();niche.productCrn=0;niche.brandCrn=0;niche.sellerCrn=0;
 assert.equal(buildCheckedOverviewSynthesis(niche,report).summary.scores.marketCompetition,20);
});
test('one missing concentration invalidates competition, but preserves independent demand and price scores',()=>{
 const {niche,report}=completeScoreFixture();const original=buildMarketOverviewSynthesis(niche,report);niche.brandCrn=null;
 const result=buildCheckedOverviewSynthesis(niche,report);
 assert.equal(result.summary.scores.marketCompetition,null);assert.equal(result.summary.score,null);assert.equal(result.summary.gradeLabel,null);
 assert.equal(result.summary.scores.marketDemand,original.scores.marketDemand);assert.equal(result.summary.scores.priceOpportunity,original.scores.priceOpportunity);
 assert.match(result.summary.sections.competition,/品牌集中度/);assert.doesNotMatch(result.summary.sections.competition,/中等竞争市场/);
});
test('unknown trends and zero comparison bases never earn non-declining or flat-growth conclusions',()=>{
 for(const points of [[],[{month:'2025-12',value:5}],Array.from({length:24},(_,i)=>({month:`${2024+Math.floor(i/12)}-${String(i%12+1).padStart(2,'0')}`,value:0}))]){
  const {niche,report}=completeScoreFixture();report.salesTrend=points;report.keywordTrends[0].points=points;
  const result=buildCheckedOverviewSynthesis(niche,report);
  assert.equal(result.summary.scores.marketDemand,null);assert.doesNotMatch(result.summary.crossSignals.join(' '),/同步|强增长市场/);
 }
});
test('missing structure blocks only dependent dimensions and missing profit cannot use estimated margin',()=>{
 const {niche,report}=completeScoreFixture();report.ratingCounts=[];
 let result=buildCheckedOverviewSynthesis(niche,report);assert.equal(result.summary.scores.marketMaturity,null);assert.equal(result.summary.scores.newEntryBarrier,null);assert.notEqual(result.summary.scores.marketCompetition,null);
 report.prices[1].items![0].profit=null;result=buildCheckedOverviewSynthesis(niche,report);
 assert.equal(result.summary.scores.priceOpportunity,null);assert.match(result.summary.sections.priceOpportunity,/毛利/);
 assert.doesNotMatch(result.summary.topOpportunities.join(' '),/优先价格带|高毛利价格带/);
});
test('each of the six dimensions rejects its missing required observation',()=>{
 const cases=[['marketDemand',(n:any,r:any)=>{n.totalUnits=null;}],['marketCompetition',(n:any,r:any)=>{n.sellerCrn=null;}],['marketMaturity',(n:any,r:any)=>{r.listingAge=[];}],['newEntryBarrier',(n:any,r:any)=>{n.newAvgUnits=null;}],['productOpportunity',(n:any,r:any)=>{n.returnRatio=null;}],['priceOpportunity',(n:any,r:any)=>{r.prices=[];}]] as const;
 for(const [key,mutate] of cases){const {niche,report}=completeScoreFixture();mutate(niche,report);const result=buildCheckedOverviewSynthesis(niche,report);assert.equal(result.summary.scores[key],null,key);assert.ok(result.evaluation.dimensions[key].missing.length);}
});
test('original computable price shares and a zero-search keyword do not falsely block complete data',()=>{
 const {niche,report}=completeScoreFixture();
 for(const row of report.prices){row.unitsShare=null;row.asinRatio=null;}
 report.keywordTrends.push({keyword:'zero',searches:0,points:report.keywordTrends[0].points.map(p=>({...p,value:0}))});
 assert.deepEqual(buildCheckedOverviewSynthesis(niche,report).summary,buildMarketOverviewSynthesis(niche,report));
});
test('source conflicts prevent dependent views judgments even if enough surviving points remain',()=>{
 const {niche,report}=completeScoreFixture();const result=buildCheckedOverviewSynthesis(niche,report,{views:['conflicting-demand-month']});
 assert.equal(result.summary.scores.marketDemand,null);assert.equal(result.summary.scores.productOpportunity,null);
 assert.doesNotMatch(result.summary.topOpportunities.join(' '),/浏览量近端继续增长/);
 assert.equal(result.summary.scores.marketCompetition,buildMarketOverviewSynthesis(niche,report).scores.marketCompetition);
});
test('price scoring stays available without optional class averages but default model estimates are not asserted',()=>{
 const {niche,report}=completeScoreFixture();niche.avgPrice=null;niche.avgProfit=null;
 const result=buildCheckedOverviewSynthesis(niche,report);
 assert.equal(result.summary.scores.priceOpportunity,buildMarketOverviewSynthesis(niche,report).scores.priceOpportunity);
 assert.doesNotMatch(result.summary.sections.priceOpportunity,/广告前毛利/);
});
test('complete inputs match original across concentration, rating, profitability and trend branches',()=>{
 for(let i=0;i<25;i++){
  const {niche,report}=completeScoreFixture();niche.avgProfit=60;niche.productCrn=i*4;niche.brandCrn=100-i*4;niche.sellerCrn=i*3;niche.newRatio=i*2;niche.totalUnits=i*10000;niche.ebcProportion=i*4;
  report.prices[0].items![0].profit=i*4-5;report.prices[1].items![0].profit=100-i*4;
  const result=buildCheckedOverviewSynthesis(niche,report);assert.deepEqual(result.summary,buildMarketOverviewSynthesis(niche,report),`sample ${i}`);
 }
});
test('keyword year-on-year needs the same keyword pool in both months without blocking independent demand scoring',()=>{
 const {niche,report}=completeScoreFixture();report.keywordTrends.push({keyword:'short-history',searches:100,points:report.keywordTrends[0].points.slice(-12)});
 const result=buildCheckedOverviewSynthesis(niche,report);
 assert.notEqual(result.summary.scores.marketDemand,null);
 assert.doesNotMatch(result.summary.crossSignals.join(' '),/需求扩张速度|新增商品增速|供需增速/);
 assert.doesNotMatch(result.summary.topRisks.join(' '),/新增商品增速/);
});
