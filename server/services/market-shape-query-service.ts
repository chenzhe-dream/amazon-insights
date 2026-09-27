import {MarketShapeQueryRequestSchema} from '../../shared/market-shape-query-contracts';
import {MarketModuleIdSchema} from '../../shared/market-module-contracts';
import {MARKET_SOURCE_HANDLER_VERSION} from '../../shared/market-source-contracts';
import {assertMarketProductQueryWindow} from '../../shared/market-product-source-policy';
import {MARKET_SHAPE_SORFTIME_FLOW_VERSION,MARKET_SHAPE_REFERENCE_RULE_VERSION} from '../domain/market-research/shape-price-flow';
import {MarketExecutionConflictError,type MarketExecutionActor} from '../db/market-module-execution-repository';
import {canonicalJsonSha256} from '../runtime/model-request-accounting';
import type {PostgresQueryContext} from '../db/postgres/query-context';
import type {MarketModuleService} from './market-module-service';

/** One durable command receipt and a scoped advisory lock protect retries and simultaneous clicks. */
export async function queryShapeRun(service:MarketModuleService,context:PostgresQueryContext,actor:MarketExecutionActor,body:unknown,key:unknown,now:string){
 const input=MarketShapeQueryRequestSchema.parse(body),command=MarketModuleIdSchema.parse(key);
 assertMarketProductQueryWindow(input.scope,new Date(now));
 const requestHash=canonicalJsonSha256(input);
 const leaf=input.scope.nodeIdPath.split(':').at(-1)!;
 const identity=canonicalJsonSha256({actor,scope:{...input.scope,nodeIdPath:leaf},params:input.params,flow:MARKET_SHAPE_SORFTIME_FLOW_VERSION,source:MARKET_SOURCE_HANDLER_VERSION,rule:MARKET_SHAPE_REFERENCE_RULE_VERSION});
 return context.transaction(async()=>{
  const authorized=await context.query("SELECT id FROM users WHERE id=$1 AND organization_id=$2 AND status='active' FOR SHARE",[actor.userId,actor.organizationId]);
  if(!authorized.rowCount)throw new MarketExecutionConflictError();
  // Command lock first also protects one key incorrectly submitted with two different scopes.
  await context.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`shape-command:${actor.organizationId}:${actor.userId}:${command}`]);
  const receipt=await context.query<{request_hash:string;run_id:string}>('SELECT request_hash,run_id FROM market_shape_query_receipts WHERE organization_id=$1 AND user_id=$2 AND command_id=$3',[actor.organizationId,actor.userId,command]);
  if(receipt.rows[0]){
   if(receipt.rows[0].request_hash!==requestHash)throw new MarketExecutionConflictError();
   return {created:false,...await service.findShapes(actor,receipt.rows[0].run_id)};
  }
  await context.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`shape-query:${identity}`]);
  const found=input.forceRefresh?null:(await context.query<{id:string}>(`SELECT r.id FROM market_analysis_module_runs r
   WHERE r.organization_id=$1 AND r.created_by=$2 AND r.request_json->>'moduleKind'='shape-price'
    AND r.request_json->'scope'->>'marketplace'=$3 AND r.request_json->'scope'->>'currency'=$4
    AND regexp_replace(r.request_json->'scope'->>'nodeIdPath','^.*:','')=$5
    AND ($6::text IS NULL OR r.request_json->'scope'->>'nodeIdPath'=$6)
    AND r.request_json->'scope'->>'fromMonth'=$7 AND r.request_json->'scope'->>'toMonth'=$8
    AND ((r.request_json->'params')-'flow')=$9::jsonb AND r.request_json->'params'->>'flow'=$10
    AND r.request_json->'versions'->>'source'=$11 AND r.request_json->'versions'->>'rule'=$12
    AND (r.status IN ('queued','running') OR (r.status='succeeded' AND r.created_at >= $13::timestamptz-interval '7 days'))
   ORDER BY (r.status IN ('queued','running')) DESC,r.created_at DESC,r.id DESC LIMIT 1`,
   [actor.organizationId,actor.userId,input.scope.marketplace,input.scope.currency,leaf,input.scope.nodeIdPath.includes(':')?input.scope.nodeIdPath:null,input.scope.fromMonth,input.scope.toMonth,JSON.stringify(input.params),MARKET_SHAPE_SORFTIME_FLOW_VERSION,MARKET_SOURCE_HANDLER_VERSION,MARKET_SHAPE_REFERENCE_RULE_VERSION,now])).rows[0];
  const cached=found?await service.findShapes(actor,found.id):null;
  const usable=cached && (cached.run.status!=='succeeded'||!!cached.run.source?.products.length);
  const result=usable?{created:false,...cached}:await (async()=>{
   const {study}=await service.createStudy(actor,input.scope,command);
   return service.startShapes(actor,study.id,input.params,command);
  })();
  await context.query('INSERT INTO market_shape_query_receipts(organization_id,user_id,command_id,request_hash,run_id,created_at) VALUES($1,$2,$3,$4,$5,$6)',[actor.organizationId,actor.userId,command,requestHash,result.run.id,now]);
  return result;
 });
}

