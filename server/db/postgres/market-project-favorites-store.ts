import {buildProjectPreviewContext} from '../../../shared/market-project-preview';
import {PostgresMarketProjectCatalog} from './market-project-catalog-store';
import {PostgresModuleVisibilityStore} from './module-visibility-store';
import type {MarketExecutionActor} from '../market-module-execution-repository';
import {createHash} from 'node:crypto';
import {ProjectContextSchema,ProjectFavoriteSchema,ProjectFavoriteCreateSchema,ProjectFavoriteUpdateSchema,ProjectFavoriteQuerySchema,projectModules,type ProjectContext,type ProjectFavorite,type ProjectFavoriteCreate,type ProjectFavoriteUpdate,type ProjectFavoriteQuery,type ProjectStatus} from '../../../shared/market-project-favorites-contracts';
import type {MarketFavoriteActor} from '../market-favorites-repository';
import {PostgresQueryContext} from './query-context';
export class ProjectFavoriteError extends Error {constructor(readonly statusCode:400|403|404|409,message:string){super(message)}}
const moduleKinds={overview:'overview',shapes:'shape-price',keywords:'keywords',themes:'customer-themes'};
const iso=(v:unknown)=>new Date(v as string).toISOString();
export class PostgresMarketProjectFavoritesStore {
 constructor(private readonly queries:PostgresQueryContext){}
 async catalog(actor:MarketFavoriteActor,input:unknown){return new PostgresMarketProjectCatalog(this.queries).catalog(actor,input)}
 async history(actor:MarketFavoriteActor,input:unknown){return new PostgresMarketProjectCatalog(this.queries).history(actor,input)}
 private async owner(actor:MarketFavoriteActor){return actor.role==='admin'||(await this.queries.query('SELECT 1 FROM system_owners WHERE organization_id=$1 AND user_id=$2',[actor.organizationId,actor.userId])).rows.length>0}
 private async group(actor:MarketFavoriteActor,id:string|null){if(id&&!(await this.queries.query('SELECT 1 FROM market_project_favorite_groups WHERE id=$1',[id])).rows.length)throw new ProjectFavoriteError(400,'分组不存在，请刷新后重试')}
 private async runs(actor:MarketFavoriteActor,ids:string[]){return (await this.queries.query(`SELECT r.id,r.request_json,r.status,r.latest_report_attempt_id,(COALESCE(a.output_json->'report',a.output_json) IS NOT NULL AND COALESCE(a.output_json->'report',a.output_json) <> 'null'::jsonb) report_exists,COALESCE(a.output_json#>>'{report,status}',a.output_json->>'status') report_status FROM market_analysis_module_runs r LEFT JOIN market_analysis_step_attempts a ON a.id=r.latest_report_attempt_id AND a.organization_id=r.organization_id WHERE r.id=ANY($2::uuid[]) AND (r.organization_id=$1 OR EXISTS (SELECT 1 FROM market_project_favorites f CROSS JOIN LATERAL jsonb_each(f.context_json) b WHERE b.value->>'runId'=r.id::text))`,[actor.organizationId,ids])).rows}
 /** Only published favorite bindings grant cross-organization read access. Mutations never use this resolver. */
 async resolveReadActor(actor:MarketExecutionActor,kind:'run'|'study',id:string):Promise<MarketExecutionActor>{
  const row=(await this.queries.query(`SELECT DISTINCT r.organization_id FROM market_analysis_module_runs r JOIN market_project_favorites f ON EXISTS (SELECT 1 FROM jsonb_each(f.context_json) b WHERE b.value->>'runId'=r.id::text) WHERE ${kind==='run'?'r.id::text':'r.study_id'}=$1`,[id])).rows[0];
  if(!row||row.organization_id===actor.organizationId)return actor;
  const visible=await new PostgresModuleVisibilityStore(this.queries).read(actor.organizationId,actor.userId);
  if(!visible.includes('market'))throw new ProjectFavoriteError(403,'无权访问市场调研');
  return {...actor,organizationId:row.organization_id};
 }
 async normalize(actor:MarketFavoriteActor,value:ProjectContext){
  const context=ProjectContextSchema.parse(value),rows=await this.runs(actor,projectModules.flatMap(m=>context[m]?.runId?[context[m]!.runId!]:[]));
  for(const m of projectModules){const binding=context[m];if(!binding?.runId)continue;const row=rows.find(r=>r.id===binding.runId!.toLowerCase());if(!row||row.request_json.moduleKind!==moduleKinds[m])throw new ProjectFavoriteError(400,'收藏报告不存在、模块不匹配或无权访问');
   const s=row.request_json.scope;context[m]={marketplace:s.marketplace,nodeIdPath:s.nodeIdPath,fromMonth:s.fromMonth,toMonth:s.toMonth,runId:row.id,...(s.overviewPeriod?{overviewPeriod:s.overviewPeriod}:{})};
  }return ProjectContextSchema.parse(context);
 }
 private async readAll(actor:MarketFavoriteActor,id?:string):Promise<ProjectFavorite[]>{
  const rows=(await this.queries.query(`SELECT f.*,u.display_name creator_name FROM market_project_favorites f JOIN users u ON u.id=f.created_by AND u.organization_id=f.organization_id WHERE ($1::uuid IS NULL OR f.id=$1) ORDER BY f.updated_at DESC,f.id DESC`,[id??null])).rows;
  const admin=await this.owner(actor),runs=await this.runs(actor,rows.flatMap(r=>projectModules.flatMap(m=>r.context_json[m]?.runId?[r.context_json[m].runId]:[])));
  return rows.map(row=>{const context=ProjectContextSchema.parse(row.context_json),moduleStatus={} as Record<typeof projectModules[number],ProjectStatus>;
   for(const m of projectModules){const id=context[m]?.runId,r=runs.find(r=>r.id===id);let status:ProjectStatus='conditions';if(id){if(!r||r.request_json.moduleKind!==moduleKinds[m])status='unavailable';else if(['queued','running'].includes(r.status))status='running';else if(r.status==='succeeded'&&r.latest_report_attempt_id){status=!r.report_exists||['partial','no-data','unavailable'].includes(r.report_status)?'partial':'ready'}else status='partial'}moduleStatus[m]=status}
   const statuses=Object.values(moduleStatus),status:ProjectStatus=statuses.every(s=>s==='ready')?'ready':statuses.includes('running')?'running':statuses.every(s=>s==='conditions')?'conditions':statuses.includes('unavailable')?'unavailable':'partial';
   return ProjectFavoriteSchema.parse({id:row.id,title:row.title,groupId:row.group_id,note:row.note,tag:row.tag,context,createdBy:row.created_by,creatorName:row.creator_name,createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),revision:row.revision,canEdit:(admin&&row.organization_id===actor.organizationId)||row.created_by===actor.userId,moduleStatus,status});
  });
 }
 private filter(all:ProjectFavorite[],actor:MarketFavoriteActor,q:ProjectFavoriteQuery){return all.filter(p=>(!q.q||[p.title,p.tag,...projectModules.map(m=>p.context[m]?.nodeIdPath??'')].some(t=>t.toLowerCase().includes(q.q.toLowerCase())))&&(!q.site||projectModules.some(m=>p.context[m]?.marketplace===q.site))&&(!q.status||p.status===q.status)&&(!q.groupId||(q.groupId==='ungrouped'?p.groupId===null:p.groupId===q.groupId))&&(q.mine!=='true'||p.createdBy===actor.userId));}
 async list(actor:MarketFavoriteActor,value:ProjectFavoriteQuery){const q=ProjectFavoriteQuerySchema.parse(value),all=await this.readAll(actor),rows=this.filter(all,actor,q);
  const page=Math.min(q.page,Math.max(1,Math.ceil(rows.length/10)));const groups=(await this.queries.query('SELECT id,name FROM market_project_favorite_groups ORDER BY created_at,id',[])).rows.map(g=>({...g,count:all.filter(p=>p.groupId===g.id).length}));
  return {items:rows.slice((page-1)*10,page*10),total:rows.length,page,pageSize:10 as const,groups,stats:{total:all.length,ready:all.filter(p=>p.status==='ready').length,followUp:all.filter(p=>p.status!=='ready').length,sites:new Set(all.flatMap(p=>projectModules.flatMap(m=>p.context[m]?[p.context[m]!.marketplace]:[]))).size}};
 }
 async get(actor:MarketFavoriteActor,id:string){
  const item=(await this.readAll(actor,id)).find(p=>p.id===id);if(!item)throw new ProjectFavoriteError(404,'未找到该调研收藏');
  const catalog=new PostgresMarketProjectCatalog(this.queries),categories=[...new Set(projectModules.flatMap(m=>item.context[m]?[item.context[m]!.nodeIdPath.split(':').at(-1)!]:[]))];
  const candidates=(await Promise.all(categories.map(category=>catalog.previewCandidates(actor,category)))).flat();
  item.previewContexts={};for(const m of projectModules)if(item.context[m])item.previewContexts[m]=buildProjectPreviewContext(item.context,m,candidates);
  return item;
 }
 async export(actor:MarketFavoriteActor,value:ProjectFavoriteQuery){const rows=this.filter(await this.readAll(actor),actor,ProjectFavoriteQuerySchema.parse(value));if(rows.length>10000)throw new ProjectFavoriteError(400,'导出超过一万条，请缩小筛选范围');return rows}

 async create(actor:MarketFavoriteActor,value:ProjectFavoriteCreate){const input=ProjectFavoriteCreateSchema.parse(value);await this.group(actor,input.groupId);const context=await this.normalize(actor,input.context),fingerprint=createHash('sha256').update(JSON.stringify(context)).digest('hex');
  const id=await this.queries.transaction(async client=>{
   await client.query(`INSERT INTO market_project_favorites(id,organization_id,created_by,title,group_id,note,tag,context_json,fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT DO NOTHING`,[input.id,actor.organizationId,actor.userId,input.title,input.groupId,input.note,input.tag,JSON.stringify(context),fingerprint]);
   const row=(await client.query('SELECT id,fingerprint FROM market_project_favorites WHERE id=$1 OR fingerprint=$2 ORDER BY (id=$1) DESC',[input.id,fingerprint])).rows[0];if(!row||row.fingerprint!==fingerprint)throw new ProjectFavoriteError(409,'收藏提交与已有记录冲突，请刷新重试');return row.id;
  });return (await this.readAll(actor,id)).find(p=>p.id===id)!;
 }
 async update(actor:MarketFavoriteActor,id:string,value:ProjectFavoriteUpdate){const input=ProjectFavoriteUpdateSchema.parse(value);await this.group(actor,input.groupId);const admin=await this.owner(actor);await this.queries.transaction(async client=>{const row=(await client.query('SELECT * FROM market_project_favorites WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!row)throw new ProjectFavoriteError(404,'未找到该调研收藏');if(!(admin&&row.organization_id===actor.organizationId)&&row.created_by!==actor.userId)throw new ProjectFavoriteError(403,'仅创建人或管理员可编辑');if(row.revision!==input.revision)throw new ProjectFavoriteError(409,'收藏已被更新，请刷新后重新编辑');await client.query('UPDATE market_project_favorites SET title=$3,group_id=$4,note=$5,tag=$6,revision=revision+1,updated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2',[row.organization_id,id,input.title,input.groupId,input.note,input.tag]);});return (await this.readAll(actor,id)).find(p=>p.id===id)!}
 async createGroup(actor:MarketFavoriteActor,input:{id:string;name:string}){await this.queries.query('INSERT INTO market_project_favorite_groups(id,organization_id,created_by,name) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[input.id,actor.organizationId,actor.userId,input.name]);const group=(await this.queries.query('SELECT id,name FROM market_project_favorite_groups WHERE name=$1',[input.name])).rows[0];if(!group)throw new ProjectFavoriteError(409,'分组提交冲突');return {...group,count:0}}
}
