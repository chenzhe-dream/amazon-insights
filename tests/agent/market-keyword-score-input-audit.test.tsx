import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {keywordRuleFixture} from './helpers/market-keyword-rule-fixture';
import {canonicalJsonSha256 as digest} from '../../server/runtime/model-request-accounting';
import {buildMarketKeywordRuleReport} from '../../server/domain/market-research/keyword-rule-report';
import {buildMarketKeywordScoreInputAudit} from '../../server/domain/market-research/keyword-score-input-audit';
import {MarketKeywordScoreInputAuditSchema,assertKeywordScoreInputAuditBinding} from '../../shared/market-keyword-score-input-audit-contracts';
import {MarketKeywordRunResponseSchema} from '../../shared/market-keyword-public-contracts';
import {MarketKeywordRulesReport} from '../../app/market-keyword-rule-report';
import {readKeywordRun,readKeywordRevision} from '../../app/lib/market-keyword-browser';
import {buildMarketKeywordRevision} from '../../server/domain/market-research/keyword-revision';

function fixture(){const {response}=keywordRuleFixture({aba:true});return {facts:response.run.facts!,report:response.run.ruleReport!,response};}
test('saved ABA zero and failed member retain evidence without inventing cluster inputs or changing old identities',()=>{
 const {facts,report}=fixture(),before=digest({facts,report});
 const audit=buildMarketKeywordScoreInputAudit({facts,report});
 assert.equal(audit.version,'market-keyword-score-input-audit/v1');
 assert.equal(audit.factsId,facts.factsId);assert.equal(audit.reportId,report.reportId);
 const aba=audit.clusters[0].inputs.find(i=>i.field==='abaTop3Share')!;
 assert.deepEqual(aba.knownMemberIds,[facts.members[0].keywordId]);
 assert.equal(aba.reason,'aba-top3-cluster-aggregation-method-not-verified');
 assert.equal(audit.members[0].abaClick.value,0);assert.equal(audit.members[1].abaClick.status,'failed');
 assert.deepEqual(audit.members[0].abaClick.sourcePath,['keywords',0,'top3_click_shares',0]);
 assert.equal(report.clusters[0].score.pvs,null);assert.equal(digest({facts,report}),before);
 assert.deepEqual(MarketKeywordScoreInputAuditSchema.parse(JSON.parse(JSON.stringify(audit))),audit);
 assertKeywordScoreInputAuditBinding(audit,facts,report);
});
test('undated USD page bid and monthly unknown-currency bid remain distinct and never become actual CPC',()=>{
 const {facts,report}=fixture(),audit=buildMarketKeywordScoreInputAudit({facts,report});
 const member=audit.members[0];
 assert.equal(member.pageRecommendedBid.currency,'USD');assert.equal(member.pageRecommendedBid.referenceMonth,null);
 assert.equal(member.trendRecommendedBid.currency,null);assert.equal(member.trendRecommendedBid.referenceMonth,facts.referenceMonth);
 const input=audit.clusters[0].inputs.find(i=>i.field==='suggestedBid')!;
 assert.ok(input.blockers.includes('source-window-unspecified'));assert.ok(input.blockers.includes('currency-unconfirmed'));
 assert.equal(input.value,null);assert.equal(facts.members[0].reference.actualCpcUsd,null);
});
test('conversion-only ABA does not count as click coverage; unclassified reports still retain original member audit',()=>{
 const {facts,response}=fixture();facts.members[0].aba!.member!.top3ClickShare={value:null,reason:'missing-value',path:['keywords',0,'top3_click_shares',0]};
 facts.members[0].aba!.member!.top3ConversionShare={value:.4,reason:null,path:['keywords',0,'top3_conversion_shares',0]};
 const {factsId:_,...basis}=facts;void _;facts.factsId=`market-keyword-facts:${digest(basis)}`;
 const report=buildMarketKeywordRuleReport({facts,classification:{kind:'global',report:response.run.reconciliation!}});
 const audit=buildMarketKeywordScoreInputAudit({facts,report});
 assert.deepEqual(audit.clusters[0].inputs.find(i=>i.field==='abaTop3Share')!.knownMemberIds,[]);
 assert.equal(audit.members[0].abaConversion.value,.4);
 const unclassified=buildMarketKeywordScoreInputAudit({facts,report:buildMarketKeywordRuleReport({facts,classification:null})});
 assert.equal(unclassified.clusters.length,0);assert.equal(unclassified.members.length,facts.members.length);
});
test('foreign facts/report/member evidence are rejected rather than displayed under the current cluster',()=>{
 const {facts,report}=fixture();
 assert.throws(()=>buildMarketKeywordScoreInputAudit({facts,report:{...report,factsId:`market-keyword-facts:${'f'.repeat(64)}`}}),/binding/i);
 const wrong=structuredClone(report);wrong.clusters[0].score.memberIds=['foreign'];assert.throws(()=>buildMarketKeywordScoreInputAudit({facts,report:wrong}),/member/i);
 const audit=buildMarketKeywordScoreInputAudit({facts,report});audit.members[0].abaClick.sourceRef=`market-source:${'f'.repeat(64)}`;
 assert.throws(()=>assertKeywordScoreInputAuditBinding(audit,facts,report),/evidence/i);
 const falseCoverage=buildMarketKeywordScoreInputAudit({facts,report});falseCoverage.clusters[0].inputs.find(i=>i.field==='abaTop3Share')!.knownMemberIds.push(facts.members[1].keywordId);
 assert.throws(()=>assertKeywordScoreInputAuditBinding(falseCoverage,facts,report),/coverage/i);
 const suppressedZero=buildMarketKeywordScoreInputAudit({facts,report});suppressedZero.members[0].abaClick.value=null;
 assert.throws(()=>assertKeywordScoreInputAuditBinding(suppressedZero,facts,report),/evidence/i);
});
test('optional public sibling is backward-compatible and current details explain blockers and rule formulas',()=>{
 const {facts,report,response}=fixture(),audit=buildMarketKeywordScoreInputAudit({facts,report});
 MarketKeywordRunResponseSchema.parse(response);
 assert.deepEqual(MarketKeywordRunResponseSchema.parse({run:{...response.run,scoreInputAudit:audit}}).run.scoreInputAudit,audit);
 const html=renderToStaticMarkup(<MarketKeywordRulesReport report={report} scoreInputAudit={audit}/>);
 for(const text of ['成员级 ABA 点击份额已保存','来源窗口未注明','趋势推荐竞价币种未确认','供需比的正式来源与供给分母','SPR 的正式来源','关键词到商品的映射','0.28','mid-rank','keyword-pvs/2.0.0','待验证'])assert.ok(html.includes(text),text);
 assert.ok(renderToStaticMarkup(<MarketKeywordRulesReport report={report}/>).includes('待验证'));
});
test('missing bid observations are reported as not collected rather than existing observations with unknown units',()=>{
 const {facts,response}=fixture();for(const member of facts.members){member.pageMetrics.recommendedCpcUsd={value:null,reason:'missing'};for(const month of member.trend.months)month.recommendedBid={value:null,reason:'missing'};}
 const {factsId:_,...basis}=facts;void _;facts.factsId=`market-keyword-facts:${digest(basis)}`;
 const report=buildMarketKeywordRuleReport({facts,classification:{kind:'global',report:response.run.reconciliation!}}),audit=buildMarketKeywordScoreInputAudit({facts,report});
 const bid=audit.clusters[0].inputs.find(i=>i.field==='suggestedBid')!;
 assert.deepEqual(bid.knownMemberIds,[]);assert.deepEqual(bid.blockers,['source-not-collected','cluster-aggregation-unverified']);
});

test('growth in input audit uses the same percentage unit as the saved scoring explanation',()=>{
 const {facts,report}=fixture(),audit=buildMarketKeywordScoreInputAudit({facts,report});
 assert.equal(audit.clusters[0].inputs.find(input=>input.field==='threeMonthGrowth')!.value,1);
 const html=renderToStaticMarkup(<MarketKeywordRulesReport report={report} scoreInputAudit={audit}/>);
 assert.ok(html.includes('<strong>较3个月前增长</strong>：100.0%；'));
 assert.ok(!html.includes('<strong>较3个月前增长</strong>：1；'));
});
test('public run and manual history transports preserve optional audit and reject a foreign audit without writes',async t=>{
 const {response,revision}=keywordRuleFixture({aba:true});
 response.run.scoreInputAudit=buildMarketKeywordScoreInputAudit({facts:response.run.facts!,report:response.run.ruleReport!});
 const saved={...revision,scoreInputAudit:buildMarketKeywordScoreInputAudit({facts:revision.catalog.facts,report:revision.ruleReport})};
 let reply:unknown=response,calls=0;
 t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{calls++;assert.equal(init.method??'GET','GET');return Response.json(reply);});
 assert.deepEqual((await readKeywordRun(response.run.id)).scoreInputAudit,response.run.scoreInputAudit);
 reply={revision:saved};assert.deepEqual((await readKeywordRevision(response.run.id,revision.catalog.revision.revisionId)).scoreInputAudit,saved.scoreInputAudit);
 reply={run:{...response.run,scoreInputAudit:saved.scoreInputAudit}};await assert.rejects(readKeywordRun(response.run.id),/binding/);
 reply={revision:{...saved,scoreInputAudit:response.run.scoreInputAudit}};await assert.rejects(readKeywordRevision(response.run.id,revision.catalog.revision.revisionId),/binding/);
 assert.equal(calls,4);
});
test('source-order facts may differ from canonical cluster member order in both global and manual reports',()=>{
 const {response,request,revision}=keywordRuleFixture({aba:true}),facts=response.run.facts!;
 facts.members.sort((a,b)=>a.keywordId<b.keywordId?1:-1);
 const {factsId:_,...basis}=facts;void _;facts.factsId=`market-keyword-facts:${digest(basis)}`;request.factsId=facts.factsId;
 const human=buildMarketKeywordRevision({facts,request,authorId:revision.catalog.revision.authorId,createdAt:revision.catalog.revision.createdAt});
 for(const classification of [{kind:'global' as const,report:response.run.reconciliation!},{kind:'manual' as const,revision:human}]){
  const report=buildMarketKeywordRuleReport({facts,classification});
  assert.notDeepEqual(report.clusters[0].score.memberIds,facts.members.map(m=>m.keywordId));
  const audit=buildMarketKeywordScoreInputAudit({facts,report});
  assert.deepEqual(audit.clusters[0].memberIds,report.clusters[0].score.memberIds);
  assert.deepEqual(audit.members.map(m=>m.keywordId),facts.members.map(m=>m.keywordId));
 }
});
