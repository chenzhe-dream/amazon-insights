import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MarketModuleIdSchema, MarketModuleRetryResponseSchema, MarketModuleCancelResponseSchema } from '../../shared/market-module-contracts';
import { MarketModuleServiceError, type MarketModuleService } from '../services/market-module-service';
import { MarketExecutionConflictError, type MarketExecutionActor } from '../db/market-module-execution-repository';
import { MarketAnalysisStorageError } from '../db/postgres/market-analysis-snapshot-store';
import { ContractRouteError } from './analysis-runs';
import {MarketShapeRevisionIdSchema} from '../../shared/market-shape-public-contracts';
import {MarketKeywordRevisionIdSchema} from '../../shared/market-keyword-revision-contracts';

const id = (r: FastifyRequest) => z.object({ id: MarketModuleIdSchema }).strict().parse(r.params).id;
export function registerMarketModuleRoutes(app: FastifyInstance, service: MarketModuleService | null) {
  async function execute<T>(request: FastifyRequest, operation: (s: MarketModuleService, actor: MarketExecutionActor) => Promise<T>) {
    const principal = request.authPrincipal;
    if (principal?.kind !== 'user') throw new ContractRouteError(401, 'AUTHENTICATION_REQUIRED', '请先登录');
    if (!service) throw new ContractRouteError(503, 'CONFIGURATION_ERROR', '市场模块需要 PostgreSQL 持久化服务');
    try { return await operation(service, { organizationId: principal.organizationId, userId: principal.userId }); }
    catch (error) {
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
  app.post('/v1/market-analysis/shape-price/query',async(req,reply)=>execute(req,async(s,actor)=>{const {created,...result}=await s.queryShapes(actor,req.body,req.headers['idempotency-key']);reply.code(created?201:200);return result;}));
  app.get('/v1/market-analysis/overview/saved',async req=>execute(req,(s,actor)=>s.findSavedOverview(actor,req.query)));
  app.post('/v1/market-analysis/studies/:id/keywords',async(req,reply)=>execute(req,async(s,actor)=>{const {created,...result}=await s.startKeywords(actor,id(req),req.body,req.headers['idempotency-key']);reply.code(created?201:200);return result;}));
  app.get('/v1/market-analysis/runs/:id/keywords',async req=>execute(req,(s,actor)=>s.findKeywords(actor,id(req))));
  app.post('/v1/market-analysis/runs/:id/keywords/revisions',async(req,reply)=>execute(req,async(s,actor)=>{const {created,...result}=await s.saveKeywordRevision(actor,id(req),req.body,req.headers['idempotency-key']);reply.code(created?201:200);return result;}));
  app.get('/v1/market-analysis/runs/:id/keywords/revisions/:revisionId',async req=>execute(req,(s,actor)=>{const p=z.object({id:MarketModuleIdSchema,revisionId:MarketKeywordRevisionIdSchema}).strict().parse(req.params);return s.keywordRevision(actor,p.id,p.revisionId);}));
  app.post('/v1/market-analysis/studies/:id/shape-price',async(req,reply)=>execute(req,async(s,actor)=>{const {created,...result}=await s.startShapes(actor,id(req),req.body,req.headers['idempotency-key']);reply.code(created?201:200);return result;}));
  app.get('/v1/market-analysis/runs/:id/shape-explanation',async req=>execute(req,(s,actor)=>s.findShapeExplanation(actor,id(req))));
  app.get('/v1/market-analysis/runs/:id/shape-price',async req=>execute(req,(s,actor)=>s.findShapes(actor,id(req))));
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
  app.post('/v1/market-analysis/runs/:id/retry', async req => execute(req, async (s, actor) => MarketModuleRetryResponseSchema.parse(await s.retry(actor, id(req), req.body, req.headers['idempotency-key']))));
  app.post('/v1/market-analysis/runs/:id/cancel', async req => execute(req, async (s, actor) => MarketModuleCancelResponseSchema.parse(await s.cancel(actor, id(req), req.body, req.headers['idempotency-key']))));
}
