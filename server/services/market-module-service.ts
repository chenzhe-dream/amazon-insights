import {MarketShapeExplanationRunResponseSchema} from '../../shared/market-shape-explanation-public-contracts';
import {isMarketShapeExplanationFlow} from '../domain/market-research/shape-explanation-flow';
import {PostgresMarketShapeExplanationRunStore} from '../db/postgres/market-shape-explanation-run-store';
import {readMarketShapeExplanationFragments} from './market-shape-explanation-fragment-service';
import {readMarketShapeExplanationReport} from '../runtime/market-shape-explanation-report-reader';
import {presentMarketShapeExplanation} from '../domain/market-research/shape-explanation-presentation';
import { z } from 'zod';
import { MarketModuleIdSchema, MarketStudyRequestSchema, MarketStudyResponseSchema, MarketThemeStartRequestSchema,
  MarketThemeRunResponseSchema, MarketModuleRetryRequestSchema } from '../../shared/market-module-contracts';
import type { MarketExecutionActor } from '../db/market-module-execution-repository';
import { MarketExecutionConflictError } from '../db/market-module-execution-repository';
import { PostgresQueryContext } from '../db/postgres/query-context';
import { PostgresMarketAnalysisSnapshotStore } from '../db/postgres/market-analysis-snapshot-store';
import { PostgresMarketModuleExecutionStore } from '../db/postgres/market-module-execution-store';
import { MarketThemeReportService } from './market-theme-report-service';
import { MARKET_THEME_RULES_FLOW_VERSION, marketThemeFlowInitialSteps, inspectMarketThemeContinuation, isMarketThemeFlow } from '../domain/market-research/customer-theme-flow';
import { MARKET_SOURCE_HANDLER_VERSION } from '../../shared/market-source-contracts';
import { MARKET_THEME_MAPPING_RULE_VERSION } from '../domain/market-research/customer-theme-mapping-rules';
import { MarketThemeDetailQueryError } from '../domain/market-research/customer-theme-details';
import {MarketOverviewStartRequestSchema,MarketOverviewRunResponseSchema} from '../../shared/market-overview-report-contracts';
import {MarketOverviewReportService} from './market-overview-report-service';
import {MARKET_OVERVIEW_RULES_FLOW_VERSION,marketOverviewFlowInitialSteps,inspectMarketOverviewContinuation,isMarketOverviewFlow} from '../domain/market-research/overview-flow';
import {MARKET_OVERVIEW_TABLE_CATALOG_VERSION} from '../domain/market-research/overview-complete-catalog';
import {isMarketAutomaticFlow,inspectMarketContinuation} from '../domain/market-research/module-flow';
import {MarketShapeStartRequestSchema,MARKET_SHAPE_RULES_FLOW_VERSION,marketShapeFlowInitialSteps,isMarketShapeFlow} from '../domain/market-research/shape-price-flow';
import {MARKET_SHAPE_REQUEST_BOUND_CATALOG_VERSION,assertMarketProductQueryWindow} from '../../shared/market-product-source-policy';
import {PostgresMarketShapePriceRevisionStore} from '../db/postgres/market-shape-price-revision-store';
import {readMarketShapeRun,marketShapePublicRevision} from './market-shape-read-service';
import {isMarketKeywordFlow,MarketKeywordStartRequestSchema,MARKET_KEYWORD_RULES_FLOW_VERSION,marketKeywordFlowInitialSteps} from '../domain/market-research/keyword-flow';
import {MARKET_KEYWORD_POOL_VERSION} from '../domain/market-research/keyword-source-pool';
import {readMarketKeywordRun} from './market-keyword-read-service';
import {readMarketKeywordReconciliationReport} from './market-keyword-reconciliation-read';
import {buildMarketKeywordRuleReport} from '../domain/market-research/keyword-rule-report';
import {buildMarketKeywordScoreInputAudit} from '../domain/market-research/keyword-score-input-audit';
import {PostgresMarketKeywordRevisionStore} from '../db/postgres/market-keyword-revision-store';
import {MarketKeywordRevisionIdSchema} from '../../shared/market-keyword-revision-contracts';
import {canonicalJsonSha256} from '../runtime/model-request-accounting';

export class MarketModuleServiceError extends Error {
  constructor(readonly statusCode: 400 | 403 | 404 | 503, message: string) { super(message); }
}
type ModelIdentity = { configurationVersion: string; promptVersion: string };
const obj = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const unavailable = () => new MarketModuleServiceError(404, '未找到该组织的市场研究或任务');

export class MarketModuleService {
  private readonly snapshots: PostgresMarketAnalysisSnapshotStore;
  private readonly steps: PostgresMarketModuleExecutionStore;
  constructor(private readonly deps: { context: PostgresQueryContext; modelIdentity: () => ModelIdentity | null; overviewSynthesisModelIdentity?: () => ModelIdentity | null; shapeModelIdentity?: () => ModelIdentity | null; keywordModelIdentity?: () => ModelIdentity | null; keywordReconciliationModelIdentity?: () => ModelIdentity | null; keywordExplicitModelIdentity?: () => ModelIdentity | null; now?: () => Date }) {
    this.snapshots = new PostgresMarketAnalysisSnapshotStore(deps.context); this.steps = new PostgresMarketModuleExecutionStore(deps.context);
  }
  private now() { return (this.deps.now?.() ?? new Date()).toISOString(); }
  private model() { const identity = this.deps.modelIdentity(); if (!identity) throw new MarketModuleServiceError(503, '市场分析模型服务暂不可用，已保存的报告仍可查看'); return identity; }
  private async replayModuleStart(actor:MarketExecutionActor,studyId:string,idempotencyKey:string,moduleKind:'shape-price'|'keywords'|'customer-themes',params:unknown){
    const previous=await this.steps.findCreatedModuleRunByCommand({actor,idempotencyKey});if(!previous)return null;
    const publicParams={...obj(previous.params)};delete publicParams.flow;
    // Theme catalogs are server-owned; shape and keyword catalogs are public intent.
    if(moduleKind==='customer-themes')delete publicParams.catalog;
    if(previous.scope.researchId!==studyId||previous.moduleKind!==moduleKind||canonicalJsonSha256(publicParams)!==canonicalJsonSha256(params))throw new MarketExecutionConflictError();
    return previous;
  }
  async createStudy(actor: MarketExecutionActor, body: unknown, key: unknown) {
    const request = MarketStudyRequestSchema.parse(body), id = MarketModuleIdSchema.parse(key), now = this.now();
    if (request.toMonth >= now.slice(0, 7)) throw new MarketModuleServiceError(400, '请选择当前月份之前的完整月份');
    // The client's one-time UUID command key also names this new study. Retrying
    // that command preserves scope identity; no random ID is regenerated on ACK loss.
    const result = await this.snapshots.createStudy({ actor, scope: { ...request, organizationId: actor.organizationId, researchId: id }, idempotencyKey: id, now });
    return { created: result.created, ...MarketStudyResponseSchema.parse({ study: { id: result.study.id, scope: result.study.scope, createdAt: result.study.createdAt } }) };
  }
  async findStudy(actor: MarketExecutionActor, id: string) {
    id = MarketModuleIdSchema.parse(id); const study = await this.snapshots.findStudy({ actor, id }); if (!study) throw unavailable();
    return MarketStudyResponseSchema.parse({ study: { id: study.id, scope: study.scope, createdAt: study.createdAt } });
  }
  async startOverview(actor:MarketExecutionActor,id:string,body:unknown,key:unknown){
    const params=MarketOverviewStartRequestSchema.parse(body),idempotencyKey=MarketModuleIdSchema.parse(key),studyId=MarketModuleIdSchema.parse(id);
    const replay=async()=>{
      const previous=await this.steps.findCreatedModuleRunByCommand({actor,idempotencyKey});if(!previous)return null;
      const frozen=obj(previous.params);
      if(previous.scope.researchId!==studyId||previous.moduleKind!=='overview'||frozen.headTopN!==params.headTopN||frozen.newProductMonths!==params.newProductMonths)throw new MarketExecutionConflictError();
      return {created:false,...await this.findOverview(actor,previous.id)};
    };
    const previous=await replay();if(previous)return previous;
    const {study}=await this.findStudy(actor,studyId);
    const request={actor,scope:study.scope,moduleKind:'overview' as const,params:{...params,flow:MARKET_OVERVIEW_RULES_FLOW_VERSION},
      versions:{source:MARKET_SOURCE_HANDLER_VERSION,rule:MARKET_OVERVIEW_TABLE_CATALOG_VERSION,mapping:MARKET_OVERVIEW_TABLE_CATALOG_VERSION,planner:MARKET_OVERVIEW_RULES_FLOW_VERSION,
        model:null,prompt:null,configuration:null},collectionRevision:'initial/v1',idempotencyKey};
    let result;
    try{result=await this.steps.createModuleRun({...request,initialSteps:marketOverviewFlowInitialSteps(request)});}
    catch(error){if(!(error instanceof MarketExecutionConflictError))throw error;const winner=await replay();if(winner)return winner;throw error;}
    return {created:result.created,...await this.findOverview(actor,result.run.id)};
  }
  async findOverview(actor:MarketExecutionActor,id:string){
    id=MarketModuleIdSchema.parse(id);
    return this.deps.context.transaction(async()=>{
      await this.deps.context.query('SELECT id FROM market_analysis_module_runs WHERE id=$1 AND organization_id=$2 FOR SHARE',[id,actor.organizationId]);
      const view=await this.steps.findModuleRun({actor,moduleRunId:id});if(!view||!isMarketOverviewFlow(view.run))throw unavailable();
      const reports=await new MarketOverviewReportService(this.deps.context).read({actor,moduleRunId:id});if(!reports)throw unavailable();
      const current=new Set(inspectMarketOverviewContinuation(view,this.now()).currentStepKeys),p=obj(view.run.params);
      return MarketOverviewRunResponseSchema.parse({run:{id,scope:view.run.scope,status:view.run.status,createdAt:view.run.createdAt,planRevision:view.run.planRevision,
        params:{headTopN:p.headTopN,newProductMonths:p.newProductMonths},currentReport:reports.currentReport,latestSavedReport:reports.latestSavedReport,history:reports.history,
        steps:view.steps.map(s=>{const a=view.attempts.find(a=>a.id===s.latestAttemptId);return {id:s.id,kind:s.kind,status:s.status,latestAttemptId:s.latestAttemptId,attemptCount:s.attemptCount,nextAttemptAt:s.nextAttemptAt??null,current:current.has(s.stepKey),...(s.kind==='collect-overview-month'?{source:{month:obj(s.input).month,operation:obj(s.input).operation}}:{}),
          canRetry:current.has(s.stepKey)&&s.status==='failed'&&view.run.status!=='cancelled',asin:null,errorCode:['failed','interrupted'].includes(a?.status??'')?obj(a?.error).code??'internal':null};})}});
    });
  }
  async overviewDetails(actor:MarketExecutionActor,id:string,attemptId:string){
    const details=await new MarketOverviewReportService(this.deps.context).details({actor,moduleRunId:id,attemptId});if(!details)throw unavailable();return details;
  }
  async startShapes(actor:MarketExecutionActor,id:string,body:unknown,key:unknown){
    const params=MarketShapeStartRequestSchema.parse(body),idempotencyKey=MarketModuleIdSchema.parse(key),studyId=MarketModuleIdSchema.parse(id);
    const replay=async()=>{const previous=await this.replayModuleStart(actor,studyId,idempotencyKey,'shape-price',params);return previous?{created:false,...await this.findShapes(actor,previous.id)}:null;};
    const previous=await replay();if(previous)return previous;
    const {study}=await this.findStudy(actor,studyId);
    assertMarketProductQueryWindow(study.scope,new Date(this.now()));
    const request={actor,scope:study.scope,moduleKind:'shape-price' as const,params:{...params,flow:MARKET_SHAPE_RULES_FLOW_VERSION},
      versions:{source:MARKET_SOURCE_HANDLER_VERSION,rule:MARKET_SHAPE_REQUEST_BOUND_CATALOG_VERSION,mapping:params.catalog.taxonomyVersion,planner:MARKET_SHAPE_RULES_FLOW_VERSION,model:null,prompt:null,configuration:null},collectionRevision:'initial/v1',idempotencyKey};
    let result;
    try{result=await this.steps.createModuleRun({...request,initialSteps:marketShapeFlowInitialSteps(request)});}
    catch(error){if(!(error instanceof MarketExecutionConflictError))throw error;const winner=await replay();if(winner)return winner;throw error;}
    return {created:result.created,...await this.findShapes(actor,result.run.id)};
  }
  async startKeywords(actor:MarketExecutionActor,id:string,body:unknown,key:unknown){
    const params=MarketKeywordStartRequestSchema.parse(body),idempotencyKey=MarketModuleIdSchema.parse(key),studyId=MarketModuleIdSchema.parse(id);
    const replay=async()=>{const previous=await this.replayModuleStart(actor,studyId,idempotencyKey,'keywords',params);return previous?{created:false,...await this.findKeywords(actor,previous.id)}:null;};
    const previous=await replay();if(previous)return previous;
    const {study}=await this.findStudy(actor,studyId);
    const request={actor,scope:study.scope,moduleKind:'keywords' as const,params:{...params,flow:MARKET_KEYWORD_RULES_FLOW_VERSION},
      versions:{source:MARKET_SOURCE_HANDLER_VERSION,rule:MARKET_KEYWORD_POOL_VERSION,mapping:params.catalog.dictionaryVersion,planner:MARKET_KEYWORD_RULES_FLOW_VERSION,
        model:null,prompt:null,configuration:null},collectionRevision:'initial/v1',idempotencyKey};
    let result;
    try{result=await this.steps.createModuleRun({...request,initialSteps:marketKeywordFlowInitialSteps(request)});}
    catch(error){if(!(error instanceof MarketExecutionConflictError))throw error;const winner=await replay();if(winner)return winner;throw error;}
    return {created:result.created,...await this.findKeywords(actor,result.run.id)};
  }
  async findKeywords(actor:MarketExecutionActor,id:string){const result=await this.deps.context.transaction(async()=>{
    id=MarketModuleIdSchema.parse(id);const result=await readMarketKeywordRun(this.deps.context,actor,id);if(!result)throw unavailable();
    const history=await new PostgresMarketKeywordRevisionStore(this.deps.context).list({actor,moduleRunId:id});
    const reconciliation=await readMarketKeywordReconciliationReport(this.deps.context,actor,result.run);
    return {...result,run:{...result.run,history,...(reconciliation?{reconciliation}:{})}};
  });
    // Facts and classification are captured under the same read lock. Pure rule
    // calculation uses that detached basis after releasing the database lock.
    const {facts,reconciliation}=result.run;
    const ruleReport=facts?buildMarketKeywordRuleReport({facts,classification:reconciliation?{kind:'global',report:reconciliation}:null}):null;
    const rulesOnly=obj(result.run.params).flow===MARKET_KEYWORD_RULES_FLOW_VERSION;
    return {...result,run:{...result.run,...(rulesOnly?{ruleStatus:facts?.ruleBaseline?.status??'unavailable',semanticStatus:'skipped' as const}:{}),...(ruleReport&&facts?{ruleReport,scoreInputAudit:buildMarketKeywordScoreInputAudit({facts,report:ruleReport})}:{})}};
  }
  async saveKeywordRevision(actor:MarketExecutionActor,id:string,body:unknown,key:unknown){
    id=MarketModuleIdSchema.parse(id);
    const result=await new PostgresMarketKeywordRevisionStore(this.deps.context).save({actor,moduleRunId:id,request:body,idempotencyKey:MarketModuleIdSchema.parse(key)});
    const {created,...revision}=result;
    const ruleReport=buildMarketKeywordRuleReport({facts:revision.catalog.facts,classification:{kind:'manual',revision:revision.catalog}});
    return {created,revision:{...revision,ruleReport,scoreInputAudit:buildMarketKeywordScoreInputAudit({facts:revision.catalog.facts,report:ruleReport})}};
  }
  async keywordRevision(actor:MarketExecutionActor,id:string,revisionId:string){
    id=MarketModuleIdSchema.parse(id);revisionId=MarketKeywordRevisionIdSchema.parse(revisionId);
    const revision=await new PostgresMarketKeywordRevisionStore(this.deps.context).find({actor,moduleRunId:id,revisionId});
    if(!revision)throw unavailable();
    const ruleReport=buildMarketKeywordRuleReport({facts:revision.catalog.facts,classification:{kind:'manual',revision:revision.catalog}});
    return {revision:{...revision,ruleReport,scoreInputAudit:buildMarketKeywordScoreInputAudit({facts:revision.catalog.facts,report:ruleReport})}};
  }
  async findShapes(actor:MarketExecutionActor,id:string){
    id=MarketModuleIdSchema.parse(id);const result=await readMarketShapeRun(this.deps.context,actor,id);if(!result)throw unavailable();return result;
  }
  async saveShapeRevision(actor:MarketExecutionActor,id:string,body:unknown,key:unknown){
    id=MarketModuleIdSchema.parse(id);const view=await this.steps.findModuleRun({actor,moduleRunId:id});if(!view||!isMarketShapeFlow(view.run))throw unavailable();
    const identity=this.deps.shapeModelIdentity?.();
    if(identity){
      const linked=await new PostgresMarketShapeExplanationRunStore(this.deps.context).saveRevisionAndEnsureExplanation({actor,parentRunId:id,request:body,idempotencyKey:MarketModuleIdSchema.parse(key),identity});
      return {created:linked.revision.created,revision:marketShapePublicRevision(linked.revision),explanation:{moduleRunId:linked.childRun.id,status:linked.childRun.status}};
    }
    const result=await new PostgresMarketShapePriceRevisionStore(this.deps.context).save({actor,moduleRunId:id,request:body,idempotencyKey:MarketModuleIdSchema.parse(key)});
    return {created:result.created,revision:marketShapePublicRevision(result),explanation:null,explanationUnavailableReason:'模型配置暂不可用，人工修订已保存'};
  }
  async shapeRevision(actor:MarketExecutionActor,id:string,revisionId:string){
    id=MarketModuleIdSchema.parse(id);const view=await this.steps.findModuleRun({actor,moduleRunId:id});if(!view||!isMarketShapeFlow(view.run))throw unavailable();
    const result=await new PostgresMarketShapePriceRevisionStore(this.deps.context).find({actor,moduleRunId:id,revisionId});if(!result)throw unavailable();
    const explanations=await new PostgresMarketShapeExplanationRunStore(this.deps.context).listForRevision({actor,parentRunId:id,revisionId});
    return {revision:marketShapePublicRevision(result),explanations};
  }
  async findShapeExplanation(actor:MarketExecutionActor,id:string){
    id=MarketModuleIdSchema.parse(id);
    return this.deps.context.transaction(async()=>{
      await this.deps.context.query('SELECT id FROM market_analysis_module_runs WHERE id=$1 AND organization_id=$2 FOR SHARE',[id,actor.organizationId]);
      const view=await this.steps.findModuleRun({actor,moduleRunId:id});if(!view||!isMarketShapeExplanationFlow(view.run))throw unavailable();
      const fragments=await readMarketShapeExplanationFragments(this.deps.context,{actor,moduleRunId:id});
      const current=new Set(inspectMarketContinuation(view,this.now()).currentStepKeys);
      const saved=view.steps.find(s=>s.kind==='report'&&s.latestAttemptId===view.run.latestReportAttemptId);
      let report=null,presentation=null;
      if(saved){const {stepKey,kind,subject,input,inputRefs}=saved;const restored=await readMarketShapeExplanationReport(this.deps.context,view,{stepKey,kind,subject,input,inputRefs},new AbortController().signal);report=restored.report;presentation=presentMarketShapeExplanation(restored.catalog,report.explanation);}
      return MarketShapeExplanationRunResponseSchema.parse({run:{id,status:view.run.status,revisionId:obj(view.run.params).revisionId,progress:{totalWindows:fragments.windows.length,completedWindows:fragments.windows.filter(w=>w.status==='succeeded').length},report,presentation,
        steps:view.steps.map(s=>{const a=view.attempts.find(a=>a.id===s.latestAttemptId);return {id:s.id,kind:s.kind,status:s.status,latestAttemptId:s.latestAttemptId,attemptCount:s.attemptCount,nextAttemptAt:s.nextAttemptAt??null,asin:null,current:current.has(s.stepKey),canRetry:current.has(s.stepKey)&&s.status==='failed'&&view.run.status!=='cancelled',errorCode:a?.error?obj(a.error).code:null};})}});
    });
  }
  async startThemes(actor: MarketExecutionActor, id: string, body: unknown, key: unknown) {
    const params=MarketThemeStartRequestSchema.parse(body),idempotencyKey=MarketModuleIdSchema.parse(key),studyId=MarketModuleIdSchema.parse(id);
    const replay=async()=>{const previous=await this.replayModuleStart(actor,studyId,idempotencyKey,'customer-themes',params);return previous?{created:false,...await this.findRun(actor,previous.id)}:null;};
    const previous=await replay();if(previous)return previous;
    const {study}=await this.findStudy(actor,studyId);
    // Empty frozen catalog permits A4 proposals; it does not imply approved groups.
    // Cross-batch reconciliation remains a mandatory report readiness condition.
    const catalog = { task: 'market-customer-theme-mapping', mappingVersion: 'theme-groups/unreviewed-v1', groupCatalog: [] };
    const request = { actor, scope: study.scope, moduleKind: 'customer-themes' as const, params: { ...params, flow: MARKET_THEME_RULES_FLOW_VERSION, catalog },
      versions: { source: MARKET_SOURCE_HANDLER_VERSION, rule: MARKET_THEME_MAPPING_RULE_VERSION, mapping: catalog.mappingVersion, planner: MARKET_THEME_RULES_FLOW_VERSION,
        model: null, prompt: null, configuration: null }, collectionRevision: 'initial/v1', idempotencyKey };
    let result;
    try{result=await this.steps.createModuleRun({...request,initialSteps:marketThemeFlowInitialSteps(request)});}
    catch(error){if(!(error instanceof MarketExecutionConflictError))throw error;const winner=await replay();if(winner)return winner;throw error;}
    return { created: result.created, ...await this.findRun(actor, result.run.id) };
  }
  async findRun(actor: MarketExecutionActor, id: string) {
    id = MarketModuleIdSchema.parse(id);
    return this.deps.context.transaction(async () => {
      await this.deps.context.query('SELECT id FROM market_analysis_module_runs WHERE id=$1 AND organization_id=$2 FOR SHARE', [id, actor.organizationId]);
      const view = await this.steps.findModuleRun({ actor, moduleRunId: id }); if (!view || !isMarketThemeFlow(view.run)) throw unavailable();
      const reports = await new MarketThemeReportService(this.deps.context).read({ actor, moduleRunId: id }); if (!reports) throw unavailable();
      const currentKeys = new Set(inspectMarketThemeContinuation(view, this.now()).currentStepKeys), p = obj(view.run.params);
      return MarketThemeRunResponseSchema.parse({ run: { id, scope: view.run.scope, status: view.run.status, createdAt: view.run.createdAt, planRevision: view.run.planRevision,
        params: { memberCount: p.memberCount, poolSize: p.poolSize, newProductMonths: p.newProductMonths, ...(p.topN !== undefined ? { topN: p.topN } : {}) },
        steps: view.steps.map(step => { const attempt = view.attempts.find(a => a.id === step.latestAttemptId), current = currentKeys.has(step.stepKey);
          return { id: step.id, kind: step.kind, status: step.status, latestAttemptId: step.latestAttemptId, attemptCount: step.attemptCount,nextAttemptAt:step.nextAttemptAt??null, current,
            canRetry: current && step.status === 'failed' && view.run.status !== 'cancelled', asin: obj(step.input).asin ?? null,
            errorCode: ['failed', 'interrupted'].includes(attempt?.status ?? '') ? obj(attempt?.error).code ?? 'internal' : null }; }),
        currentReport: reports.currentReport, latestSavedReport: reports.latestSavedReport, history: reports.history } });
    });
  }
  async retry(actor: MarketExecutionActor, id: string, body: unknown, key: unknown) {
    id = MarketModuleIdSchema.parse(id); const input = MarketModuleRetryRequestSchema.parse(body), idempotencyKey = MarketModuleIdSchema.parse(key);
    return this.deps.context.transaction(async () => {
      await this.deps.context.query('SELECT id FROM market_analysis_module_runs WHERE id=$1 AND organization_id=$2 FOR UPDATE', [id, actor.organizationId]);
      const view = await this.steps.findModuleRun({ actor, moduleRunId: id }); if (!view || !isMarketAutomaticFlow(view.run)) throw unavailable();
      const previous = await this.deps.context.query("SELECT id FROM market_analysis_commands WHERE organization_id=$1 AND kind='retry-failed' AND idempotency_key=$2", [actor.organizationId, idempotencyKey]);
      if (!previous.rowCount) {
        if(view.run.scope.marketplace!=='US'&&input.steps.some(selected=>view.steps.some(s=>s.id===selected.stepId&&s.kind==='collect-keyword-aba')))
          throw new MarketModuleServiceError(400,'此站点尚无已验证的 ABA 补充接口，不能重试此补充步骤');
        const rulesOnly=String(obj(view.run.params).flow)==='market-theme-flow/rules-v1'||String(obj(view.run.params).flow)==='market-shape-price-flow/rules-v1'||String(obj(view.run.params).flow)==='market-keyword-flow/rules-v1'||String(obj(view.run.params).flow)==='market-overview-flow/rules-v1';
        const requiresModel=rulesOnly?false:isMarketKeywordFlow(view.run)?input.steps.some(selected=>view.steps.some(s=>s.id===selected.stepId&&['prepare-model-batches','model-batch'].includes(s.kind))):isMarketShapeExplanationFlow(view.run)?input.steps.some(selected=>view.steps.some(s=>s.id===selected.stepId&&s.kind!=='report')):isMarketShapeFlow(view.run)?input.steps.some(selected=>view.steps.some(s=>s.id===selected.stepId&&(['prepare-model-batches','model-batch'].includes(s.kind)||s.kind==='prepare-members'&&obj(s.input).phase!=='select-shape-members'))):!isMarketOverviewFlow(view.run)||input.steps.some(selected=>view.steps.some(s=>s.id===selected.stepId&&['prepare-members','prepare-model-batches','model-batch'].includes(s.kind)));
        const model=requiresModel?(isMarketShapeExplanationFlow(view.run)?this.deps.shapeModelIdentity?.():isMarketKeywordFlow(view.run)&&obj(view.run.params).analysisMode==='global-reconciliation/v2'?this.deps.keywordExplicitModelIdentity?.():isMarketKeywordFlow(view.run)&&obj(view.run.params).analysisMode==='global-reconciliation/v1'?this.deps.keywordReconciliationModelIdentity?.():isMarketKeywordFlow(view.run)&&obj(obj(view.run.params).catalog).discoveryMode==='labels-and-clusters/v1'?this.deps.keywordModelIdentity?.():this.model()):null; if(requiresModel&&!model)throw new MarketModuleServiceError(503,'该分析模型暂不可用，已保存输入与报告保留'); if (model&&(view.run.versions.configuration !== model.configurationVersion || view.run.versions.prompt !== model.promptVersion))
          throw new MarketModuleServiceError(503, '该任务的模型版本暂不可用，请保留报告并使用当前版本创建分析');
        const current = new Set(inspectMarketContinuation(view, this.now()).currentStepKeys);
        if (input.steps.some(selected => !view.steps.some(s => s.id === selected.stepId && current.has(s.stepKey)))) throw new MarketExecutionConflictError();
      }
      return this.steps.retryFailedSteps({ actor, moduleRunId: id, ...input, idempotencyKey });
    });
  }
  async cancel(actor: MarketExecutionActor, id: string, body: unknown, key: unknown) {
    id = MarketModuleIdSchema.parse(id); z.object({}).strict().parse(body);
    const view=await this.steps.findModuleRun({actor,moduleRunId:id});if(!view||!isMarketAutomaticFlow(view.run))throw unavailable();
    return this.steps.cancelModuleRun({ actor, moduleRunId: id, idempotencyKey: MarketModuleIdSchema.parse(key) });
  }
  async evidence(actor:MarketExecutionActor,id:string,attemptId:string,query:unknown) {
    try{const result=await new MarketThemeReportService(this.deps.context).readEvidence({actor,moduleRunId:id,attemptId,query});if(!result)throw unavailable();return result;}
    catch(e){if(e instanceof MarketThemeDetailQueryError)throw unavailable();throw e;}
  }
  async details(actor: MarketExecutionActor, id: string, attemptId: string, query: unknown) {
    try {
      const result = await new MarketThemeReportService(this.deps.context).readDetails({ actor, moduleRunId: id, attemptId, query });
      if (!result) throw unavailable(); return result;
    } catch (error) {
      if (error instanceof MarketThemeDetailQueryError) throw new MarketModuleServiceError(400, '该报告没有此页或主题分组');
      throw error;
    }
  }
}
