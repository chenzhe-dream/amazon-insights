import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {startPostgresTestContainer} from './helpers/postgres-test-container';
import {createSorftimeSourceCache, sourceIdentity, sourceMetadata, estimateSorftimeCost} from '../../scripts/lib/sorftime-source-cache.mjs';
import {callSorftimeTool} from '../../scripts/lib/sorftime-mcp-client.mjs';
import {createSorftimeConnector} from '../../server/connectors/mcp-connectors';
import {runPostgresMigrations} from '../../server/db/postgres/migrations';
import {createProductDetailEvidence} from '../../scripts/lib/scoped-sorftime-evidence.mjs';
import {attachSourceMetadata} from '../../scripts/lib/sorftime-source-policy.mjs';

test('shared Sorftime cache: market 150 plus competitor 10, restart, isolation, failures and quota', {timeout:120_000}, async t => {
  const db=await startPostgresTestContainer(); t.after(()=>db.close());
  await db.pool.query(await readFile(new URL('../../server/db/migrations/postgres/0067_sorftime_source_cache.sql',import.meta.url),'utf8'));
  let now=Date.parse('2026-10-14T00:00:00Z');
  const cache=createSorftimeSourceCache({pool:db.pool,now:()=>now});
  const second=createSorftimeSourceCache({pool:db.createPool(),now:()=>now});
  let calls=0;
  const fetchImpl:typeof fetch=async (_url,init)=>{
    calls++;
    const args=JSON.parse(String(init?.body)).params.arguments;
    return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:JSON.stringify({data:{...args,values:[1,2]}})}]}}));
  };
  const env={};
  const call=(asin:string,type='SalesVolume',site='US',key='test-key')=>callSorftimeTool(key,'product_trend',{asin,amz_site:site,type},{sourceCache:cache,fetchImpl,env});
  const asin=(i:number)=>'B'+String(i).padStart(9,'0');
  await t.test('competitor evidence keeps source time instead of new job time',async()=>{
    const detail=attachSourceMetadata({data:{asin:asin(1),title:'lamp',price:20}},{fetchedAt:'2026-10-13T22:00:00.000Z'});
    const evidence=createProductDetailEvidence({jobId:'new-job',marketplace:'US',asin:asin(1),detail,fetchedAt:'2026-10-14T00:00:00.000Z'});
    assert.equal(evidence.fetchedAt,'2026-10-13T22:00:00.000Z');
  });
  await t.test('100 then 150 fetches only delta; competitor and repeat need zero additional histories',async()=>{
    for(let i=0;i<100;i++)for(const type of ['SalesVolume','SalesAmount'])await call(asin(i),type);
    assert.equal(calls,200);
    for(let i=0;i<150;i++)for(const type of ['SalesVolume','SalesAmount'])await call(asin(i),type);
    assert.equal(calls,300);
    for(let i=0;i<10;i++)for(const type of ['SalesVolume','SalesAmount'])await call(asin(i),type);
    assert.equal(calls,300);
    const costs=await db.pool.query("SELECT sum(estimated_units)::int AS units FROM sorftime_source_events WHERE kind='dispatch'");
    assert.equal(costs.rows[0].units,1500);
  });
  await t.test('independent connector uses same cache and original collection timestamp',async()=>{
    const connector=createSorftimeConnector({env,resolveCredential:async()=> 'test-key',fetchImpl,sourceCache:second});
    const result=await connector.execute({operation:'product_trend',input:{type:'SalesVolume',amz_site:'US',asin:asin(1)}});
    assert.equal(calls,300);
    assert.equal(result.source.fetchedAt,new Date(now).toISOString());
  });
  await t.test('canonical identity includes site, credential, page, metric and all filters',async()=>{
    await call(asin(0),'SalesVolume','DE'); await call(asin(0),'Price'); await call(asin(0),'SalesVolume','US','another-key');
    assert.equal(calls,303);
    const base={key:'test-key',endpoint:'https://example.com',tool:'product_search',args:{amz_site:'US',page:1}};
    assert.notEqual(sourceIdentity(base).id,sourceIdentity({...base,args:{...base.args,page:2}}).id);
    assert.notEqual(sourceIdentity(base).id,sourceIdentity({...base,args:{...base.args,search_name:'lamp'}}).id);
    assert.equal(sourceIdentity(base).id,sourceIdentity({...base,args:{page:1,amz_site:'US'}}).id);
  });
  await t.test('concurrent independent cache instances perform one physical collection',async()=>{
    let n=0;
    const spec={key:'parallel',endpoint:'https://example.com',tool:'product_detail',args:{asin:asin(999),amz_site:'US'}};
    const execute=async({recordAttempt}:{recordAttempt:()=>Promise<void>})=>{await recordAttempt();n++;await new Promise(r=>setTimeout(r,80));return {data:{asin:asin(999)}};};
    const [a,b]=await Promise.all([cache.run(spec,execute),second.run(spec,execute)]);
    assert.equal(n,1);assert.deepEqual(a,b);assert.ok(sourceMetadata(b)?.fetchedAt);
  });
  await t.test('separate Node processes share durable cache and concurrent lock',async()=>{
    let physical=0;
    const server=createServer(async(req,res)=>{
      for await(const _chunk of req) {}
      physical++;await new Promise(r=>setTimeout(r,150));
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:JSON.stringify({data:{asin:asin(912)}})}]}}));
    });
    await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
    try {
      const address=server.address() as {port:number},config=db.pool.options;
      const env:NodeJS.ProcessEnv={...process.env,NODE_ENV:'test',SORFTIME_SOURCE_CACHE_ENABLED:'1',
        AGENT_DATABASE_URL:`postgresql://postgres@127.0.0.1:${config.port}/${config.database}`,
        SORFTIME_MCP_ENDPOINT:`http://127.0.0.1:${address.port}`,
        AGENT_CHILD_RESOURCE_GOVERNOR_REQUIRED:'0',AGENT_SYNC_JOB_ID:'',FORCE_REFRESH:'0'};
      const clientUrl=new URL('../../scripts/lib/sorftime-mcp-client.mjs',import.meta.url).href;
      const script=`import {callSorftimeTool} from ${JSON.stringify(clientUrl)};await callSorftimeTool('cross-process-test-key','product_detail',{asin:'${asin(912)}',amz_site:'US'});`;
      const child=()=>promisify(execFile)(process.execPath,['--input-type=module','-e',script],{env,windowsHide:true,timeout:15000});
      await Promise.all([child(),child()]);assert.equal(physical,1);
      await child();assert.equal(physical,1);
    } finally {await new Promise<void>(r=>server.close(()=>r()));}
  });
  await t.test('aborted waiter never dispatches or releases owner lock',async()=>{
    const spec={key:'cancel',endpoint:'https://example.com',tool:'product_detail',args:{asin:asin(913),amz_site:'US'}};
    let entered!:()=>void,release!:()=>void,n=0;
    const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
    const owner=cache.run(spec,async()=>{n++;entered();await gate;return {data:{ok:true}};});
    await ready;const controller=new AbortController();
    const waiter=second.run({...spec,signal:controller.signal},async()=>{n++;return {data:{ok:true}};});
    const rejection=assert.rejects(waiter);controller.abort();await rejection;release();await owner;
    assert.equal(n,1);
  });
  await t.test('known empty data expires quickly, unsuccessful envelopes are never cached',async()=>{
    const spec={key:'empty',endpoint:'https://example.com',tool:'product_reviews',args:{asin:asin(914),amz_site:'US'}};
    let n=0;const execute=async()=>{n++;return {data:[]};};
    await cache.run(spec,execute);await cache.run(spec,execute);assert.equal(n,1);
    now+=301000;await cache.run(spec,execute);assert.equal(n,2);
    await assert.rejects(cache.run({...spec,key:'unsuccessful'},async()=>({success:false,message:'error'})));
    const id=sourceIdentity({...spec,key:'unsuccessful'}).id;
    assert.equal((await db.pool.query('SELECT 1 FROM sorftime_source_cache WHERE cache_key=$1',[id])).rowCount,0);
  });
  await t.test('expiry and explicit refresh fetch again',async()=>{
    const before=calls;now+=25*3600_000;await call(asin(0));assert.equal(calls,before+1);
    await callSorftimeTool('test-key','product_trend',{asin:asin(0),amz_site:'US',type:'SalesVolume'},{sourceCache:cache,fetchImpl,env,forceRefresh:true});
    assert.equal(calls,before+2);
  });
  await t.test('explicit market recollection refreshes once, subsequent steps reuse its result',async()=>{
    const before=calls;now+=1000;
    await db.pool.query('INSERT INTO sorftime_source_refresh_scopes(job_id,not_before) VALUES($1,$2)',['refresh-market-job',new Date(now)]);
    const args={asin:asin(0),amz_site:'US',type:'SalesVolume'};
    const options={sourceCache:cache,fetchImpl,env,jobId:'refresh-market-job'};
    assert.equal((await cache.estimate([{key:'test-key',endpoint:'https://mcp.sorftime.com',tool:'product_trend',args,jobId:'refresh-market-job'}])).estimatedUnits,5);
    await callSorftimeTool('test-key','product_trend',args,options);
    await callSorftimeTool('test-key','product_trend',args,options);
    assert.equal(calls,before+1);
  });
  await t.test('provider errors never become success and can recover',async()=>{
    const spec={key:'error',endpoint:'https://example.com',tool:'product_detail',args:{asin:asin(777),amz_site:'US'}};
    await assert.rejects(cache.run(spec,async()=>{throw new Error('network');}));
    now+=6000;
    assert.deepEqual(await cache.run(spec,async()=>({data:{ok:true}})),{data:{ok:true}});
  });
  await t.test('quota exhausted stops next uncached request, cached reads remain usable',async()=>{
    let n=0;
    const mock:typeof fetch=async()=>{n++;return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:{isError:true,content:[{type:'text',text:'MCP使用次数已达到上限，请升级您的套餐'}]}}));};
    await assert.rejects(callSorftimeTool('test-key','product_detail',{asin:asin(800),amz_site:'US'},{sourceCache:cache,fetchImpl:mock,env}));
    await assert.rejects(callSorftimeTool('test-key','product_detail',{asin:asin(801),amz_site:'US'},{sourceCache:second,fetchImpl:mock,env}));
    assert.equal(n,1);
    const before=calls;await call(asin(0));assert.equal(calls,before);
  });
  await t.test('budget deduplicates and marks unknown prices without billing claims',async()=>{
    assert.equal(estimateSorftimeCost('product_trend',{type:'SalesAmount'}),5);
    assert.equal(estimateSorftimeCost('product_trend',{type:'BsrRank'}),10);
    assert.equal(estimateSorftimeCost('unknown',{}),null);
    const spec={key:'test-key',endpoint:'https://example.com',tool:'product_detail',args:{asin:asin(9999),amz_site:'US'}};
    const budget=await cache.estimate([spec,spec]);
    assert.equal(budget.uniqueRequests,1);assert.equal(budget.estimatedUnits,1);
  });
  await t.test('150+10 full shared-request manifest budgets cache and competitor internal duplicates',async()=>{
    const requests:Array<{tool:string,args:Record<string,any>}>=[];
    const add=(tool:string,args:Record<string,any>)=>requests.push({tool,args});
    add('category_products',{node_id:'1063294',amz_site:'US'});
    for(let page=1;page<=3;page++)add('product_search',{search_name:'Floor Lamps',amz_site:'US',page,subcategory_sales_volume_rank_min:101,subcategory_sales_volume_rank_max:150});
    const metrics=['SalesCount','AvgPrice','Top3ProductSalesAmountShare','Top3BrandSalesAmountShare','Top3SellerSalesAmountShare'];
    add('category_report',{node_id:'1063294',amz_site:'US'});
    for(const trend_index of metrics)add('category_trend',{node_id:'1063294',amz_site:'US',trend_index});
    for(let i=0;i<150;i++){
      for(const type of ['SalesVolume','SalesAmount'])add('product_trend',{asin:asin(i),amz_site:'US',type});
      add('product_detail',{asin:asin(i),amz_site:'US'});
    }
    for(let i=0;i<20;i++)add('product_customers_say',{asin:asin(i),site:'US'});
    for(let i=0;i<10;i++){
      for(const type of ['SalesVolume','SalesAmount','Price','Rank','Price'])add('product_trend',{asin:asin(i),amz_site:'US',type});
      for(let step=0;step<4;step++)add('product_detail',{asin:asin(i),amz_site:'US'});
      add('product_content',{asin:asin(i),amz_site:'US'});
      add('product_customers_say',{asin:asin(i),site:'US'});
      for(let step=0;step<2;step++){
        add('product_reviews',{asin:asin(i),amz_site:'US',review_type:'Both'});
        add('product_variations',{asin:asin(i),amz_site:'US',page:1});
      }
    }
    for(const trend_index of metrics)add('category_trend',{node_id:'1063294',amz_site:'US',trend_index});
    const specs=requests.map(r=>({...r,key:'manifest-key',endpoint:'https://mcp.sorftime.com'}));
    const budget=await cache.estimate(specs);
    assert.equal(budget.estimatedUnits,1873);assert.equal(budget.networkRequests,530);
    assert.equal(requests.reduce((sum,r)=>sum+(estimateSorftimeCost(r.tool,r.args)??0),0),2148);
    const before=calls;
    for(const request of requests)await callSorftimeTool('manifest-key',request.tool,request.args,{sourceCache:cache,fetchImpl,env,jobId:'manifest-150-10'});
    assert.equal(calls-before,530);
    const repeat=await second.estimate(specs);
    assert.equal(repeat.estimatedUnits,0);assert.equal(repeat.networkRequests,0);
    for(const request of requests)await callSorftimeTool('manifest-key',request.tool,request.args,{sourceCache:second,fetchImpl,env});
    assert.equal(calls-before,530);
    console.log(JSON.stringify({scenario:'offline-150-plus-10',logicalRequests:requests.length,coldPhysicalRequests:530,coldEstimatedUnits:1873,repeatedPhysicalRequests:0}));
  });
});

test('0067 migration installs with all current migrations and safely reruns',{timeout:90_000},async t=>{
  const db=await startPostgresTestContainer();t.after(()=>db.close());
  const first=await runPostgresMigrations(db.pool),second=await runPostgresMigrations(db.pool);
  assert.deepEqual(second,first);
  assert.ok(first.some(migration=>migration.version===67));
  const tables=await db.pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'sorftime_source_%' ORDER BY tablename");
  assert.deepEqual(tables.rows.map(r=>r.tablename),['sorftime_source_cache','sorftime_source_events','sorftime_source_pauses','sorftime_source_refresh_scopes']);
});
