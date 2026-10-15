import test from 'node:test';
import assert from 'node:assert/strict';
import {keywordRuleFixture} from './helpers/market-keyword-rule-fixture';
import {originalEstimateInput} from '../../server/domain/market-research/keyword-original-estimate';
import {buildMarketKeywordRuleReport} from '../../server/domain/market-research/keyword-rule-report';
import {buildKeywordOriginalClassification} from '../../server/domain/market-research/keyword-original-classification';
import {canonicalJsonSha256 as digest} from '../../server/runtime/model-request-accounting';

function fixture(status:'empty'|'failed'|'pending'='empty'){
 const facts=structuredClone(keywordRuleFixture().response.run.facts!);
 const member=facts.members[0];member.trend.status=status;
 const base=member.trend.months[0];
 member.trend.historyMonths=['2026-04','2026-05','2026-06','2026-07'].map((month,i)=>({...base,month,searchVolume:{value:[0,100,200,300][i],reason:null}}));
 member.trend.months=[{...base,month:facts.referenceMonth,searchVolume:{value:null,reason:'missing'},yoyGrowth:{...base.yoyGrowth,value:null,reason:'missing-current'},recentGrowth:{...base.recentGrowth,value:null,reason:'missing-current'}}];
 member.reference={...member.reference,searchVolume:null,yoyGrowth:null,recentGrowth:null};
 const {factsId:_,...basis}=facts;facts.factsId=`market-keyword-facts:${digest(basis)}`;
 return facts;
}

test('empty research month retains verified historical points including zero without inventing reference data',()=>{
 const facts=fixture(),before=JSON.stringify(facts);
 const rows=originalEstimateInput(facts,'lamp').keywords;
 assert.deepEqual(rows[0].trend.map(p=>p.volume),[0,100,200,300]);
 assert.ok(rows[0].trend.every(p=>p.month!==facts.referenceMonth));
 const report=buildMarketKeywordRuleReport({facts,classification:{kind:'local',report:buildKeywordOriginalClassification(facts,'lamp')}});
 assert.equal(report.keywords[0].w5.searchVolume.value,null);
 assert.equal(report.keywords[0].w5.recentGrowth.baselineValue,300);
 assert.equal(report.keywords[0].w5.recentGrowth.value,null);
 assert.equal(report.keywords[0].w5.yoyGrowth.value,null);
 assert.equal(JSON.stringify(facts),before);
});

test('failed or pending trend cannot contribute historical estimates',()=>{
 for(const status of ['failed','pending'] as const){
  const facts=fixture(status);
  assert.deepEqual(originalEstimateInput(facts,'lamp').keywords[0].trend,[]);
 }
 const facts=fixture();facts.members[0].trend.historyMonths=[];
 assert.deepEqual(originalEstimateInput(facts,'lamp').keywords[0].trend,[]);
});
