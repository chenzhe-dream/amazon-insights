import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {loadVocPositioningRuntimeConfig} from '../../server/config';
import {SkillRegistry} from '../../server/skills/registry';
import * as definitions from '../../server/skills/market-semantic-task-definitions';
import * as runtime from '../../server/runtime/market-model-runtime';
import {MarketKeywordStartRequestSchema} from '../../shared/market-keyword-flow-contracts';

const base=()=>loadVocPositioningRuntimeConfig({OPENAI_API_KEY:'synthetic-secret',AGENT_VOC_MODEL:'synthetic-model',AGENT_VOC_ESTIMATED_INPUT_TOKENS:'10000',AGENT_VOC_MAX_OUTPUT_TOKENS:'4000',AGENT_VOC_TIMEOUT_MS:'90000',AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS:'1',AGENT_VOC_OUTPUT_USD_PER_MILLION_TOKENS:'2',AGENT_VOC_CALL_MAX_TOKENS:'100000',AGENT_VOC_CALL_MAX_COST_MICROS:'1000000',AGENT_VOC_RUN_MAX_TOKENS:'100000',AGENT_VOC_RUN_MAX_COST_MICROS:'1000000',AGENT_VOC_DAILY_MAX_TOKENS:'100000',AGENT_VOC_DAILY_MAX_COST_MICROS:'1000000',AGENT_VOC_WORKER_OWNER_ID:'synthetic-worker'});
test('discovery selects immutable instructions and strict output without widening legacy requests',async()=>{
 const fixture=JSON.parse(await readFile('skills-src/market-classify-keyword-demand/fixtures/market-classify-keyword-demand-synthetic-v1.json','utf8'));
 const old=fixture.input,discovery={...old,discoveryMode:'labels-and-clusters/v1'};
 const legacyDefinition=definitions.marketSemanticExecutionDefinition(old),next=definitions.marketSemanticExecutionDefinition(discovery);
 assert.equal(legacyDefinition.skill.version,'1.0.0');assert.equal(next.skill.version,'1.1.0');
 const registry=await SkillRegistry.open('skills-src'),skill=await registry.load(next.skill.id,next.skill.version);
 assert.equal(skill.manifest.inputSchema,next.inputSchema);assert.equal(skill.manifest.outputSchema,next.outputSchema);
 const legacyShape=definitions.marketSemanticOutputContract(old).output as any,newShape=definitions.marketSemanticOutputContract(discovery).output as any;
 assert.equal(legacyShape.shape.labelProposals,undefined);assert.ok(newShape.shape.labelProposals);assert.equal(newShape.shape.labelProposals.safeParse(undefined).success,false);
 const request=MarketKeywordStartRequestSchema.parse({plannedPages:[{seed:'floor lamp',page:1}],maxMembers:50,catalog:{task:old.task,dictionaryVersion:old.dictionaryVersion,categoryContext:old.categoryContext,dimensionLabels:old.dimensionLabels,clusterCatalog:old.clusterCatalog,discoveryMode:'labels-and-clusters/v1'}});
 assert.equal(request.catalog.discoveryMode,'labels-and-clusters/v1');
});
test('keyword discovery identity changes with its own prompt and budgets',async()=>{
 const registry=await SkillRegistry.open('skills-src'),manifest=(await registry.load('market-classify-keyword-demand','1.1.0')).manifest;
 const first=runtime.buildMarketKeywordDiscoveryIdentityVersions(base(),manifest);
 const changed=runtime.buildMarketKeywordDiscoveryIdentityVersions(base(),{...manifest,contentHash:'f'.repeat(64)});
 assert.notEqual(first.keywordDiscoveryConfigurationVersion,changed.keywordDiscoveryConfigurationVersion);
 assert.notEqual(first.keywordDiscoveryPromptVersion,changed.keywordDiscoveryPromptVersion);
 const original=base(),model={...original,model:{...original.model,name:'another-model'}};
 assert.notEqual(first.keywordDiscoveryConfigurationVersion,runtime.buildMarketKeywordDiscoveryIdentityVersions(model,manifest).keywordDiscoveryConfigurationVersion);
 assert.doesNotMatch(JSON.stringify(first),/synthetic-secret/);
});
