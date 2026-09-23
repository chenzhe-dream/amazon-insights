import assert from 'node:assert/strict';
import test from 'node:test';
import {readHistoricalSyncPointer, eligibleImageSourceProjects, priorityRecoveryProjectId} from '../../app/lib/image-source-project';

const project={id:'source',kind:'analysis' as const,asins:['B01M119PTN','B00P8J6AQG','B0FV2T2SP4'],marketplace:'US'};
function reader(responses:Response[]){return async()=>{const value=responses.shift();assert.ok(value);return value;};}
test('reopened project recovers its real sync job independent of ASIN ordering',async()=>{
 const recovered={...project,id:priorityRecoveryProjectId};
 const fetcher=reader([Response.json({project:{id:recovered.id,currentRunId:'run'}}),Response.json({jobId:'job',runId:'run'}),Response.json({jobId:'job',asins:[...project.asins].reverse(),marketplace:'US',scope:{projectId:recovered.id,runId:'run'}})]);
 assert.deepEqual(await readHistoricalSyncPointer(recovered,{fetcher,strict:true}),{projectId:recovered.id,runId:'run',jobId:'job'});
});

test('reopened project uses the latest completed job instead of the old run idempotency key',async()=>{
 const recovered={...project,id:priorityRecoveryProjectId};
 const paths:string[]=[];
 const fetcher=async(path:string)=>{
  paths.push(path);
  if(path===`/v1/projects/${recovered.id}`)return Response.json({project:{id:recovered.id,currentRunId:'run'}});
  if(path===`/v1/local-data/projects/${recovered.id}/current-sync-job`)return Response.json({jobId:'new-job',runId:'run'});
  if(path==='/v1/local-data/sync-asins/new-job')return Response.json({jobId:'new-job',asins:project.asins,marketplace:'US',scope:{projectId:recovered.id,runId:'run'}});
  throw Error(`Unexpected path ${path}`);
 };
 assert.deepEqual(await readHistoricalSyncPointer(recovered,{fetcher,strict:true}),{projectId:recovered.id,runId:'run',jobId:'new-job'});
 assert.ok(!paths.some(path=>path.includes('/v1/runs/')));
});
test('other saved projects keep their existing pointer path during priority recovery',async()=>{
 const paths:string[]=[];
 const fetcher=async(path:string)=>{
  paths.push(path);
  if(path==='/v1/projects/source')return Response.json({project:{id:'source',currentRunId:'run'}});
  if(path==='/v1/runs/run')return Response.json({run:{id:'run',projectId:'source',idempotencyKey:'old-job'}});
  if(path==='/v1/local-data/sync-asins/old-job')return Response.json({jobId:'old-job',asins:project.asins,marketplace:'US',scope:{projectId:'source',runId:'run'}});
  throw Error(`Unexpected path ${path}`);
 };
 assert.deepEqual(await readHistoricalSyncPointer(project,{fetcher,strict:true}),{projectId:'source',runId:'run',jobId:'old-job'});
 assert.ok(!paths.some(path=>path.includes('/current-sync-job')));
});
test('collection IDs are never queried as analysis IDs and transport failures are not no-sync',async()=>{
 await assert.rejects(readHistoricalSyncPointer({...project,kind:'keyword-compare'},{fetcher:async()=>{throw Error('must not fetch')},strict:true}),/收藏/);
 await assert.rejects(readHistoricalSyncPointer(project,{fetcher:reader([Response.json({}, {status:503})]),strict:true}),/读取.*503/);
 await assert.rejects(readHistoricalSyncPointer(project,{fetcher:reader([Response.json({}, {status:401})]),strict:true}),/登录/);
 await assert.rejects(readHistoricalSyncPointer(project,{fetcher:async()=>{throw Error('offline')},strict:true}),/网络/);
 assert.equal(await readHistoricalSyncPointer(project,{fetcher:reader([Response.json({}, {status:503})])}),null);
});
test('scope mismatches remain errors and an absent run is genuinely unsynchronized',async()=>{
 assert.equal(await readHistoricalSyncPointer(project,{fetcher:reader([Response.json({project:{id:'source',currentRunId:null}}),Response.json({}, {status:404})]),strict:true}),null);
 await assert.rejects(readHistoricalSyncPointer(project,{fetcher:reader([Response.json({project:{id:'wrong',currentRunId:'run'}})]),strict:true}),/不匹配/);
 await assert.rejects(readHistoricalSyncPointer(project,{fetcher:reader([Response.json({project:{id:'source',currentRunId:'run'}}),Response.json({run:{id:'run',projectId:'source',idempotencyKey:'job'}}),Response.json({jobId:'job',asins:project.asins,marketplace:'US',scope:{projectId:'source',runId:'wrong'}})]),strict:true}),/不匹配/);
});
test('source choices require an authorized registered analysis project and never override explicit provenance',()=>{
 const local=[{...project,name:'Original'}, {...project,id:'foreign'}, {...project,id:'wrong-site',marketplace:'UK'}, {...project,id:'other'}];
 const registered=local.filter(p=>p.id!=='foreign').map(p=>({...p,currentRunId:'run'}));
 const collection={...project,id:'collection',kind:'keyword-compare' as const};
 assert.deepEqual(eligibleImageSourceProjects(collection,local,registered).map(p=>p.id),['source','other']);
 assert.deepEqual(eligibleImageSourceProjects({...collection,sourceProjectId:'source'},local,registered).map(p=>p.id),['source']);
 assert.deepEqual(eligibleImageSourceProjects({...collection,sourceProjectId:'foreign'},local,registered),[]);
});
