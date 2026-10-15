import {MarketKeywordQueryRequestSchema,MarketThemeQueryRequestSchema} from '../../shared/market-standalone-query-contracts';
import {MarketModuleIdSchema} from '../../shared/market-module-contracts';
import {MarketExecutionConflictError,type MarketExecutionActor} from '../db/market-module-execution-repository';
import type {PostgresQueryContext} from '../db/postgres/query-context';
import {canonicalJsonSha256} from '../runtime/model-request-accounting';
import {findCompatibleModuleHistory,marketModuleQueryLock} from './market-linked-history';
import type {MarketModuleService} from './market-module-service';

export function queryStandaloneRun(service:MarketModuleService,context:PostgresQueryContext,actor:MarketExecutionActor,module:'keywords',body:unknown,key:unknown,now:string):Promise<Awaited<ReturnType<MarketModuleService['startKeywords']>>>;
export function queryStandaloneRun(service:MarketModuleService,context:PostgresQueryContext,actor:MarketExecutionActor,module:'themes',body:unknown,key:unknown,now:string):Promise<Awaited<ReturnType<MarketModuleService['startThemes']>>>;
export async function queryStandaloneRun(service:MarketModuleService,context:PostgresQueryContext,actor:MarketExecutionActor,module:'keywords'|'themes',body:unknown,key:unknown,now:string){
 const input=(module==='keywords'?MarketKeywordQueryRequestSchema:MarketThemeQueryRequestSchema).parse(body),command=MarketModuleIdSchema.parse(key);
 const requestHash=canonicalJsonSha256({module,...input});
 const lock=marketModuleQueryLock(actor.organizationId,module,input.scope,input.params);
 const read=(id:string)=>module==='keywords'?service.findKeywords(actor,id):service.findRun(actor,id);
 return context.transaction(async()=>{
  const authorized=await context.query("SELECT id FROM users WHERE id=$1 AND organization_id=$2 AND status='active' FOR SHARE",[actor.userId,actor.organizationId]);
  if(!authorized.rowCount)throw new MarketExecutionConflictError();
  await context.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`standalone-command:${actor.organizationId}:${actor.userId}:${command}`]);
  const receipt=await context.query<{request_hash:string;run_id:string}>('SELECT request_hash,run_id FROM market_standalone_query_receipts WHERE organization_id=$1 AND user_id=$2 AND command_id=$3',[actor.organizationId,actor.userId,command]);
  if(receipt.rows[0]){
   if(receipt.rows[0].request_hash!==requestHash)throw new MarketExecutionConflictError();
   return {created:false,...await read(receipt.rows[0].run_id)};
  }
  await context.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[lock]);
  const previous=input.forceRefresh?null:await findCompatibleModuleHistory(context,service,actor,input.scope,module,input.params);
  const result=previous?{created:false,...await read(previous.id)}:await (async()=>{
   const {study}=await service.createStudy(actor,input.scope,command);
   return module==='keywords'?service.startKeywords(actor,study.id,input.params,command):service.startThemes(actor,study.id,input.params,command);
  })();
  // Workers cannot see the new run before its refresh boundary is committed.
  if(input.forceRefresh&&result.created)await context.query('INSERT INTO sorftime_source_refresh_scopes(job_id,not_before) VALUES($1,$2) ON CONFLICT(job_id) DO NOTHING',[result.run.id,now]);
  await context.query('INSERT INTO market_standalone_query_receipts(organization_id,user_id,command_id,request_hash,run_id,created_at) VALUES($1,$2,$3,$4,$5,$6)',[actor.organizationId,actor.userId,command,requestHash,result.run.id,now]);
  return result;
 });
}
