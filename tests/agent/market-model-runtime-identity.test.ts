import assert from 'node:assert/strict';
import test from 'node:test';
import {loadVocPositioningRuntimeConfig} from '../../server/config';
import {SkillRegistry} from '../../server/skills/registry';
import {marketOverviewLegacySkill,marketSemanticTaskDefinitions} from '../../server/skills/market-semantic-task-definitions';
import {buildLegacyMarketModelIdentityVersions,buildMarketModelRuntimeIdentityVersions} from '../../server/runtime/market-model-runtime';
import type {MarketSemanticTaskName} from '../../shared/market-semantic-contracts';

const env={OPENAI_API_KEY:'secret-not-hashed',AGENT_VOC_MODEL:'model-a',AGENT_VOC_ESTIMATED_INPUT_TOKENS:'10000',AGENT_VOC_MAX_OUTPUT_TOKENS:'4000',AGENT_VOC_TIMEOUT_MS:'90000',AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS:'1',AGENT_VOC_OUTPUT_USD_PER_MILLION_TOKENS:'2',AGENT_VOC_CALL_MAX_TOKENS:'100000',AGENT_VOC_CALL_MAX_COST_MICROS:'1000000',AGENT_VOC_RUN_MAX_TOKENS:'100000',AGENT_VOC_RUN_MAX_COST_MICROS:'1000000',AGENT_VOC_DAILY_MAX_TOKENS:'100000',AGENT_VOC_DAILY_MAX_COST_MICROS:'1000000',AGENT_VOC_WORKER_OWNER_ID:'worker'};

test('shape explanation identity is isolated while shared model policy changes both configurations',async()=>{
 const registry=await SkillRegistry.open('skills-src');
 const manifests=new Map<MarketSemanticTaskName,any>(await Promise.all(marketSemanticTaskDefinitions.map(async d=>[d.id,(await registry.load(d.skill.id,d.skill.version)).manifest] as const)));
 const legacy=(await registry.load(marketOverviewLegacySkill.id,marketOverviewLegacySkill.version)).manifest,base=loadVocPositioningRuntimeConfig(env);
 const initial=buildMarketModelRuntimeIdentityVersions(base,manifests,legacy);
 // Independently executed from the actual 0c7cc29 runtime algorithm with this
 // fixed synthetic configuration. Do not regenerate from the new helper.
 assert.equal(initial.configurationVersion,'market-model-config:a812cfb6a5b56ff555613e09b87218bc2ea6a728f6ef1322e5e146947ae91671');
 assert.equal(initial.promptVersion,'market-prompts:9a265d1274f6cf08bdb1e3bf50c9937b578bd2d5022469035a0b4acd580f725c');
 const beforeAddition=new Map(manifests);beforeAddition.delete('market-shape-structure-explanation');
 const oldIdentity=buildLegacyMarketModelIdentityVersions(base,beforeAddition,legacy);
 assert.equal(initial.configurationVersion,oldIdentity.configurationVersion);
 assert.equal(initial.promptVersion,oldIdentity.promptVersion);
 const changedShape=new Map(manifests);changedShape.set('market-shape-structure-explanation',{...changedShape.get('market-shape-structure-explanation'),contentHash:'f'.repeat(64)});
 const promptChanged=buildMarketModelRuntimeIdentityVersions(base,changedShape,legacy);
 assert.equal(promptChanged.configurationVersion,initial.configurationVersion);
 assert.equal(promptChanged.promptVersion,initial.promptVersion);
 assert.notEqual(promptChanged.shapeExplanationConfigurationVersion,initial.shapeExplanationConfigurationVersion);
 assert.notEqual(promptChanged.shapeExplanationPromptVersion,initial.shapeExplanationPromptVersion);
 const changedModel=buildMarketModelRuntimeIdentityVersions({...base,model:{...base.model,name:'model-b'}},manifests,legacy);
 assert.notEqual(changedModel.configurationVersion,initial.configurationVersion);
 assert.notEqual(changedModel.shapeExplanationConfigurationVersion,initial.shapeExplanationConfigurationVersion);
 assert.doesNotMatch(initial.configurationVersion,/secret-not-hashed/);
 assert.doesNotMatch(initial.shapeExplanationConfigurationVersion,/secret-not-hashed/);
});
