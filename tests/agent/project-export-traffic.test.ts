import assert from 'node:assert/strict';
import test from 'node:test';
import { readTrafficExportSection } from '../../app/project-export/read-traffic-export';
import type { ExportModuleContext } from '../../app/project-export/export-module-context';
import type { CurrentProjectDisplayVersion } from '../../app/lib/project-display-version-browser';
import { exportVersionFixture } from './helpers/project-export-fixture';
const stamp = '2026-09-24T01:00:00Z';
function context() {
  const version = exportVersionFixture() as unknown as CurrentProjectDisplayVersion;
  const asin = version.asins[0];
  const item = { totalScore: 1000, naturalAd: [{label:'自然流量',score:700,ratio:70},{label:'广告流量',score:300,ratio:30}],
    adChannels: [{label:'SP(常规)',score:200,ratio:66.7},{label:'SBV',score:100,ratio:33.3}],
    recommendationSources: Array.from({length:12}, (_,i)=>({label:`推荐${i}`,score:i+1,ratio:i+1})),
    children: Array.from({length:105}, (_,i)=>({asin:`B${String(i).padStart(9,'0')}`,label:`子体${i}`,image:'https://m.media-amazon.com/image.jpg',totalScore:i,sharePct:0.9,organic:i,sp:0,spRecommend:0,sb:0,sbv:0})), updatedThrough:'2026-09-22' };
  version.stageOutputs = { traffic: {stage:'traffic',stageStatus:'done', projectId:version.projectId,runId:version.runId,jobId:version.jobId,jobVersion:1,outputVersion:1,contentHash:'c'.repeat(64),updatedAt:stamp,
    data:{listingByAsin:{[asin]:item,B099999999:{secret:'outside'}},monthlyByAsin:{[asin]:{points:Array.from({length:20},(_,i)=>({month:`${2025+Math.floor(i/12)}-${String(i%12+1).padStart(2,'0')}`,natural:i,advertising:i+1}))}}}} };
  return { projectId:version.projectId,organizationId:version.organizationId,marketplace:'US',asins:version.asins,sourceAsins:version.asins,version,capturedAt:stamp,currentRunId:null } satisfies ExportModuleContext & {currentRunId:null};
}
function run(ctx:ExportModuleContext, id:string) { return {run:{id,projectId:ctx.projectId,mode:'existing-data',status:'succeeded',createdBy:'66666666-6666-4666-8666-666666666666',dataCutoffAt:stamp,createdAt:stamp,updatedAt:stamp},stages:[]}; }
function missing(){return Response.json({error:{code:'NOT_FOUND',message:'Traffic snapshot is pending',requestId:'test'}},{status:404});}

test('published traffic exports all detail rows and months, rules, gaps and safe scope without requests',async()=>{
 const ctx=context(); const section=await readTrafficExportSection(ctx,async()=>{throw Error('unexpected request');});
 assert.equal(section.status,'ready'); const body=JSON.stringify(section); assert.ok(!body.includes('outside'));
 const table=section.blocks.find(b=>b.kind==='table'&&b.title.includes('子体流量结构'));
 assert.ok(table?.kind==='table'); assert.equal(table.rows.length,105);
 const rec=section.blocks.find(b=>b.kind==='table'&&b.title.includes('推荐专栏'));
 assert.ok(rec?.kind==='table');assert.equal(rec.rows.length,12);
 const chart=section.blocks.find(b=>b.kind==='chart'&&b.title.includes('月流量'));
 assert.ok(chart?.kind==='chart');assert.equal(chart.labels.length,20);
 for(const label of ['SP(推荐)','SBV','推广能力','置信度','Top','利润'])assert.ok(body.includes(label),label);
});

test('missing published traffic does not inherit dynamic or generated examples',async()=>{
 const ctx=context();ctx.version!.stageOutputs={traffic:{stage:'traffic',stageStatus:'missing-output',reasonCode:'OUTPUT_UNAVAILABLE'}};
 const section=await readTrafficExportSection(ctx,async()=>{throw Error('no fallback');});assert.equal(section.status,'missing');assert.match(JSON.stringify(section),/暂无已生成结果/);
});

test('unpublished dynamic snapshot is GET-only and a failed request is not missing',async()=>{
 const ctx={...context(),version:null,currentRunId:'44444444-4444-4444-8444-444444444444'};const calls:string[]=[];
 const section=await readTrafficExportSection(ctx,async(path,init)=>{assert.equal(init?.method,'GET');calls.push(path);if(path.endsWith('/reports'))return Response.json({reports:[]});if(path.endsWith('/traffic-snapshot'))return missing();return Response.json(run(ctx,ctx.currentRunId));});
 assert.equal(section.status,'missing');assert.ok(calls.filter(path=>path.endsWith('/traffic-snapshot')).length>=2);
 await assert.rejects(readTrafficExportSection(ctx,async(path)=>path.endsWith('/traffic-snapshot')?Response.json({error:'failure'},{status:500}):path.endsWith('/reports')?Response.json({reports:[]}):Response.json(run(ctx,ctx.currentRunId))),/流量/);
});

test('wrong run project identity blocks all snapshot reads',async()=>{
 const ctx={...context(),version:null,currentRunId:'44444444-4444-4444-8444-444444444444'};
 await assert.rejects(readTrafficExportSection(ctx,async()=>Response.json({...run(ctx,ctx.currentRunId),run:{...run(ctx,ctx.currentRunId).run,projectId:'11111111-1111-4111-8111-111111111111'}})),/范围|归属/);
});

test('traffic cannot silently coerce missing monthly fields into zero or accept wrong stage ownership',async()=>{
 const ctx=context();const stage=ctx.version!.stageOutputs.traffic!;
 if('data'in stage&&stage.stage==='traffic') stage.data.monthlyByAsin[ctx.asins[0]]={points:[{month:'2026-01',natural:10}]};
 const section=await readTrafficExportSection(ctx,async()=>{throw Error('unexpected');});
 const chart=section.blocks.find(b=>b.kind==='chart'&&b.title.includes('月流量'));
 assert.ok(chart?.kind==='chart');assert.deepEqual(chart.series.find(s=>s.label==='广告流量')?.values,[null]);
 if('projectId'in stage)stage.projectId='foreign';
 await assert.rejects(readTrafficExportSection(ctx,async()=>{throw Error('unexpected');}),/范围|归属/);
});

function dynamicSnapshot(ctx:ExportModuleContext) {
 return {version:'1',state:'ready',marketplace:'US',asins:ctx.sourceAsins,source:'sif',collectedAt:stamp,
 traffic:{competitors:[{asin:ctx.asins[0],brand:'动态品牌',trafficRank:1,trafficVolume:1000,naturalVolume:700,naturalShare:69.8,advertisingVolume:300,advertisingShare:30.2,top1Share:80,top3Share:100,hhi:6800,effectiveChildren:2,childCount:2,recommendationTraffic:20,maxAdvertisingChannel:'SP',maxAdvertisingChannelShare:100,effectiveAdvertisingChannels:1,pullGrade:'强',naturalGrade:'强',advertisingGrade:'中',recommendationGrade:'中',variantGrade:'中',health:'健康',monthlyTrend:[{month:'2026-08',natural:700,advertising:300,total:1000}]}]}};
}

test('dynamic traffic preserves supplied ratios and compares the full mutable snapshot',async()=>{
 const ctx={...context(),version:null,currentRunId:'44444444-4444-4444-8444-444444444444'};
 const stable=dynamicSnapshot(ctx);let count=0;
 const serve=async(path:string)=>path.endsWith('/reports')?Response.json({reports:[]}):path.endsWith('/traffic-snapshot')?Response.json(stable):Response.json(run(ctx,ctx.currentRunId));
 const section=await readTrafficExportSection(ctx,serve);
 assert.match(JSON.stringify(section),/69.8/);
 await assert.rejects(readTrafficExportSection(ctx,async(path)=>{if(path.endsWith('/traffic-snapshot')){count++;return Response.json({...stable,collectedAt:count===1?stamp:'2026-09-24T02:00:00Z'});}return serve(path);}),/变化/);
});

function reportFixture(ctx:ExportModuleContext,runId:string) {
 return {schemaVersion:'1.0.0',id:'77777777-7777-4777-8777-777777777777',runId,agentRunId:'88888888-8888-4888-8888-888888888888',version:1,stage:'traffic-analysis',status:'complete',skill:{id:'traffic-analysis',version:'1.0.0',contentHash:'a'.repeat(64)},snapshotIds:['99999999-9999-4999-8999-999999999999'],model:{provider:'test',model:'saved-model'},dataCutoffAt:stamp,createdAt:stamp,evidence:[{id:'proof',type:'metric',sourceId:'source-evidence',capturedAt:stamp}],result:{kind:'competitor-traffic-analysis',summary:'已保存完整结论',competitors:[{asin:ctx.asins[0],details:Array.from({length:120},(_,i)=>`已有证据${i}`)}],dataBoundary:'已有边界'}};
}

test('saved traffic report preserves the complete selected result and evidence without running a model',async()=>{
 const ctx={...context(),currentRunId:'44444444-4444-4444-8444-444444444444'};const report=reportFixture(ctx,ctx.currentRunId);const requests:string[]=[];
 const section=await readTrafficExportSection(ctx,async(path,init)=>{assert.equal(init?.method,'GET');requests.push(path);if(path.endsWith('/reports'))return Response.json({reports:[report]});if(path.includes('/v1/reports/'))return Response.json({report});return Response.json(run(ctx,ctx.currentRunId));});
 const text=JSON.stringify(section);for(const expected of ['已有证据119','source-evidence','已保存完整结论',report.id])assert.ok(text.includes(expected),expected);assert.equal(requests.length,3);
 await assert.rejects(readTrafficExportSection(ctx,async(path)=>path.endsWith('/reports')?Response.json({reports:[report]}):path.includes('/v1/reports/')?Response.json({report:{...report,runId:'11111111-1111-4111-8111-111111111111'}}):Response.json(run(ctx,ctx.currentRunId))),/来源/);
});

test('snapshot and saved report cannot introduce an out-of-scope competitor',async()=>{
 const ctx={...context(),version:null,currentRunId:'44444444-4444-4444-8444-444444444444'};const snap=dynamicSnapshot(ctx);snap.traffic.competitors[0].asin='B099999999';
 await assert.rejects(readTrafficExportSection(ctx,async(path)=>path.endsWith('/traffic-snapshot')?Response.json(snap):Response.json(run(ctx,ctx.currentRunId))),/范围/);
 const report=reportFixture(ctx,ctx.currentRunId);report.result.competitors[0].asin='B099999999';
 await assert.rejects(readTrafficExportSection({...ctx,version:context().version},async(path)=>path.endsWith('/reports')?Response.json({reports:[report]}):path.includes('/v1/reports/')?Response.json({report}):Response.json(run(ctx,ctx.currentRunId))),/范围/);
});

test('a comparative saved report cannot leak full-project prose into a smaller export scope',async()=>{
 const base=context();const ctx={...base,asins:[base.asins[0]],currentRunId:'44444444-4444-4444-8444-444444444444'};const report=reportFixture(ctx,ctx.currentRunId);report.result.summary=`结论提及未选择商品 ${base.asins[1]}`;
 await assert.rejects(readTrafficExportSection(ctx,async(path)=>path.endsWith('/reports')?Response.json({reports:[report]}):path.includes('/v1/reports/')?Response.json({report}):Response.json(run(ctx,ctx.currentRunId))),/范围/);
});

test('saved report renders readable business fields rather than a raw JSON text block',async()=>{
 const ctx={...context(),currentRunId:'44444444-4444-4444-8444-444444444444'};const report=reportFixture(ctx,ctx.currentRunId);
 const section=await readTrafficExportSection(ctx,async(path)=>path.endsWith('/reports')?Response.json({reports:[report]}):path.includes('/v1/reports/')?Response.json({report}):Response.json(run(ctx,ctx.currentRunId)));
 assert.ok(!section.blocks.some(block=>block.kind==='text'&&block.text.includes('"competitors"')));
 const fields=section.blocks.find(block=>block.kind==='table'&&block.title==='已保存流量分析报告完整结果');
 assert.ok(fields?.kind==='table');assert.ok(fields.rows.some(row=>row[0].text.includes('报告摘要')&&row[1].text==='已保存完整结论'));
 assert.ok(fields.rows.some(row=>row[1].text==='已有证据119'));
});

test('incomplete traffic details never render default zero grades as a formal conclusion',async()=>{
 const ctx=context();const stage=ctx.version!.stageOutputs.traffic!;
 if('data'in stage&&stage.stage==='traffic')stage.data.listingByAsin={[ctx.asins[0]]:{total:10}};
 const section=await readTrafficExportSection(ctx,async()=>{throw Error('unexpected');});
 assert.ok(!section.blocks.some(block=>block.kind==='table'&&block.title==='推广能力结论总览'));
 assert.match(JSON.stringify(section),/无法形成推广能力结论/);
});
