import {MarketDevelopmentConclusionService} from '../../server/services/market-development-conclusion-service';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,mkdtemp,readFile,writeFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {startPostgresTestContainer} from './helpers/postgres-test-container';
import {runPostgresMigrations} from '../../server/db/postgres/migrations';
import {PostgresQueryContext} from '../../server/db/postgres/query-context';
import {PostgresMarketResearchStore} from '../../server/db/postgres/market-research-store';
import {PostgresMarketModuleExecutionStore} from '../../server/db/postgres/market-module-execution-store';
import {MarketResearchService,MarketResearchWorker} from '../../server/services/market-research-service';
import {MarketModuleService} from '../../server/services/market-module-service';
import {MarketLinkedService} from '../../server/services/market-linked-service';
import {collectMarketOverview} from '../../server/services/market-overview-collector';
import {createMarketModelRuntime} from '../../server/runtime/market-model-runtime';
import {loadVocPositioningRuntimeConfig} from '../../server/config';
import {createSorftimeConnector,createSifConnector,createSellerSpriteConnector} from '../../server/connectors/mcp-connectors';
import type {RemoteMcpConnector} from '../../server/connectors/connector-contract';
import {loadPreviousMarketResult,needsPreviousMarketResult} from '../../app/lib/market-retained-result';
import {createSorftimeSourceCache} from '../../scripts/lib/sorftime-source-cache.mjs';

const root=fileURLToPath(new URL('../..',import.meta.url));
const asin=(n:number)=>`B${String(n).padStart(9,'0')}`;
const row=(n:number)=>({asin:asin(n),title:`Synthetic floor lamp ${n}`,brand:'Offline',price:30,monthly_sales_volume:100,monthly_sales_amount:3000,gross_profit_margin:70,category_rank:`Floor Lamps (Rank: ${n})`,subcategory:`Floor Lamps (Rank: ${n})`,online_date:'2025-01-01',main_image:['https://m.media-amazon.com/images/I/offline.jpg'],sub_category:[['Floor Lamps','34',n,'20261014']],star_rating:4.5,review_count:12});

test('offline real market workers and competitor collection scripts expose dispatch reuse',{timeout:900000},async t=>{
 const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);
 const directory=await mkdtemp(path.join(tmpdir(),'market-dispatch-audit-'));
 const actor={organizationId:randomUUID(),userId:randomUUID()};
 await pg.pool.query("INSERT INTO users(id,organization_id,email,display_name,role,status,created_at,updated_at) VALUES($1,$2,$3,'Offline audit','member','active',clock_timestamp(),clock_timestamp())",[actor.userId,actor.organizationId,`${actor.userId}@example.test`]);
 const context=new PostgresQueryContext(pg.pool),store=new PostgresMarketResearchStore(context),steps=new PostgresMarketModuleExecutionStore(context);
 // Capture the real settlement exception in this isolated synthetic test, before
 // the worker intentionally redacts it to the public error code.
 const settle=PostgresMarketModuleExecutionStore.prototype.settleAndEnqueue;
 PostgresMarketModuleExecutionStore.prototype.settleAndEnqueue=async function(input){
  try{return await settle.call(this,input);}catch(error){
   console.error('AUDIT settlement-error '+JSON.stringify({kind:(input as {claim:{step:{kind:string}}}).claim.step.kind,error:String(error),stack:error instanceof Error?error.stack:null}));throw error;
  }
 };
 t.after(()=>{PostgresMarketModuleExecutionStore.prototype.settleAndEnqueue=settle;});

 const physical:any[]=[],logical:any[]=[],stageResults:any[]=[],checkpoints:any[]=[];let phase='initial',modelCalls=0,quotaDuringModules=false;
 const sifPayload=(op:string,a:any):unknown=>{
  if(op==='market_get_asin_keyword_signals')return {asin:a.asin,marketplace:'US',summary:{total_keywords_in_period:2,top_keywords_analyzed:2},top_keywords:['floor lamp','floor lamp for kids'].map(keyword=>({keyword,traffic_share:.5,search_volume:100}))};
  if(op==='market_get_keyword_history')return {country:'US',granularity:'month',keywords:a.keywords.map((keyword:string)=>({keyword,data_points:1,dates:['2026-09'],volumes:[100],ranks:[1],top3_click_shares:[.2],top3_conversion_shares:[.1]}))};
  if(op==='market_assess_keyword_promotion')return {assessments:a.keywords.map((keyword:string)=>({keyword,supporting_signals:{cpc_fixed_exact:1}}))};
  if(op==='ops_get_listing_traffic_overview')return {overview:{nf:{score:70,ratio:.7},ad:{score:30,ratio:.3}},total:100,data_notice:'Synthetic 2026-10-14'};
  if(op==='ops_get_listing_traffic_structure')return {chars:{dims:[{val:a.asin,sumScore:100,ratio:1}],nfs:[{score:70}],sps:[{score:30}],recs:[{score:0}],sbs:[{score:0}],sbvs:[{score:0}]}};
  if(op==='ops_get_asin_traffic_trend')return {dates:['2026-09'],nfScore:[{score:70}],adScore:[{score:30}]};
  throw Error(`Unimplemented virtual SIF tool: ${op}`);
 };
 const payload=(op:string,a:any):unknown=>{
  if(op==='category_products')return {data:Array.from({length:100},(_,i)=>({...row(i+1),sub_category:[['Floor Lamps','34',i+1]]}))};
  if(op==='category_keywords')return {data:[{keyword:'floor lamp',search_volume:100,search_rank:1}]};
  if(op==='category_report')return {data:{category_stats_report:{category_name:'Floor Lamps',node_id:'34',top100_monthly_sales_volume:10000},top100_products:Array.from({length:100},(_,i)=>row(i+1))}};
  if(op==='product_search')return {data:Array.from({length:Math.max(0,Math.min(20,150-(100+(Number(a.page)-1)*20)))},(_,i)=>row(101+(Number(a.page)-1)*20+i))};
  if(op==='product_detail')return {data:{...row(Number(String(a.asin).slice(1))),asin:a.asin,node_id:'34',category:['Lighting','228013'],fba_fee:4.2,coupon:0,feature:['Synthetic easy assembly'],a_plus:false}};
  if(op==='product_content')return {data:{asin:a.asin,main_image:['https://m.media-amazon.com/images/I/offline.jpg','https://m.media-amazon.com/images/I/offline-secondary.jpg']}};
  if(op==='product_trend'||op==='category_trend')return {data:['2026-06=100','2026-07=110','2026-08=120','2026-09=130']};
  if(op==='product_customers_say')return {data:{details:[{keyword:'easy assembly',content:'Easy to assemble for this synthetic example.',mention:10,positive:9,negative:1,update_time:'2026-09-01'}]}};
  if(op==='product_reviews')return {data:[{title:'Synthetic review',content:'Easy to assemble and bright.',star_rating:5,variant_attribute:'Color: Black'}]};
  if(op==='product_variations')return {data:[{Asin:a.asin,Property:'Color: Black',SalesAmount:100,ItemTotal:1,ItemIndex:1}]};
  if(op==='keyword_extends')return {data:[{keyword:'floor lamp'},{keyword:'floor lamp for kids'}]};
  if(op==='keyword_trend')return {data:{keyword:a.keyword,search_volume_trend:['2026-09 search volume 100'],search_rank_trend:[],recommended_bid_trend:[]}};
  throw Error(`Unimplemented virtual Sorftime tool: ${op}`);
 };
 const server=createServer(async(req,res)=>{try{
  if(req.method!=='POST'){res.writeHead(405).end();return;}
  let body='';for await(const c of req)body+=c;const r=JSON.parse(body);
  res.setHeader('Content-Type','application/json');
  if(r.method==='notifications/initialized'){res.writeHead(202).end();return;}
  if(r.method==='initialize'){res.end(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'offline',version:'1'}}}));return;}
  assert.equal(r.method,'tools/call');
  const provider=req.url?.startsWith('/sif')?'sif':req.url?.startsWith('/seller')?'sellerSprite':'sorftime';
  physical.push({phase,provider,operation:r.params.name,args:r.params.arguments});
  if(quotaDuringModules){res.end(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{isError:true,content:[{type:'text',text:'MCP使用次数已达上限，额度耗尽'}]}}));return;}
  const data=(provider==='sif'?sifPayload:provider==='sellerSprite'?sellerPayload:payload)(r.params.name,r.params.arguments);
  res.end(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{content:[{type:'text',text:JSON.stringify(data)}]}}));
 }catch(e){res.statusCode=500;res.end(JSON.stringify({error:String(e)}));}});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));
 const endpoint=`http://127.0.0.1:${(server.address() as any).port}/mcp`,key='offline-public-source-key';
 const cache=createSorftimeSourceCache({pool:pg.pool});
 const remote=createSorftimeConnector({env:{NODE_ENV:'test',SORFTIME_MCP_ENDPOINT:endpoint},resolveCredential:async()=>key,sourceCache:cache,fetchImpl:async(url,init)=>{assert.equal(new URL(String(url)).origin,new URL(endpoint).origin);return fetch(url,init);}});
 const sorftime:RemoteMcpConnector={...remote,execute:async r=>{logical.push({phase,provider:'sorftime',operation:r.operation,args:r.input});return remote.execute(r);}};
 const sellerPayload=(operation:string,input:any)=>{
  const r={operation};const a:any=input.request??input;
  const month=String(a.month??'202609').replace(/^(\d{4})(\d{2})$/,'$1-$2');let data:Record<string,unknown>|unknown[];
  const basic={marketplace:'US',currency:'USD',nodeIdPath:'12:34',nodeId:'34',nodeLabelName:'Floor Lamps',month,topProducts:100,products:100,totalUnits:10000,totalRevenue:300000,avgPrice:30};
  if(r.operation==='product_node')data=[{nodeIdPath:'12:34',nodeLabelPath:'Floor Lamps'}];
  else if(r.operation==='market_research')data={items:[basic]};
  else if(r.operation==='market_research_statistics')data=basic;
  else if(r.operation==='competitor_lookup')data={page:a.page,pages:1,items:a.asins.map((asin:string)=>({asin,price:30,profit:70,fba:4.2}))};
  else if(r.operation==='market_product_concentration')data=Array.from({length:100},(_,i)=>({...row(i+1),totalUnits:100,totalRevenue:3000,ranking:i+1}));
  else if(r.operation==='market_product_demand_trend')data={items:[],asinCount:null};
  else if(r.operation==='market_seller_type_concentration')data=[{label:'FBA',asinNum:100,productNum:100,units:10000}];
  else if(r.operation==='market_ebc_distribution')data=['有A+有视频','有A+无视频','无A+有视频','无A+无视频'].flatMap(label=>[{label,products:25,units:2500},{label:`新品${label}`,products:0,units:0}]);
  else if(['market_brand_concentration','market_seller_concentration','market_seller_country_distribution','market_listing_date_distribution','market_listing_trend_distribution','market_price_distribution','market_rating_distribution','market_ratings_count_distribution'].includes(r.operation))data=[{label:'Synthetic bucket',brand:'Offline',sellerName:'Offline seller',asins:[asin(1)],products:100,units:10000,totalUnits:10000,revenue:300000,totalRevenue:300000}];
  else if(r.operation==='keyword_research')data={items:[]};
  else if(r.operation==='aba_research_trend')data=[];
  else if(r.operation==='market_get_keyword_history')data={country:'US',granularity:'month',keywords:a.keywords.map((keyword:string)=>({keyword,data_points:1,dates:['2026-09'],volumes:[100],ranks:[1],top3_click_shares:[.2],top3_conversion_shares:[.1]}))};
  else throw Error(`Unimplemented virtual SellerSprite tool: ${r.operation}`);
  return {code:'OK',marketplace:'US',currency:'USD',nodeIdPath:'12:34',month,data};
 };
 const environment={NODE_ENV:'test',SELLERSPRITE_MCP_ENDPOINT:new URL('/seller',endpoint).href,SIF_MCP_ENDPOINT:new URL('/sif',endpoint).href};
 const track=(remote:RemoteMcpConnector):RemoteMcpConnector=>({...remote,execute:async r=>{logical.push({phase,provider:remote.id,operation:r.operation,args:r.input});return remote.execute(r);}});
 const seller=track(createSellerSpriteConnector({env:environment,resolveCredential:async()=> 'offline-seller-secret',sourceCache:cache}));
 const sif=track(createSifConnector({env:environment,resolveCredential:async()=> 'offline-sif-secret',sourceCache:cache}));
 t.after(()=>seller.close?.());
 const research=new MarketResearchService({repository:store,findUser:async()=>({organizationId:actor.organizationId,status:'active'})});
 const service=new MarketModuleService({context,modelIdentity:()=>null});
 const linked=new MarketLinkedService({context,research,modules:service});
 const basicWorker=new MarketResearchWorker({repository:store,collect:i=>collectMarketOverview({...i,connector:seller})});t.after(()=>basicWorker.stop());
 const config=loadVocPositioningRuntimeConfig({OPENAI_API_KEY:'synthetic',AGENT_VOC_MODEL:'gpt-5.6',AGENT_VOC_ESTIMATED_INPUT_TOKENS:'12000',AGENT_VOC_MAX_OUTPUT_TOKENS:'4000',AGENT_VOC_TIMEOUT_MS:'60000',AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS:'1',AGENT_VOC_OUTPUT_USD_PER_MILLION_TOKENS:'2',AGENT_VOC_CALL_MAX_TOKENS:'1000000',AGENT_VOC_CALL_MAX_COST_MICROS:'10000000',AGENT_VOC_RUN_MAX_TOKENS:'1000000',AGENT_VOC_RUN_MAX_COST_MICROS:'10000000',AGENT_VOC_DAILY_MAX_TOKENS:'1000000',AGENT_VOC_DAILY_MAX_COST_MICROS:'10000000',AGENT_VOC_WORKER_OWNER_ID:'offline-dispatch-audit'});
 const runtime=await createMarketModelRuntime(context,config,{connectors:{sellerSprite:seller,sorftime,sif},client:{responses:{create:async()=>{modelCalls++;throw Error('Rules path must not call a model');}}} as never});t.after(()=>runtime.stop());
 const checkpoint=async(name:string)=>{const events=(await pg.pool.query('SELECT operation,kind,count(*)::int AS count,sum(estimated_units)::int AS estimated_units FROM sorftime_source_events GROUP BY operation,kind ORDER BY operation,kind')).rows;checkpoints.push({name,physical:physical.length,logical:logical.length,events});console.log('AUDIT '+JSON.stringify(checkpoints.at(-1)));};
 const drain=async()=>{for(let i=0;i<1200;i++){if(!await runtime.tick())return;if(i%100===99)console.log(`AUDIT ${phase}: ${i+1} worker ticks`);}throw Error('Worker did not settle');};
 const request={scope:{marketplace:'US',nodeQuery:'34',month:'2026-09',headTopN:10,newProductMonths:6},fromMonth:'2026-07'};
 const runBatch=async(forceRefresh=false,failModules=false)=>{const id=randomUUID();await linked.create(actor,{...request,forceRefresh},id);await basicWorker.tick();await linked.tick();const batch=(await linked.find(actor,id)).batch;assert.equal(batch.status,'started',JSON.stringify(batch));quotaDuringModules=failModules;try{await drain();}finally{quotaDuringModules=false;}const views=[];for(const entry of Object.values(batch.modules)){const view=await steps.findModuleRun({actor,moduleRunId:entry.runId!});assert.ok(view);const summary={module:view.run.moduleKind,status:view.run.status,steps:view.steps.map(s=>({kind:s.kind,status:s.status,input:s.input})),errors:view.attempts.filter(a=>a.error).map(a=>a.error)};views.push(summary);console.log('AUDIT module '+JSON.stringify({...summary,steps:summary.steps.filter(s=>s.status==='failed')}));}return {batch,views};};
 phase='market-linked-100';const initial=await runBatch();await checkpoint(phase);
 const conclusions=new MarketDevelopmentConclusionService(context,service),conclusionBasis={kind:'linked' as const,batchId:initial.batch.id};
 const callsBeforeConclusion=physical.length,preview=await conclusions.read(actor,conclusionBasis);
 assert.equal(preview.response.conclusion.evidence.length,4);assert.ok(preview.response.conclusion.evidence.every(e=>e.identity&&e.status!=='mismatch'&&e.status!=='missing'),JSON.stringify(preview.response.conclusion.evidence));
 const frozenConclusion=await conclusions.save(actor,conclusionBasis,preview.response.contentHash);
 assert.ok(frozenConclusion.savedAt);assert.equal(physical.length,callsBeforeConclusion,'conclusion generation and freeze use no provider calls');
 if(process.env.MARKET_VIRTUAL_CONCLUSIONS_ONLY==='1'){assert.deepEqual((await conclusions.read(actor,conclusionBasis,frozenConclusion.contentHash)).response.conclusion,frozenConclusion.conclusion);console.log('CONCLUSION four modules generated, frozen and replayed; provider delta 0');return;}


 phase='market-expand-150';const study=await service.createStudy(actor,{marketplace:'US',currency:'USD',nodeIdPath:'12:34',fromMonth:'2026-07',toMonth:'2026-09'},randomUUID());
 const expanded=await service.startShapes(actor,study.study.id,{poolSize:150,newProductMonths:6,catalog:{task:'market-product-shape-suggestion',taxonomyVersion:'manual-after-collection/v1',allowedLabels:[]}},randomUUID());await drain();const shape=(await service.findShapes(actor,expanded.run.id)).run;await checkpoint(phase);
 assert.equal(shape.source?.products.length,150,JSON.stringify({shape,initial:initial.views,physical}));assert.equal(shape.status,'succeeded');
 phase='report-reload';const before=physical.length;await linked.find(actor,initial.batch.id);await service.findOverview(actor,initial.batch.modules.overview.runId!);await service.findKeywords(actor,initial.batch.modules.keywords.runId!);await service.findRun(actor,initial.batch.modules.themes.runId!);await service.findShapes(actor,expanded.run.id);assert.equal(physical.length,before);await checkpoint(phase);
 const generated=path.join(directory,'data','generated-app-data');await mkdir(generated,{recursive:true});await mkdir(path.join(directory,'runtime'),{recursive:true});
 for(const name of await readdir(path.join(root,'app')))if(name.endsWith('-data.ts'))await writeFile(path.join(generated,name),'// Isolated synthetic run; no seed records.\n');
 await writeFile(path.join(generated,'competitor-data.ts'),'export const refreshedCatalog = [];');
 const guard=path.join(directory,'network-guard.mjs');await writeFile(guard,`const original=globalThis.fetch;globalThis.fetch=(u,o)=>{if(new URL(String(u)).origin!==${JSON.stringify(new URL(endpoint).origin)})throw Error('Offline external fetch blocked');return original(u,o)};`);
 const childEnv:NodeJS.ProcessEnv={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,NODE_ENV:'test',SORFTIME_MCP_KEY:key,SORFTIME_MCP_ENDPOINT:endpoint,SORFTIME_SOURCE_CACHE_ENABLED:'1',AGENT_DATABASE_URL:`postgresql://postgres@127.0.0.1:${pg.pool.options.port}/${pg.pool.options.database}`,AGENT_FORMAL_WORKTREE_ROOT:root,AGENT_DATA_ROOT:path.join(directory,'data'),AGENT_RUNTIME_ROOT:path.join(directory,'runtime'),AGENT_CHILD_RESOURCE_GOVERNOR_REQUIRED:'0',SORFTIME_ASINS:Array.from({length:10},(_,i)=>asin(i+1)).join(','),SORFTIME_MARKETPLACE:'US'};
 Object.assign(childEnv,{SHARED_MCP_SOURCE_CACHE_ENABLED:'1',SIF_MCP_SECRET:'offline-sif-secret',SIF_MCP_ENDPOINT:new URL('/sif',endpoint).href,SIF_ASINS:childEnv.SORFTIME_ASINS,SIF_MARKETPLACE:'US'});
 const scripts=['catalog-from-sorftime','sif-keyword-analysis',...['rating','review-analysis','sales-trend','variant-data','child-sales','price-strategy','fba-fee','listing-content','category-trend'].map(s=>`sorftime-${s}`),'sif-listing-traffic'];
 const runScripts=async(round:string)=>{for(const script of scripts){phase=`${round}/${script}`;const count=physical.length;let result;try{const r=await promisify(execFile)(process.execPath,['--import',pathToFileURL(guard).href,`scripts/build-${script}.mjs`],{cwd:root,env:childEnv,windowsHide:true,timeout:120000,maxBuffer:2_000_000});result={exitCode:0,...r};}catch(e:any){result={exitCode:e.code,stdout:e.stdout,stderr:e.stderr};}stageResults.push({phase,physical:physical.length-count,...result});console.log('AUDIT script '+JSON.stringify({phase,physical:physical.length-count,exitCode:result.exitCode}));}await checkpoint(round);};
 await runScripts('competitor-first');await runScripts('competitor-repeat');
 const counts=async()=> (await pg.pool.query('SELECT (SELECT count(*) FROM market_research_jobs)::int AS jobs,(SELECT count(*) FROM market_analysis_module_runs)::int AS runs,(SELECT count(*) FROM market_analysis_steps)::int AS steps')).rows[0];
 const beforeRestore=await counts(),restoreStart=performance.now();
 phase='market-second-batch';const repeated=await runBatch();await checkpoint(phase);
 assert.deepEqual(await counts(),beforeRestore,'restoring completed history creates no collection jobs, runs or steps');
 assert.equal(repeated.batch.basicJobId,initial.batch.basicJobId);
 for(const module of ['overview','shapes','keywords','themes'] as const)assert.equal(repeated.batch.modules[module].runId,initial.batch.modules[module].runId);
 console.log('RESTORE '+JSON.stringify({elapsedMs:Math.round(performance.now()-restoreStart),newJobs:0,newRuns:0,newSteps:0,providerCalls:0}));
 const modules=['overview','shapes','keywords','themes'] as const;
 type Module=typeof modules[number];
 const readRun=async(module:Module,id:string):Promise<any>=>{
  if(module==='overview')return (await service.findOverview(actor,id)).run;
  if(module==='shapes')return (await service.findShapes(actor,id)).run;
  if(module==='keywords')return (await service.findKeywords(actor,id)).run;
  return (await service.findRun(actor,id)).run;
 };
 const usable=(module:Module,run:any)=>module==='overview'?!!(run.currentReport??run.latestSavedReport):module==='shapes'?!!run.source?.products.length||!!run.latestRevision:module==='keywords'?!!run.facts?.members.length:!!(run.currentReport??run.latestSavedReport)?.report.counts.successfulCount;
 const snapshot=async(batch:typeof initial.batch)=>Object.fromEntries(await Promise.all(modules.map(async module=>[module,await readRun(module,batch.modules[module].runId!)])));
 const initialSaved=await snapshot(initial.batch);
 for(const module of modules)assert.ok(usable(module,initialSaved[module]),module+' initial report must contain data');
 const scenarios:any[]=[{name:'ordinary-query',sameFourRunIds:true,newJobs:0,newRuns:0,newSteps:0,providerCalls:physical.filter(r=>r.phase==='market-second-batch').length}];
 const standaloneBefore=await counts(),standaloneCalls=physical.length;
 for(const module of ['keywords','themes'] as const){
  const saved=initialSaved[module],{organizationId,researchId,...scope}=saved.scope;
  const result=await service[module==='keywords'?'queryKeywords':'queryThemes'](actor,{scope,params:saved.params},randomUUID());
  assert.equal(result.run.id,saved.id,'standalone query restores a real linked saved report');
  const afterRestart=new MarketModuleService({context,modelIdentity:()=>null,now:()=>new Date(Date.now()+8*86400000)});
  assert.equal((await afterRestart[module==='keywords'?'queryKeywords':'queryThemes'](actor,{scope,params:saved.params},randomUUID())).run.id,saved.id,'closed-month saved reports survive restart and source TTL');
 }
 assert.deepEqual(await counts(),standaloneBefore);assert.equal(physical.length,standaloneCalls);
 scenarios.push({name:'standalone-saved-query',sameRunIds:true,providerCalls:0,newRuns:0});
 const refreshBefore=await counts(),refreshCalls=physical.length;
 phase='explicit-refresh';const refreshed=await runBatch(true);const refreshAfter=await counts();
 for(const module of modules)assert.notEqual(refreshed.batch.modules[module].runId,initial.batch.modules[module].runId,module);
 assert.notEqual(refreshed.batch.basicJobId,initial.batch.basicJobId);
 assert.ok(refreshed.views.every(v=>v.status==='succeeded'),JSON.stringify(refreshed.views.map(v=>({...v,steps:v.steps.filter(s=>s.status==='failed')}))));
 assert.ok(physical.length>refreshCalls,'explicit refresh must call virtual providers');
 assert.deepEqual(await snapshot(initial.batch),initialSaved,'refresh must not modify previous four reports');
 const refreshSaved=await snapshot(refreshed.batch);
 for(const module of modules)assert.ok(usable(module,refreshSaved[module]),module+' refreshed report must contain data');
 scenarios.push({name:'explicit-refresh',newJobs:refreshAfter.jobs-refreshBefore.jobs,newRuns:refreshAfter.runs-refreshBefore.runs,providerCalls:physical.length-refreshCalls,modules:refreshed.views.map(v=>({module:v.module,status:v.status}))});
 await checkpoint(phase);
 phase='quota-failed-refresh';const failedCalls=physical.length;const failed=await runBatch(true,true);
 const retained=[];
 for(const module of modules){
  const current=await readRun(module,failed.batch.modules[module].runId!);
  assert.notEqual(current.id,refreshSaved[module].id,module+' failed refresh must have its own identity');
  assert.ok(current.steps.some((s:any)=>s.current&&s.errorCode==='quota-exhausted'),module+' must expose quota-exhausted: '+JSON.stringify(current.steps));
  assert.ok(needsPreviousMarketResult(current,run=>usable(module,run)),module+' failed or partial refresh must retain the previous report');
  const restored=await loadPreviousMarketResult(current,async id=>readRun(module,id),id=>id===current.id?refreshSaved[module].id:null,run=>usable(module,run),new AbortController().signal);
  assert.deepEqual(restored,refreshSaved[module],module+' retains exact previous result');
  retained.push({module,failedRun:current.id,retainedRun:restored!.id,status:current.status,hasPartialNewResult:usable(module,current),quotaReported:true});
 }
 assert.deepEqual(await snapshot(refreshed.batch),refreshSaved,'quota failure must not alter the last successful reports');
 scenarios.push({name:'quota-failed-refresh',providerCalls:physical.length-failedCalls,modules:retained});await checkpoint(phase);
 const failedRestoreCounts=await counts(),failedRestoreCalls=physical.length;
 for(const module of ['keywords','themes'] as const){
  const saved=refreshSaved[module],{organizationId,researchId,...scope}=saved.scope;
  const result=await service[module==='keywords'?'queryKeywords':'queryThemes'](actor,{scope,params:saved.params},randomUUID());
  assert.equal(result.run.id,saved.id,'standalone query ignores a newer unusable failed refresh');
 }
 phase='ordinary-after-failure';const recovered=await runBatch();
 assert.deepEqual(await counts(),failedRestoreCounts,'ordinary query after failure creates no jobs/runs/steps');
 assert.equal(physical.length,failedRestoreCalls,'ordinary query after quota failure is local only');
 for(const module of modules)assert.equal(recovered.batch.modules[module].runId,refreshed.batch.modules[module].runId,module+' selects latest good report rather than failed refresh');
 scenarios.push({name:'ordinary-after-failure',sameFourRunIds:true,newJobs:0,newRuns:0,newSteps:0,providerCalls:0});await checkpoint(phase);
 const frozenReplay=await conclusions.read(actor,conclusionBasis,frozenConclusion.contentHash);assert.deepEqual(frozenReplay.response.conclusion,frozenConclusion.conclusion,'refresh failures cannot rewrite frozen conclusions');
 console.log('SCENARIOS '+JSON.stringify(scenarios));
 const report={synthetic:true,liveCalls:0,directory,scenarios,initial:initial.views,repeated:repeated.views,expanded:{products:shape.source?.products.length,status:shape.status},modelCalls,checkpoints,physical,logical,stageResults};
 const reportPath=path.join(root,'.runtime','market-competitor-offline-dispatch-audit.json');await writeFile(reportPath,JSON.stringify(report,null,2));console.log('AUDIT report '+reportPath);
 assert.equal(modelCalls,0);assert.ok(initial.views.every(v=>!v.steps.some(s=>s.status==='failed')),JSON.stringify(initial.views));
 assert.ok(stageResults.every(r=>r.exitCode===0),JSON.stringify(stageResults.filter(r=>r.exitCode!==0)));
 assert.ok(repeated.views.every(v=>v.status==='succeeded'),JSON.stringify(repeated.views));
 assert.equal(physical.filter(r=>r.phase==='market-second-batch').length,0,'identical market batch shares all providers');
 assert.equal(physical.filter(r=>r.phase.startsWith('competitor-repeat')).length,0);
});
