import assert from 'node:assert/strict';
import test from 'node:test';
import {readHistoricalSyncPointer, eligibleImageSourceProjects} from '../../app/lib/image-source-project';

const project={id:'source',kind:'analysis' as const,asins:['B01M119PTN','B00P8J6AQG','B0FV2T2SP4'],marketplace:'US'};
function reader(responses:Response[]){return async()=>{const value=responses.shift();assert.ok(value);return value;};}
test('reopened project recovers its real sync job independent of ASIN ordering',async()=>{
 const fetcher=reader([Response.json({project:{id:'source',currentRunId:'run'}}),Response.json({run:{id:'run',projectId:'source',idempotencyKey:'job'}}),Response.json({jobId:'job',asins:[...project.asins].reverse(),marketplace:'US',scope:{projectId:'source',runId:'run'}})]);
 assert.deepEqual(await readHistoricalSyncPointer(project,{fetcher,strict:true}),{projectId:'source',runId:'run',jobId:'job'});
});
test('collection IDs are never queried as analysis IDs and transport failures are not no-sync',async()=>{
 await assert.rejects(readHistoricalSyncPointer({...project,kind:'keyword-compare'},{fetcher:async()=>{throw Error('must not fetch')},strict:true}),/收藏/);
 await assert.rejects(readHistoricalSyncPointer(project,{fetcher:reader([Response.json({}, {status:503})]),strict:true}),/读取.*503/);
 await assert.rejects(readHistoricalSyncPointer(project,{fetcher:reader([Response.json({}, {status:401})]),strict:true}),/登录/);
 await assert.rejects(readHistoricalSyncPointer(project,{fetcher:async()=>{throw Error('offline')},strict:true}),/网络/);
 assert.equal(await readHistoricalSyncPointer(project,{fetcher:reader([Response.json({}, {status:503})])}),null);
});
test('scope mismatches remain errors and an absent run is genuinely unsynchronized',async()=>{
 assert.equal(await readHistoricalSyncPointer(project,{fetcher:reader([Response.json({project:{id:'source',currentRunId:null}})]),strict:true}),null);
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
