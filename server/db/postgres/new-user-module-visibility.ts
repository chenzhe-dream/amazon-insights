import {INITIAL_NEW_USER_MODULES, ModuleVisibilityDefaultsSchema} from '../../../shared/module-visibility-contracts';
import type {PostgresQueryContext} from './query-context';

// Both callers must hold a transaction. Serialize policy updates with account snapshots.
export async function lockModuleVisibilityDefaults(queries:PostgresQueryContext, organizationId:string){
 await queries.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',['module-visibility-defaults:'+organizationId]);
}
export async function readModuleVisibilityDefaults(queries:PostgresQueryContext,organizationId:string){
 const result=await queries.query('SELECT modules_json,version FROM module_visibility_defaults WHERE organization_id=$1',[organizationId]);
 return ModuleVisibilityDefaultsSchema.parse({visibleModules:result.rows[0]?.modules_json??INITIAL_NEW_USER_MODULES,version:result.rows[0]?.version??0});
}
export async function initializeNewUserModuleVisibility(queries:PostgresQueryContext,userId:string,organizationId:string){
 await lockModuleVisibilityDefaults(queries,organizationId);
 const defaults=await readModuleVisibilityDefaults(queries,organizationId);
 await queries.query(`INSERT INTO user_module_visibility(user_id,organization_id,modules_json,version,updated_by,configuration_source,default_version)
 VALUES($1,$2,$3::jsonb,1,$1,'new-user-default',$4)`,[userId,organizationId,JSON.stringify(defaults.visibleModules),defaults.version]);
}
