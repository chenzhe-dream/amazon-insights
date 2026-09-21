import {lockModuleVisibilityDefaults,readModuleVisibilityDefaults} from './new-user-module-visibility';
import {randomUUID} from 'node:crypto';
import {ALL_MODULES,VisibleModulesSchema,VisibilityPeopleResponseSchema,VisibilityPersonSchema,type ModuleKey} from '../../../shared/module-visibility-contracts';
import {type ModuleVisibilityRepository,VisibilityConflictError,VisibilityPersonNotFoundError,ProtectedSystemOwnerError} from '../module-visibility-repository';
import {PostgresQueryContext} from './query-context';

function person(row:Record<string,unknown>){
 return VisibilityPersonSchema.parse({userId:row.id,displayName:row.display_name,account:row.email,visibleModules:row.is_owner?ALL_MODULES:row.modules_json??ALL_MODULES,version:Number(row.version??0),configured:row.version!=null,isSystemOwner:Boolean(row.is_owner),configurationSource:row.configuration_source??(row.version!=null?'personal':'legacy')});
}
export class PostgresModuleVisibilityStore implements ModuleVisibilityRepository {
 constructor(private readonly queries:PostgresQueryContext){}
 async readDefaults(organizationId:string){return readModuleVisibilityDefaults(this.queries,organizationId);}
 async saveDefaults(input:Parameters<ModuleVisibilityRepository['saveDefaults']>[0]){
  const modules=VisibleModulesSchema.parse(input.visibleModules);
  return this.queries.transaction(async client=>{
   await lockModuleVisibilityDefaults(this.queries,input.organizationId);
   const actor=await client.query("SELECT id FROM users WHERE id=$1 AND organization_id=$2 AND status='active' AND archived_at IS NULL",[input.actorId,input.organizationId]);
   if(!actor.rows.length)throw new VisibilityPersonNotFoundError();
   const before=await this.readDefaults(input.organizationId);
   if(before.version!==input.version)throw new VisibilityConflictError();
   const version=before.version+1;
   await client.query(`INSERT INTO module_visibility_defaults(organization_id,modules_json,version,updated_by)
    VALUES($1,$2::jsonb,$3,$4) ON CONFLICT(organization_id) DO UPDATE SET modules_json=EXCLUDED.modules_json,version=EXCLUDED.version,updated_by=EXCLUDED.updated_by,updated_at=now()`,[input.organizationId,JSON.stringify(modules),version,input.actorId]);
   await client.query(`INSERT INTO audit_events(id,organization_id,actor_user_id,action,target_type,target_id,metadata_json,created_at)
    VALUES($1,$2,$3,'module-visibility.defaults-updated','organization',$2,$4::jsonb,now())`,[randomUUID(),input.organizationId,input.actorId,JSON.stringify({before,after:{visibleModules:modules,version}})]);
   return {visibleModules:modules,version};
  });
 }
 async isOwner(organizationId:string,userId:string):Promise<boolean>{
  const result=await this.queries.query('SELECT 1 FROM system_owners WHERE organization_id=$1 AND user_id=$2',[organizationId,userId]);
  return result.rows.length>0;
 }
 async read(organizationId:string,userId:string):Promise<ModuleKey[]>{
  const result=await this.queries.query('SELECT v.modules_json FROM users u LEFT JOIN user_module_visibility v ON v.user_id=u.id AND v.organization_id=u.organization_id WHERE u.id=$1 AND u.organization_id=$2 AND u.status=\'active\' AND u.archived_at IS NULL',[userId,organizationId]);
  if(!result.rows.length)throw new VisibilityPersonNotFoundError();
  return await this.isOwner(organizationId,userId)?[...ALL_MODULES]:VisibleModulesSchema.parse(result.rows[0].modules_json??ALL_MODULES);
 }
 async list(organizationId:string,q:string,page:number){
  const result=await this.queries.query(`WITH people AS MATERIALIZED (
   SELECT u.id,u.display_name,u.email,v.modules_json,v.version,v.configuration_source,EXISTS(SELECT 1 FROM system_owners o WHERE o.user_id=u.id AND o.organization_id=u.organization_id) is_owner FROM users u
   JOIN auth_identities i ON i.user_id=u.id AND i.provider='dingtalk'
   LEFT JOIN user_module_visibility v ON v.user_id=u.id AND v.organization_id=u.organization_id
   WHERE u.organization_id=$1 AND u.archived_at IS NULL AND u.status='active'
   AND ($2='' OR strpos(lower(u.display_name),lower($2))>0 OR strpos(lower(u.email),lower($2))>0)
  ), meta AS(SELECT COUNT(*)::int total,LEAST($3::int,GREATEST(1,CEIL(COUNT(*)::numeric/10)::int)) page FROM people),
  selected AS(SELECT * FROM people ORDER BY display_name,id LIMIT 10 OFFSET (SELECT (page-1)*10 FROM meta))
  SELECT meta.*,selected.* FROM meta LEFT JOIN selected ON true ORDER BY selected.display_name,selected.id`,[organizationId,q,page]);
  return VisibilityPeopleResponseSchema.parse({people:result.rows.filter(row=>row.id!=null).map(person),page:result.rows[0].page,pageSize:10,total:result.rows[0].total});
 }
 async save(input:Parameters<ModuleVisibilityRepository['save']>[0]){
  const modules=VisibleModulesSchema.parse(input.visibleModules);
  return this.queries.transaction(async client=>{
   // Locking the target also serializes the first insert, where no config row exists yet.
   const selected=await client.query(`SELECT u.* FROM users u JOIN auth_identities i ON i.user_id=u.id AND i.provider='dingtalk'
    WHERE u.id=$1 AND u.organization_id=$2 AND u.status='active' AND u.archived_at IS NULL FOR UPDATE OF u`,[input.userId,input.organizationId]);
   const actor=await client.query("SELECT id FROM users WHERE id=$1 AND organization_id=$2 AND status='active' AND archived_at IS NULL",[input.actorId,input.organizationId]);
   if(!selected.rows.length||!actor.rows.length)throw new VisibilityPersonNotFoundError();
   const owner=await client.query('SELECT 1 FROM system_owners WHERE user_id=$1 AND organization_id=$2',[input.userId,input.organizationId]);
   if(owner.rows.length)throw new ProtectedSystemOwnerError();
   const old=await client.query('SELECT modules_json,version FROM user_module_visibility WHERE user_id=$1 AND organization_id=$2',[input.userId,input.organizationId]);
   if(Number(old.rows[0]?.version??0)!==input.version)throw new VisibilityConflictError();
   const version=input.version+1;
   await client.query(`INSERT INTO user_module_visibility(user_id,organization_id,modules_json,version,updated_by)
    VALUES($1,$2,$3::jsonb,$4,$5) ON CONFLICT(user_id) DO UPDATE SET modules_json=EXCLUDED.modules_json,version=EXCLUDED.version,updated_by=EXCLUDED.updated_by,updated_at=now(),configuration_source='personal',default_version=NULL`,[input.userId,input.organizationId,JSON.stringify(modules),version,input.actorId]);
   await client.query(`INSERT INTO audit_events(id,organization_id,actor_user_id,action,target_type,target_id,metadata_json,created_at)
    VALUES($1,$2,$3,'module-visibility.updated','user',$4,$5::jsonb,now())`,[randomUUID(),input.organizationId,input.actorId,input.userId,JSON.stringify({before:old.rows[0]?.modules_json??null,after:modules,version})]);
   return person({...selected.rows[0],modules_json:modules,version});
  });
 }
}
