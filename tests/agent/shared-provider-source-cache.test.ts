import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {startPostgresTestContainer} from './helpers/postgres-test-container';
import {createSorftimeSourceCache,sourceMetadata} from '../../scripts/lib/sorftime-source-cache.mjs';
import {callSifTool} from '../../scripts/lib/sif-mcp-client.mjs';
import {callSellerSpriteMcpTool,createSellerSpriteSessionPool} from '../../scripts/lib/sellersprite-mcp-client.mjs';
import {createSellerSpriteConnector,createSifConnector} from '../../server/connectors/mcp-connectors';
import {ResourceGovernorAdmissionError} from '../../server/db/concurrency-control-repository';

test('SellerSprite and SIF share only successful identical read requests across consumers and processes', {timeout:120000}, async t=>{
 const db=await startPostgresTestContainer();t.after(()=>db.close());
 await db.pool.query(await readFile(new URL('../../server/db/migrations/postgres/0067_sorftime_source_cache.sql',import.meta.url),'utf8'));
 let now=Date.parse('2026-10-14T00:00:00Z'),calls=0;let failure:unknown=null,envelope:unknown=null;
 const server=createServer(async(req,res)=>{
  if(req.method!=='POST'){res.writeHead(405).end();return;}
  let body='';for await(const c of req)body+=c;const r=JSON.parse(body);
  res.setHeader('Content-Type','application/json');
  if(r.method==='notifications/initialized'){res.writeHead(202).end();return;}
  if(r.method==='initialize'){res.end(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'offline',version:'1'}}}));return;}
  if(r.method==='tools/call')calls++;
  const value=failure??{data:{items:[{value:1}]}};
  res.end(JSON.stringify({jsonrpc:'2.0',id:r.id,result:envelope??{content:[{type:'text',text:JSON.stringify(value)}]}}));
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));
 const endpoint=`http://127.0.0.1:${(server.address() as any).port}/mcp`;
 const env={NODE_ENV:'test' as const,SIF_MCP_SECRET:'offline-key',SIF_MCP_ENDPOINT:endpoint,SELLERSPRITE_MCP_ENDPOINT:endpoint};
 const cache=createSorftimeSourceCache({pool:db.pool,now:()=>now});
 const second=createSorftimeSourceCache({pool:db.createPool(),now:()=>now});
 for(const provider of ['sif','sellerSprite'] as const)await t.test(provider,async()=>{
  const tool=provider==='sif'?'market_get_keyword_history':'market_research';
  const args={country:'US',month:'202609',keywords:['lamp']};
  const call=(input=args,options:any={})=>provider==='sif'?callSifTool(tool,input,{env,sourceCache:cache,...options} as any):callSellerSpriteMcpTool('offline-key',tool,input,{env,sourceCache:cache,...options} as any);
  let before=calls;
  const [first]=await Promise.all([call(),call(args,{sourceCache:second})]);
  assert.equal(calls-before,1,'concurrent reads must coalesce');
  const saved=await call();assert.equal(calls-before,1);assert.equal(sourceMetadata(saved)?.cacheHit,true);
  assert.equal(sourceMetadata(saved)?.fetchedAt,sourceMetadata(first)?.fetchedAt);
  let governed=0;
  const connector=(provider==='sif'?createSifConnector:createSellerSpriteConnector)({env,resolveCredential:async()=> 'offline-key',sourceCache:second,resourceGovernor:{run:async input=>{governed++;return input.operation();}}});
  const response=await connector.execute({operation:tool,input:args,governorScope:{organizationId:'test-org',jobId:'test-job'}});
  assert.equal(calls-before,1);assert.equal(governed,0,'cache hit consumes no physical permit');assert.equal(response.source.fetchedAt,sourceMetadata(first)?.fetchedAt);await connector.close?.();
  await call({...args,country:'DE'});await call({...args,month:'202608'});assert.equal(calls-before,3,'site/month are isolated');
  await call(args,{forceRefresh:true});assert.equal(calls-before,4);
  now+=25*3600_000;await call();assert.equal(calls-before,5,'expired cache refetches');
  const scope=provider+'-refresh';now+=1000;
  await db.pool.query('INSERT INTO sorftime_source_refresh_scopes(job_id,not_before) VALUES($1,$2)',[scope,new Date(now)]);
  await call(args,{jobId:scope});assert.equal(calls-before,6,'job refresh barrier rejects older entries');
  failure={code:'ERROR',message:'upstream unavailable'};
  await assert.rejects(call({...args,month:'202607'}));before=calls;
  await assert.rejects(call({...args,month:'202607'}));assert.equal(calls,before,'failure backoff prevents duplicate dispatch');
  now+=6000;failure=null;await call({...args,month:'202607'});assert.equal(calls,before+1);
  failure={code:'ERROR',message:'quota exhausted'};await assert.rejects(call({...args,month:'202606'}));before=calls;
  await assert.rejects(call({...args,month:'202605'}));assert.equal(calls,before,'credential quota pause stops new misses');
  await call();assert.equal(calls,before,'valid cache is usable during quota pause');failure=null;now+=3600_001;
 });
 await t.test('different credentials and unknown operations do not reuse results',async()=>{
  const before=calls;
  for(const secret of ['credential-a','credential-b'])await callSifTool('market_get_keyword_history',{country:'US'},{env:{...env,SIF_MCP_SECRET:secret},sourceCache:cache} as any);
  for(let i=0;i<2;i++)await callSifTool('unreviewed_operation',{}, {env,sourceCache:cache} as any);
  assert.equal(calls-before,4);
 });
 await t.test('empty responses expire after five minutes and failures never replace valid records',async()=>{
  const scopedEnv={...env,SIF_MCP_SECRET:'empty-test-key'};
  const call=()=>callSifTool('market_get_asin_keyword_signals',{country:'US',asin:'B000000001'},{env:scopedEnv,sourceCache:cache});
  failure={top_keywords:[]};const before=calls;await call();await call();assert.equal(calls-before,1);
  now+=300001;failure=null;await call();assert.equal(calls-before,2);
  failure={success:false,error:'temporary failure'};
  await assert.rejects(callSifTool('market_get_asin_keyword_signals',{country:'US',asin:'B000000001'},{env:scopedEnv,sourceCache:cache,forceRefresh:true}));
  failure=null;const after=calls;assert.deepEqual(await call(),{data:{items:[{value:1}]}});assert.equal(calls,after);
 });
 await t.test('pooled SellerSprite dispatches once and does not count handshakes as business calls',async()=>{
  const pool=createSellerSpriteSessionPool();const before=calls;
  try{for(let i=0;i<2;i++)await callSellerSpriteMcpTool('pooled-key','review',{asin:'B000000001'},{env,sourceCache:cache,sessionPool:pool,sessionScope:'market',organizationId:'test-org',jobId:'test-job'} as any);}finally{await pool.close();}
  assert.equal(calls-before,1);
  const events=await db.pool.query("SELECT count(*)::int AS n FROM sorftime_source_events WHERE operation='sellerSprite/review' AND kind='dispatch'");assert.equal(events.rows[0].n,1);
 });
 await t.test('MCP envelopes without business content are not durable successful data',async()=>{
  for(const provider of ['sif','sellerSprite'] as const){
   const options={env:{...env,SIF_MCP_SECRET:'malformed-test-key'},sourceCache:cache};
   const call=()=>provider==='sif'?callSifTool('market_get_keyword_history',{country:'US'},options):callSellerSpriteMcpTool('malformed-test-key','review',{marketplace:'US'},options);
   envelope={content:[]};await assert.rejects(call());
   now+=6000;envelope=null;assert.deepEqual(await call(),{data:{items:[{value:1}]}});
  }
 });
 await t.test('local admission rejection does not pause an unattempted supplier request',async()=>{
  for(const factory of [createSifConnector,createSellerSpriteConnector]){
   let blocked=true;
   const connector=factory({env,resolveCredential:async()=> 'admission-test-key',sourceCache:cache,resourceGovernor:{run:async input=>{if(blocked)throw new ResourceGovernorAdmissionError({reason:'concurrency'});return input.operation();}}});
   const request={operation:connector.id==='sif'?'market_get_keyword_history':'review',input:{country:'US'},governorScope:{organizationId:'test-org',jobId:'test-job'}};
   const before=calls;await assert.rejects(connector.execute(request),(e:any)=>e.code==='local-admission');assert.equal(calls,before);
   blocked=false;assert.deepEqual((await connector.execute(request)).data,{data:{items:[{value:1}]}});assert.equal(calls,before+1);await connector.close?.();
  }
 });
 await t.test('child process reuses persisted SIF response through environment switch',async()=>{
  // Use wall-clock time for data read by another process.
  now=Date.now();const args={country:'US',keywords:['cross-process']};const childKeyEnv={...env,SIF_MCP_SECRET:'cross-process-key'};
  await callSifTool('market_get_keyword_history',args,{env:childKeyEnv,sourceCache:cache} as any);const before=calls;
  const childEnv={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,...childKeyEnv,SHARED_MCP_SOURCE_CACHE_ENABLED:'1',AGENT_DATABASE_URL:`postgresql://postgres@127.0.0.1:${db.pool.options.port}/${db.pool.options.database}`};
  await promisify(execFile)(process.execPath,['--input-type=module','-e',`import {callSifTool} from './scripts/lib/sif-mcp-client.mjs'; await callSifTool('market_get_keyword_history',${JSON.stringify(args)});`],{env:childEnv,windowsHide:true});
  assert.equal(calls,before);
 });
 const eventRows=await db.pool.query("SELECT estimated_units FROM sorftime_source_events WHERE operation LIKE 'sif/%' OR operation LIKE 'sellerSprite/%'");
 assert.ok(eventRows.rows.every(r=>r.estimated_units===null||r.estimated_units===0),'do not apply Sorftime prices to other providers');
});
