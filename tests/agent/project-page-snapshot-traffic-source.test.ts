import assert from 'node:assert/strict';
import test from 'node:test';
import { readPageSnapshotTraffic } from '../../app/project-export/read-page-snapshot-traffic';
import {snapshotProducts} from '../../app/project-export/read-page-snapshot-sources';
import {buildTrafficAnalysisConclusion} from '../../app/traffic-analysis-conclusion';
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

function dynamicSnapshot(ctx:ExportModuleContext) {
 return {version:'1',state:'ready',marketplace:'US',asins:ctx.sourceAsins,source:'sif',collectedAt:stamp,
 traffic:{competitors:[{asin:ctx.asins[0],brand:'动态品牌',trafficRank:1,trafficVolume:1000,naturalVolume:700,naturalShare:69.8,advertisingVolume:300,advertisingShare:30.2,top1Share:80,top3Share:100,hhi:6800,effectiveChildren:2,childCount:2,recommendationTraffic:20,maxAdvertisingChannel:'SP',maxAdvertisingChannelShare:100,effectiveAdvertisingChannels:1,pullGrade:'强',naturalGrade:'强',advertisingGrade:'中',recommendationGrade:'中',variantGrade:'中',health:'健康',monthlyTrend:[{month:'2026-08',natural:700,advertising:300,total:1000}]}]}};
}
const prepare = (ctx:ExportModuleContext,read:Parameters<typeof readPageSnapshotTraffic>[1]) => readPageSnapshotTraffic(ctx,read,snapshotProducts(ctx));
const noRequests = async()=>{throw Error('unexpected request');};
test('published source retains all saved children and months, excludes foreign data, and is detached',async()=>{
  const ctx=context(), result=await prepare(ctx,noRequests), asin=ctx.asins[0];
  assert.equal(result.trafficData.overview[asin]?.children.length,105);
  assert.equal(result.trafficData.overview[asin]?.recommendationSources.length,12);
  assert.equal(result.monthlyTrendByAsin[asin].points.length,20);
  assert.doesNotMatch(JSON.stringify(result),/outside|B099999999/);
  const before=JSON.stringify(result);ctx.version.stageOutputs={};assert.equal(JSON.stringify(result),before);
});
test('missing published traffic cannot fall back to dynamic data or generate zero grades',async()=>{
  const ctx=context();ctx.version.stageOutputs={traffic:{stage:'traffic',stageStatus:'missing-output',reasonCode:'OUTPUT_UNAVAILABLE'}};
  const result=await prepare(ctx,noRequests);
  assert.equal(result.trafficData.overview[ctx.asins[0]],null);
  assert.deepEqual(result.monthlyTrendByAsin,{});
  assert.equal(buildTrafficAnalysisConclusion(result.products,result.trafficData).overview.length,0);
});
test('unpublished dynamic reads are GET-only, double-checked, and never read report history',async()=>{
  const ctx={...context(),version:null,currentRunId:'44444444-4444-4444-8444-444444444444'};
  const paths:string[]=[];
  const result=await prepare(ctx,async(path,init)=>{
    assert.equal(init?.method,'GET');assert.equal(init?.cache,'no-store');paths.push(path);
    if(path.endsWith('/traffic-snapshot'))return missing();
    assert.equal(path,`/v1/runs/${ctx.currentRunId}`);return Response.json(run(ctx,ctx.currentRunId));
  });
  assert.equal(result.trafficData.overview[ctx.asins[0]],null);assert.equal(paths.length,3);
  await assert.rejects(prepare(ctx,async(path)=>path.endsWith('/traffic-snapshot')?Response.json({error:'failure'},{status:500}):Response.json(run(ctx,ctx.currentRunId))),/流量/);
});
test('wrong run ownership blocks dynamic requests',async()=>{
  const ctx={...context(),version:null,currentRunId:'44444444-4444-4444-8444-444444444444'};
  await assert.rejects(prepare(ctx,async()=>Response.json({run:{...run(ctx,ctx.currentRunId).run,projectId:'11111111-1111-4111-8111-111111111111'},stages:[]})),/范围|归属/);
});
test('monthly missing numbers remain null and wrong stage identity or row market is rejected',async()=>{
  const ctx=context(),stage=ctx.version.stageOutputs.traffic!;
  assert.ok(stage.stage==='traffic'&&'data'in stage);
  stage.data.monthlyByAsin[ctx.asins[0]]={points:[{month:'2026-01',natural:10}]};
  const point=(await prepare(ctx,noRequests)).monthlyTrendByAsin[ctx.asins[0]].points[0];
  assert.equal(point.ad,null);assert.equal(point.total,null);
  stage.data.monthlyByAsin[ctx.asins[0]]={marketplace:'DE',points:[]};
  await assert.rejects(prepare(ctx,noRequests),/范围/);
  stage.data.monthlyByAsin={};stage.projectId='foreign';await assert.rejects(prepare(ctx,noRequests),/范围|归属/);
});
test('dynamic supplied ratios are retained and any mutable snapshot change invalidates preparation',async()=>{
  const ctx={...context(),version:null,currentRunId:'44444444-4444-4444-8444-444444444444'},snap=dynamicSnapshot(ctx);
  const serve=async(path:string)=>path.endsWith('/traffic-snapshot')?Response.json(snap):Response.json(run(ctx,ctx.currentRunId));
  const result=await prepare(ctx,serve);assert.equal(result.trafficData.overview[ctx.asins[0]]?.naturalAd[0].ratio,69.8);
  let count=0;await assert.rejects(prepare(ctx,async(path)=>path.endsWith('/traffic-snapshot')?Response.json({...snap,collectedAt:++count===1?stamp:'2026-09-24T02:00:00Z'}):serve(path)),/变化/);
  snap.traffic.competitors[0].asin='B099999999';await assert.rejects(prepare(ctx,serve),/范围/);
});
test('partial exports use only selected products and never request comparative full-project saved reports',async()=>{
  const base=context(),ctx={...base,asins:[base.asins[0]],currentRunId:'44444444-4444-4444-8444-444444444444'};
  const result=await prepare(ctx,async(path)=>{assert.equal(path,`/v1/runs/${ctx.currentRunId}`);return Response.json(run(ctx,ctx.currentRunId));});
  assert.deepEqual(result.products.map(p=>p.asin),ctx.asins);
  assert.ok(!JSON.stringify(result).includes(base.asins[1]));
});


