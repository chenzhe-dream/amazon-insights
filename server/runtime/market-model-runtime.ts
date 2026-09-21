import { marketTaskTimeout } from './market-model-config';
import type { ModelNetworkDiagnostic } from './model-network-diagnostics';
import { MARKET_SHAPE_SPAN_NORMALIZATION_VERSION } from '../domain/market-research/shape-span-normalization';
import {MARKET_SHAPE_SUGGESTION_BATCH_POLICY} from '../domain/market-research/semantic-batch-plan';
import {MARKET_SEMANTIC_DIAGNOSTICS_VERSION} from '../domain/market-research/semantic-validation-rules';
import type {ModelValidationFailureLog} from './skill-runner';
import {MarketOverviewSynthesisTransportInputSchema} from './market-semantic-wire';
import {MarketOverviewSynthesisModelInputSchema,MarketOverviewSynthesisModelDimensionOutputSchema,MarketOverviewSynthesisModelFinalOutputSchema,MarketOverviewSynthesisModelSchemaDefinitions} from './market-overview-synthesis-wire';
import {createMarketOverviewSynthesisRoundStep} from './market-overview-synthesis-round-step';
import {createMarketOverviewSynthesisReportStep} from './market-overview-synthesis-report-step';
import {buildMarketKeywordDiscoveryIdentityVersions,buildMarketKeywordReconciliationIdentityVersions,buildMarketKeywordExplicitIdentityVersions} from './market-keyword-model-identity';
export {buildMarketKeywordDiscoveryIdentityVersions} from './market-keyword-model-identity';
import {MarketKeywordSemanticsLegacyInputSchema,MarketKeywordSemanticsLegacyOutputSchema} from '../../shared/market-semantic-contracts';
import type {MarketModuleRun} from '../db/market-module-execution-repository';
import {MarketShapeSynthesisTransportInputSchema} from './market-semantic-wire';
import {createMarketShapeSynthesisRoundStep} from './market-shape-synthesis-round-step';
import {createMarketShapeExplanationReportStep} from './market-shape-explanation-report-step';
import {MarketOverviewMetricTableSchema} from './market-overview-metric-table';
import {z} from 'zod';
import { resolve } from 'node:path';
import type { VocPositioningRuntimeConfig } from '../config';
import { PostgresQueryContext } from '../db/postgres/query-context';
import { PostgresMarketModuleExecutionStore } from '../db/postgres/market-module-execution-store';
import { PostgresMarketAgentRunStore } from '../db/postgres/market-agent-run-store';
import { SkillRegistry } from '../skills/registry';
import { marketSemanticTaskDefinitions, validateMarketSemanticTaskDefinitions,marketSemanticContracts,marketSemanticSchemaDefinitions,marketOverviewOutputVariants,marketOverviewLegacySkill,marketKeywordDiscoverySkill,marketKeywordReconciliationSkill,marketKeywordExplicitDiscoverySkill,marketKeywordExplicitReconciliationSkill } from '../skills/market-semantic-task-definitions';
import {createStructuredResponseFormat} from './structured-response-format';
import {MARKET_BATCH_REPAIR_HEADROOM,MARKET_OVERVIEW_REPAIR_HEADROOM} from './market-semantic-batch-meter';
import type {MarketSemanticOutput} from '../../shared/market-semantic-contracts';
import type { MarketSemanticTaskName } from '../../shared/market-semantic-contracts';
import { MarketModelBatchWorker, type MarketModelWorkerOptions } from './market-model-batch-worker';
import { MarketSemanticExecutionService, type ResolvedMarketSemanticConfiguration } from './market-semantic-execution-service';
import { canonicalJsonSha256 } from './model-request-accounting';
import type { OpenAIProviderOptions } from './openai-provider';
import { MARKET_REQUEST_ESTIMATION_VERSION } from './market-request-admission';
import { StaticModelBudgetLimitProvider } from './model-budget-coordinator';
import { MarketModuleStepWorker, type MarketModuleStepWorkerOptions } from './market-module-step-worker';
import { MarketSemanticBatchPreparationService, MarketBatchPreparationInputSchema } from './market-semantic-batch-preparation';
import type { ConnectorMap } from '../connectors/connector-contract';
import { createMarketSourceStepHandlers } from './market-source-step-handlers';
import { createMarketSourceProjectionStep } from './market-source-projection-step';
import { createMarketKeywordPoolStep } from './market-keyword-pool-step';
import { createMarketThemeRulesStep } from './market-theme-rules-step';
import { createMarketThemeReportStep } from './market-theme-report-step';
import { createMarketThemeReconciliationStep } from './market-theme-reconciliation-step';
import {createMarketKeywordReconciliationStep} from './market-keyword-reconciliation-step';
import {MARKET_KEYWORD_FLOW_VERSION} from '../../shared/market-keyword-flow-contracts';
import { createMarketThemeReconciliationEvaluationStep } from './market-theme-reconciliation-evaluation-step';
import { MARKET_THEME_RECONCILED_FLOW_VERSION } from '../domain/market-research/customer-theme-flow';
import {createMarketOverviewCatalogStep} from './market-overview-catalog-step';
import {createMarketOverviewWindowsStep} from './market-overview-windows-step';
import {createMarketOverviewReportStep} from './market-overview-report-step';
import {createMarketShapeSelectionStep} from './market-shape-selection-step';
import {createMarketShapeExplanationWindowStep} from './market-shape-explanation-window-step';
import {MarketShapeSynthesisModelInputSchema,MarketShapeSynthesisModelDimensionOutputSchema,MarketShapeSynthesisModelFinalOutputSchema,MarketShapeSynthesisModelSchemaDefinitions} from './market-shape-synthesis-wire';

export interface MarketModelRuntime {
  readonly overviewSynthesisConfigurationVersion:string;
  readonly overviewSynthesisPromptVersion:string;
  readonly configurationVersion: string;
  readonly promptVersion: string;
  readonly shapeExplanationConfigurationVersion: string;
  readonly shapeExplanationPromptVersion: string;
  readonly keywordDiscoveryConfigurationVersion: string;
  readonly keywordDiscoveryPromptVersion: string;
  readonly keywordReconciliationConfigurationVersion: string;
  readonly keywordReconciliationPromptVersion: string;
  readonly keywordExplicitConfigurationVersion: string;
  readonly keywordExplicitPromptVersion: string;
  readonly modelAlias: 'market.semantic.text.v1';
  start(): void; stop(): Promise<void>; tick(): Promise<boolean>;
}
type RuntimeSkillManifest={id:string;version:string;contentHash:string};
export function buildLegacyMarketModelIdentityVersions(base:VocPositioningRuntimeConfig,taskManifests:ReadonlyMap<MarketSemanticTaskName,RuntimeSkillManifest>,overviewLegacyManifest:RuntimeSkillManifest){
  const shapeTasks=new Set<MarketSemanticTaskName>(['market-shape-structure-explanation','market-shape-synthesis','market-overview-synthesis']),legacyDefinitions=marketSemanticTaskDefinitions.filter(d=>!shapeTasks.has(d.id));
  const legacyManifests=[...legacyDefinitions.map(d=>taskManifests.get(d.id)!),overviewLegacyManifest];
  if(legacyManifests.some(value=>!value))throw new TypeError('Market model identity is missing a skill manifest');
  const limits=new StaticModelBudgetLimitProvider(base.budgetLimits).getLimits();
  const modelFor=(task:typeof marketSemanticTaskDefinitions[number])=>Object.freeze({name:base.model.name,estimatedInputTokens:task.budget.maxInputTokens,maxOutputTokens:Math.min(base.model.maxOutputTokens,task.budget.maxOutputTokens),timeoutMs:marketTaskTimeout(base,task),pricing:Object.freeze({...base.model.pricing})});
  const models=Object.fromEntries(marketSemanticTaskDefinitions.map(task=>[task.id,modelFor(task)])) as Record<MarketSemanticTaskName,VocPositioningRuntimeConfig['model']>;
  const promptVersion=`market-prompts:${canonicalJsonSha256(legacyManifests.map(m=>({id:m.id,version:m.version,contentHash:m.contentHash})))}`;
  const configurationVersion=`market-model-config:${canonicalJsonSha256({schemaVersion:1,provider:base.providerName,transport:base.transport,endpointHash:canonicalJsonSha256(base.baseUrl),limits,models:Object.fromEntries(legacyDefinitions.map(d=>[d.id,models[d.id]])),skills:legacyManifests.map(m=>({id:m.id,version:m.version,contentHash:m.contentHash})),estimation:MARKET_REQUEST_ESTIMATION_VERSION,validationDiagnostics:MARKET_SEMANTIC_DIAGNOSTICS_VERSION,preparation:{shapeSpanNormalization:MARKET_SHAPE_SPAN_NORMALIZATION_VERSION,shapeSuggestionBatching:MARKET_SHAPE_SUGGESTION_BATCH_POLICY,overviewSkillSelection:'table-1.2-legacy-1.1/v1',repairHeadroom:MARKET_BATCH_REPAIR_HEADROOM,overviewRepairHeadroom:MARKET_OVERVIEW_REPAIR_HEADROOM},inputSchemas:legacyDefinitions.map(d=>({task:d.id,digest:canonicalJsonSha256(JSON.parse(JSON.stringify(z.toJSONSchema(d.id==='market-keyword-semantics'?MarketKeywordSemanticsLegacyInputSchema:marketSemanticContracts[d.id].input))))})),overviewMetricTableInput:canonicalJsonSha256(JSON.parse(JSON.stringify(z.toJSONSchema(MarketOverviewMetricTableSchema)))),overviewOutputVariants:marketOverviewOutputVariants.map(v=>({name:v.name,digest:createStructuredResponseFormat<MarketSemanticOutput>(v.schema,'MarketOverviewExplanationOutput@1.1.0',v.definitions).digest})),wireSchemas:legacyDefinitions.map(d=>({task:d.id,digest:createStructuredResponseFormat<MarketSemanticOutput>(d.id==='market-keyword-semantics'?MarketKeywordSemanticsLegacyOutputSchema:marketSemanticContracts[d.id].output,d.outputSchema,marketSemanticSchemaDefinitions[d.id]).digest}))})}`;
  return Object.freeze({configurationVersion,promptVersion,limits,models});
}
export function buildMarketModelRuntimeIdentityVersions(base:VocPositioningRuntimeConfig,taskManifests:ReadonlyMap<MarketSemanticTaskName,RuntimeSkillManifest>,overviewLegacyManifest:RuntimeSkillManifest){
  const shapeTasks=['market-shape-structure-explanation','market-shape-synthesis'] as const,shapeDefinitions=shapeTasks.map(id=>marketSemanticTaskDefinitions.find(d=>d.id===id)!),shapeManifests=shapeTasks.map(id=>taskManifests.get(id)!);
  if(shapeManifests.some(value=>!value))throw new TypeError('Market model identity is missing a shape explanation skill manifest');
  const legacy=buildLegacyMarketModelIdentityVersions(base,taskManifests,overviewLegacyManifest),{configurationVersion,promptVersion,limits,models}=legacy;
  const shapeExplanationPromptVersion=`market-shape-explanation-prompt:${canonicalJsonSha256(shapeManifests.map(({id,version,contentHash})=>({id,version,contentHash})))}`;
  const synthesisTransportWire={encoding:'shape-synthesis-envelope/v2',envelopeInputSchema:canonicalJsonSha256(JSON.parse(JSON.stringify(z.toJSONSchema(MarketShapeSynthesisTransportInputSchema)))),inputSchema:canonicalJsonSha256(JSON.parse(JSON.stringify(z.toJSONSchema(MarketShapeSynthesisModelInputSchema)))),dimensionOutputSchema:createStructuredResponseFormat<unknown>(MarketShapeSynthesisModelDimensionOutputSchema,'MarketShapeSynthesisModelDimensionOutput@1.0.0',MarketShapeSynthesisModelSchemaDefinitions).digest,finalOutputSchema:createStructuredResponseFormat<unknown>(MarketShapeSynthesisModelFinalOutputSchema,'MarketShapeSynthesisModelFinalOutput@1.0.0',MarketShapeSynthesisModelSchemaDefinitions).digest};
  const shapeExplanationConfigurationVersion=`market-shape-explanation-config:${canonicalJsonSha256({schemaVersion:3,orchestration:'shape-synthesis-automatic/v1',windowManifest:'shape-explanation-windows/v2',provider:base.providerName,transport:base.transport,endpointHash:canonicalJsonSha256(base.baseUrl),tasks:Object.fromEntries(shapeTasks.map((id,index)=>[id,{model:models[id],skill:shapeManifests[index],inputSchema:canonicalJsonSha256(JSON.parse(JSON.stringify(z.toJSONSchema(marketSemanticContracts[id].input)))),wireSchema:createStructuredResponseFormat<MarketSemanticOutput>(marketSemanticContracts[id].output,shapeDefinitions[index].outputSchema,marketSemanticSchemaDefinitions[id]).digest,...(id==='market-shape-synthesis'?{transportWire:synthesisTransportWire}:{}),budget:shapeDefinitions[index].budget,batchTimeoutMs:shapeDefinitions[index].batchTimeoutMs,stageTimeoutMs:shapeDefinitions[index].stageTimeoutMs}])),estimation:MARKET_REQUEST_ESTIMATION_VERSION,validationDiagnostics:MARKET_SEMANTIC_DIAGNOSTICS_VERSION,budgetPolicy:{limits,repairHeadroom:MARKET_BATCH_REPAIR_HEADROOM}})}`;
  const overviewTask=marketSemanticTaskDefinitions.find(d=>d.id==='market-overview-synthesis')!,overviewManifest=taskManifests.get(overviewTask.id);
  if(!overviewManifest)throw new TypeError('Market model identity is missing an overview synthesis skill manifest');
  const overviewWire={encoding:'overview-synthesis-envelope/v1',envelopeInputSchema:canonicalJsonSha256(JSON.parse(JSON.stringify(z.toJSONSchema(MarketOverviewSynthesisTransportInputSchema)))),inputSchema:canonicalJsonSha256(JSON.parse(JSON.stringify(z.toJSONSchema(MarketOverviewSynthesisModelInputSchema)))),dimensionOutputSchema:createStructuredResponseFormat(MarketOverviewSynthesisModelDimensionOutputSchema,'MarketOverviewSynthesisModelDimensionOutput@1.0.0',MarketOverviewSynthesisModelSchemaDefinitions).digest,finalOutputSchema:createStructuredResponseFormat(MarketOverviewSynthesisModelFinalOutputSchema,'MarketOverviewSynthesisModelFinalOutput@1.0.0',MarketOverviewSynthesisModelSchemaDefinitions).digest};
  const overviewSynthesisPromptVersion=`market-overview-synthesis-prompt:${canonicalJsonSha256({legacyPromptVersion:promptVersion,skill:overviewManifest})}`;
  const overviewSynthesisConfigurationVersion=`market-overview-synthesis-config:${canonicalJsonSha256({schemaVersion:1,flow:'market-overview-flow/v5',legacyConfigurationVersion:configurationVersion,definition:overviewTask,skill:overviewManifest,model:models[overviewTask.id],transportWire:overviewWire,inputSchema:canonicalJsonSha256(JSON.parse(JSON.stringify(z.toJSONSchema(marketSemanticContracts[overviewTask.id].input)))),outputSchema:createStructuredResponseFormat(marketSemanticContracts[overviewTask.id].output,overviewTask.outputSchema,marketSemanticSchemaDefinitions[overviewTask.id]).digest})}`;
  return Object.freeze({configurationVersion,promptVersion,shapeExplanationConfigurationVersion,shapeExplanationPromptVersion,overviewSynthesisConfigurationVersion,overviewSynthesisPromptVersion,limits,models});
}
export async function createMarketModelRuntime(context: PostgresQueryContext, base: VocPositioningRuntimeConfig, options: {
  networkLogger?: (entry: ModelNetworkDiagnostic & { task: MarketSemanticTaskName }) => void;
  validationLogger?: (entry: Readonly<ModelValidationFailureLog & { task: MarketSemanticTaskName }>) => void;
  skillsRoot?: string; client?: OpenAIProviderOptions['client']; worker?: MarketModelWorkerOptions; stepWorker?: MarketModuleStepWorkerOptions;
  connectors?: Pick<ConnectorMap, 'sellerSprite' | 'sorftime'> & Partial<Pick<ConnectorMap,'sif'>>;
} = {}): Promise<MarketModelRuntime> {
  const registry = await SkillRegistry.open(resolve(options.skillsRoot ?? 'skills-src'));
  await validateMarketSemanticTaskDefinitions(marketSemanticTaskDefinitions, registry);
  const taskManifests=new Map<MarketSemanticTaskName,RuntimeSkillManifest>(await Promise.all(marketSemanticTaskDefinitions.map(async d=>[d.id,(await registry.load(d.skill.id,d.skill.version)).manifest] as const)));
  const overviewLegacyManifest=(await registry.load(marketOverviewLegacySkill.id,marketOverviewLegacySkill.version)).manifest;
  const {configurationVersion,promptVersion,shapeExplanationConfigurationVersion,shapeExplanationPromptVersion,overviewSynthesisConfigurationVersion,overviewSynthesisPromptVersion,limits,models}=buildMarketModelRuntimeIdentityVersions(base,taskManifests,overviewLegacyManifest);
  const discoveryManifest=(await registry.load(marketKeywordDiscoverySkill.id,marketKeywordDiscoverySkill.version)).manifest;
  const {keywordDiscoveryConfigurationVersion,keywordDiscoveryPromptVersion}=buildMarketKeywordDiscoveryIdentityVersions(base,discoveryManifest);
  const reconciliationManifest=(await registry.load(marketKeywordReconciliationSkill.id,marketKeywordReconciliationSkill.version)).manifest;
  const {keywordReconciliationConfigurationVersion,keywordReconciliationPromptVersion}=buildMarketKeywordReconciliationIdentityVersions(base,discoveryManifest,reconciliationManifest);
  const explicitDiscovery=(await registry.load(marketKeywordExplicitDiscoverySkill.id,marketKeywordExplicitDiscoverySkill.version)).manifest;
  const explicitReconciliation=(await registry.load(marketKeywordExplicitReconciliationSkill.id,marketKeywordExplicitReconciliationSkill.version)).manifest;
  const {keywordExplicitConfigurationVersion,keywordExplicitPromptVersion}=buildMarketKeywordExplicitIdentityVersions(base,discoveryManifest,reconciliationManifest,explicitDiscovery,explicitReconciliation);
  const configurations = new Map<MarketSemanticTaskName, ResolvedMarketSemanticConfiguration>(marketSemanticTaskDefinitions.map(task => [task.id,
    Object.freeze({ task: task.id, configurationVersion:task.id==='market-overview-synthesis'?overviewSynthesisConfigurationVersion:['market-shape-structure-explanation','market-shape-synthesis'].includes(task.id)?shapeExplanationConfigurationVersion:configurationVersion, providerName: base.providerName, transport: base.transport, model: models[task.id], limits,
      ...(options.validationLogger ? { validationLogger: (entry: Readonly<ModelValidationFailureLog>) => options.validationLogger!(Object.freeze({ ...entry, task: task.id })) } : {}),
      openAI: Object.freeze({ apiKey: base.apiKey, baseUrl: base.baseUrl, ...(options.networkLogger ? { networkLogger: (entry: ModelNetworkDiagnostic) => options.networkLogger!(Object.freeze({ ...entry, task: task.id })) } : {}), ...(options.client ? { client: options.client } : {}) }) })]));
  const overviewSynthesisLeafConfiguration=Object.freeze({...configurations.get('market-overview-explanation')!,configurationVersion:overviewSynthesisConfigurationVersion});
  const discoveryConfiguration=Object.freeze({...configurations.get('market-keyword-semantics')!,configurationVersion:keywordDiscoveryConfigurationVersion});
  const keywordReconciliationConfiguration=Object.freeze({...discoveryConfiguration,configurationVersion:keywordReconciliationConfigurationVersion});
  const keywordExplicitConfiguration=Object.freeze({...discoveryConfiguration,configurationVersion:keywordExplicitConfigurationVersion});
  const configurationFor=(task:MarketSemanticTaskName,run:MarketModuleRun)=>{
    const catalog=(run.params as {catalog?:{discoveryMode?:unknown}}).catalog;
    const selected=task==='market-overview-explanation'&&(run.params as {flow?:unknown}).flow==='market-overview-flow/v5'?overviewSynthesisLeafConfiguration:task==='market-keyword-semantics'&&(run.params as {analysisMode?:unknown}).analysisMode==='global-reconciliation/v2'?keywordExplicitConfiguration:task==='market-keyword-semantics'&&(run.params as {analysisMode?:unknown}).analysisMode==='global-reconciliation/v1'?keywordReconciliationConfiguration:task==='market-keyword-semantics'&&catalog?.discoveryMode==='labels-and-clusters/v1'?discoveryConfiguration:configurations.get(task)!;
    if(run.versions.configuration!==selected.configurationVersion)throw new Error('Market model configuration lineage is unavailable');
    return selected;
  };
  const steps = new PostgresMarketModuleExecutionStore(context);
  const pollMs = options.worker?.pollMs ?? 1000;
  const worker = new MarketModelBatchWorker({ ...options.worker, steps,
    audit: new PostgresMarketAgentRunStore(context), execution: new MarketSemanticExecutionService(context, registry),
    resolveConfiguration: ({ task, run }) => {
      return configurationFor(task,run);
    } });
  const preparation = new MarketSemanticBatchPreparationService(context, registry);
  const reconciliationPage=createMarketThemeReconciliationStep(context),reconciliationEvaluation=createMarketThemeReconciliationEvaluationStep(context);
  const keywordReconciliation=createMarketKeywordReconciliationStep(context);
  const overviewCatalog=createMarketOverviewCatalogStep(context),themeRules=createMarketThemeRulesStep(context);
  const sourceProjection=createMarketSourceProjectionStep(context),overviewWindows=createMarketOverviewWindowsStep(context,{registry,configuration:configurations.get('market-overview-explanation')!});
  const overviewSynthesisWindows=createMarketOverviewWindowsStep(context,{registry,configuration:overviewSynthesisLeafConfiguration});
  const overviewSynthesisRound=createMarketOverviewSynthesisRoundStep(context,{registry,configuration:configurations.get('market-overview-synthesis')!});
  const overviewSynthesisReport=createMarketOverviewSynthesisReportStep(context);
  const shapeSelection=createMarketShapeSelectionStep(context);
  const shapeExplanationWindows=createMarketShapeExplanationWindowStep(context,{registry,configuration:configurations.get('market-shape-structure-explanation')!});
  const shapeSynthesisRound=createMarketShapeSynthesisRoundStep(context,{registry,configuration:configurations.get('market-shape-synthesis')!});
  const shapeExplanationReport=createMarketShapeExplanationReportStep(context);
  const overviewReport=createMarketOverviewReportStep(context),themeReport=createMarketThemeReportStep(context);
  const stepWorker = new MarketModuleStepWorker({ ...options.stepWorker, steps, moduleKindsByStepKind: { rules: ['customer-themes','overview'], report: ['customer-themes','overview','shape-price'],reconcile:['customer-themes','keywords'] },
    flowVersionsByStepKind:{reconcile:[MARKET_THEME_RECONCILED_FLOW_VERSION,MARKET_KEYWORD_FLOW_VERSION]},handlers: {
    'prepare-members': input=>{
      const phase=(input.claim.step.input as {phase?:unknown})?.phase;
      if(phase==='select-shape-members')return shapeSelection(input);
      if(phase==='prepare-overview-synthesis')return overviewSynthesisRound(input);
      if(phase==='prepare-shape-synthesis')return shapeSynthesisRound(input);
      if(phase==='prepare-shape-explanation')return shapeExplanationWindows(input);
      if(phase==='overview-semantic-windows')return (async()=>{
        const view=await steps.findModuleRun({actor:{organizationId:input.claim.organizationId,userId:input.claim.createdBy},moduleRunId:input.claim.moduleRunId});
        if(!view)throw new Error('Market overview run is unavailable');
        return ((view.run.params as {flow?:unknown}).flow==='market-overview-flow/v5'?overviewSynthesisWindows:overviewWindows)(input);
      })();
      return sourceProjection(input);
    },
    'prepare-keyword-pool': createMarketKeywordPoolStep(context),
    'rules': input=>(input.claim.step.input as {task?:unknown})?.task==='overview-source-catalog'?overviewCatalog(input):themeRules(input),
    'report': input=>(input.claim.step.input as {phase?:unknown})?.phase==='overview-synthesis-report'?overviewSynthesisReport(input):(input.claim.step.input as {phase?:unknown})?.phase==='shape-explanation-report'?shapeExplanationReport(input):(input.claim.step.input as {task?:unknown})?.task==='overview-report'?overviewReport(input):themeReport(input),
    'reconcile': input=>{
      const task=(input.claim.step.input as {task?:unknown})?.task;
      if(task==='keyword-reconciliation-page'||task==='keyword-reconciliation-evaluate')return keywordReconciliation(input);
      if(task==='customer-theme-reconciliation-page')return reconciliationPage(input);
      if(task==='customer-theme-reconciliation-evaluate')return reconciliationEvaluation(input);
      throw new TypeError('Unsupported theme reconciliation task');
    },
    ...(options.connectors ? createMarketSourceStepHandlers({ context, connectors: options.connectors }) : {}),
    'prepare-model-batches': async ({ claim, signal }) => {
      const input = MarketBatchPreparationInputSchema.parse(claim.step.input);
      const view=await steps.findModuleRun({actor:{organizationId:claim.organizationId,userId:claim.createdBy},moduleRunId:claim.moduleRunId});
      if(!view)throw new Error('Market model run is unavailable');
      const plan = await preparation.planBatches(claim, configurationFor(input.task,view.run), signal);
      return { kind: 'atomic', commit: plan.commit };
    },
  } });
  // One runtime slot across both consumers. Preparation does not add another
  // concurrent model request or run a second background polling loop.
  let timer: ReturnType<typeof setInterval> | undefined, running: Promise<boolean> | undefined;
  let stopped = false, stopping: Promise<void> | undefined, preferSteps = false;
  const tick = (): Promise<boolean> => {
    if (running) return running; if (stopped) return Promise.resolve(false);
    running = (async () => {
      const order = preferSteps ? [stepWorker, worker] : [worker, stepWorker];
      for (const consumer of order) if (await consumer.tick()) { preferSteps = consumer === worker; return true; }
      return false;
    })().finally(() => { running = undefined; }); return running;
  };
  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    stopped = true; if (timer) clearInterval(timer); timer = undefined;
    stopping = (async () => {
      const results = await Promise.allSettled([worker.stop(), stepWorker.stop()]);
      if (results.some(r => r.status === 'rejected')) throw new Error('Market runtime did not stop cleanly');
    })(); return stopping;
  };
  return Object.freeze({ overviewSynthesisConfigurationVersion,overviewSynthesisPromptVersion,configurationVersion, promptVersion,shapeExplanationConfigurationVersion,shapeExplanationPromptVersion,keywordDiscoveryConfigurationVersion,keywordDiscoveryPromptVersion,keywordReconciliationConfigurationVersion,keywordReconciliationPromptVersion,keywordExplicitConfigurationVersion,keywordExplicitPromptVersion, modelAlias: 'market.semantic.text.v1', tick, stop, start: () => {
    if (stopped) throw new Error('A stopped market runtime cannot be restarted'); if (timer) return;
    const poll = () => { void tick().catch(() => { try { options.worker?.onEvent?.({ event: 'poll-failed' }); } catch { /* logs only */ } }); };
    timer = setInterval(poll, pollMs); timer.unref(); poll();
  } });
}
