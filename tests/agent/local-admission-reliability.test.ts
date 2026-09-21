import assert from 'node:assert/strict';
import test from 'node:test';
import {ResourceGovernorAdmissionError} from '../../server/db/concurrency-control-repository';
import {createRemoteMcpConnector} from '../../server/connectors/remote-mcp-connector';
import {ResourceGovernorAdmissionError as ScriptError} from '../../scripts/lib/postgres-resource-governor.mjs';
test('local rolling admission preserves absolute cooldown with no dispatch or internal retry',async()=>{
 const retryAt='2026-09-17T12:00:00.000Z'; let dispatch=0,admissions=0;
 const error=new ResourceGovernorAdmissionError({reason:'rolling-window',retryAt});
 assert.equal(error.reason,'rolling-window'); assert.equal(error.retryAt,retryAt);
 const scripted=new ScriptError({reason:'rolling-window',retryAt});assert.equal(scripted.reason,error.reason);assert.equal(scripted.retryAt,retryAt);
 const connector=createRemoteMcpConnector({id:'sellerSprite',resolveCredential:async()=> 'fixture',clock:()=>new Date(),sleep:async()=>assert.fail('must not sleep'),
 policy:{timeoutMs:1000,maxAttempts:2,retryDelayMs:0,maxConcurrent:1,maxQueue:1},resourceGovernor:{run:async()=>{admissions++;throw error;}},
 transport:async()=>{dispatch++;return {};},probeTransport:async()=>({})});
 await assert.rejects(connector.execute({operation:'fixture',input:{},governorScope:{organizationId:'org',jobId:'job'}}),e=>{
 assert.equal((e as any).code,'local-admission');assert.deepEqual((e as any).admission,{reason:'rolling-window',retryAt});return true;});
 assert.equal(dispatch,0);assert.equal(admissions,1);
});
test('manual hold does not invent a release time',()=>{
 const error=new ResourceGovernorAdmissionError({reason:'paused'});assert.equal(error.reason,'paused');assert.equal(error.retryAt,null);
});

import {PostgresConcurrencyControlStore} from '../../server/db/postgres/concurrency-control-store';
import {PostgresQueryContext} from '../../server/db/postgres/query-context';
test('rolling governor uses database clock and safe release including policy shrink',async()=>{
 const now='2026-09-17T12:00:00.000Z',retryAt='2026-09-17T12:00:30.000Z';const queries:string[]=[];
 const context={transaction:async(fn:any)=>fn(),query:async(sql:string,params:any[])=>{
 queries.push(sql);
 if(sql.includes('clock_timestamp() AS admission_now'))return {rows:[{admission_now:now}]};
 if(sql.includes('current_policy AS'))return {rows:[{policy_version:'fixture',seller_sprite_rolling_window_ms:60000,seller_sprite_rolling_max_attempts:2}]};
 if(sql.includes('concurrency_resource_circuits'))return {rows:[]};
 if(sql.includes('concurrency_physical_attempts')){assert.equal(params[0],'org-a');assert.equal(params[1],now);return {rows:[{count:3,retry_at:retryAt}]};}
 return {rows:[]};
 }} as unknown as PostgresQueryContext;
 const store=new PostgresConcurrencyControlStore(context,{permitId:()=> 'permit'});
 await assert.rejects(store.recordPhysicalAttempt({organizationId:'org-a',resource:'sellerSprite',jobId:'job',attemptKind:'initial'}),e=>{assert.equal((e as any).reason,'rolling-window');assert.equal((e as any).retryAt,retryAt);return true;});
 assert.ok(queries.some(s=>s.includes('clock_timestamp() AS admission_now')));
 assert.ok(queries.some(s=>s.includes('OFFSET')),'policy shrinking below existing count must wait for enough attempts to expire');
 assert.ok(!queries.some(s=>s.includes('INSERT INTO concurrency_physical_attempts')));
});
test('timeout preserves post-dispatch no-retry fence when transport settles after abort',async()=>{
 let dispatch=0;
 const connector=createRemoteMcpConnector({id:'sellerSprite',physicalGovernance:'transport-dispatch',resolveCredential:async()=> 'fixture',clock:()=>new Date(),sleep:async()=>{},policy:{timeoutMs:10,maxAttempts:2,retryDelayMs:0,maxConcurrent:1,maxQueue:1},
 transport:async(_request,signal)=>{dispatch++;return await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error('stopped'),{doNotRetry:true})),{once:true}));},probeTransport:async()=>({})});
 await assert.rejects(connector.execute({operation:'fixture',input:{},sessionScope:'market',governorScope:{organizationId:'org',jobId:'job'}}), error => {
  assert.equal((error as {code:string}).code,'timeout');
  assert.equal((error as {retryable:boolean}).retryable,false,'durable source scheduler must not automatically replay ambiguous dispatch');return true;
 });assert.equal(dispatch,1);
});
import {MarketModuleStepPublicSchema} from '../../shared/market-module-contracts';
test('public step reads accept waiting metadata without rewriting legacy history',()=>{
 const old={id:'11111111-1111-4111-8111-111111111111',kind:'collect-product-month',status:'failed',latestAttemptId:null,attemptCount:1,current:true,canRetry:true,asin:null,errorCode:'governance'};
 assert.deepEqual(MarketModuleStepPublicSchema.parse(old),old);
 const waiting={...old,status:'queued',canRetry:false,errorCode:'local-admission',nextAttemptAt:'2026-09-17T12:00:30.000Z'};
 assert.deepEqual(MarketModuleStepPublicSchema.parse(waiting),waiting);
});
