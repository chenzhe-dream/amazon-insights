import {ProjectFavoriteError} from '../db/postgres/market-project-favorites-store';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MarketModuleIdSchema, MarketModuleRetryResponseSchema, MarketModuleCancelResponseSchema } from '../../shared/market-module-contracts';
import { MarketModuleServiceError, type MarketModuleService } from '../services/market-module-service';
import { MarketExecutionConflictError, type MarketExecutionActor } from '../db/market-module-execution-repository';
import { MarketAnalysisStorageError } from '../db/postgres/market-analysis-snapshot-store';
import { ContractRouteError } from './analysis-runs';
import {MarketShapeRevisionIdSchema} from '../../shared/market-shape-public-contracts';
import {MarketKeywordRevisionIdSchema} from '../../shared/market-keyword-revision-contracts';
import {MarketThemeTranslationQuerySchema,MarketThemeTranslationStartSchema} from '../../shared/market-theme-translation-contracts';
import {MarketOverviewEvidenceError} from '../domain/market-research/overview-catalog-compatibility';

const id = (r: FastifyRequest) => z.object({ id: MarketModuleIdSchema }).strict().parse(r.params).id;
export function registerMarketModuleRoutes(app: FastifyInstance, service: MarketModuleService | null, resolveSharedRead?: (actor:MarketExecutionActor,kind:'run'|'study',id:string)=>Promise<MarketExecutionActor>) {
  async function execute<T>(request: FastifyRequest, operation: (s: MarketModuleService, actor: MarketExecutionActor) => Promise<T>) {
    const principal = request.authPrincipal;
    if (principal?.kind !== 'user') throw new ContractRouteError(401, 'AUTHENTICATION_REQUIRED', '请先登录');
    if (!service) throw new ContractRouteError(503, 'CONFIGURATION_ERROR', '市场模块需要 PostgreSQL 持久化服务');
    try { let actor:MarketExecutionActor={organizationId:principal.organizationId,userId:principal.userId};
      const match=request.method==='GET'?request.routeOptions.url?.match(/^\/v1\/market-analysis\/(runs|studies)\/:id(?:\/|$)/):null;
      if(match&&resolveSharedRead){const value=(request.params as {id?:string}).id;if(value&&MarketModuleIdSchema.safeParse(value).success)actor=await resolveSharedRead(actor,match[1]==='runs'?'run':'study',value)}
      return await operation(service, actor); }
    catch (error) {
      if(error instanceof ProjectFavoriteError)throw new ContractRouteError(error.statusCode,error.statusCode===403?'FORBIDDEN':'VALIDATION_ERROR',error.message);
      if (error instanceof MarketOverviewEvidenceError) throw new ContractRouteError(409, 'CONFLICT', '已保存报告的数据版本校验未通过，请联系管理员检查历史报告兼容性；无需修改类目编号');
      if (error instanceof z.ZodError) throw new ContractRouteError(400, 'VALIDATION_ERROR', '市场研究参数或任务编号无效');
      if (error instanceof MarketExecutionConflictError || error instanceof MarketAnalysisStorageError) throw new ContractRouteError(409, 'CONFLICT', '研究范围或任务状态已变化，请刷新后重试');
      if (error instanceof MarketModuleServiceError) throw new ContractRouteError(error.statusCode, error.statusCode === 404 ? 'NOT_FOUND' : error.statusCode === 403 ? 'FORBIDDEN' : error.statusCode === 503 ? 'CONFIGURATION_ERROR' : 'VALIDATION_ERROR', error.message);
      throw error;
    }
  }
  app.post('/v1/market-analysis/studies', async (req, reply) => execute(req, async (s, actor) => {
    const { created, ...result } = await s.createStudy(actor, req.body, req.headers['idempotency-key']); reply.code(created ? 201 : 200); return result;
  }));
  app.get('/v1/market-analysis/studies/:id', async req => execute(req, (s, actor) => s.findStudy(actor, id(req))));
  app.post('/v1/market-analysis/keywords/query',async(req,reply)=>execute(req,async(s,actor)=>{const {created,...result}=await s.queryKeywords(actor,req.body,req.headers['idempotency-key']);reply.code(created?201:200);return result;}));
  app.post('/v1/market-analysis/customer-themes/query',async(req,reply)=>execute(req,async(s,actor)=>{const {created,...result}=await s.queryThemes(actor,req.body,req.headers['idempotency-key']);reply.code(created?201:200);return result;}));
  app.post('/v1/market-analysis/shape-price/query',async(req,reply)=>execute(req,async(s,actor)=>{const {created,...result}=await s.queryShapes(actor,req.body,req.headers['idempotency-key']);reply.code(created?201:200);return result;}));
  app.post('/v1/market-analysis/shape-price/resolve-category',async req=>execute(req,(s,actor)=>s.resolveShapeCategory(actor,req.body)));
  app.get('/v1/market-analysis/overview/saved',async req=>execute(req,(s,actor)=>s.findSavedOverview(actor,req.query)));
  app.post('/v1/market-analysis/studies/:id/keywords',async(req,reply)=>execute(req,async(s,actor)=>{const {created,...result}=await s.startKeywords(actor,id(req),req.body,req.headers['idempotency-key']);reply.code(created?201:200);return result;}));
  app.get('/v1/market-analysis/runs/:id/keywords',async req=>execute(req,(s,actor)=>s.findKeywords(actor,id(req))));
  app.post('/v1/market-analysis/runs/:id/keywords/revisions',async(req,reply)=>execute(req,async(s,actor)=>{const {created,...result}=await s.saveKeywordRevision(actor,id(req),req.body,req.headers['idempotency-key']);reply.code(created?201:200);return result;}));
  app.get('/v1/market-analysis/runs/:id/keywords/revisions/:revisionId',async req=>execute(req,(s,actor)=>{const p=z.object({id:MarketModuleIdSchema,revisionId:MarketKeywordRevisionIdSchema}).strict().parse(req.params);return s.keywordRevision(actor,p.id,p.revisionId);}));
  app.post('/v1/market-analysis/studies/:id/shape-price',async(req,reply)=>execute(req,async(s,actor)=>{const {created,...result}=await s.startShapes(actor,id(req),req.body,req.headers['idempotency-key']);reply.code(created?201:200);return result;}));
  app.get('/v1/market-analysis/runs/:id/shape-explanation',async req=>execute(req,(s,actor)=>s.findShapeExplanation(actor,id(req))));
  app.get('/v1/market-analysis/runs/:id/shape-price',async req=>execute(req,(s,actor)=>s.findShapes(actor,id(req))));
  app.get('/v1/market-analysis/runs/:id/shape-price/draft',async req=>execute(req,(s,actor)=>s.findShapeDraft(actor,id(req))));
  app.put('/v1/market-analysis/runs/:id/shape-price/draft',async req=>execute(req,(s,actor)=>s.saveShapeDraft(actor,id(req),req.body,req.headers['idempotency-key'])));
  app.post('/v1/market-analysis/runs/:id/shape-price/revisions',async(req,reply)=>execute(req,async(s,actor)=>{const {created,...result}=await s.saveShapeRevision(actor,id(req),req.body,req.headers['idempotency-key']);reply.code(created?201:200);return result;}));
  app.get('/v1/market-analysis/runs/:id/shape-price/revisions/:revisionId',async req=>execute(req,(s,actor)=>{const p=z.object({id:MarketModuleIdSchema,revisionId:MarketShapeRevisionIdSchema}).strict().parse(req.params);return s.shapeRevision(actor,p.id,p.revisionId);}));
  app.post('/v1/market-analysis/studies/:id/overview',async(req,reply)=>execute(req,async(s,actor)=>{const {created,...result}=await s.startOverview(actor,id(req),req.body,req.headers['idempotency-key']);reply.code(created?201:200);return result;}));
  app.get('/v1/market-analysis/runs/:id/overview',async req=>execute(req,(s,actor)=>s.findOverview(actor,id(req))));
  app.get('/v1/market-analysis/runs/:id/reports/:attemptId/overview',async req=>execute(req,(s,actor)=>{
    const params=z.object({id:MarketModuleIdSchema,attemptId:MarketModuleIdSchema}).strict().parse(req.params);return s.overviewDetails(actor,params.id,params.attemptId);
  }));
  app.post('/v1/market-analysis/studies/:id/customer-themes', async (req, reply) => execute(req, async (s, actor) => {
    const { created, ...result } = await s.startThemes(actor, id(req), req.body, req.headers['idempotency-key']); reply.code(created ? 201 : 200); return result;
  }));
  app.get('/v1/market-analysis/runs/:id', async req => execute(req, (s, actor) => s.findRun(actor, id(req))));
  app.get('/v1/market-analysis/runs/:id/reports/:attemptId/details', async req => execute(req, (s, actor) => {
    const params = z.object({ id: MarketModuleIdSchema, attemptId: MarketModuleIdSchema }).strict().parse(req.params);
    return s.details(actor, params.id, params.attemptId, req.query);
  }));
  app.get('/v1/market-analysis/runs/:id/reports/:attemptId/evidence', async req => execute(req,(s,actor)=>{
    const params=z.object({id:MarketModuleIdSchema,attemptId:MarketModuleIdSchema}).strict().parse(req.params);return s.evidence(actor,params.id,params.attemptId,req.query);
  }));
  app.get('/v1/market-analysis/runs/:id/reports/:attemptId/translations', async req => execute(req,(s,actor)=>{
    const params=z.object({id:MarketModuleIdSchema,attemptId:MarketModuleIdSchema}).strict().parse(req.params);
    return s.themeTranslations(actor,params.id,params.attemptId,MarketThemeTranslationQuerySchema.parse(req.query));
  }));
  app.post('/v1/market-analysis/runs/:id/reports/:attemptId/translations', async req => execute(req,(s,actor)=>{
    const params=z.object({id:MarketModuleIdSchema,attemptId:MarketModuleIdSchema}).strict().parse(req.params);
    return s.startThemeTranslations(actor,params.id,params.attemptId,MarketThemeTranslationStartSchema.parse(req.body));
  }));
  app.post('/v1/market-analysis/runs/:id/retry', async req => execute(req, async (s, actor) => MarketModuleRetryResponseSchema.parse(await s.retry(actor, id(req), req.body, req.headers['idempotency-key']))));
  app.post('/v1/market-analysis/runs/:id/cancel', async req => execute(req, async (s, actor) => MarketModuleCancelResponseSchema.parse(await s.cancel(actor, id(req), req.body, req.headers['idempotency-key']))));
}
