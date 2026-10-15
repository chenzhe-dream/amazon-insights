import {ProjectCatalogSchema,ProjectCatalogQuerySchema,ProjectHistoryQuerySchema,ProjectHistorySchema} from '../../shared/market-project-catalog-contracts';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {ProjectFavoriteExportSchema,ProjectFavoriteCreateSchema,ProjectFavoriteUpdateSchema,ProjectFavoriteQuerySchema,ProjectFavoriteListSchema,ProjectFavoriteResponseSchema,ProjectGroupCreateSchema} from '../../shared/market-project-favorites-contracts';
import {ProjectFavoriteError,type PostgresMarketProjectFavoritesStore} from '../db/postgres/market-project-favorites-store';
import type {MarketFavoriteActor} from '../db/market-favorites-repository';
import {ContractRouteError} from './analysis-runs';
export function registerMarketProjectFavoriteRoutes(app:FastifyInstance,store:PostgresMarketProjectFavoritesStore|undefined,authorized:(request:FastifyRequest)=>Promise<MarketFavoriteActor>){
 const path='/v1/market-research/project-favorites';
 const parse=<T>(schema:z.ZodType<T>,value:unknown)=>{const result=schema.safeParse(value);if(!result.success)throw new ContractRouteError(400,'VALIDATION_ERROR','调研收藏参数无效');return result.data};
 async function run<T>(request:FastifyRequest,fn:(actor:MarketFavoriteActor)=>Promise<T>){const actor=await authorized(request);if(!store)throw new ContractRouteError(503,'CONFIGURATION_ERROR','调研收藏暂不可用');try{return await fn(actor)}catch(e){if(e instanceof ProjectFavoriteError)throw new ContractRouteError(e.statusCode,e.statusCode===409?'CONFLICT':e.statusCode===403?'FORBIDDEN':e.statusCode===404?'NOT_FOUND':'VALIDATION_ERROR',e.message);throw e}}
 app.get(path+'/catalog',request=>run(request,async actor=>ProjectCatalogSchema.parse(await store!.catalog(actor,parse(ProjectCatalogQuerySchema,request.query)))));
 app.get(path+'/history',request=>run(request,async actor=>ProjectHistorySchema.parse(await store!.history(actor,parse(ProjectHistoryQuerySchema,request.query)))));
 app.get(path,request=>run(request,async actor=>ProjectFavoriteListSchema.parse(await store!.list(actor,parse(ProjectFavoriteQuerySchema,request.query)))));
 app.post(path,request=>run(request,async actor=>ProjectFavoriteResponseSchema.parse({project:await store!.create(actor,parse(ProjectFavoriteCreateSchema,request.body))})));
 app.patch(path+'/:id',request=>run(request,async actor=>ProjectFavoriteResponseSchema.parse({project:await store!.update(actor,parse(z.strictObject({id:z.string().uuid()}),request.params).id,parse(ProjectFavoriteUpdateSchema,request.body))})));
 app.post(path+'/groups',request=>run(request,async actor=>({group:await store!.createGroup(actor,parse(ProjectGroupCreateSchema,request.body))})));
 app.get(path+'/export',request=>run(request,async actor=>ProjectFavoriteExportSchema.parse({items:await store!.export(actor,parse(ProjectFavoriteQuerySchema,request.query))})));
 app.get(path+'/:id',request=>run(request,async actor=>ProjectFavoriteResponseSchema.parse({project:await store!.get(actor,parse(z.strictObject({id:z.string().uuid()}),request.params).id)})));
}
