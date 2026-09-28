import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMarketKeywordRevision } from '../../server/domain/market-research/keyword-revision';
import { canonicalJsonSha256 as digest } from '../../server/runtime/model-request-accounting';
import type { MarketKeywordFacts } from '../../shared/market-keyword-public-contracts';
const uuid = '00000000-0000-4000-8000-000000000001', hash = 'a'.repeat(64);
function rawFixture(volumes: (number|null)[] = [10, 30, 0, null]) {
  const missing = { value: null, reason: 'missing' }, value = {
    version: 'market-keyword-facts/v1', moduleRunId: uuid,
    scope: { organizationId: uuid, researchId: uuid, marketplace: 'US', nodeIdPath: '12', fromMonth: '2026-07', toMonth: '2026-08', currency: 'USD' }, referenceMonth: '2026-08',
    pool: { attemptId: uuid, rawInputSnapshotId: `market-input:${hash}`, semanticInputSnapshotId: `market-input:${hash}`, basisHash: hash, dataCutoffAt: '2026-09-01T00:00:00.000Z', plannedPageCount: 1, receivedPageCount: 1, missingPages: [], emptyPages: [], fullPages: [], collectionCoverage: 'complete', exhaustive: false, maxMembers: 2000, uniqueObservedMemberCount: volumes.length, omittedMemberIds: [], conflictingMemberIds: [], duplicateMemberCount: 0, memberLimitReached: false, selectionPolicy: 'seed-page-source-order/first-observation/v1' },
    members: volumes.map((searchVolume, i) => ({ keywordId: `keyword:${i}`, keyword: `lamp ${i}`, sourceRef: `market-source:${hash}`, occurrences: [],
      pageMetrics: { monthlySearchVolume: { value: 999, reason: null }, weeklySearchVolume: missing, weeklySearchRank: missing, recommendedCpcUsd: { value: 4, reason: null }, period: 'unspecified-source-window' },
      trend: { status: 'empty', stepId: null, attemptId: null, inputSnapshotId: null, sourceRef: null, fetchedAt: null, cpcCurrency: null, months: [] },
      reference: { searchVolume, yoyGrowth: i === 0 ? 0 : i === 1 ? 1 : null, recentGrowth: i === 0 ? -1 : null, actualCpcUsd: null, actualCpcReason: 'source-provides-recommended-bid-only' } })),
    semantics: { status: 'unavailable', unavailableKeywordIds: volumes.map((_,i)=>`keyword:${i}`), unknownDimensionCount: 0, unknownClusterCount: 0, batches: [] }
  };
  const facts = { ...value, factsId: `market-keyword-facts:${digest(value)}` } as MarketKeywordFacts;
  const request = { factsId: facts.factsId, expectedParentRevisionId: null, labels: { W1: [{ labelId: 'human-new', label: '人工新标签', definition: '人工定义' }], W2: [], W3: [], W4: [] }, clusters: [{ clusterId: 'one', label: '同名', definition: '第一簇' }, { clusterId: 'two', label: '同名', definition: '第二簇' }], assignments: facts.members.map((m,i)=>({ keywordId:m.keywordId,W1:['human-new'],W2:[],W3:[],W4:[],clusterId:i<2?'one':null })), note: '人工校对' };
  return { facts, request, authorId: uuid, createdAt: '2026-09-13T00:00:00.000Z' };
}

import {buildMarketKeywordRuleReport} from '../../server/domain/market-research/keyword-rule-report';
function fixture(volumes:(number|null)[]=[10,30,60]){
 const f=rawFixture(volumes);
 for(const [i,m] of f.facts.members.entries()){
  m.trend.status='ready';m.trend.inputSnapshotId=f.facts.pool.rawInputSnapshotId;m.trend.sourceRef=m.sourceRef;m.trend.fetchedAt='2026-09-01T00:00:00.000Z';
  m.trend.months=['2025-08','2026-05','2026-07','2026-08'].map((month,j)=>({month,searchVolume:{value:j===3?volumes[i]:j===1?10:j===2?100:20,reason:j===3&&volumes[i]===null?'missing':null},searchRank:{value:null,reason:'missing'},recommendedBid:{value:8,reason:null},yoyGrowth:{value:null,reason:'missing-baseline',baselineMonth:'2024-08',baselineValue:null,formulaVersion:'calendar-month-growth/v1'},recentGrowth:{value:null,reason:'missing-baseline',baselineMonth:'2026-06',baselineValue:null,formulaVersion:'calendar-month-growth/v1'}}));
 }
 rehash(f.facts);return f;
}
function rehash(facts:MarketKeywordFacts){const {factsId,...basis}=facts;facts.factsId=`market-keyword-facts:${digest(basis)}`;}
function manual(f:ReturnType<typeof fixture>){f.request.factsId=f.facts.factsId;return {kind:'manual' as const,revision:buildMarketKeywordRevision(f)};}
function abaFixture(){
 const f=fixture();
 for(const member of f.facts.members){
  const previous=member.keywordId,next=`kw_${digest(member.keyword)}`;member.keywordId=next;
  f.request.assignments.find(assignment=>assignment.keywordId===previous)!.keywordId=next;
  f.facts.semantics.unavailableKeywordIds=f.facts.semantics.unavailableKeywordIds.map(id=>id===previous?next:id);
 }
 rehash(f.facts);return f;
}
function setAba(f:ReturnType<typeof abaFixture>,index:number,status:'pending'|'failed'|'ready'|'partial',clickShare:number|null,conversionShare:number|null= null){
 const member=f.facts.members[index],collected=status==='ready'||status==='partial';
 member.aba={status,stepId:uuid,attemptId:uuid,inputSnapshotId:collected?`market-input:${'b'.repeat(64)}`:null,sourceRef:collected?`market-source:${'b'.repeat(64)}`:null,
  fetchedAt:collected?'2026-09-01T00:00:00.000Z':null,referenceMonth:f.facts.referenceMonth,sourceScope:'exact-keyword-marketplace',nodeBinding:'not-provided',member:collected?{
   keyword:member.keyword,memberId:member.keywordId,referenceMonth:f.facts.referenceMonth,keywordPath:['keywords',index,'keyword'],monthPath:['keywords',index,'dates',0],
   searchVolume:{value:100,reason:null,path:['keywords',index,'volumes',0]},
   top3ClickShare:clickShare===null?{value:null,reason:'missing-value',path:['keywords',index,'top3_click_shares',0]}:{value:clickShare,reason:null,path:['keywords',index,'top3_click_shares',0]},
   top3ConversionShare:conversionShare===null?{value:null,reason:'missing-value',path:['keywords',index,'top3_conversion_shares',0]}:{value:conversionShare,reason:null,path:['keywords',index,'top3_conversion_shares',0]},
  }:null};
 rehash(f.facts);
}
test('original weighted members and unassigned pool denominator survive uneven merges',()=>{
 const f=fixture(),r=buildMarketKeywordRuleReport({facts:f.facts,classification:manual(f)});
 assert.equal(r.aggregation.pool.totalSearchVolume,100);assert.equal(r.aggregation.unassigned.totalSearchVolume,60);
 assert.equal(r.clusters[0].score.searchVolumeSharePercent,40);assert.equal(r.clusters[0].threeMonthGrowth.metric.value,1.5);
 assert.equal(r.keywords[0].w5.recentGrowth.value,-.9);assert.equal(r.keywords[0].w5.threeMonthGrowth.value,0);
 assert.equal(r.clusters[0].score.pvs,null);assert.equal(r.clusters[0].score.status,'pending');
 assert.equal(r.keywords[0].w5.seasonality.status,'unavailable');assert.equal(r.clusters[0].metrics.suggestedBid.value,null);
 assert.equal(r.reportId,'market-keyword-rule-report:0a2a9cb8bad2e5321d1b47c28d984d8c48e04350b47c0b3476034ac0dd2cf637','legacy facts without ABA retain their report identity');
});
test('zero baseline, negative growth, missing histories and field coverage remain explicit',()=>{
 const f=fixture([0,30,60]);f.facts.members[0].trend.months[1].searchVolume.value=10;f.facts.members[1].trend.months[1].searchVolume.value=0;rehash(f.facts);
 const r=buildMarketKeywordRuleReport({facts:f.facts,classification:manual(f)});
 assert.equal(r.keywords[0].w5.threeMonthGrowth.value,-1);assert.equal(r.keywords[1].w5.threeMonthGrowth.reason,'zero-baseline');
 assert.equal(r.clusters[0].threeMonthGrowth.metric.value,null);assert.equal(r.clusters[0].threeMonthGrowth.coverage.unknownValueCount,1);
 f.facts.members[1].trend.months=[];rehash(f.facts);const missing=buildMarketKeywordRuleReport({facts:f.facts,classification:null});assert.equal(missing.keywords[1].w5.searchVolume.value,null);
});
test('rejects tampered facts, duplicate months and classification foreign binding',()=>{
 const f=fixture(),classification=manual(f);f.facts.members[0].reference.searchVolume=999;assert.throws(()=>buildMarketKeywordRuleReport({facts:f.facts,classification}));
 rehash(f.facts);assert.throws(()=>buildMarketKeywordRuleReport({facts:f.facts,classification}));
 f.facts.members[0].trend.months.push(f.facts.members[0].trend.months[0]);rehash(f.facts);assert.throws(()=>buildMarketKeywordRuleReport({facts:f.facts,classification:null}));
});
import {MarketKeywordRuleReportSchema} from '../../shared/market-keyword-rule-report-contracts';
import type {MarketKeywordReconciliationReport} from '../../shared/market-keyword-reconciliation-contracts';
function globalReport(f:ReturnType<typeof fixture>):MarketKeywordReconciliationReport{
 const unknown={status:'unknown' as const,candidateIds:[],reason:'insufficient-evidence',evidence:[]};
 return {version:'keyword-reconciliation-report/v1',moduleRunId:f.facts.moduleRunId,inputSnapshotId:f.facts.pool.semanticInputSnapshotId,status:'ready',completedRounds:1,resultHash:'b'.repeat(64),catalog:[{candidateId:'global-one',dimension:'cluster',label:'Global',definition:'Global demand',evidence:[]}],decisions:f.facts.members.map((m,i)=>({keywordId:m.keywordId,W1:unknown,W2:unknown,W3:unknown,W4:unknown,cluster:i<2?{status:'supported',candidateIds:['global-one'],reason:null,evidence:[]}:unknown}))};
}
test('global final assignments and manual revisions remain separate while pending remains useful',()=>{
 const f=fixture(),global=globalReport(f),report=buildMarketKeywordRuleReport({facts:f.facts,classification:{kind:'global',report:global}}),human=buildMarketKeywordRuleReport({facts:f.facts,classification:manual(f)});
 assert.equal(report.classification.identity,global.resultHash);assert.notEqual(report.reportId,human.reportId);assert.equal(report.aggregation.unassigned.totalSearchVolume,60);
 const pending={...global,status:'waiting-initial-models' as const,resultHash:null,decisions:[]};const p=buildMarketKeywordRuleReport({facts:f.facts,classification:{kind:'global',report:pending}});
 assert.equal(p.clusters.length,0);assert.equal(p.keywords[0].w5.threeMonthGrowth.value,0);assert.equal(p.classification.identity,null);
 assert.notEqual(p.reportId,buildMarketKeywordRuleReport({facts:f.facts,classification:{kind:'global',report:{...pending,status:'pending'}}}).reportId);
 assert.deepEqual(MarketKeywordRuleReportSchema.parse(JSON.parse(JSON.stringify(report))),report);
 assert.ok(report.rankPools.length<=7);assert.equal('comparisonClusterIds' in report.clusters[0].score.ranks.searchVolume,false);
});
test('rejects incomplete, repeated, foreign and multi-cluster global materializations',()=>{
 for(const change of [(r:MarketKeywordReconciliationReport)=>{r.decisions.pop();},(r:MarketKeywordReconciliationReport)=>{r.decisions[1].keywordId=r.decisions[0].keywordId;},(r:MarketKeywordReconciliationReport)=>{r.decisions[0].keywordId='foreign';},(r:MarketKeywordReconciliationReport)=>{r.inputSnapshotId='market-input:'+ 'f'.repeat(64);},(r:MarketKeywordReconciliationReport)=>{r.decisions[0].cluster.candidateIds.push('global-one');},(r:MarketKeywordReconciliationReport)=>{r.decisions[0].cluster.candidateIds=['foreign'];}]){
  const f=fixture(),report=globalReport(f);change(report);assert.throws(()=>buildMarketKeywordRuleReport({facts:f.facts,classification:{kind:'global',report}}));
 }
});
test('growth ignores legacy monthly/reference values and exposes partial original-member coverage',()=>{
 const f=fixture();f.facts.members[1].trend.months=f.facts.members[1].trend.months.filter(m=>m.month!=='2026-05');f.facts.members[0].reference.recentGrowth=999;f.facts.members[0].reference.searchVolume=999;rehash(f.facts);
 const r=buildMarketKeywordRuleReport({facts:f.facts,classification:manual(f)});assert.equal(r.keywords[0].w5.searchVolume.value,10);assert.equal(r.keywords[0].w5.threeMonthGrowth.value,0);
 assert.equal(r.clusters[0].threeMonthGrowth.coverage.weightSum,10);assert.equal(r.clusters[0].threeMonthGrowth.coverage.unknownValueCount,1);assert.ok(r.clusters[0].score.limitations.includes('partial-member-three-month-coverage'));
 const oldId=r.reportId;f.request.note='New revision';assert.notEqual(buildMarketKeywordRuleReport({facts:f.facts,classification:manual(f)}).reportId,oldId);
});
test('conflicting source references and incomplete current month cannot become known evidence',()=>{
 const f=fixture();f.facts.members[1].trend.sourceRef='market-source:'+ 'e'.repeat(64);rehash(f.facts);assert.throws(()=>buildMarketKeywordRuleReport({facts:f.facts,classification:null}),/Conflicting/);
 const g=fixture();g.facts.members[0].trend.months[3].searchVolume.reason='incomplete-month';rehash(g.facts);const r=buildMarketKeywordRuleReport({facts:g.facts,classification:null});assert.equal(r.keywords[0].w5.searchVolume.value,null);assert.equal(r.keywords[0].w5.threeMonthGrowth.reason,'missing-current');
});
test('many-cluster public ranks share pools instead of copying quadratic identity arrays',t=>{
 const f=fixture(Array.from({length:200},()=>10));f.request.clusters=f.facts.members.map((_,i)=>({clusterId:`c${i}`,label:`cluster ${i}`,definition:'Synthetic distinct group'}));f.request.assignments.forEach((a,i)=>{a.clusterId=`c${i}`;});
 const start=performance.now(),r=buildMarketKeywordRuleReport({facts:f.facts,classification:manual(f)});
 assert.equal(r.clusters.length,200);assert.ok(r.rankPools.length<=7);
 for(const c of r.clusters)for(const rank of Object.values(c.score.ranks)){assert.ok(r.rankPools.some(p=>p.id===rank.comparisonPoolId));assert.equal('comparisonClusterIds' in rank,false);}
 t.diagnostic(`200 original members/clusters: ${Math.round(performance.now()-start)} ms; ${Buffer.byteLength(JSON.stringify(r))} serialized bytes; ${r.rankPools.length} shared rank pools`);
});
test('verified original-member ABA zero changes only the merged cluster missing reason',()=>{
 for(const status of ['ready','partial'] as const){const f=abaFixture();setAba(f,0,status,0);setAba(f,1,'failed',null);
  const report=buildMarketKeywordRuleReport({facts:f.facts,classification:manual(f)}),aba=report.clusters[0].metrics.abaTop3Share;
  assert.deepEqual(aba,{value:null,evidence:null,missingReason:'aba-top3-cluster-aggregation-method-not-verified'});
  assert.equal(report.clusters[0].score.pvs,null);assert.equal(report.clusters[0].score.status,'pending');
  assert.deepEqual(MarketKeywordRuleReportSchema.parse(JSON.parse(JSON.stringify(report))),report);
 }
});
test('non-click ABA, pending, missing and failed members remain not collected',()=>{
 const cases=[
  (f:ReturnType<typeof abaFixture>)=>setAba(f,0,'ready',null,.4),
  (f:ReturnType<typeof abaFixture>)=>setAba(f,0,'partial',null),
  (f:ReturnType<typeof abaFixture>)=>setAba(f,0,'pending',null),
  (f:ReturnType<typeof abaFixture>)=>setAba(f,0,'failed',null),
  (f:ReturnType<typeof abaFixture>)=>{delete f.facts.members[0].aba;rehash(f.facts);},
  (f:ReturnType<typeof abaFixture>)=>{setAba(f,0,'ready',.2);f.facts.members[0].aba!.inputSnapshotId=null;rehash(f.facts);},
  (f:ReturnType<typeof abaFixture>)=>{setAba(f,0,'ready',.2);f.facts.members[0].aba!.sourceRef=null;rehash(f.facts);},
  (f:ReturnType<typeof abaFixture>)=>{setAba(f,0,'ready',.2);f.facts.members[0].aba!.fetchedAt=null;rehash(f.facts);},
 ];
 for(const arrange of cases){const f=abaFixture();arrange(f);const report=buildMarketKeywordRuleReport({facts:f.facts,classification:manual(f)});
  assert.equal(report.clusters[0].metrics.abaTop3Share.missingReason,'aba-top3-not-collected');
 }
});
test('ABA member evidence must bind the original member id, keyword and reference month',()=>{
 const changes=[
  (f:ReturnType<typeof abaFixture>)=>{f.facts.members[0].aba!.member!.memberId=`kw_${'f'.repeat(64)}`;},
  (f:ReturnType<typeof abaFixture>)=>{f.facts.members[0].aba!.member!.keyword='foreign keyword';},
  (f:ReturnType<typeof abaFixture>)=>{f.facts.members[0].aba!.member!.referenceMonth='2026-07';},
 ];
 for(const change of changes){const f=abaFixture();setAba(f,0,'ready',.2);change(f);rehash(f.facts);
  assert.throws(()=>buildMarketKeywordRuleReport({facts:f.facts,classification:null}),/ABA member binding mismatch/);
 }
});

function historicalFixture(values:number[]=Array.from({length:12},(_,i)=>i<6?10:i<9?20:40)){
 const f=fixture([values.at(-1)!,values.at(-1)!,values.at(-1)!]);
 for(const member of f.facts.members){
  const template=member.trend.months.at(-1)!;
  const history=values.map((value,index)=>{const date=new Date(Date.UTC(2026,7-values.length+1+index,1));return {...template,month:date.toISOString().slice(0,7),searchVolume:{value,reason:null}};});
  member.trend.months=[history.at(-1)!];
  Object.assign(member.trend,{historyMonths:history});
 }
 rehash(f.facts);return f;
}
test('original history compares equal 6-month sums and recent 3-month sums with versioned lifecycle',()=>{
 const f=historicalFixture(),r=buildMarketKeywordRuleReport({facts:f.facts,classification:manual(f)});
 assert.equal(r.version,'market-keyword-rule-report/v3');
 assert.equal(r.keywords[0].w5.yoyGrowth.value,2);
 assert.equal(r.keywords[0].w5.threeMonthGrowth.value,1);
 assert.equal(r.keywords[0].w5.threeMonthGrowth.currentValue,120);
 assert.equal(r.keywords[0].w5.threeMonthGrowth.baselineValue,60);
 assert.equal(r.keywords[0].w5.threeMonthLabel,'近3月合计较前3月');
 assert.equal(r.keywords[0].w5.lifecycle.status,'computed');
 assert.equal((r.keywords[0].w5.lifecycle as any).diagnosis,'growing');
 assert.equal(r.clusters[0].score.demandClass,'mainstream');
 assert.equal(r.clusters[0].score.pvs,null);assert.equal(r.clusters[0].score.keywordValidationTier,null);
 assert.equal((r.clusters[0] as any).development.status,'hypothesis');
 assert.equal((r.clusters[0] as any).development.priority,null);
 assert.deepEqual(MarketKeywordRuleReportSchema.parse(JSON.parse(JSON.stringify(r))),r);
});
test('missing calendar history and zero baselines remain missing without neutral lifecycle inputs',()=>{
 for(const mode of ['gap','zero','short'] as const){
  const f=historicalFixture(mode==='zero'?Array(12).fill(0):mode==='short'?Array(6).fill(40):undefined);
  if(mode==='gap')for(const m of f.facts.members)(m.trend as any).historyMonths.splice(8,1);
  rehash(f.facts);const r=buildMarketKeywordRuleReport({facts:f.facts,classification:manual(f)});
  assert.equal(r.keywords[0].w5.yoyGrowth.value,null);
  assert.equal(r.keywords[0].w5.lifecycle.status,'unavailable');
  if(mode!=='short')assert.equal(r.keywords[0].w5.threeMonthGrowth.value,null);
 }
});
test('original lifecycle thresholds distinguish stable and weakening without claiming structural decline',()=>{
 for(const [recent,expected] of [[10,'mature_stable'],[1,'recent_weakening']] as const){
  const f=historicalFixture(Array.from({length:12},(_,i)=>i<6?10:recent));
  const r=buildMarketKeywordRuleReport({facts:f.facts,classification:manual(f)});
  assert.equal((r.keywords[0].w5.lifecycle as any).diagnosis,expected);
  assert.equal(r.clusters[0].score.keywordValidationTier,null);
 }
});

import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MarketKeywordRulesReport} from '../../app/market-keyword-rule-report';
import {buildMarketKeywordScoreInputAudit} from '../../server/domain/market-research/keyword-score-input-audit';
test('original report UI and input audit explain window sums and pending development validation',()=>{
 const f=historicalFixture(),report=buildMarketKeywordRuleReport({facts:f.facts,classification:manual(f)});
 const audit=buildMarketKeywordScoreInputAudit({facts:f.facts,report});
 const html=renderToStaticMarkup(React.createElement(MarketKeywordRulesReport,{report,scoreInputAudit:audit}));
 for(const expected of ['等长历史窗口','近3月合计较前3月','成长','主流需求','竞争象限','产品开发方向','验证优先级','可行性待验证'])assert.ok(html.includes(expected),expected);
 assert.ok(!html.includes('当前月 / 三个月前单月'));
 assert.ok(audit.formulas.some(f=>f.expression.includes('近3月合计 / 前3月合计')));
 assert.ok(!html.includes('生命周期仍缺少诊断依据'));
});

test('v3 contract rejects mixed formula versions and fabricated development priorities',()=>{
 const f=historicalFixture(),r=buildMarketKeywordRuleReport({facts:f.facts,classification:manual(f)});
 const mixed=structuredClone(r);mixed.threeMonthFormulaVersion='calendar-three-month-growth/v1';assert.equal(MarketKeywordRuleReportSchema.safeParse(mixed).success,false);
 const invented=structuredClone(r);invented.clusters[0].development!.priority='P1';assert.equal(MarketKeywordRuleReportSchema.safeParse(invented).success,false);
});
test('original 12-month windows cap long histories and reject gaps, future months and conflicting sources',()=>{
 const f=historicalFixture(Array.from({length:30},(_,i)=>i<18?10:20));
 const r=buildMarketKeywordRuleReport({facts:f.facts,classification:manual(f)});
 assert.equal(r.keywords[0].w5.yoyGrowth.window!.months,12);assert.equal(r.keywords[0].w5.yoyGrowth.value,1);
 const g=historicalFixture();g.facts.members[0].trend.historyMonths!.push({...g.facts.members[0].trend.months[0],month:'2026-09'});rehash(g.facts);
 assert.throws(()=>buildMarketKeywordRuleReport({facts:g.facts,classification:null}),/reference month/);
 const conflict=historicalFixture();conflict.facts.members[0].trend.months=structuredClone(conflict.facts.members[0].trend.months);conflict.facts.members[0].trend.historyMonths!.at(-1)!.searchVolume={value:999,reason:null};rehash(conflict.facts);
 assert.throws(()=>buildMarketKeywordRuleReport({facts:conflict.facts,classification:null}),/Conflicting/);
});

test('cluster lifecycle does not merge growth from incomplete member coverage into a complete diagnosis',()=>{
 const f=historicalFixture();f.facts.members[1].trend.historyMonths=f.facts.members[1].trend.historyMonths!.slice(-6);rehash(f.facts);
 const r=buildMarketKeywordRuleReport({facts:f.facts,classification:manual(f)});
 assert.equal(r.keywords[1].w5.lifecycle.status,'unavailable');assert.equal(r.clusters[0].lifecycle!.status,'unavailable');
});

test('rank-only older months cannot lengthen original search-volume comparison windows',()=>{
 const base=historicalFixture(Array.from({length:12},(_,i)=>i<6?10:20));
 const expected=buildMarketKeywordRuleReport({facts:base.facts,classification:manual(base)}).keywords[0].w5.yoyGrowth;
 const extended=historicalFixture(Array.from({length:24},(_,i)=>i<18?10:20));
 for(const member of extended.facts.members)for(const point of member.trend.historyMonths!.slice(0,12))point.searchVolume={value:null,reason:'missing'};
 rehash(extended.facts);
 const report=buildMarketKeywordRuleReport({facts:extended.facts,classification:manual(extended)});
 assert.equal(report.keywords[0].w5.yoyGrowth.value,1);
 assert.deepEqual(report.keywords[0].w5.yoyGrowth.window,expected.window);
 assert.equal(report.keywords[0].w5.yoyGrowth.currentValue,120);assert.equal(report.keywords[0].w5.yoyGrowth.baselineValue,60);
 for(const member of extended.facts.members)member.trend.historyMonths!.splice(16,1);
 rehash(extended.facts);
 const missing=buildMarketKeywordRuleReport({facts:extended.facts,classification:manual(extended)});
 assert.equal(missing.keywords[0].w5.yoyGrowth.window!.months,6,'Interior gaps do not compress the calendar span');
 assert.equal(missing.keywords[0].w5.yoyGrowth.value,null,'A real missing volume month still invalidates the comparison');
 assert.equal(missing.keywords[0].w5.lifecycle.status,'unavailable');
});
