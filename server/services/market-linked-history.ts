import {canonicalJsonSha256} from '../runtime/model-request-accounting';
import {z} from 'zod';
import {MarketStudyRequestSchema} from '../../shared/market-module-contracts';
import {linkedModuleParams,type LinkedModule,type MarketLinkedRequest} from '../../shared/market-linked-contracts';
import {MARKET_SOURCE_HANDLER_VERSION} from '../../shared/market-source-contracts';
import {marketSiteCurrency} from '../../shared/market-sites';
import {MARKET_OVERVIEW_EXTERNAL_RULES_FLOW_VERSION} from '../domain/market-research/overview-flow';
import {MARKET_OVERVIEW_PRODUCT_CATALOG_VERSION} from '../domain/market-research/overview-complete-catalog';
import {MARKET_SHAPE_SORFTIME_FLOW_VERSION,MARKET_SHAPE_REFERENCE_RULE_VERSION} from '../domain/market-research/shape-price-flow';
import {MARKET_KEYWORD_RULES_FLOW_VERSION} from '../domain/market-research/keyword-flow';
import {MARKET_KEYWORD_POOL_VERSION} from '../domain/market-research/keyword-source-pool';
import {MARKET_THEME_RULES_FLOW_V3} from '../domain/market-research/customer-theme-flow';
import {MARKET_THEME_MAPPING_RULE_VERSION} from '../domain/market-research/customer-theme-mapping-rules';
import {MarketExecutionConflictError,type MarketExecutionActor} from '../db/market-module-execution-repository';
import type {PostgresQueryContext} from '../db/postgres/query-context';
import type {MarketModuleService} from './market-module-service';

const invalidHistoricalEvidence=new Set([
 'Overview report frozen evidence differs','Overview report frozen evidence is unavailable',
 'Overview synthesis report frozen evidence is unavailable','Overview external frozen source differs',
 'Theme report coverage partitions differ','Theme report lineage differs','Unsupported theme report',
 'Undeclared report input','Unaccepted report basis','Invalid empty selection report',
 'Invalid reconciliation report','Invalid rule report','Duplicate report selection',
]);

// Reports for closed months are saved results, not a new observation of the source.
// Their original collection dates and partial status stay intact. Raw-source TTLs
// continue to apply when the caller explicitly requests a fresh collection.
export async function findLinkedBasicHistory(context:PostgresQueryContext,actor:MarketExecutionActor,request:MarketLinkedRequest){
 const scope=request.scope;
 const rows=await context.query<{id:string}>(`SELECT id FROM market_research_jobs
  WHERE organization_id=$1 AND scope_json-'nodeQuery'=$2::jsonb-'nodeQuery'
   AND status IN ('succeeded','partial') AND report_json IS NOT NULL
   AND report_json->>'nodeId'=$3
   AND ($4::text IS NULL OR report_json->>'nodeIdPath'=$4)
  ORDER BY (status='succeeded') DESC,created_at DESC,id DESC LIMIT 20`,
 [actor.organizationId,JSON.stringify(scope),scope.nodeQuery.split(':').at(-1),scope.nodeQuery.includes(':')?scope.nodeQuery:null]);
 return rows.rows;
}

export async function findLinkedModuleHistory(context:PostgresQueryContext,service:MarketModuleService,actor:MarketExecutionActor,
 request:MarketLinkedRequest,module:LinkedModule,nodePath:string,categoryName:string|null){
 const params=linkedModuleParams(module,categoryName,request.scope.newProductMonths,request.scope.headTopN) as Record<string,unknown>;
 return findCompatibleModuleHistory(context,service,actor,{marketplace:request.scope.marketplace,currency:marketSiteCurrency(request.scope.marketplace),nodeIdPath:nodePath,fromMonth:request.fromMonth,toMonth:request.scope.month},module,params);
}

/** Shared by linked and standalone queries: complete frozen inputs and validated report readers. */
export async function findCompatibleModuleHistory(context:PostgresQueryContext,service:MarketModuleService,actor:MarketExecutionActor,
 scope:z.infer<typeof MarketStudyRequestSchema>,module:LinkedModule,params:Record<string,unknown>){
 const nodePath=scope.nodeIdPath;
 const catalog=params.catalog as {taxonomyVersion?:string;dictionaryVersion?:string}|undefined;
 const spec=module==='overview'?{kind:'overview',flow:MARKET_OVERVIEW_EXTERNAL_RULES_FLOW_VERSION,rule:MARKET_OVERVIEW_PRODUCT_CATALOG_VERSION,mapping:MARKET_OVERVIEW_PRODUCT_CATALOG_VERSION}
  :module==='shapes'?{kind:'shape-price',flow:MARKET_SHAPE_SORFTIME_FLOW_VERSION,rule:MARKET_SHAPE_REFERENCE_RULE_VERSION,mapping:catalog!.taxonomyVersion!}
  :module==='keywords'?{kind:'keywords',flow:MARKET_KEYWORD_RULES_FLOW_VERSION,rule:MARKET_KEYWORD_POOL_VERSION,mapping:catalog!.dictionaryVersion!}
  :{kind:'customer-themes',flow:MARKET_THEME_RULES_FLOW_V3,rule:MARKET_THEME_MAPPING_RULE_VERSION,mapping:'theme-groups/unreviewed-v1'};
 const frozen={...params,flow:spec.flow,...(module==='overview'?{scoringVersion:'observed-items/2'}:{}),
  ...(module==='themes'?{catalog:{task:'market-customer-theme-mapping',mappingVersion:spec.mapping,groupCatalog:[]}}:{})};
 const versions={source:MARKET_SOURCE_HANDLER_VERSION,rule:spec.rule,mapping:spec.mapping,planner:spec.flow,model:null,prompt:null,configuration:null};
 const rows=await context.query<{id:string;status:string}>(`SELECT r.id,r.status FROM market_analysis_module_runs r
  JOIN market_analysis_studies s ON s.id=r.study_id AND s.organization_id=r.organization_id
  WHERE r.organization_id=$1 AND r.request_json->>'moduleKind'=$2 AND r.request_json->'scope'=s.scope_json
   AND r.request_json->'scope'->>'marketplace'=$3 AND r.request_json->'scope'->>'currency'=$4
   AND regexp_replace(r.request_json->'scope'->>'nodeIdPath','^.*:','')=$5
   AND ($6::text IS NULL OR r.request_json->'scope'->>'nodeIdPath'=$6 OR r.request_json->'scope'->>'nodeIdPath'=$5)
   AND r.request_json->'scope'->>'fromMonth'=$7 AND r.request_json->'scope'->>'toMonth'=$8
   AND COALESCE(r.request_json->'scope'->>'overviewPeriod','')=''
   AND r.request_json->'params'=$9::jsonb AND r.request_json->'versions'=$10::jsonb
   AND r.status IN ('succeeded','partial','queued','running')
   AND (r.status NOT IN ('queued','running') OR EXISTS(SELECT 1 FROM users u WHERE u.id=r.created_by AND u.organization_id=r.organization_id AND u.status='active'))
  ORDER BY CASE r.status WHEN 'succeeded' THEN 0 WHEN 'partial' THEN 1 ELSE 2 END,r.created_at DESC,r.id DESC LIMIT 30`,
 [actor.organizationId,spec.kind,scope.marketplace,scope.currency,nodePath.split(':').at(-1),nodePath.includes(':')?nodePath:null,
 scope.fromMonth,scope.toMonth,JSON.stringify(frozen),JSON.stringify(versions)]);
 for(const row of rows.rows){
  try{
   // Do not trust a status label alone: exercise the same validated reader as the UI.
   const result=module==='overview'?await service.findOverview(actor,row.id):module==='shapes'?await service.findShapes(actor,row.id)
    :module==='keywords'?await service.findKeywords(actor,row.id):await service.findRun(actor,row.id);
   const run=result.run;
   const usable='source' in run?!!run.source?.products.length:'facts' in run?!!run.facts?.members.length:
    'currentReport' in run?!!(run.currentReport||run.latestSavedReport):false;
   if(['queued','running'].includes(run.status)||usable)return {id:row.id,status:run.status};
  }catch(error){
   // Invalid historical receipts must not prevent trying an earlier valid report.
   if(!(error instanceof z.ZodError)&&!(error instanceof MarketExecutionConflictError)
    &&!(error instanceof TypeError&&invalidHistoricalEvidence.has(error.message))
    &&!(error instanceof Error&&'statusCode' in error&&error.statusCode===404))throw error;
  }
 }
 return null;
}

/** Shared acquisition lock for linked and standalone entry points, including leaf aliases. */
export function marketModuleQueryLock(organizationId:string,module:LinkedModule,scope:z.infer<typeof MarketStudyRequestSchema>,params:unknown){
 return `market-module-query:${canonicalJsonSha256({organizationId,module,scope:{...scope,nodeIdPath:scope.nodeIdPath.split(':').at(-1)},params})}`;
}
