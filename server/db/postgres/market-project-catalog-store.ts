import {ProjectCatalogSchema,ProjectCatalogQuerySchema,ProjectHistoryQuerySchema,ProjectHistorySchema} from '../../../shared/market-project-catalog-contracts';
import type {MarketFavoriteActor} from '../market-favorites-repository';
import type {PostgresQueryContext} from './query-context';
import {buildProjectPreviewContext,type ProjectPreviewCandidate} from '../../../shared/market-project-preview';

// Listing projects only reads scalar report status in PostgreSQL, never report bodies over the wire.
// A saved binding is the shared-read grant. No unrelated task enters this relation.
const referencesSql=`WITH expanded AS (
 SELECT f.id favorite_id,f.title,f.tag,f.group_id,f.created_by,f.updated_at,u.display_name creator_name,
 b.key module, b.value->>'runId' run_id,COALESCE(r.created_at,f.updated_at) report_created_at,
 (a.output_json IS NOT NULL AND COALESCE(a.output_json->'report',a.output_json) <> 'null'::jsonb
  AND COALESCE(a.output_json#>>'{report,status}',a.output_json->>'status','') NOT IN ('no-data','unavailable')) report_exists,
 COALESCE(b.value->>'runId',f.id::text||':'||b.key) identity,
 CASE WHEN r.request_json->>'moduleKind'=CASE b.key WHEN 'shapes' THEN 'shape-price' WHEN 'themes' THEN 'customer-themes' ELSE b.key END
 THEN jsonb_strip_nulls(jsonb_build_object('marketplace',r.request_json#>>'{scope,marketplace}','nodeIdPath',r.request_json#>>'{scope,nodeIdPath}','fromMonth',r.request_json#>>'{scope,fromMonth}','toMonth',r.request_json#>>'{scope,toMonth}','runId',r.id::text,'overviewPeriod',r.request_json#>>'{scope,overviewPeriod}')) ELSE b.value END binding,
 jsonb_strip_nulls(jsonb_build_object('headTopN',f.context_json->'headTopN','newProductMonths',f.context_json->'newProductMonths','keywordInput',CASE WHEN b.key='keywords' THEN f.context_json->'keywordInput' END)) parameters,
 CASE WHEN b.value->>'runId' IS NULL THEN 'conditions'
 WHEN r.id IS NULL OR r.request_json->>'moduleKind' IS DISTINCT FROM CASE b.key WHEN 'shapes' THEN 'shape-price' WHEN 'themes' THEN 'customer-themes' ELSE b.key END THEN 'unavailable'
 WHEN r.status IN ('queued','running') THEN 'running'
 WHEN r.status='succeeded' AND r.latest_report_attempt_id IS NOT NULL AND a.output_json IS NOT NULL AND COALESCE(a.output_json->'report',a.output_json) <> 'null'::jsonb
 AND COALESCE(a.output_json#>>'{report,status}',a.output_json->>'status','') NOT IN ('partial','no-data','unavailable') THEN 'ready'
 ELSE 'partial' END status
 FROM market_project_favorites f JOIN users u ON u.id=f.created_by AND u.organization_id=f.organization_id
 CROSS JOIN LATERAL jsonb_each(f.context_json) b
 LEFT JOIN market_analysis_module_runs r ON r.id::text=b.value->>'runId'
 LEFT JOIN market_analysis_step_attempts a ON a.id=r.latest_report_attempt_id AND a.organization_id=r.organization_id
 WHERE b.key IN ('overview','shapes','keywords','themes')
 AND ($2::boolean=false OR f.created_by=$1::text)
 AND ($3::text IS NULL OR CASE WHEN $3='ungrouped' THEN f.group_id IS NULL ELSE f.group_id::text=$3 END)
), filtered AS (
 SELECT *,regexp_replace(binding->>'nodeIdPath','^.*:','') category_id FROM expanded
 WHERE ($4::text IS NULL OR binding->>'marketplace'=$4)
 AND ($5::text='' OR strpos(lower(title||' '||tag||' '||(binding->>'nodeIdPath')),lower($5))>0)
 AND ($6::text IS NULL OR status=$6)
), refs AS (
 SELECT DISTINCT ON (category_id,module,identity) * FROM filtered
 ORDER BY category_id,module,identity,updated_at DESC,favorite_id DESC
)`;
function values(actor:MarketFavoriteActor,q:ReturnType<typeof ProjectCatalogQuerySchema.parse>){return [actor.userId,q.mine==='true',q.groupId??null,q.site??null,q.q,q.status??null]}
const catalogSql=referencesSql+`, names AS (
 -- Read names before report deduplication, so auto-named duplicate bindings do
 -- not hide an older custom title. Exclude only the generated title formats.
 SELECT DISTINCT ON (category_id) category_id,btrim(title) display_name FROM filtered
 WHERE btrim(title)<>''
 AND btrim(title)<>('类目 '||category_id||' · '||(binding->>'marketplace')||' 调研')
 AND btrim(title) !~ '^[A-Z]{2} · .+ · [0-9]{4}-[0-9]{2}～[0-9]{4}-[0-9]{2}( · (市场总览|形态价格|关键词|买家评论) · [a-f0-9]{8})?$'
 ORDER BY category_id,updated_at DESC,favorite_id DESC
), aligned AS (
 SELECT category_id,binding->>'marketplace',binding->>'fromMonth',binding->>'toMonth',COALESCE(binding->>'overviewPeriod','calendar')
 FROM refs WHERE status='ready' GROUP BY 1,2,3,4,5 HAVING count(DISTINCT module)=4
), modules AS (
 SELECT category_id,module,jsonb_build_object('reports',count(*) FILTER(WHERE run_id IS NOT NULL),'conditions',count(*) FILTER(WHERE run_id IS NULL),'ready',count(*) FILTER(WHERE status='ready'),'running',count(*) FILTER(WHERE status='running')) summary
 FROM refs GROUP BY category_id,module
), categories AS (
 SELECT category_id,jsonb_build_object('categoryId',category_id,'displayName',(SELECT display_name FROM names n WHERE n.category_id=refs.category_id),'sites',jsonb_agg(DISTINCT binding->>'marketplace'),
 'reports',count(*) FILTER(WHERE run_id IS NOT NULL),'conditions',count(*) FILTER(WHERE run_id IS NULL),
 'complete',EXISTS(SELECT 1 FROM aligned a WHERE a.category_id=refs.category_id),'updatedAt',max(updated_at),
 'modules','{"overview":{"reports":0,"conditions":0,"ready":0,"running":0},"shapes":{"reports":0,"conditions":0,"ready":0,"running":0},"keywords":{"reports":0,"conditions":0,"ready":0,"running":0},"themes":{"reports":0,"conditions":0,"ready":0,"running":0}}'::jsonb || (SELECT jsonb_object_agg(module,summary) FROM modules m WHERE m.category_id=refs.category_id)) item,
 max(updated_at) updated_at FROM refs GROUP BY category_id
), totals AS (SELECT count(*)::int total,LEAST($7::int,GREATEST(1,ceil(count(*)/10.0)::int)) page FROM categories), paged AS (
 SELECT item FROM categories ORDER BY updated_at DESC,category_id LIMIT 10 OFFSET (SELECT (page-1)*10 FROM totals)
)
SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(item) FROM paged),'[]'::jsonb),'total',total,'page',page,'pageSize',10,
 'groups',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',g.id,'name',g.name,'count',(SELECT count(*) FROM market_project_favorites f WHERE f.group_id=g.id)) ORDER BY g.created_at,g.id) FROM market_project_favorite_groups g),'[]'::jsonb),
 'stats',jsonb_build_object('categories',total,'reports',(SELECT count(*) FROM refs WHERE run_id IS NOT NULL),'conditions',(SELECT count(*) FROM refs WHERE run_id IS NULL),'complete',(SELECT count(DISTINCT category_id) FROM aligned),'sites',(SELECT count(DISTINCT binding->>'marketplace') FROM refs))) result FROM totals`;
const historySql=referencesSql+`, selected AS (
 SELECT * FROM refs WHERE category_id=$7 AND module=$8
), totals AS (SELECT count(*)::int total,LEAST($9::int,GREATEST(1,ceil(count(*)/10.0)::int)) page FROM selected), paged AS (
 SELECT jsonb_build_object('favoriteId',favorite_id,'title',title,'creatorName',creator_name,'updatedAt',updated_at,'status',status,'context',jsonb_build_object(module,binding)||parameters) item
 FROM selected ORDER BY updated_at DESC,favorite_id DESC LIMIT 10 OFFSET (SELECT (page-1)*10 FROM totals)
)
SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(item) FROM paged),'[]'::jsonb),'total',total,'page',page,'pageSize',10) result FROM totals`;

function isoDates(result:{items:{updatedAt:string}[]}){for(const row of result.items)row.updatedAt=new Date(row.updatedAt).toISOString();return result}

const previewSql=referencesSql+` SELECT jsonb_build_object(module,binding)||parameters context,status,report_created_at,report_exists
 FROM refs WHERE category_id=$7 AND run_id IS NOT NULL AND status IN ('ready','partial')`;

export class PostgresMarketProjectCatalog {
 constructor(private readonly queries:PostgresQueryContext){}
 async previewCandidates(actor:MarketFavoriteActor,categoryId:string):Promise<ProjectPreviewCandidate[]>{
  const peers=await this.queries.query(previewSql,[...values(actor,ProjectCatalogQuerySchema.parse({})),categoryId]);
  return peers.rows.map(r=>({context:r.context,status:r.status,createdAt:new Date(r.report_created_at).toISOString(),hasReport:r.report_exists}));
 }
 async catalog(actor:MarketFavoriteActor,input:unknown){const q=ProjectCatalogQuerySchema.parse(input);const result=await this.queries.query(catalogSql,[...values(actor,q),q.page]);return ProjectCatalogSchema.parse(isoDates(result.rows[0].result))}
 async history(actor:MarketFavoriteActor,input:unknown){
  const q=ProjectHistoryQuerySchema.parse(input);
  const [result,peers]=await Promise.all([
   this.queries.query(historySql,[...values(actor,q),q.categoryId,q.module,q.page]),
   // Peers come from all published favorites, independent of list filters. Only metadata is read.
   this.previewCandidates(actor,q.categoryId),
  ]);
  const history=ProjectHistorySchema.parse(isoDates(result.rows[0].result));
  for(const row of history.items)row.previewContext=buildProjectPreviewContext(row.context,q.module,peers);
  return ProjectHistorySchema.parse(history);
 }
}
