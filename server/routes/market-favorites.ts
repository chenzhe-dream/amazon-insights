import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {MarketFavoriteCreateSchema,MarketFavoriteCreateResponseSchema,MarketFavoriteListQuerySchema,MarketFavoriteListResponseSchema} from '../../shared/market-favorites-contracts';
import {MarketFavoriteConflictError,MarketFavoriteForbiddenError,MarketFavoriteNotFoundError,type MarketFavoritesRepository} from '../db/market-favorites-repository';
import {VisibilityPersonNotFoundError,type ModuleVisibilityRepository} from '../db/module-visibility-repository';
import {ContractRouteError} from './analysis-runs';

export function registerMarketFavoritesRoutes(app:FastifyInstance,store:MarketFavoritesRepository|null,moduleVisibility:ModuleVisibilityRepository|null=null){
 async function authorized(request:FastifyRequest){
  const p=request.authPrincipal;
  if(p?.kind!=='user')throw new ContractRouteError(401,'AUTHENTICATION_REQUIRED','请先登录');
  if(!store)throw new ContractRouteError(503,'CONFIGURATION_ERROR','市场收藏暂不可用');
  if(moduleVisibility){
   let visible=false;
   try{visible=(await moduleVisibility.read(p.organizationId,p.userId)).includes('market');}
   catch(error){if(!(error instanceof VisibilityPersonNotFoundError))throw error;}
   if(!visible)throw new ContractRouteError(403,'FORBIDDEN','无权访问市场调研');
  }
  return p;
 }
 function rethrow(error:unknown):never{
  if(error instanceof MarketFavoriteConflictError)throw new ContractRouteError(409,'CONFLICT','收藏标识已被使用，请刷新后重试');
  if(error instanceof MarketFavoriteNotFoundError)throw new ContractRouteError(404,'NOT_FOUND','未找到该收藏');
  if(error instanceof MarketFavoriteForbiddenError)throw new ContractRouteError(403,'FORBIDDEN','仅作者或管理员可删除该收藏');
  throw error;
 }
 app.get('/v1/market-research/favorites',async request=>{
  const p=await authorized(request),query=MarketFavoriteListQuerySchema.safeParse(request.query);
  if(!query.success)throw new ContractRouteError(400,'VALIDATION_ERROR','收藏筛选参数无效');
  return MarketFavoriteListResponseSchema.parse(await store!.list(p,query.data));
 });
 app.post('/v1/market-research/favorites',async request=>{
  const p=await authorized(request),body=MarketFavoriteCreateSchema.safeParse(request.body);
  if(!body.success)throw new ContractRouteError(400,'VALIDATION_ERROR','收藏内容无效');
  try{return MarketFavoriteCreateResponseSchema.parse({favorite:await store!.create(p,body.data)});}catch(error){rethrow(error);}
 });
 app.delete('/v1/market-research/favorites/:favoriteId',async(request,reply)=>{
  const p=await authorized(request),params=z.strictObject({favoriteId:z.string().uuid()}).safeParse(request.params);
  if(!params.success||Object.keys(request.query as object).length||request.body!==undefined)throw new ContractRouteError(400,'VALIDATION_ERROR','收藏删除参数无效');
  try{await store!.delete(p,params.data.favoriteId);return reply.code(204).send();}catch(error){rethrow(error);}
 });
}
