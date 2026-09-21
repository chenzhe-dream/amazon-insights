import {MARKET_SEMANTIC_DIAGNOSTICS_VERSION} from '../domain/market-research/semantic-validation-rules';
import {z} from 'zod';
import type {VocPositioningRuntimeConfig} from '../config';
import {MarketKeywordSemanticsDiscoveryInputSchema as MarketKeywordSemanticsInputSchema,MarketKeywordSemanticsReconciliationInputSchema as MarketKeywordReconciliationInputSchema,MarketKeywordSemanticsInputSchema as MarketKeywordExplicitInputSchema,MarketKeywordSemanticsDiscoveryOutputSchema} from '../../shared/market-semantic-contracts';
import {marketSemanticTaskDefinitions,marketKeywordDiscoverySchemaDefinitions,marketKeywordDiscoverySkill,marketKeywordReconciliationSkill,marketKeywordReconciliationOutputSchema,marketKeywordExplicitDiscoverySkill,marketKeywordExplicitReconciliationSkill} from '../skills/market-semantic-task-definitions';
import {StaticModelBudgetLimitProvider} from './model-budget-coordinator';
import {MARKET_REQUEST_ESTIMATION_VERSION} from './market-request-admission';
import {MARKET_BATCH_REPAIR_HEADROOM} from './market-semantic-batch-meter';
import {createStructuredResponseFormat} from './structured-response-format';
import {canonicalJsonSha256 as digest} from './model-request-accounting';

/** A separately versioned discovery contract leaves the original four-task
 * configuration identity intact, so saved work can still execute and replay. */
export function buildMarketKeywordDiscoveryIdentityVersions(base:VocPositioningRuntimeConfig,manifest:{id:string;version:string;contentHash:string}){
 if(manifest.id!==marketKeywordDiscoverySkill.id||manifest.version!==marketKeywordDiscoverySkill.version)throw new TypeError('Keyword discovery skill identity mismatch');
 const definition=marketSemanticTaskDefinitions.find(d=>d.id==='market-keyword-semantics')!;
 const skill={id:manifest.id,version:manifest.version,contentHash:manifest.contentHash};
 const model={name:base.model.name,estimatedInputTokens:definition.budget.maxInputTokens,maxOutputTokens:Math.min(base.model.maxOutputTokens,definition.budget.maxOutputTokens),timeoutMs:Math.min(base.model.timeoutMs,definition.budget.timeoutMs),pricing:{...base.model.pricing}};
 const keywordDiscoveryPromptVersion=`market-keyword-discovery-prompt:${digest(skill)}`;
 const keywordDiscoveryConfigurationVersion=`market-keyword-discovery-config:${digest({schemaVersion:1,mode:'labels-and-clusters/v1',provider:base.providerName,transport:base.transport,endpointHash:digest(base.baseUrl),model,skill,limits:new StaticModelBudgetLimitProvider(base.budgetLimits).getLimits(),estimation:MARKET_REQUEST_ESTIMATION_VERSION,validationDiagnostics:MARKET_SEMANTIC_DIAGNOSTICS_VERSION,repairHeadroom:MARKET_BATCH_REPAIR_HEADROOM,budget:definition.budget,batchTimeoutMs:definition.batchTimeoutMs,stageTimeoutMs:definition.stageTimeoutMs,inputSchema:digest(JSON.parse(JSON.stringify(z.toJSONSchema(MarketKeywordSemanticsInputSchema)))),outputSchema:createStructuredResponseFormat<unknown>(MarketKeywordSemanticsDiscoveryOutputSchema,'MarketKeywordSemanticsOutput@1.1.0',marketKeywordDiscoverySchemaDefinitions).digest})}`;
 return Object.freeze({keywordDiscoveryConfigurationVersion,keywordDiscoveryPromptVersion});
}
export function buildMarketKeywordReconciliationIdentityVersions(base:VocPositioningRuntimeConfig,discoveryManifest:{id:string;version:string;contentHash:string},reconciliationManifest:{id:string;version:string;contentHash:string}){
 if(reconciliationManifest.id!==marketKeywordReconciliationSkill.id||reconciliationManifest.version!==marketKeywordReconciliationSkill.version)throw new TypeError('Keyword reconciliation skill identity mismatch');
 const discovery=buildMarketKeywordDiscoveryIdentityVersions(base,discoveryManifest);
 const skill={id:reconciliationManifest.id,version:reconciliationManifest.version,contentHash:reconciliationManifest.contentHash};
 return Object.freeze({
  keywordReconciliationPromptVersion:`market-keyword-reconciliation-prompt:${digest({discovery:discovery.keywordDiscoveryPromptVersion,skill})}`,
  keywordReconciliationConfigurationVersion:`market-keyword-reconciliation-config:${digest({schemaVersion:1,discovery:discovery.keywordDiscoveryConfigurationVersion,skill,planner:'market-keyword-reconciliation/v1',candidateWindow:4,memberWindow:20,inputSchema:digest(JSON.parse(JSON.stringify(z.toJSONSchema(MarketKeywordReconciliationInputSchema)))),outputSchema:createStructuredResponseFormat<unknown>(marketKeywordReconciliationOutputSchema,'MarketKeywordSemanticsOutput@1.2.0',marketKeywordDiscoverySchemaDefinitions).digest})}`,
 });
}
type Manifest={id:string;version:string;contentHash:string};
/** Output-shape guidance is a new prompt/configuration identity. Existing v1
 * jobs still resolve to their original frozen schema and immutable skills. */
export function buildMarketKeywordExplicitIdentityVersions(base:VocPositioningRuntimeConfig,discoveryManifest:Manifest,reconciliationManifest:Manifest,explicitDiscovery:Manifest,explicitReconciliation:Manifest){
 const expected=[marketKeywordExplicitDiscoverySkill,marketKeywordExplicitReconciliationSkill],manifests=[explicitDiscovery,explicitReconciliation];
 if(manifests.some((m,i)=>m.id!==expected[i].id||m.version!==expected[i].version))throw new TypeError('Explicit keyword skill identity mismatch');
 const parent=buildMarketKeywordReconciliationIdentityVersions(base,discoveryManifest,reconciliationManifest);
 const skills=manifests.map(({id,version,contentHash})=>({id,version,contentHash}));
 return Object.freeze({keywordExplicitPromptVersion:`market-keyword-explicit-prompt:${digest(skills)}`,
  keywordExplicitConfigurationVersion:`market-keyword-explicit-config:${digest({schemaVersion:1,flow:'global-reconciliation/v2',outputProtocol:'explicit-shape/v1',parent:parent.keywordReconciliationConfigurationVersion,skills,
   inputSchema:digest(JSON.parse(JSON.stringify(z.toJSONSchema(MarketKeywordExplicitInputSchema)))),
   discoveryOutput:createStructuredResponseFormat<unknown>(MarketKeywordSemanticsDiscoveryOutputSchema,'MarketKeywordSemanticsOutput@1.3.0',marketKeywordDiscoverySchemaDefinitions).digest,
   reconciliationOutput:createStructuredResponseFormat<unknown>(marketKeywordReconciliationOutputSchema,'MarketKeywordSemanticsOutput@1.4.0',marketKeywordDiscoverySchemaDefinitions).digest})}`});
}
