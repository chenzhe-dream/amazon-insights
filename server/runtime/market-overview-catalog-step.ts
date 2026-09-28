import {overviewExternalAsins} from '../services/market-overview-external-collector';
import {z} from 'zod';
import {MarketInputRecordSchema,type MarketInputSnapshot} from '../../shared/market-analysis-contracts';
import {MARKET_SOURCE_HANDLER_VERSION,type MarketSourceEvidence} from '../../shared/market-source-contracts';
import {PostgresQueryContext} from '../db/postgres/query-context';
import {PostgresMarketModuleExecutionStore} from '../db/postgres/market-module-execution-store';
import {PostgresMarketAnalysisSnapshotStore} from '../db/postgres/market-analysis-snapshot-store';
import {buildMarketOverviewSourceCatalog,MarketOverviewCatalogVersionSchema} from '../domain/market-research/overview-source-catalog';
import {inspectMarketOverviewContinuation,marketOverviewFlowInitialSteps,MarketOverviewFlowParamsSchema,MarketOverviewCatalogStepInputSchema} from '../domain/market-research/overview-flow';
import {MarketOverviewSourceStepInputSchema} from '../services/market-overview-source-collector';
import {MarketOverviewDistributionStepInputSchema} from '../services/market-overview-distribution-collector';
import {buildMarketOverviewCompleteCatalog,MARKET_OVERVIEW_TABLE_CATALOG_VERSION,MARKET_OVERVIEW_PRODUCT_CATALOG_VERSION} from '../domain/market-research/overview-complete-catalog';
import {buildOverviewRuleBaseline} from '../domain/market-research/overview-rule-baseline';
import {buildMarketOverviewExpandedCatalog} from '../domain/market-research/overview-expanded-catalog';
import {MARKET_OVERVIEW_EXPANDED_CATALOG_VERSION,type MarketOverviewExpandedSourceFailureV2} from '../../shared/market-overview-distribution-contracts';
import {MarketOverviewSourceFailureSchema} from '../domain/market-research/overview-source-catalog';
import {canonicalJsonSha256 as digest} from './model-request-accounting';
import type {MarketStepHandler} from './market-module-step-worker';
import type {MarketModuleRunView,MarketStepDefinition} from '../db/market-module-execution-repository';
const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
function invalid():never{throw new z.ZodError([{code:'custom',path:[],message:'Overview source receipt or execution binding differs'}]);}
const factory=(s:MarketInputSnapshot)=>({scope:s.scope,kind:s.kind,sourceVersion:s.sourceVersion,ruleVersion:s.ruleVersion,collectedAt:s.collectedAt,expectedRecordIds:s.expectedRecordIds,records:s.records});
const sourceRef=z.string().regex(/^market-source:[a-f0-9]{64}$/),inputRef=z.string().regex(/^market-input:[a-f0-9]{64}$/);

export function createMarketOverviewCatalogStep(context:PostgresQueryContext):MarketStepHandler{
  const steps=new PostgresMarketModuleExecutionStore(context);
  return async({claim,signal})=>{
    signal.throwIfAborted();const input=MarketOverviewCatalogStepInputSchema.parse(claim.step.input),actor={organizationId:claim.organizationId,userId:claim.createdBy};
    const view=await steps.findModuleRun({actor,moduleRunId:claim.moduleRunId}),step=view?.steps.find(s=>s.id===claim.stepId);
    if(!view||!step||claim.step.kind!=='rules'||step.status!=='running'||step.latestAttemptId!==claim.attemptId||digest(claim.step)!==claim.inputHash||step.inputHash!==claim.inputHash||view.run.status==='cancelled'||view.run.createdBy!==claim.createdBy||view.run.scope.researchId!==claim.studyId)invalid();
    if(!inspectMarketOverviewContinuation(view,input.dataCutoffAt).currentStepKeys.includes(step.stepKey))invalid();
    const {catalog,output}=await computeMarketOverviewCatalog(context,view,claim.step,signal,'current',true);
    const hasNumericData=catalog.months.some(m=>Object.values(m.metrics).some(v=>v.state==='known'))||'distributions' in catalog&&catalog.distributions.some(d=>d.distribution?.rows.some(r=>r.products!==null||r.units!==null));
    return {kind:'settlement',value:{inputs:[factory(catalog.numericSnapshot),...(catalog.semanticSnapshot?[factory(catalog.semanticSnapshot)]:[])].map(s=>MarketInputRecordSchema.shape.data.parse(s)),outcome:{status:hasNumericData?'succeeded':'empty',output}}};
  };
}
/** Replays the frozen source receipts before a model plan consumes the saved facts. */
export async function readMarketOverviewCatalog(context:PostgresQueryContext,view:MarketModuleRunView,attemptId:string,signal:AbortSignal,mode:'current'|'frozen'='current'){
  const a=view.attempts.find(a=>a.id===attemptId),step=view.steps.find(s=>s.id===a?.stepId);
  if(!a||!step||step.kind!=='rules'||!['succeeded','empty'].includes(a.status)||mode==='current'&&(step.latestAttemptId!==a.id||step.status!==a.status))invalid();
  const computed=await computeMarketOverviewCatalog(context,view,step,signal,mode,Object.hasOwn(obj(a.output),'ruleBaseline'));if(digest(a.output)!==digest(computed.output))invalid();
  const snapshots=new PostgresMarketAnalysisSnapshotStore(context),actor={organizationId:view.run.scope.organizationId,userId:view.run.createdBy};
  for(const value of [computed.catalog.numericSnapshot,...(computed.catalog.semanticSnapshot?[computed.catalog.semanticSnapshot]:[])]){
    signal.throwIfAborted();const saved=await snapshots.findInput({actor,studyId:view.run.scope.researchId,id:value.snapshotId});if(!saved||digest(saved.snapshot)!==digest(value))invalid();
  }
  return computed;
}
async function computeMarketOverviewCatalog(context:PostgresQueryContext,view:MarketModuleRunView,definition:MarketStepDefinition,signal:AbortSignal,mode:'current'|'frozen'='current',includeRuleBaseline=false){
    const snapshots=new PostgresMarketAnalysisSnapshotStore(context),actor={organizationId:view.run.scope.organizationId,userId:view.run.createdBy},studyId=view.run.scope.researchId;
    const input=MarketOverviewCatalogStepInputSchema.parse(definition.input),params=MarketOverviewFlowParamsSchema.parse(view.run.params),expected=marketOverviewFlowInitialSteps(view.run);
    const sourceSteps=expected.map((d,i)=>{const s=view.steps.find(s=>s.stepKey===d.stepKey),a=view.attempts.find(a=>a.id===input.sourceAttemptIds[i]);
      if(!s||!a||a.stepId!==s.id||s.inputHash!==digest(d))invalid();
      return mode==='current'?s:{...s,latestAttemptId:a.id,status:a.status==='interrupted'?'failed' as const:a.status};});
    if(sourceSteps.some((s,i)=>!s||s.inputHash!==digest(expected[i]))||digest(sourceSteps.map(s=>s.latestAttemptId))!==digest(input.sourceAttemptIds)||digest(definition.inputRefs)!==digest(sourceSteps.filter(s=>s.status==='succeeded'||s.status==='empty').map(s=>({kind:'step-output',id:s.latestAttemptId}))))invalid();
    const sources:MarketSourceEvidence[]=[],failures:MarketOverviewExpandedSourceFailureV2[]=[],receipts:unknown[]=[];
    for(const sourceStep of sourceSteps){
      signal.throwIfAborted();const a=view.attempts.find(a=>a.id===sourceStep.latestAttemptId&&a.stepId===sourceStep.id);if(!a)invalid();
      const {month,operation,headTopN,newProductMonths}=z.union([MarketOverviewSourceStepInputSchema,MarketOverviewDistributionStepInputSchema]).parse(sourceStep.input);
      if(sourceStep.status==='failed'&&['failed','interrupted'].includes(a.status)){
        failures.push({month,operation,attemptId:a.id,code:z.string().min(1).max(100).parse(obj(a.error).code)});receipts.push({month,operation,attemptId:a.id,status:'failed'});continue;
      }
      if(!['succeeded','empty'].includes(a.status)||a.status!==sourceStep.status)invalid();
      const output=obj(a.output),parameters={headTopN,newProductMonths};
      if(output.handlerVersion!==MARKET_SOURCE_HANDLER_VERSION||output.month!==month||output.operation!==operation||digest(output.parameters)!==digest(parameters)||!['ready','partial','empty'].includes(String(output.collectionStatus))||(a.status==='empty')!==(output.collectionStatus==='empty'))invalid();
      const ref=sourceRef.parse(output.sourceRef),id=inputRef.parse(output.inputSnapshotId);
      const source=await snapshots.findSource({actor,studyId,id:ref}),saved=await snapshots.findInput({actor,studyId,id});
      if(!source||!saved||digest(saved.snapshot.scope)!==digest(view.run.scope)||saved.snapshot.kind!=='overview'||saved.snapshot.sourceVersion!==MARKET_SOURCE_HANDLER_VERSION||saved.snapshot.collectedAt!==source.evidence.fetchedAt||saved.snapshot.records.length!==1)invalid();
      const record=saved.snapshot.records[0];
      if(record.id!==`${month}:${operation}`||digest(record.data)!==digest({collection:'overview-month',month,operation,parameters,sourceRef:ref})||source.evidence.operation!==operation||source.evidence.requestIdentity.month!==month)invalid();
      sources.push(source.evidence);receipts.push({month,operation,attemptId:a.id,status:output.collectionStatus,sourceRef:ref,inputSnapshotId:id});
    }
    const common={scope:view.run.scope,parameters:{headTopN:params.headTopN,newProductMonths:params.newProductMonths},dataCutoffAt:input.dataCutoffAt,sources};
    const catalog=view.run.versions.rule===MARKET_OVERVIEW_PRODUCT_CATALOG_VERSION?buildMarketOverviewCompleteCatalog({...common,failures},{metricTable:true,productRows:true}):view.run.versions.rule===MARKET_OVERVIEW_TABLE_CATALOG_VERSION?buildMarketOverviewCompleteCatalog({...common,failures},{metricTable:true}):view.run.versions.rule===MARKET_OVERVIEW_EXPANDED_CATALOG_VERSION?buildMarketOverviewExpandedCatalog({...common,failures}):buildMarketOverviewSourceCatalog({...common,failures:failures.map(f=>MarketOverviewSourceFailureSchema.parse(f)),version:MarketOverviewCatalogVersionSchema.parse(view.run.versions.rule)});signal.throwIfAborted();
    const output:Record<string,unknown>={catalogVersion:catalog.version,numericInputSnapshotId:catalog.numericSnapshot.snapshotId,semanticInputSnapshotId:catalog.semanticSnapshot?.snapshotId??null,semanticStatus:catalog.semanticSnapshot?'pending':'no-input',sourceRefs:catalog.sourceRefs,sourceReceipts:receipts,sourceAttemptIds:input.sourceAttemptIds,dataCutoffAt:input.dataCutoffAt,failures};
    if(params.flow==='market-overview-flow/rules-v4')output.externalAsins=overviewExternalAsins(sources,view.run.scope);
    if(includeRuleBaseline)output.ruleBaseline=buildOverviewRuleBaseline(catalog);
    return {catalog,sources,output:MarketInputRecordSchema.shape.data.parse(output)};
}
