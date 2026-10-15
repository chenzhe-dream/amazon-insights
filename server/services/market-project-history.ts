import {createHash} from 'node:crypto';
import {ProjectContextSchema, ProjectFavoriteCreateSchema, projectModules, type ProjectContext, type ProjectModule} from '../../shared/market-project-favorites-contracts';

type Owner={id:string;organization_id:string;created_by:string;created_at:string};
export type HistoryRun=Owner & {request_json:{moduleKind:string;scope:Record<string,unknown>;params?:Record<string,unknown>}};
type Batch=Owner & {state_json:{categoryName?:string;modules?:Record<string,{runId?:string}>}};
type Legacy=Owner & {module:string;title:string;query_json:Record<string,string>;keyword_input_json?:unknown};
export type HistorySnapshot={runs:HistoryRun[];batches:Batch[];legacy:Legacy[]};
const kinds:Record<string,ProjectModule>={overview:'overview','shape-price':'shapes',keywords:'keywords','customer-themes':'themes'};
const labels={overview:'市场总览',shapes:'形态价格',keywords:'关键词',themes:'买家评论'};
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
function uuid(s:string){const h=hash('market-project-history/v1/'+s);return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}
type Item=Owner & {title:string;group:string;note:string;tag:string;context:ProjectContext;fingerprint:string;origin:string};
export type HistoryPlan={items:Item[];warnings:string[]};
function contextFor(r:HistoryRun):ProjectContext{
 const m=kinds[r.request_json.moduleKind];if(!m)throw new Error('unsupported module');
 const s=r.request_json.scope,p=r.request_json.params??{};
 return ProjectContextSchema.parse({[m]:{marketplace:s.marketplace,nodeIdPath:s.nodeIdPath,fromMonth:s.fromMonth,toMonth:s.toMonth,runId:r.id,...(s.overviewPeriod?{overviewPeriod:s.overviewPeriod}:{})},
 ...(m==='overview'&&p.headTopN?{headTopN:String(p.headTopN)}:{}),...(m==='overview'&&p.newProductMonths?{newProductMonths:String(p.newProductMonths)}:{})});
}
/** No collection, inferred joins, status changes or mutations of source reports. */
export function planProjectHistory(snapshot:HistorySnapshot):HistoryPlan{
 const items:Item[]=[],warnings:string[]=[],used=new Set<string>();
 const runs=new Map(snapshot.runs.map(r=>[r.id,r]));
 const add=(o:Owner,origin:string,group:string,title:string,value:ProjectContext)=>{
  const context=ProjectContextSchema.parse(value),id=uuid(origin);
  const note=`历史数据导入；来源 ${origin}。保留原任务及原始采集范围，报告状态以实际任务为准。`;
  ProjectFavoriteCreateSchema.parse({id,title,context,note,tag:'历史导入'});
  items.push({...o,id,title,group,note,tag:'历史导入',context,fingerprint:hash(JSON.stringify(context)),origin});
 };
 for(const b of [...snapshot.batches].sort((a,b)=>a.id.localeCompare(b.id))){
  try{
   const context:ProjectContext={},members:HistoryRun[]=[];
   for(const m of projectModules){const id=b.state_json.modules?.[m]?.runId;if(!id)continue;const r=runs.get(id);
    if(!r||r.organization_id!==b.organization_id||kinds[r.request_json.moduleKind]!==m)throw new Error('batch member missing or mismatched');
    Object.assign(context,contextFor(r));members.push(r);
   }
   if(!members.length)continue;
   const s=members[0].request_json.scope;
   add(b,'batch:'+b.id,'历史联动调研',`${s.marketplace} · ${b.state_json.categoryName||'类目 '+String(s.nodeIdPath).split(':').at(-1)} · ${s.fromMonth}～${s.toMonth}`,context);
   members.forEach(r=>used.add(r.id));
  }catch{warnings.push('batch:'+b.id+': invalid binding; preserving standalone runs');}
 }
 for(const r of [...snapshot.runs].sort((a,b)=>a.id.localeCompare(b.id))){if(used.has(r.id))continue;
  try{const s=r.request_json.scope,m=kinds[r.request_json.moduleKind];
   add(r,'run:'+r.id,'历史独立报告',`${s.marketplace} · 类目 ${String(s.nodeIdPath).split(':').at(-1)} · ${s.fromMonth}～${s.toMonth} · ${labels[m]} · ${r.id.slice(0,8)}`,contextFor(r));
  }catch{warnings.push('run:'+r.id+': invalid historical context');}
 }
 for(const f of [...snapshot.legacy].sort((a,b)=>a.id.localeCompare(b.id))){
  try{const q=f.query_json,m=f.module as ProjectModule;if(!projectModules.includes(m))throw new Error('unsupported legacy module');
   const prefix={overview:'market',shapes:'marketShape',keywords:'marketKeyword',themes:'marketTheme'}[m];
   const field=(suffix:string)=>q[prefix+suffix]??q['market'+suffix];
   // Legacy records are conditions only: never infer a run from matching dates/category.
   const context=ProjectContextSchema.parse({[m]:{marketplace:field('Site'),nodeIdPath:field('Node'),fromMonth:field('From')??field('Month'),toMonth:field('Month')},...(q.marketHead?{headTopN:q.marketHead}:{}),...(q.marketNew?{newProductMonths:q.marketNew}:{}),...(f.keyword_input_json?{keywordInput:f.keyword_input_json}:{})});
   add(f,'legacy:'+f.id,'旧版收藏',f.title,context);
  }catch{warnings.push('legacy:'+f.id+': invalid historical conditions');}
 }
 return {items,warnings};
}

// JSON is encoded as UTF-8 hex before entering SQL; user titles never become SQL syntax.
const literal=(v:unknown)=>`convert_from(decode('${Buffer.from(JSON.stringify(v),'utf8').toString('hex')}','hex'),'UTF8')::jsonb`;
export function historyInsertSql(plan:HistoryPlan):string{
 return `BEGIN; SET LOCAL search_path=public; SET LOCAL lock_timeout='5s';\n`+plan.items.map(p=>{
  const v=literal(p),groupId=uuid('group:'+p.group);
  return `WITH p AS (SELECT ${v} v) INSERT INTO market_project_favorite_groups(id,organization_id,created_by,name) SELECT '${groupId}',v->>'organization_id',v->>'created_by',v->>'group' FROM p ON CONFLICT DO NOTHING;
WITH p AS (SELECT ${v} v) INSERT INTO market_project_favorites(id,organization_id,created_by,title,group_id,note,tag,context_json,fingerprint,created_at,updated_at) SELECT (v->>'id')::uuid,v->>'organization_id',v->>'created_by',v->>'title',(SELECT id FROM market_project_favorite_groups WHERE name=v->>'group'),v->>'note',v->>'tag',v->'context',v->>'fingerprint',(v->>'created_at')::timestamptz,(v->>'created_at')::timestamptz FROM p ON CONFLICT DO NOTHING;`;
 }).join('\n')+'\nCOMMIT;';
}
