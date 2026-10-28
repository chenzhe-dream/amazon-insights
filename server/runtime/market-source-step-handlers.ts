import {createOverviewExternalStep} from './market-overview-external-step';
import {createOverviewIndustryDemandStep} from './market-overview-industry-demand-step';
import {inspectMarketThemeContinuation,MARKET_THEME_RULES_FLOW_V3} from '../domain/market-research/customer-theme-flow';
import {collectMarketShapeProductImage} from '../services/market-shape-product-image';
import {collectSorftimeShapePoolPage} from '../services/market-shape-sorftime-pool';
import {collectShapeCategory} from '../services/market-shape-category-collector';
import {ShapeCategoryMetricSchema} from '../../shared/market-shape-category-contracts';
import {collectMarketProductHistory} from '../services/market-product-history-collector';
import {inspectMarketShapeContinuation} from '../domain/market-research/shape-price-flow';
import { z } from 'zod';
import { MarketInputRecordSchema, type MarketAnalysisScope, type MarketJsonValue } from '../../shared/market-analysis-contracts';
import { MARKET_SOURCE_HANDLER_VERSION, MarketSourceIdentityValueSchemas, type MarketSourceEvidence } from '../../shared/market-source-contracts';
import { ConnectorError, type ConnectorMap } from '../connectors/connector-contract';
import { PostgresQueryContext } from '../db/postgres/query-context';
import { PostgresMarketModuleExecutionStore } from '../db/postgres/market-module-execution-store';
import { PostgresMarketAnalysisSnapshotStore } from '../db/postgres/market-analysis-snapshot-store';
import type { MarketStepClaim, MarketStepError } from '../db/market-module-execution-repository';
import { collectMarketProductPool } from '../services/market-product-pool-collector';
import { collectMarketKeywordPage, collectMarketKeywordTrend } from '../services/market-keyword-collector';
import {collectMarketKeywordAba} from '../services/market-keyword-aba-collector';
import {inspectMarketKeywordContinuation} from '../domain/market-research/keyword-flow';
import { collectMarketCustomerThemes } from '../services/market-customer-themes-collector';
import {MarketThemeSourceIssueSchema,type MarketThemeSourceIssue} from '../../shared/market-theme-source-issue';
import { collectMarketOverviewSource, MarketOverviewSourceStepInputSchema } from '../services/market-overview-source-collector';
import {collectMarketOverviewDistribution,MarketOverviewDistributionStepInputSchema} from '../services/market-overview-distribution-collector';
import { createMarketInputSnapshot } from '../domain/market-research/snapshot';
import { createMarketSourceEvidence } from '../domain/market-research/source-evidence';
import { canonicalJsonSha256 as digest } from './model-request-accounting';
import type { MarketStepHandler, MarketStepWork } from './market-module-step-worker';

export { MARKET_SOURCE_HANDLER_VERSION } from '../../shared/market-source-contracts';
const snapshotId = z.string().regex(/^market-input:[a-f0-9]{64}$/), asin = MarketSourceIdentityValueSchemas.asin;
const productInput = z.object({ month: z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/), poolSize: z.number().int().min(1).max(100),
  newProductMonths: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12)]),
  selectedAsins: z.array(asin).min(1).max(100).optional(), selectionInputSnapshotId: snapshotId.optional() }).strict();
const pageInput = z.object({ seed: MarketSourceIdentityValueSchemas.keyword, page: MarketSourceIdentityValueSchemas.page,sourceMode:z.literal('category-keywords').optional() }).strict();
const trendInput = z.object({ keyword: MarketSourceIdentityValueSchemas.keyword, keywordId: z.string().min(1).max(160), poolInputSnapshotId: snapshotId }).strict();
const themesInput = z.object({ asin, selectionInputSnapshotId: snapshotId }).strict();
const abaInput=z.object({poolInputSnapshotId:snapshotId,referenceMonth:z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/),
  members:z.array(z.object({keywordId:z.string().min(1).max(160),keyword:MarketSourceIdentityValueSchemas.keyword}).strict()).min(1).max(10)}).strict();
const json = (value: unknown): MarketJsonValue => JSON.parse(JSON.stringify(MarketInputRecordSchema.shape.data.parse(value))) as MarketJsonValue;
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function invalid(message: string): never { throw new z.ZodError([{ code: 'custom', path: [], message }]); }

/** Recreate the original T4 factory input; its hash must remain unchanged when
 * settleAndEnqueue validates and stores it in the transaction. */
function evidenceProposal(evidence: MarketSourceEvidence) {
  const responseIdentityPaths = Object.fromEntries(Object.entries(evidence.responseIdentity)
    .filter(([, check]) => check.echoes.length + check.missingPaths.length > 0)
    .map(([field, check]) => [field, [...check.echoes.map(echo => echo.path), ...check.missingPaths]]));
  const proposal = { scope: evidence.scope, provider: evidence.provider, operation: evidence.operation,
    requestIdentity: evidence.requestIdentity, responseIdentityPaths, payload: evidence.payload, fetchedAt: evidence.fetchedAt,
    observationPeriod: evidence.observationPeriod, units: evidence.units, coverage: evidence.coverage };
  if (digest(createMarketSourceEvidence(proposal)) !== digest(evidence)) invalid('Source evidence could not be preserved');
  return proposal;
}
function failure(sourceCode: string, retryable: boolean, themeIssue?:MarketThemeSourceIssue): MarketStepWork {
  const code: MarketStepError['code'] = ['scope-mismatch', 'identity-conflict', 'identity-mismatch', 'source-mismatch'].includes(sourceCode) ? 'scope-mismatch'
    : ['quota-exhausted','rate-limit'].includes(sourceCode) ? sourceCode as MarketStepError['code']
    : sourceCode === 'keyword-not-trending' ? 'keyword-not-trending' : sourceCode === 'authentication' ? 'authentication'
    : ['configuration', 'local-admission', 'governor-rejected'].includes(sourceCode) ? 'governance'
    : sourceCode === 'timeout' ? 'timeout' : ['interrupted', 'cancelled'].includes(sourceCode) ? 'interrupted'
    : ['rate-limit', 'upstream-temporary'].includes(sourceCode) ? 'upstream-temporary' : 'invalid-data';
  return { kind: 'settlement', value: { outcome: { status: 'failed', error: { code, retryable },
    diagnostic: { handlerVersion: MARKET_SOURCE_HANDLER_VERSION, sourceCode, ...(themeIssue?{themeIssue}:{}) } } } };
}
function collected(scope: MarketAnalysisScope, kind: 'products' | 'keywords' | 'customer-themes' | 'overview', expectedRecordIds: string[],
  records: { id: string; data: unknown }[], status: string, evidence: MarketSourceEvidence, metadata: Record<string, unknown>): MarketStepWork {
  const sourceRef = `market-source:${digest(evidence)}`;
  const input = { scope, kind, sourceVersion: MARKET_SOURCE_HANDLER_VERSION, ruleVersion: 'source-normalization/v1', collectedAt: evidence.fetchedAt,
    expectedRecordIds, records: records.map(r => ({ id: r.id, scope, data: json({ ...object(r.data), sourceRef }) })) };
  const snapshot = createMarketInputSnapshot(input);
  return { kind: 'settlement', value: { outcome: { status: status === 'empty' ? 'empty' : 'succeeded',
    output: json({ handlerVersion: MARKET_SOURCE_HANDLER_VERSION, collectionStatus: status, sourceRef, inputSnapshotId: snapshot.snapshotId, ...metadata }) },
    sources: [json(evidenceProposal(evidence))], inputs: [json(input)] } };
}

function buildMarketSourceStepHandlers(deps: { context: PostgresQueryContext; connectors: Pick<ConnectorMap, 'sellerSprite' | 'sorftime'> & Partial<Pick<ConnectorMap,'sif'>> }) {
  const steps = new PostgresMarketModuleExecutionStore(deps.context), snapshots = new PostgresMarketAnalysisSnapshotStore(deps.context);
  async function scopeFor(claim: MarketStepClaim, signal: AbortSignal, moduleKind?:'overview') {
    signal.throwIfAborted();
    const actor = { organizationId: claim.organizationId, userId: claim.createdBy };
    const view = await steps.findModuleRun({ actor, moduleRunId: claim.moduleRunId }); const step = view?.steps.find(s => s.id === claim.stepId);
    if (!view || !step || step.status !== 'running' || view.run.status === 'cancelled' || view.run.createdBy !== claim.createdBy ||
      view.run.scope.researchId !== claim.studyId || view.run.versions.source !== MARKET_SOURCE_HANDLER_VERSION ||
      step.latestAttemptId !== claim.attemptId || step.inputHash !== claim.inputHash || digest(claim.step) !== claim.inputHash || (moduleKind!==undefined&&view.run.moduleKind!==moduleKind)) invalid('Collection execution scope or source version is unavailable');
    return view.run.scope;
  }
  async function selected(claim: MarketStepClaim, id: string, scope: MarketAnalysisScope) {
    if (!claim.step.inputRefs.some(ref => ref.kind === 'input' && ref.id === id)) invalid('Collection selection is not bound to this step');
    const saved = await snapshots.findInput({ actor: { organizationId: claim.organizationId, userId: claim.createdBy }, studyId: claim.studyId, id });
    if (!saved || digest(saved.snapshot.scope) !== digest(scope)) invalid('Collection selection scope is unavailable');
    return saved.snapshot;
  }
  const products: MarketStepHandler = async ({ claim, signal }) => {
    const input = productInput.parse(claim.step.input), scope = await scopeFor(claim, signal);
    if (input.selectedAsins) {
      if (!input.selectionInputSnapshotId) invalid('Fixed products require a saved selection');
      const selection = await selected(claim, input.selectionInputSnapshotId, scope);
      if (selection.kind !== 'products' || input.selectedAsins.some(id => !selection.records.some(r => r.id === id && object(r.data).collection === 'product-month' && object(object(r.data).product).asin === id))) invalid('Fixed product is outside its saved source pool');
    } else if (input.selectionInputSnapshotId) invalid('A product selection requires explicit fixed members');
    signal.throwIfAborted();
    const result = await collectMarketProductPool({ scope, month: input.month, poolSize: input.poolSize, newProductMonths: input.newProductMonths,
      ...(input.selectedAsins ? { selectedAsins: input.selectedAsins } : {}), jobId: claim.moduleRunId, connector: deps.connectors.sellerSprite, signal });
    if (result.status === 'failed' || !result.evidence) return failure(result.issues[0]?.code ?? 'invalid-source', result.issues[0]?.retryable ?? false);
    return collected(scope, 'products', result.sampling.selectedAsins ?? result.products.map(p => p.asin),
      result.products.map(product => ({ id: product.asin, data: { collection: 'product-month', month: result.month, product } })), result.status, result.evidence,
      { month: result.month, sampling: result.sampling, boundaries: result.boundaries, issues: result.issues });
  };
  const sorftimePool:MarketStepHandler=async({claim,signal})=>{
    const input=z.object({poolSize:z.number().int().min(1).max(300),page:z.number().int().min(1).max(20).optional(),categoryName:z.string().max(500).optional(),referenceAttemptId:z.string().uuid().optional()}).strict().parse(claim.step.input),scope=await scopeFor(claim,signal);
    const view=await steps.findModuleRun({actor:{organizationId:claim.organizationId,userId:claim.createdBy},moduleRunId:claim.moduleRunId});
    if(!view)invalid('Pool run unavailable');
    const theme=view.run.moduleKind==='customer-themes'&&object(view.run.params).flow===MARKET_THEME_RULES_FLOW_V3;
    if(!(theme ? input.page===undefined && inspectMarketThemeContinuation(view,new Date().toISOString()).currentStepKeys.includes(claim.step.stepKey) : view.run.moduleKind==='shape-price'&&object(view.run.params).flow==='market-shape-price-flow/rules-v4'&&inspectMarketShapeContinuation(view,new Date().toISOString()).currentStepKeys.includes(claim.step.stepKey)))invalid('Pool outside Sorftime frontier');
    const result=await collectSorftimeShapePoolPage({...input,scope,jobId:claim.moduleRunId,connector:deps.connectors.sorftime,signal});
    if(result.status==='failed')return failure(result.failure.code,result.failure.retryable);
    return collected(scope,'products',result.products.map(p=>p.asin),result.products.map(product=>({id:product.asin,data:{collection:'sorftime-shape-pool',product}})),result.status,result.evidence,{productCount:result.products.length,productAsins:result.products.map(p=>p.asin),receivedCount:result.receivedCount,categoryName:result.categoryName});
  };
  const productHistory: MarketStepHandler = async ({claim,signal}) => {
    const input=themesInput.parse(claim.step.input),scope=await scopeFor(claim,signal);
    const view=await steps.findModuleRun({actor:{organizationId:claim.organizationId,userId:claim.createdBy},moduleRunId:claim.moduleRunId});
    if(!view)invalid('Image/history run unavailable');
    const themeImage=view.run.moduleKind==='customer-themes'&&object(view.run.params).flow===MARKET_THEME_RULES_FLOW_V3&&claim.step.kind==='collect-product-image';
    if(!(themeImage ? inspectMarketThemeContinuation(view,new Date().toISOString()).currentStepKeys.includes(claim.step.stepKey) : view.run.moduleKind==='shape-price'&&inspectMarketShapeContinuation(view,new Date().toISOString()).currentStepKeys.includes(claim.step.stepKey)))invalid('History is outside the current frontier');
    const pool=await selected(claim,input.selectionInputSnapshotId,scope);
    if(pool.kind!=='products'||!pool.records.some(r=>r.id===input.asin&&['product-month','sorftime-shape-pool'].includes(String(object(r.data).collection))&&object(object(r.data).product).asin===input.asin))invalid('History ASIN is outside frozen pool');
    if(claim.step.kind==='collect-product-image'){
      const result=await collectMarketShapeProductImage({...input,scope,jobId:claim.moduleRunId,connector:deps.connectors.sorftime,signal});
      if(result.status==='failed')return failure(result.failure.code,result.failure.retryable);
      return collected(scope,'products',[input.asin],[{id:input.asin,data:{collection:'product-image',asin:input.asin,imageUrl:result.imageUrl}}],result.status,result.evidence,{asin:input.asin,selectionInputSnapshotId:input.selectionInputSnapshotId});
    }
    const metric=claim.step.kind==='collect-product-amount-history'?'SalesAmount':'SalesVolume';
    const result=await collectMarketProductHistory({...input,metric,scope,jobId:claim.moduleRunId,connector:deps.connectors.sorftime,signal});
    if(result.status==='failed')return failure(result.failure.code,result.failure.retryable);
    return collected(scope,'products',[input.asin],[{id:input.asin,data:{collection:metric==='SalesAmount'?'product-amount-history':'product-history',asin:input.asin,metric,points:result.points}}],result.status,result.evidence,{asin:input.asin,metric,selectionInputSnapshotId:input.selectionInputSnapshotId});
  };
  const category:MarketStepHandler=async({claim,signal})=>{
    const input=z.object({metric:ShapeCategoryMetricSchema,selectionInputSnapshotId:snapshotId}).strict().parse(claim.step.input),scope=await scopeFor(claim,signal);
    const view=await steps.findModuleRun({actor:{organizationId:claim.organizationId,userId:claim.createdBy},moduleRunId:claim.moduleRunId});
    if(!view||view.run.moduleKind!=='shape-price'||!inspectMarketShapeContinuation(view,new Date().toISOString()).currentStepKeys.includes(claim.step.stepKey))invalid('Category is outside shape frontier');
    const pool=await selected(claim,input.selectionInputSnapshotId,scope);if(pool.kind!=='products')invalid('Category selection differs');
    const result=await collectShapeCategory({...input,scope,connector:deps.connectors.sorftime,jobId:claim.moduleRunId,signal});
    if(result.status==='failed')return failure(result.failure.code,result.failure.retryable);
    return collected(scope,'overview',[input.metric],[{id:input.metric,data:{collection:'shape-category',metric:input.metric,points:result.points,stats:result.stats}}],result.status,result.evidence,{metric:input.metric,selectionInputSnapshotId:input.selectionInputSnapshotId});
  };
  const pages: MarketStepHandler = async ({ claim, signal }) => {
    const input = pageInput.parse(claim.step.input), scope = await scopeFor(claim, signal);
    const result = await collectMarketKeywordPage({ ...input, scope, jobId: claim.moduleRunId, connector: deps.connectors.sorftime, signal });
    if (result.status === 'failed') return failure(result.failure.code, result.failure.retryable);
    return collected(scope, 'keywords', result.members.map(m => m.id), result.members.map(member => ({ id: member.id, data: { collection: 'keyword-page', member } })), result.status, result.evidence,
      { seed: result.seed, page: result.page, sourceMode: result.sourceMode, receivedCount: result.receivedCount, pagination: result.pagination, issues: result.issues });
  };
  const trends: MarketStepHandler = async ({ claim, signal }) => {
    const input = trendInput.parse(claim.step.input), scope = await scopeFor(claim, signal);
    const selection = await selected(claim, input.poolInputSnapshotId, scope), record = selection.records.find(r => r.id === input.keywordId);
    if (selection.kind !== 'keywords' || !record || object(record.data).collection !== 'keyword-page' || object(object(record.data).member).keyword !== input.keyword) invalid('Keyword does not match the saved pool');
    signal.throwIfAborted();
    const result = await collectMarketKeywordTrend({ keyword: input.keyword, scope, jobId: claim.moduleRunId, connector: deps.connectors.sorftime, signal });
    if (result.status === 'failed') return failure(result.failure.code, result.failure.retryable);
    if (result.memberId !== input.keywordId) return failure('identity-conflict', false);
    const { evidence, issues, ...trend } = result;
    return collected(scope, 'keywords', [input.keywordId], [{ id: input.keywordId, data: { collection: 'keyword-trend', trend } }], result.status, evidence,
      { keywordId: input.keywordId, keyword: result.keyword, cpcCurrency: result.cpcCurrency, observedCompleteMonths: result.observedCompleteMonths, issues });
  };
  const aba:MarketStepHandler=async({claim,signal})=>{
    const input=abaInput.parse(claim.step.input),scope=await scopeFor(claim,signal);
    const view=await steps.findModuleRun({actor:{organizationId:claim.organizationId,userId:claim.createdBy},moduleRunId:claim.moduleRunId});
    if(!view||view.run.moduleKind!=='keywords'||input.referenceMonth!==scope.toMonth||
      !inspectMarketKeywordContinuation(view,new Date().toISOString()).currentStepKeys.includes(claim.step.stepKey))invalid('ABA step is outside the current keyword frontier');
    const pool=await selected(claim,input.poolInputSnapshotId,scope);
    if(pool.kind!=='keywords'||new Set(input.members.map(m=>m.keywordId)).size!==input.members.length||input.members.some(member=>{
      const record=pool.records.find(r=>r.id===member.keywordId);
      return !record||object(record.data).collection!=='keyword-page'||object(object(record.data).member).keyword!==member.keyword;
    }))invalid('ABA keywords differ from the fixed pool');
    if(scope.marketplace!=='US')return failure('unsupported-marketplace',false);
    if(!deps.connectors.sif)return failure('configuration',false);
    const result=await collectMarketKeywordAba({scope,keywords:input.members.map(m=>m.keyword),referenceMonth:input.referenceMonth,jobId:claim.moduleRunId,connector:deps.connectors.sif,signal});
    if(result.status==='failed'){
      const rejected=failure(result.failure.code,'retryable' in result.failure&&result.failure.retryable===true);
      if(rejected.kind==='settlement'&&rejected.value.outcome.status==='failed')rejected.value.outcome.diagnostic=json({...object(rejected.value.outcome.diagnostic),abaDiagnostic:result.diagnostic});
      return rejected;
    }
    const {evidence,...batch}=result,batchId=`keyword-aba-batch:${digest(input.members.map(m=>m.keywordId))}`;
    return collected(scope,'keywords',[batchId],[{id:batchId,data:{collection:'keyword-aba',result:batch}}],result.status,evidence,
      {sourceVersion:result.schemaVersion,referenceMonth:input.referenceMonth,keywordIds:input.members.map(m=>m.keywordId),batchId});
  };
  const themes: MarketStepHandler = async ({ claim, signal }) => {
    const input = themesInput.parse(claim.step.input), scope = await scopeFor(claim, signal), selection = await selected(claim, input.selectionInputSnapshotId, scope);
    if (selection.kind !== 'products' || !selection.records.some(r => r.id === input.asin && ['product-month','sorftime-shape-pool'].includes(String(object(r.data).collection)) && object(object(r.data).product).asin === input.asin)) invalid('ASIN is outside the saved source pool');
    signal.throwIfAborted();
    const result = await collectMarketCustomerThemes({ asin: input.asin, scope, jobId: claim.moduleRunId, connector: deps.connectors.sorftime, signal, quarantineInvalidThemes: selection.records.every(r=>object(r.data).collection==='sorftime-shape-pool') });
    if (result.result.status === 'failed' || !result.evidence) {
      const first=result.issues[0],path=first?.path;
      const detail=first?.code==='invalid-theme'&&path?.length===4&&path[0]==='data'&&path[1]==='details'
        ?MarketThemeSourceIssueSchema.safeParse({code:first.reason??'invalid-theme',themeIndex:path[2],field:path[3]}):null;
      const rejected=failure(first?.code??'invalid-source',first?.retryable??false,detail?.success?detail.data:undefined);
      if(rejected.kind==='settlement'&&rejected.value.outcome.status==='failed'&&result.rawPayload)rejected.value.outcome.diagnostic=json({...object(rejected.value.outcome.diagnostic),rawPayload:result.rawPayload});
      return rejected;
    }
    return collected(scope, 'customer-themes', [input.asin], [{ id: input.asin, data: { collection: 'customer-themes', result: result.result } }],
      result.result.status === 'empty' ? 'empty' : 'ready', result.evidence, { asin: input.asin, selectionInputSnapshotId: input.selectionInputSnapshotId, issues: result.issues });
  };
  const external=createOverviewExternalStep(deps.context,deps.connectors);
  const demand=createOverviewIndustryDemandStep(deps.context,deps.connectors);
  const overview:MarketStepHandler=async({claim,signal})=>{
    if(object(claim.step.input).phase==='overview-external')return external({claim,signal});
    if(object(claim.step.input).phase==='overview-industry-demand')return demand({claim,signal});
    const input=z.union([MarketOverviewSourceStepInputSchema,MarketOverviewDistributionStepInputSchema]).parse(claim.step.input),scope=await scopeFor(claim,signal,'overview');
    const view=await steps.findModuleRun({actor:{organizationId:claim.organizationId,userId:claim.createdBy},moduleRunId:claim.moduleRunId});
    const common={scope,jobId:claim.moduleRunId,connector:deps.connectors.sellerSprite,signal,originalDemand:object(view?.run.params).flow==='market-overview-flow/rules-v4'};
    const result=MarketOverviewSourceStepInputSchema.safeParse(input).success?await collectMarketOverviewSource({...MarketOverviewSourceStepInputSchema.parse(input),...common}):await collectMarketOverviewDistribution({...MarketOverviewDistributionStepInputSchema.parse(input),...common});
    if(result.status==='failed'||!result.evidence)return failure(result.issues[0]?.code??'invalid-source',result.issues[0]?.retryable??false);
    const id=`${input.month}:${input.operation}`;
    return collected(scope,'overview',[id],[{id,data:{collection:'overview-month',month:input.month,operation:input.operation,parameters:result.parameters}}],result.status,result.evidence,
      {month:input.month,operation:input.operation,parameters:result.parameters,issues:result.issues});
  };
  return Object.freeze({ 'collect-product-month': products, 'collect-product-history':productHistory, 'collect-product-amount-history':productHistory,'collect-product-image':productHistory, 'collect-shape-pool':sorftimePool, 'collect-shape-category':category, 'collect-overview-month':overview, 'collect-keyword-page': pages, 'collect-keyword-trend': trends, 'collect-keyword-aba':aba, 'collect-customer-themes': themes });
}

/** Per-invocation wrappers keep safe admission metadata across collectors that flatten errors. */
export function createMarketSourceStepHandlers(deps: Parameters<typeof buildMarketSourceStepHandlers>[0]) {
  const handlers = buildMarketSourceStepHandlers(deps);
  return Object.fromEntries(Object.keys(handlers).map(kind => [kind, (async input => {
    let admission: ConnectorError['admission'];
    const connectors = Object.fromEntries(Object.entries(deps.connectors).map(([id, connector]) => [id, {
      ...connector,
      execute: async (request: Parameters<typeof connector.execute>[0]) => {
        try { return await connector.execute({...request, sessionScope:'market'}); }
        catch(error) { if(error instanceof ConnectorError && error.code==='local-admission') admission=error.admission; throw error; }
      },
    }])) as typeof deps.connectors;
    const work = await buildMarketSourceStepHandlers({...deps, connectors})[kind as keyof typeof handlers](input);
    if (!admission) return work;
    input.signal.throwIfAborted();
    if(object(input.claim.step.input).phase==='overview-industry-demand'&&work.kind==='settlement'&&work.value.outcome.status==='failed')return {kind:'settlement',value:{...work.value,outcome:{...work.value.outcome,error:{code:'local-admission',retryable:admission.reason==='rolling-window'||admission.reason==='concurrency',admission}}}};
    return {kind:'settlement',value:{outcome:{status:'failed',error:{code:'local-admission',
      retryable:admission.reason==='rolling-window'||admission.reason==='concurrency',admission},
      diagnostic:{handlerVersion:MARKET_SOURCE_HANDLER_VERSION,sourceCode:'local-admission'}}}};
  }) satisfies MarketStepHandler])) as typeof handlers;
}
