import assert from 'node:assert/strict';
import {keywordRuleFixture} from './helpers/market-keyword-rule-fixture';
import {MarketKeywordRulesReport} from '../../app/market-keyword-rule-report';
import test from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createKeywordStudy, startKeywordRun, readKeywordRun, retryKeywordSteps, cancelKeywordRun, saveKeywordRevision, readKeywordRevision} from '../../app/lib/market-keyword-browser';
import {MarketKeywordFactsReport, MarketKeywordRevisionReport, MarketKeywordAuditReport} from '../../app/market-keyword-report';
import {keywordPageRun, keywordRunId, keywordUserId} from './helpers/market-keyword-page-fixture';
import {buildMarketKeywordRevision} from '../../server/domain/market-research/keyword-revision';
import {canonicalJsonSha256 as digest} from '../../server/runtime/model-request-accounting';

function revisionFixture(){
 const facts=keywordPageRun().run.facts!;
 const request={factsId:facts.factsId,expectedParentRevisionId:null,labels:{W1:[{labelId:'shelf',label:'层架灯',definition:'包含层架'}],W2:[],W3:[],W4:[]},clusters:[{clusterId:'human',label:'人工阅读照明',definition:'人工确认阅读用途'}],assignments:facts.members.map(m=>({keywordId:m.keywordId,W1:['shelf'],W2:[],W3:[],W4:[],clusterId:'human'})),note:'人工审核记录'};
 return {request,catalog:buildMarketKeywordRevision({facts,request,authorId:keywordUserId,createdAt:'2026-09-13T00:00:00.000Z'})};
}
async function withFetch(reply:(path:string,init:RequestInit)=>Response|Promise<Response>,action:()=>Promise<void>){const old=globalThis.fetch;globalThis.fetch=(path,init)=>Promise.resolve(reply(String(path),init??{}));try{await action();}finally{globalThis.fetch=old;}}

test('keyword transport validates inputs before network and uses authenticated same-origin no-store requests',async()=>{
 let calls=0;const sample=keywordPageRun(),controller=new AbortController();
 await withFetch((path,init)=>{calls++;assert.equal(path,`/api/agent/v1/market-analysis/studies/${sample.run.scope.researchId}/keywords`);assert.equal(init.credentials,'same-origin');assert.equal(init.cache,'no-store');assert.equal(init.signal,controller.signal);assert.equal(new Headers(init.headers).get('idempotency-key'),keywordUserId);assert.deepEqual(JSON.parse(init.body as string),sample.run.params);return Response.json(sample);},async()=>{
  await assert.rejects(readKeywordRun('../escape'));await assert.rejects(startKeywordRun(sample.run.scope.researchId,{},keywordUserId));assert.equal(calls,0);
  assert.equal((await startKeywordRun(sample.run.scope.researchId,sample.run.params,keywordUserId,controller.signal)).id,keywordRunId);
 });
});
test('keyword run rejects wrong run, study, request and every mismatching facts scope field',async()=>{
 const sample=keywordPageRun();
 for(const mutate of [(r:typeof sample)=>{r.run.id=keywordUserId;},(r:typeof sample)=>{r.run.facts!.moduleRunId=keywordUserId;},...(['organizationId','researchId','nodeIdPath','fromMonth','toMonth'] as const).map(field=>(r:typeof sample)=>{r.run.facts!.scope[field]=field==='fromMonth'?'2026-06':field==='toMonth'?'2026-09':field==='nodeIdPath'?'9:8':keywordRunId;}),(r:typeof sample)=>{r.run.facts!.referenceMonth='2026-07';}]){
  const changed=structuredClone(sample);mutate(changed);await withFetch(()=>Response.json(changed),async()=>{await assert.rejects(readKeywordRun(keywordRunId),/身份|范围|月份/);});
 }
 await withFetch(()=>Response.json(sample),async()=>{await assert.rejects(startKeywordRun(keywordUserId,sample.run.params,keywordUserId),/研究|身份|范围/);await assert.rejects(startKeywordRun(sample.run.scope.researchId,{...sample.run.params,maxMembers:200},keywordUserId),/参数/);});
});
test('study creation checks complete requested scope and study identity',async()=>{
 const {scope}=keywordPageRun().run;const {organizationId,researchId,...input}=scope;void organizationId;
 const result={study:{id:researchId,scope,createdAt:'2026-09-13T00:00:00.000Z'}};
 await withFetch(()=>Response.json(result),async()=>{assert.equal((await createKeywordStudy(input,researchId)).id,researchId);await assert.rejects(createKeywordStudy({...input,nodeIdPath:'9'},researchId),/范围/);});
 result.study.scope={...scope,researchId:keywordRunId};await withFetch(()=>Response.json(result),async()=>{await assert.rejects(createKeywordStudy(input,researchId),/身份/);});
});
test('keyword transport preserves error detail and aborts before/after response parsing',async()=>{
 await withFetch(()=>Response.json({error:{message:'事实基线变化，请刷新'}},{status:409}),async()=>{await assert.rejects(readKeywordRun(keywordRunId),/事实基线变化/);});
 await withFetch(()=>Response.json({run:{}}),async()=>{await assert.rejects(readKeywordRun(keywordRunId),/格式/);});
 const controller=new AbortController();controller.abort();await withFetch(()=>{assert.fail('aborted request must not fetch');},async()=>{await assert.rejects(readKeywordRun(keywordRunId,controller.signal),{name:'AbortError'});});
 const later=new AbortController();await withFetch(()=>{later.abort();return Response.json(keywordPageRun());},async()=>{await assert.rejects(readKeywordRun(keywordRunId,later.signal),{name:'AbortError'});});
});
test('revision requests retain body and decode wrappers; history URLs encode the selected revision',async()=>{
 const {request,catalog}=revisionFixture();let saving=true;
 await withFetch((path,init)=>{assert.equal(path,`/api/agent/v1/market-analysis/runs/${keywordRunId}/keywords/revisions${saving?'':`/${encodeURIComponent(catalog.revision.revisionId)}`}`);if(saving)assert.deepEqual(JSON.parse(init.body as string),request);return Response.json({revision:{ordinal:1,catalog}});},async()=>{
  assert.deepEqual(await saveKeywordRevision(keywordRunId,request,keywordUserId),{ordinal:1,catalog});saving=false;assert.deepEqual(await readKeywordRevision(keywordRunId,catalog.revision.revisionId),{ordinal:1,catalog});
 });
});
test('revision rejects foreign facts, old parent, altered choices/note and wrong selected revision',async()=>{
 const original=revisionFixture();
 for(const mutate of [(c:typeof original.catalog)=>{c.facts.moduleRunId=keywordUserId;},(c:typeof original.catalog)=>{c.facts.factsId=`market-keyword-facts:${'b'.repeat(64)}`;},(c:typeof original.catalog)=>{c.revision.parentRevisionId=`market-keyword-revision:${'b'.repeat(64)}`;},(c:typeof original.catalog)=>{c.classification.assignments[0].W1=[];},(c:typeof original.catalog)=>{c.revision.note='other';},(c:typeof original.catalog)=>{c.facts.referenceMonth='2026-07';}]){
  const catalog=structuredClone(original.catalog);mutate(catalog);await withFetch(()=>Response.json({revision:{ordinal:1,catalog}}),async()=>{await assert.rejects(saveKeywordRevision(keywordRunId,original.request,keywordUserId),/身份|范围|版本|月份|选择/);});
 }
 await withFetch(()=>Response.json({revision:{ordinal:1,catalog:original.catalog}}),async()=>{await assert.rejects(readKeywordRevision(keywordRunId,`market-keyword-revision:${'b'.repeat(64)}`),/版本/);await assert.rejects(readKeywordRevision(keywordUserId,original.catalog.revision.revisionId),/身份/);});
});
test('retry and cancellation reject acknowledgements from another run',async()=>{
 const steps=[{stepId:keywordUserId,failedAttemptId:keywordUserId}];
 await withFetch(()=>Response.json({moduleRunId:keywordUserId,cancelled:true}),async()=>{await assert.rejects(cancelKeywordRun(keywordRunId,keywordUserId),/身份/);});
 await withFetch(()=>Response.json({moduleRunId:keywordUserId,stepIds:[keywordUserId]}),async()=>{await assert.rejects(retryKeywordSteps(keywordRunId,steps,keywordUserId),/身份/);});
 await withFetch((path,init)=>{assert.deepEqual(JSON.parse(init.body as string),path.endsWith('/retry')?{steps}:{});return Response.json(path.endsWith('/retry')?{moduleRunId:keywordRunId,stepIds:[keywordUserId]}:{moduleRunId:keywordRunId,cancelled:true});},async()=>{assert.equal((await retryKeywordSteps(keywordRunId,steps,keywordUserId)).moduleRunId,keywordRunId);assert.equal((await cancelKeywordRun(keywordRunId,keywordUserId)).cancelled,true);});
});
test('facts report separates reference/unspecified periods, growth fractions, zero and unknown bid currency',()=>{
 const facts=keywordPageRun().run.facts!;facts.members[0].reference.yoyGrowth=.25;facts.members[0].reference.recentGrowth=-.1;
 facts.members[0].trend.months=[{month:'2026-08',searchVolume:{value:0,reason:null},searchRank:{value:null,reason:'missing'},recommendedBid:{value:2.4,reason:null},yoyGrowth:{value:.25,reason:null,baselineMonth:'2025-08',baselineValue:0,formulaVersion:'calendar-month-growth/v1'},recentGrowth:{value:-.1,reason:null,baselineMonth:'2026-07',baselineValue:0,formulaVersion:'calendar-month-growth/v1'}}];
 facts.pool.missingPages=[{seed:'shelf lamp',page:2}];facts.pool.memberLimitReached=true;facts.pool.conflictingMemberIds=['keyword:0'];
 const html=renderToStaticMarkup(React.createElement(MarketKeywordAuditReport,{facts}));
 for(const phrase of ['参考月搜索量','2026-08','25.0%','-10.0%','来源未注明月份','推荐竞价','非实际 CPC','币种未知','词池不是全市场','缺页','截断','冲突','未知维度','W1 产品','W2 人群','W3 场景','W4 功能属性'])assert.ok(html.includes(phrase),phrase);
 assert.match(html,/>0<\/td>/);assert.ok(!html.includes('2.4 USD'));assert.ok(!html.includes('"pageMetrics"'));
});
test('manual report shows independent author/time, unchanged pool denominator and unknown cluster share',()=>{
 const {catalog}=revisionFixture(),html=renderToStaticMarkup(React.createElement(MarketKeywordRevisionReport,{catalog,showAuditDetails:true}));
 for(const phrase of ['关键词人工修订报告',keywordUserId,'2026-09-13','人工阅读照明','人工审核记录','词池分母','未知','已知搜索量','分页不改变统计分母','W5','PVS'])assert.ok(html.includes(phrase),phrase);
 assert.ok(!html.includes('NaN'));assert.ok(!html.includes('Infinity'));assert.ok(!html.includes('"aggregation"'));
});
test('model suggestions preserve batch-local proposal identity and keyword evidence',()=>{
 const facts=keywordPageRun().run.facts!;const evidence=[{refId:'evidence',start:0,end:5,quote:'shelf'}],unknown={status:'unknown' as const,reason:'insufficient-evidence' as const,evidence:[]};
 facts.semantics.status='validated';facts.semantics.batches=[keywordRunId,keywordUserId].map((batchId,i)=>({stepId:batchId,attemptId:batchId,agentRunId:batchId,bindingId:batchId,inputDigest:'a'.repeat(64),output:{schemaVersion:'1.0.0',task:'market-keyword-semantics',batchId,inputDigest:'a'.repeat(64),keywords:[{keywordId:`keyword:${i}`,W1:{status:'supported',labelIds:['shelf'],evidence},W2:unknown,W3:unknown,W4:unknown,cluster:{status:'proposed',proposalId:'same-id',evidence}}],proposals:[{proposalId:'same-id',labelZh:i?'第二批提案':'第一批提案',definition:'批内定义',evidence}],synonymRelations:[]}}));
 const html=renderToStaticMarkup(React.createElement(MarketKeywordAuditReport,{facts,catalog:keywordPageRun().run.params.catalog}));for(const phrase of ['第一批提案','第二批提案','层架灯','shelf','语义协议通过','不等于质量已验',keywordRunId,keywordUserId])assert.ok(html.includes(phrase),phrase);
});
test('all keywords remain in the saved facts while report initially renders a bounded page',()=>{
 const facts=keywordPageRun().run.facts!;facts.members=Array.from({length:45},(_,i)=>({...facts.members[0],keywordId:`keyword:${i}`,keyword:`term-${i}`}));const before=digest(facts);
 const html=renderToStaticMarkup(React.createElement(MarketKeywordFactsReport,{facts}));assert.ok(html.includes('term-0'));assert.ok(!html.includes('term-44'));assert.ok(html.includes('下一页'));assert.ok(html.includes('45'));assert.equal(digest(facts),before);
});
test('discovered labels are displayed by dimension and batch without replacing source catalog or human classification',()=>{
 const run=keywordPageRun().run,facts=run.facts!,unknown={status:'unknown' as const,reason:'insufficient-evidence' as const,evidence:[]};
 facts.semantics.status='validated';facts.semantics.batches=[keywordRunId,keywordUserId].map((batchId,i)=>{
  const evidence=[{refId:`ref-${i}`,start:0,end:4,quote:'lamp'}];
  return {stepId:batchId,attemptId:batchId,agentRunId:batchId,bindingId:batchId,inputDigest:'a'.repeat(64),output:{schemaVersion:'1.0.0',task:'market-keyword-semantics',batchId,inputDigest:'a'.repeat(64),keywords:[{keywordId:`keyword:${i}`,W1:{status:'supported',labelIds:['new-label'],evidence},W2:unknown,W3:unknown,W4:unknown,cluster:unknown}],proposals:[],synonymRelations:[],labelProposals:[{dimension:'W1',labelId:'new-label',label:i?'第二批产品':'第一批产品',definition:i?'第二批定义':'第一批定义',evidence}]}};
 });
 const before=digest({facts,catalog:run.params.catalog});
 const html=renderToStaticMarkup(React.createElement(MarketKeywordAuditReport,{facts,catalog:run.params.catalog}));
 for(const value of ['第一批产品','第二批产品','第一批定义','第二批定义','此批标签提案'])assert.ok(html.includes(value),value);
  assert.ok(!html.includes('目录名称未取得'));assert.equal(digest({facts,catalog:run.params.catalog}),before);
});

test('rule reports keep global and immutable human classification identities separate across transport',async()=>{
 const f=keywordRuleFixture();
 await withFetch(()=>Response.json(f.response),async()=>{assert.deepEqual((await readKeywordRun(keywordRunId)).ruleReport,f.response.run.ruleReport);});
 await withFetch(()=>Response.json({revision:f.revision}),async()=>{
  assert.deepEqual((await readKeywordRevision(keywordRunId,f.revision.catalog.revision.revisionId)).ruleReport,f.revision.ruleReport);
  assert.deepEqual((await saveKeywordRevision(keywordRunId,f.request,keywordUserId)).ruleReport,f.revision.ruleReport);
 });
 const wrong=structuredClone(f.response);wrong.run.ruleReport=f.revision.ruleReport;
 await withFetch(()=>Response.json(wrong),async()=>{await assert.rejects(readKeywordRun(keywordRunId),/分类版本/);});
 for(const change of [(r:typeof f.revision.ruleReport)=>{r.factsId='foreign-facts';},(r:typeof f.revision.ruleReport)=>{r.classification.identity=f.response.run.reconciliation!.resultHash;},(r:typeof f.revision.ruleReport)=>{r.referenceMonth='2026-07';}]){
  const revision=structuredClone(f.revision);change(revision.ruleReport);
  await withFetch(()=>Response.json({revision}),async()=>{await assert.rejects(readKeywordRevision(keywordRunId,revision.catalog.revision.revisionId),/规则报告/);});
 }
});

test('W5 and PVS presentation distinguishes comparison months, zero baselines and missing score inputs',()=>{
 const {revision}=keywordRuleFixture(),before=digest(revision.ruleReport);
 const html=renderToStaticMarkup(React.createElement(MarketKeywordRulesReport,{report:revision.ruleReport}));
 for(const value of ['较3个月前','2026-05','2026-08','基期为零','PVS','待验证','缺少分项','经验排序','不代表成功概率','币种未确认','人工灯具组','250','100.0%'])assert.ok(html.includes(value),value);
 assert.ok(!html.includes('NaN'));assert.ok(!html.includes('Infinity'));assert.equal(digest(revision.ruleReport),before);
});

test('leaf category may resolve to a full path, but foreign leaves and other scope changes are rejected',async()=>{
 const {scope}=keywordPageRun().run;const {organizationId,researchId,...base}=scope;void organizationId;
 const expected={...base,nodeIdPath:'1063294'},resolved={...scope,nodeIdPath:'228013:495224:3736561:1063294'};
 await withFetch(()=>Response.json({study:{id:researchId,scope:resolved,createdAt:'2026-09-27T00:00:00.000Z'}}),async()=>{
  assert.equal((await createKeywordStudy(expected,researchId)).scope.nodeIdPath,resolved.nodeIdPath);
  await assert.rejects(createKeywordStudy({...expected,nodeIdPath:'999'},researchId),/范围/);
  await assert.rejects(createKeywordStudy({...expected,nodeIdPath:'1:1063294'},researchId),/范围/);
  await assert.rejects(createKeywordStudy({...expected,fromMonth:'2025-01'},researchId),/范围/);
 });
});
