import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {historyInsertSql,planProjectHistory,type HistorySnapshot} from '../server/services/market-project-history';
import {Pool} from 'pg';
import {PostgresQueryContext} from '../server/db/postgres/query-context';
import {PostgresMarketProjectFavoritesStore} from '../server/db/postgres/market-project-favorites-store';
import {ProjectFavoriteQuerySchema} from '../shared/market-project-favorites-contracts';

// Deliberately candidate-only. Formal publication requires a separately reviewed operation.
const container='amazon-insights-candidate-20261008',database='amazon_linked_20261013';
const args=process.argv.slice(2);const apply=args.includes('--apply');
const outArg=args.find(a=>a.startsWith('--output='));if(!outArg)throw new Error('Required: --output=<audit directory> [--apply]');
const directory=resolve(outArg.slice(9));mkdirSync(directory,{recursive:true});
function sql(query:string){return execFileSync('docker',['exec','-i',container,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d',database,'-At'],{input:query,encoding:'utf8',maxBuffer:30*1024*1024,windowsHide:true});}
function rows(query:string){return JSON.parse(sql(`SELECT COALESCE(jsonb_agg(x),'[]'::jsonb) FROM (${query}) x;`));}
const snapshot:HistorySnapshot={
 runs:rows("SELECT id,organization_id,created_by,created_at,jsonb_build_object('moduleKind',request_json->'moduleKind','scope',request_json->'scope','params',jsonb_build_object('headTopN',request_json->'params'->'headTopN','newProductMonths',request_json->'params'->'newProductMonths')) request_json FROM public.market_analysis_module_runs ORDER BY id"),
 batches:rows('SELECT id,organization_id,created_by,created_at,state_json FROM public.market_linked_batches ORDER BY id'),
 legacy:rows('SELECT id,organization_id,created_by,created_at,module,title,query_json,keyword_input_json FROM public.market_favorites ORDER BY id')
};
const before=rows('SELECT * FROM public.market_project_favorites ORDER BY id');
const groups=rows('SELECT * FROM public.market_project_favorite_groups ORDER BY id');
const plan=planProjectHistory(snapshot);
writeFileSync(join(directory,'source-snapshot.json'),JSON.stringify(snapshot,null,2));
writeFileSync(join(directory,'favorites-before.json'),JSON.stringify({favorites:before,groups},null,2));
writeFileSync(join(directory,'plan.json'),JSON.stringify(plan,null,2));
if(plan.warnings.length)throw new Error('Review plan warnings before applying: '+plan.warnings.join('; '));
if(apply)sql(historyInsertSql(plan));
const after=rows('SELECT id,fingerprint,context_json,title,note,revision FROM public.market_project_favorites ORDER BY id');
if(apply){for(const p of plan.items)if(!after.some((r:{fingerprint:string})=>r.fingerprint===p.fingerprint))throw new Error('Missing imported origin '+p.origin);}
const summary={database,apply,sourceRuns:snapshot.runs.length,sourceLegacy:snapshot.legacy.length,planned:plan.items.length,groups:Object.fromEntries([...new Set(plan.items.map(p=>p.group))].map(g=>[g,plan.items.filter(p=>p.group===g).length])),before:before.length,after:after.length,warnings:plan.warnings};
writeFileSync(join(directory,'result.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary,null,2));
if(apply && plan.items.length){
 // Read through the application's actual list/schema code; never output credentials.
 const env: string[]=JSON.parse(execFileSync('docker',['inspect',container,'--format','{{json .Config.Env}}'],{encoding:'utf8',windowsHide:true}));
 const password=env.find(v=>v.startsWith('POSTGRES_PASSWORD='))?.slice('POSTGRES_PASSWORD='.length);
 const pool=new Pool({host:'127.0.0.1',port:64733,database,user:'postgres',password,connectionTimeoutMillis:5000});
 try{
  const p=plan.items[0],actor={organizationId:p.organization_id,userId:p.created_by,role:'member' as const};
  const store=new PostgresMarketProjectFavoritesStore(new PostgresQueryContext(pool));
  const list=await store.list(actor,ProjectFavoriteQuerySchema.parse({}));
  const all=await store.export(actor,ProjectFavoriteQuerySchema.parse({}));
  const result={total:list.total,stats:list.stats,groups:list.groups,pageSize:list.items.length,exportCount:all.length,statusCounts:Object.fromEntries([...new Set(all.map(p=>p.status))].map(s=>[s,all.filter(p=>p.status===s).length]))};
  if(list.total!==after.length||all.length!==after.length)throw new Error('Application list count differs from persisted favorites');
  writeFileSync(join(directory,'application-read-verification.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
 }finally{await pool.end();}
}
