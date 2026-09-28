import {inspectMarketOverviewSynthesisContinuation} from './overview-synthesis-continuation';
import {z} from 'zod';
import {MARKET_OVERVIEW_TABLE_CATALOG_VERSION,MARKET_OVERVIEW_PRODUCT_CATALOG_VERSION} from './overview-complete-catalog';
import {MarketAnalysisScopeSchema} from '../../../shared/market-analysis-contracts';
import {MARKET_SOURCE_HANDLER_VERSION} from '../../../shared/market-source-contracts';
import type {CreateMarketModuleRunInput,MarketModuleRunView,MarketStepDefinition} from '../../db/market-module-execution-repository';
import {MarketOverviewCatalogVersionSchema} from './overview-source-catalog';
import {canonicalJsonSha256 as digest} from '../../runtime/model-request-accounting';
import {MarketOverviewWindowPlanSchema,marketOverviewWindowPreparations} from './overview-window-plan';
import {marketOverviewReportDefinition,type MarketOverviewReportInput} from './overview-report-plan';
import {MARKET_OVERVIEW_ALL_OPERATIONS,MARKET_OVERVIEW_ALL_OPERATIONS_V2,MARKET_OVERVIEW_EXPANDED_CATALOG_VERSION} from '../../../shared/market-overview-distribution-contracts';

export const MARKET_OVERVIEW_FLOW_VERSION='market-overview-flow/v1';
export const MARKET_OVERVIEW_EXPLAINED_FLOW_VERSION='market-overview-flow/v2';
export const MARKET_OVERVIEW_EXPANDED_FLOW_VERSION='market-overview-flow/v3';
export const MARKET_OVERVIEW_COMPLETE_FLOW_VERSION='market-overview-flow/v4';
export const MARKET_OVERVIEW_SYNTHESIS_FLOW_VERSION='market-overview-flow/v5';
export const MARKET_OVERVIEW_RULES_FLOW_VERSION='market-overview-flow/rules-v1';
export const MARKET_OVERVIEW_PRODUCT_RULES_FLOW_VERSION='market-overview-flow/rules-v2';
export const MARKET_OVERVIEW_DEMAND_RULES_FLOW_VERSION='market-overview-flow/rules-v3';
export const MarketOverviewFlowParamsSchema=z.object({flow:z.enum([MARKET_OVERVIEW_FLOW_VERSION,MARKET_OVERVIEW_EXPLAINED_FLOW_VERSION,MARKET_OVERVIEW_EXPANDED_FLOW_VERSION,MARKET_OVERVIEW_COMPLETE_FLOW_VERSION,MARKET_OVERVIEW_SYNTHESIS_FLOW_VERSION,MARKET_OVERVIEW_RULES_FLOW_VERSION,MARKET_OVERVIEW_PRODUCT_RULES_FLOW_VERSION,MARKET_OVERVIEW_DEMAND_RULES_FLOW_VERSION]),headTopN:z.union([z.literal(5),z.literal(10),z.literal(20)]),newProductMonths:z.union([z.literal(1),z.literal(3),z.literal(6),z.literal(12)])}).strict();
export const MarketOverviewCatalogStepInputSchema=z.object({task:z.literal('overview-source-catalog'),sourceAttemptIds:z.array(z.string().uuid()).min(1).max(2000),dataCutoffAt:z.string().datetime()}).strict();
type Request=Pick<CreateMarketModuleRunInput,'scope'|'moduleKind'|'params'|'versions'>;
const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
export const isMarketOverviewFlow=(request:{params:unknown})=>[MARKET_OVERVIEW_FLOW_VERSION,MARKET_OVERVIEW_EXPLAINED_FLOW_VERSION,MARKET_OVERVIEW_EXPANDED_FLOW_VERSION,MARKET_OVERVIEW_COMPLETE_FLOW_VERSION,MARKET_OVERVIEW_SYNTHESIS_FLOW_VERSION,MARKET_OVERVIEW_RULES_FLOW_VERSION,MARKET_OVERVIEW_PRODUCT_RULES_FLOW_VERSION,MARKET_OVERVIEW_DEMAND_RULES_FLOW_VERSION].includes(String(obj(request.params).flow));
export function marketOverviewFlowInitialSteps(request:Request):MarketStepDefinition[]{
  const p=MarketOverviewFlowParamsSchema.parse(request.params),scope=MarketAnalysisScopeSchema.parse(request.scope);
  const productRows=p.flow===MARKET_OVERVIEW_PRODUCT_RULES_FLOW_VERSION||p.flow===MARKET_OVERVIEW_DEMAND_RULES_FLOW_VERSION,complete=productRows||p.flow===MARKET_OVERVIEW_COMPLETE_FLOW_VERSION||p.flow===MARKET_OVERVIEW_SYNTHESIS_FLOW_VERSION||p.flow===MARKET_OVERVIEW_RULES_FLOW_VERSION,expanded=complete||p.flow===MARKET_OVERVIEW_EXPANDED_FLOW_VERSION,validRule=expanded?request.versions.rule===(productRows?MARKET_OVERVIEW_PRODUCT_CATALOG_VERSION:complete?MARKET_OVERVIEW_TABLE_CATALOG_VERSION:MARKET_OVERVIEW_EXPANDED_CATALOG_VERSION):request.versions.rule!==MARKET_OVERVIEW_EXPANDED_CATALOG_VERSION&&MarketOverviewCatalogVersionSchema.safeParse(request.versions.rule).success;
  if(request.moduleKind!=='overview'||request.versions.source!==MARKET_SOURCE_HANDLER_VERSION||!validRule||request.versions.mapping!==request.versions.rule||request.versions.planner!==p.flow)throw new TypeError('Overview flow versions differ');
  const definitions:MarketStepDefinition[]=[];
  for(let month=scope.fromMonth;month<=scope.toMonth;){
    for(const operation of productRows?MARKET_OVERVIEW_ALL_OPERATIONS_V2:expanded?MARKET_OVERVIEW_ALL_OPERATIONS:['market_research','market_research_statistics']){
      // Listing-level rows are displayed for the latest complete month only.
      if(operation==='market_product_concentration'&&month!==scope.toMonth)continue;
      definitions.push({stepKey:`overview-source/${month}/${operation}`,kind:'collect-overview-month',subject:{flow:p.flow},input:{month,operation,headTopN:p.headTopN,newProductMonths:p.newProductMonths},inputRefs:[]});
    }
    if(definitions.length>2000)throw new TypeError('Overview period exceeds the native step budget');
    const [y,m]=month.split('-').map(Number);month=`${m===12?y+1:y}-${String(m===12?1:m+1).padStart(2,'0')}`;
  }
  return definitions.sort((a,b)=>a.stepKey.localeCompare(b.stepKey));
}
/** Versioned source barrier. Numeric artifacts are durable before model work;
 * their completion alone must never mark the whole overview run successful. */
export function inspectMarketOverviewContinuation(view:MarketModuleRunView,now:string):{children:MarketStepDefinition[];currentStepKeys:string[]}{
  const currentStepKeys:string[]=[],pending:MarketStepDefinition[]=[];const result=(children:MarketStepDefinition[]=[])=>({children:[...pending,...children],currentStepKeys});
  const report=(input:MarketOverviewReportInput)=>{const definition=marketOverviewReportDefinition(view,input),saved=view.steps.find(s=>s.stepKey===definition.stepKey);
    currentStepKeys.push(definition.stepKey);if(!saved)pending.push(definition);else if(saved.inputHash!==digest(definition))throw new TypeError('Overview report definition differs');return saved;};
  if(!isMarketOverviewFlow(view.run)||view.run.status==='cancelled')return result();z.string().datetime().parse(now);
  const expected=marketOverviewFlowInitialSteps(view.run);
  const sources=expected.map(definition=>{
    const matches=view.steps.filter(s=>s.stepKey===definition.stepKey);if(matches.length!==1||matches[0].inputHash!==digest(definition))throw new TypeError('Overview source definition differs from its frozen parameters');
    currentStepKeys.push(definition.stepKey);return matches[0];
  });
  if(sources.some(s=>!['succeeded','empty','failed'].includes(s.status)))return result();
  const attempts=sources.map(s=>{
    const a=view.attempts.find(a=>a.id===s.latestAttemptId&&a.stepId===s.id);
    if(!a||(a.status!==s.status&&!(s.status==='failed'&&a.status==='interrupted')))throw new TypeError('Overview source attempt differs');
    return a;
  });
  const sourceAttemptIds=attempts.map(a=>a.id),stepKey=`overview-catalog/${digest(sourceAttemptIds)}`;currentStepKeys.push(stepKey);
  const catalogStep=view.steps.find(s=>s.stepKey===stepKey),flow=MarketOverviewFlowParamsSchema.parse(view.run.params).flow;
  if(!catalogStep)return result([{stepKey,kind:'rules',subject:{flow},input:{task:'overview-source-catalog',sourceAttemptIds,dataCutoffAt:now},inputRefs:attempts.filter(a=>a.status==='succeeded'||a.status==='empty').map(a=>({kind:'step-output',id:a.id}))}]);
  if(flow===MARKET_OVERVIEW_FLOW_VERSION||!['succeeded','empty'].includes(catalogStep.status))return result();
  const catalog=view.attempts.find(a=>a.id===catalogStep.latestAttemptId&&a.stepId===catalogStep.id);if(!catalog||catalog.status!==catalogStep.status)throw new TypeError('Overview catalog attempt differs');
  const catalogOutput=obj(catalog.output),inputId=z.string().regex(/^market-input:[a-f0-9]{64}$/),numericId=inputId.parse(catalogOutput.numericInputSnapshotId);
  const reportBase={task:'overview-report' as const,catalogAttemptId:catalog.id,numericInputSnapshotId:numericId};
  report({...reportBase,phase:'numeric',windowAttemptId:null,preparationAttemptIds:[],modelAttemptIds:[]});
  if(flow===MARKET_OVERVIEW_DEMAND_RULES_FLOW_VERSION){
    const definition=overviewIndustryDemandDefinition(view,catalog.id),saved=view.steps.find(s=>s.stepKey===definition.stepKey);currentStepKeys.push(definition.stepKey);
    if(!saved)return result([definition]);if(saved.inputHash!==digest(definition))throw new TypeError('Demand definition differs');
    if(['succeeded','empty','failed'].includes(saved.status)){const attempt=view.attempts.find(a=>a.id===saved.latestAttemptId&&a.stepId===saved.id);if(!attempt||!(attempt.status===saved.status||saved.status==='failed'&&attempt.status==='interrupted'))throw new TypeError('Demand attempt differs');report({...reportBase,phase:'numeric',windowAttemptId:null,preparationAttemptIds:[],modelAttemptIds:[],industryDemandAttemptId:attempt.id});}
    if(!['succeeded','empty','failed'].includes(saved.status)){const previous=[...view.attempts].reverse().find(a=>a.stepId===saved.id&&['succeeded','empty','failed','interrupted'].includes(a.status));if(previous)report({...reportBase,phase:'numeric',windowAttemptId:null,preparationAttemptIds:[],modelAttemptIds:[],industryDemandAttemptId:previous.id});}
    return result();
  }
  if(flow===MARKET_OVERVIEW_RULES_FLOW_VERSION||flow===MARKET_OVERVIEW_PRODUCT_RULES_FLOW_VERSION||catalogOutput.semanticInputSnapshotId===null)return result();
  const semanticId=inputId.parse(catalogOutput.semanticInputSnapshotId);
  const windowKey=`overview-windows/${catalog.id}`;currentStepKeys.push(windowKey);const windowStep=view.steps.find(s=>s.stepKey===windowKey);
  if(!windowStep)return result([{stepKey:windowKey,kind:'prepare-members',subject:{flow},input:{phase:'overview-semantic-windows',catalogAttemptId:catalog.id},
    inputRefs:[{kind:'step-output',id:catalog.id},{kind:'input',id:semanticId},{kind:'input',id:numericId}]}]);
  if(!['succeeded','empty','failed'].includes(windowStep.status))return result();
  const windowAttempt=view.attempts.find(a=>a.id===windowStep.latestAttemptId&&a.stepId===windowStep.id);if(!windowAttempt||(windowAttempt.status!==windowStep.status&&!(windowStep.status==='failed'&&windowAttempt.status==='interrupted')))throw new TypeError('Overview window attempt differs');
  if(windowStep.status==='failed'){report({...reportBase,phase:'window-results',windowAttemptId:windowAttempt.id,preparationAttemptIds:[],modelAttemptIds:[]});return result();}
  const plan=MarketOverviewWindowPlanSchema.parse(windowAttempt.output);
  if(plan.catalogAttemptId!==catalog.id||plan.basisSnapshotId!==semanticId||plan.numericInputSnapshotId!==numericId||plan.dataCutoffAt!==catalogOutput.dataCutoffAt||plan.configurationVersion!==view.run.versions.configuration)throw new TypeError('Overview window plan differs from catalog');
  const preparationAttemptIds:string[]=[],modelAttemptIds:string[]=[];let terminal=true;
  for(const definition of marketOverviewWindowPreparations(plan)){
    const preparation=view.steps.find(s=>s.stepKey===definition.stepKey);if(!preparation||preparation.inputHash!==digest(definition))throw new TypeError('Overview window preparation is missing or conflicting');currentStepKeys.push(preparation.stepKey);
    if(!['succeeded','empty','failed'].includes(preparation.status)){terminal=false;continue;}
    const a=view.attempts.find(a=>a.id===preparation.latestAttemptId&&a.stepId===preparation.id);if(!a||(a.status!==preparation.status&&!(preparation.status==='failed'&&a.status==='interrupted')))throw new TypeError('Overview preparation attempt differs');
    preparationAttemptIds.push(a.id);if(preparation.status==='failed')continue;
    const batches=z.array(z.object({bindingId:z.string().uuid(),inputDigest:z.string().regex(/^[a-f0-9]{64}$/)})).max(2000).parse(obj(a.output).batches);
    if(new Set(batches.map(b=>b.bindingId)).size!==batches.length)throw new TypeError('Duplicate overview model binding');
    for(const b of batches){const matches=view.steps.filter(s=>s.kind==='model-batch'&&obj(s.input).bindingId===b.bindingId&&obj(s.input).inputDigest===b.inputDigest);
      if(matches.length!==1)throw new TypeError('Overview model step is missing or ambiguous');const model=matches[0];currentStepKeys.push(model.stepKey);
      if(!['succeeded','empty','failed'].includes(model.status)){terminal=false;continue;}
      const attempt=view.attempts.find(a=>a.id===model.latestAttemptId&&a.stepId===model.id);if(!attempt||(attempt.status!==model.status&&!(model.status==='failed'&&attempt.status==='interrupted')))throw new TypeError('Overview model attempt differs');modelAttemptIds.push(attempt.id);}
  }
  if(terminal){const saved=report({...reportBase,phase:'window-results',windowAttemptId:windowAttempt.id,preparationAttemptIds,modelAttemptIds});
    if(flow===MARKET_OVERVIEW_SYNTHESIS_FLOW_VERSION&&saved&&saved.status==='succeeded'){
      const attempt=view.attempts.find(a=>a.id===saved.latestAttemptId&&a.stepId===saved.id);if(!attempt||attempt.status!=='succeeded')throw new TypeError('Overview window report attempt differs');
      const synthesis=inspectMarketOverviewSynthesisContinuation(view,attempt);currentStepKeys.push(...synthesis.currentStepKeys);pending.push(...synthesis.children);
    }
  }
  return result();
}

export function overviewIndustryDemandDefinition(view:MarketModuleRunView,catalogAttemptId:string):MarketStepDefinition{
 if(view.run.moduleKind!=='overview'||obj(view.run.params).flow!==MARKET_OVERVIEW_DEMAND_RULES_FLOW_VERSION)throw new TypeError('Demand requires its own overview flow');
 const attempt=view.attempts.find(a=>a.id===catalogAttemptId),step=view.steps.find(s=>s.id===attempt?.stepId);if(!attempt||!step||step.kind!=='rules'||obj(step.input).task!=='overview-source-catalog'||!['succeeded','empty'].includes(attempt.status))throw new TypeError('Demand requires saved overview catalog');
 return {stepKey:`overview-industry-demand/${catalogAttemptId}`,kind:'collect-overview-month',subject:{flow:MARKET_OVERVIEW_DEMAND_RULES_FLOW_VERSION},input:{phase:'overview-industry-demand',catalogAttemptId},inputRefs:[{kind:'step-output',id:catalogAttemptId}]};
}
