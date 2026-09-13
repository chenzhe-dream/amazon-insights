import assert from 'node:assert/strict';
import test from 'node:test';
import {collectMarketKeywordTrend} from '../../server/services/market-keyword-collector';
import {projectKeywordComparisonMonths} from '../../server/domain/market-research/keyword-comparison-months';
import {buildMarketKeywordRuleReport} from '../../server/domain/market-research/keyword-rule-report';
import {buildMarketKeywordRevision} from '../../server/domain/market-research/keyword-revision';
import {MarketKeywordFactsSchema} from '../../shared/market-keyword-public-contracts';
import {MarketKeywordComparisonMonthsSchema} from '../../shared/market-keyword-comparison-contracts';
import {MarketKeywordRuleReportSchema} from '../../shared/market-keyword-rule-report-contracts';
import {canonicalJsonSha256 as digest} from '../../server/runtime/model-request-accounting';
import {keywordPageRun,keywordUserId} from './helpers/market-keyword-page-fixture';

function rehash(facts:ReturnType<typeof keywordPageRun>['run']['facts']){
 const {factsId:_previous,...body}=facts!;void _previous;facts!.factsId=`market-keyword-facts:${digest(body)}`;
}
async function fixture(){
 const facts=keywordPageRun().run.facts!,fetchedAt='2026-09-12T00:00:00.000Z';let calls=0;
 const source=await collectMarketKeywordTrend({scope:facts.scope,jobId:'comparison-projection-test',keyword:'shelf lamp',connector:{id:'sorftime',probe:async()=>{throw new Error('Unused');},execute:async()=>{
  calls++;return {data:{data:{keyword:'shelf lamp',search_volume_trend:['2025-08 search volume 80','2026-05 search volume 100','2026-07 search volume 160','2026-08 search volume 200'],search_rank_trend:[],recommended_bid_trend:[]}},source:{connectorId:'sorftime',operation:'keyword_trend',fetchedAt,attemptCount:1}};
 }}},new Date(fetchedAt));
 assert.notEqual(source.status,'failed');if(source.status==='failed')throw new Error('Collector failed');
 assert.deepEqual(source.months.map(m=>m.month),['2026-07','2026-08']);assert.equal(calls,1);
 const reference=source.months.at(-1)!,member=facts.members[0];
 member.keywordId=source.memberId;member.sourceRef=`market-source:${digest(source.evidence)}`;
 member.trend={status:source.status,stepId:facts.moduleRunId,attemptId:facts.moduleRunId,inputSnapshotId:`market-input:${digest(source)}`,sourceRef:member.sourceRef,fetchedAt,cpcCurrency:null,months:structuredClone([...source.months]),comparisonMonths:projectKeywordComparisonMonths(source,facts.referenceMonth)};
 member.reference={...member.reference,searchVolume:reference.searchVolume.value,yoyGrowth:reference.yoyGrowth.value,recentGrowth:reference.recentGrowth.value};
 facts.members=[member];facts.pool.uniqueObservedMemberCount=1;facts.semantics.unavailableKeywordIds=[member.keywordId];rehash(facts);
 return {facts,source};
}

test('the full saved source supplies baselines omitted from the displayed research window',async()=>{
 const {facts}=await fixture(),report=buildMarketKeywordRuleReport({facts,classification:null}),w5=report.keywords[0].w5;
 assert.equal(report.version,'market-keyword-rule-report/v2');assert.equal(w5.yoyGrowth.value,1.5);assert.equal(w5.recentGrowth.value,.25);assert.equal(w5.threeMonthGrowth.value,1);
 assert.equal(w5.threeMonthGrowth.baselineMonth,'2026-05');assert.equal(w5.threeMonthGrowth.baselineValue,100);assert.equal(w5.threeMonthGrowth.source!.sourceRef,facts.members[0].trend.sourceRef);
 assert.deepEqual(facts.members[0].trend.months.map(m=>m.month),['2026-07','2026-08'],'Display coverage remains the requested scope');
 assert.equal(facts.members[0].trend.comparisonMonths!.months.length,4);
});

test('legacy immutable facts recover retained YoY/MoM baselines without inventing the unsaved M-3 value',async()=>{
 const {facts}=await fixture();delete facts.members[0].trend.comparisonMonths;rehash(facts);
 const classification={labels:{W1:[],W2:[],W3:[],W4:[]},clusters:[],assignments:facts.members.map(m=>({keywordId:m.keywordId,W1:[],W2:[],W3:[],W4:[],clusterId:null}))};
 const revision=buildMarketKeywordRevision({facts,authorId:keywordUserId,createdAt:'2026-09-13T00:00:00.000Z',request:{factsId:facts.factsId,expectedParentRevisionId:null,...classification,note:'Legacy facts'}}),before=digest(revision);
 const report=buildMarketKeywordRuleReport({facts,classification:{kind:'manual',revision}}),w5=report.keywords[0].w5;
 assert.equal(w5.yoyGrowth.value,1.5);assert.equal(w5.yoyGrowth.baselineValue,80);assert.equal(w5.recentGrowth.value,.25);assert.equal(w5.threeMonthGrowth.value,null);assert.equal(w5.threeMonthGrowth.reason,'missing-baseline');
 assert.equal(digest(revision),before);assert.equal(MarketKeywordFactsSchema.parse(facts).factsId,facts.factsId);
 assert.ok(MarketKeywordRuleReportSchema.safeParse({...report,version:'market-keyword-rule-report/v1'}).success,'Transport can still read archived v1 shapes');
});

test('comparison projection rejects wrong windows, overlap conflicts and tampered retained baselines',async()=>{
 const {facts}=await fixture();const original=structuredClone(facts.members[0].trend.comparisonMonths!);
 assert.equal(MarketKeywordComparisonMonthsSchema.safeParse({...original,referenceMonth:'2026-07'}).success,false);
 for(const mutate of [
  (f:typeof facts)=>{f.members[0].trend.comparisonMonths!.months[3].searchVolume.value=99;},
  (f:typeof facts)=>{f.members[0].trend.comparisonMonths!.months[0].searchVolume.value=99;},
  (f:typeof facts)=>{f.members[0].trend.months[1].yoyGrowth.baselineMonth='2025-07';},
  (f:typeof facts)=>{delete f.members[0].trend.comparisonMonths;f.members[0].trend.months[1].yoyGrowth.value=99;},
 ]){const changed=structuredClone(facts);mutate(changed);rehash(changed);assert.throws(()=>buildMarketKeywordRuleReport({facts:changed,classification:null}),/comparison|baseline|growth/);}
 const missing=structuredClone(facts);missing.members[0].trend.comparisonMonths!.months[1].searchVolume={value:null,reason:'missing'};rehash(missing);
 assert.equal(buildMarketKeywordRuleReport({facts:missing,classification:null}).keywords[0].w5.threeMonthGrowth.value,null);
 const zero=structuredClone(facts);zero.members[0].trend.comparisonMonths!.months[1].searchVolume.value=0;rehash(zero);
 assert.equal(buildMarketKeywordRuleReport({facts:zero,classification:null}).keywords[0].w5.threeMonthGrowth.reason,'zero-baseline');
});
