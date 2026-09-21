import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {ModuleVisibilityDefaultsSchema,VisibilityPeopleQuerySchema,VisibilitySaveSchema,VisibilitySaveResponseSchema} from '../../shared/module-visibility-contracts';
import type {UserPresenceAccess} from '../auth/user-presence-access';
import {type ModuleVisibilityRepository,VisibilityConflictError,VisibilityPersonNotFoundError,ProtectedSystemOwnerError} from '../db/module-visibility-repository';
import {ContractRouteError} from './analysis-runs';

export function registerModuleVisibilityRoutes(app:FastifyInstance,store:ModuleVisibilityRepository|null,access:UserPresenceAccess|null){
 async function authorized(request:FastifyRequest){
  const p=request.authPrincipal;
  if(p?.kind!=='user')throw new ContractRouteError(401,'AUTHENTICATION_REQUIRED','请先登录');
  let allowed=false;try{allowed=Boolean(access&&await access.canView(p))}catch{}
  if(!allowed)throw new ContractRouteError(403,'FORBIDDEN','无权配置模块可见性');
  if(!store)throw new ContractRouteError(503,'CONFIGURATION_ERROR','模块可见性配置暂不可用');
  return p;
 }
 app.get('/v1/admin/module-visibility',async request=>{
  const p=await authorized(request),query=VisibilityPeopleQuerySchema.safeParse(request.query);
  if(!query.success)throw new ContractRouteError(400,'VALIDATION_ERROR','人员筛选参数无效');
  return store!.list(p.organizationId,query.data.q,query.data.page);
 });
 app.get('/v1/admin/module-visibility/defaults',async request=>{
  const p=await authorized(request);
  return ModuleVisibilityDefaultsSchema.parse(await store!.readDefaults(p.organizationId));
 });
 app.put('/v1/admin/module-visibility/defaults',async request=>{
  const p=await authorized(request),body=VisibilitySaveSchema.safeParse(request.body);
  if(!body.success)throw new ContractRouteError(400,'VALIDATION_ERROR','默认模块配置无效');
  try{return ModuleVisibilityDefaultsSchema.parse(await store!.saveDefaults({organizationId:p.organizationId,actorId:p.userId,...body.data}))}
  catch(error){
   if(error instanceof VisibilityConflictError)throw new ContractRouteError(409,'CONFLICT','默认配置已被更新，请重新打开后修改');
   if(error instanceof VisibilityPersonNotFoundError)throw new ContractRouteError(403,'FORBIDDEN','无权修改默认模块配置');
   throw error;
  }
 });
 app.put('/v1/admin/module-visibility/:userId' ,async request=>{
  const p=await authorized(request),params=z.strictObject({userId:z.string().uuid()}).safeParse(request.params),body=VisibilitySaveSchema.safeParse(request.body);
  if(!params.success||!body.success)throw new ContractRouteError(400,'VALIDATION_ERROR','模块配置无效');
  try{return VisibilitySaveResponseSchema.parse({person:await store!.save({organizationId:p.organizationId,actorId:p.userId,userId:params.data.userId,...body.data})})}
  catch(error){
   if(error instanceof ProtectedSystemOwnerError)throw new ContractRouteError(403,'FORBIDDEN','系统所有者拥有全部权限，不可修改');
   if(error instanceof VisibilityConflictError)throw new ContractRouteError(409,'CONFLICT','配置已被更新，请重新打开后修改');
   if(error instanceof VisibilityPersonNotFoundError)throw new ContractRouteError(404,'NOT_FOUND','未找到可配置的人员');
   throw error;
  }
 });
}
