import type {SkillManifest} from '../../server/skills/manifest';
import assert from 'node:assert/strict';
import test from 'node:test';
import {loadVocPositioningRuntimeConfig} from '../../server/config';
import {SkillRegistry} from '../../server/skills/registry';
import {marketOverviewLegacySkill,marketSemanticTaskDefinitions} from '../../server/skills/market-semantic-task-definitions';
import {buildLegacyMarketModelIdentityVersions,buildMarketModelRuntimeIdentityVersions} from '../../server/runtime/market-model-runtime';
import type {MarketSemanticTaskName} from '../../shared/market-semantic-contracts';
import {assertCurrentMarketScopeIdentityContracts} from './helpers/market-current-scope-identity';

const env={OPENAI_API_KEY:'secret-not-hashed',AGENT_VOC_MODEL:'model-a',AGENT_VOC_ESTIMATED_INPUT_TOKENS:'10000',AGENT_VOC_MAX_OUTPUT_TOKENS:'4000',AGENT_VOC_TIMEOUT_MS:'90000',AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS:'1',AGENT_VOC_OUTPUT_USD_PER_MILLION_TOKENS:'2',AGENT_VOC_CALL_MAX_TOKENS:'100000',AGENT_VOC_CALL_MAX_COST_MICROS:'1000000',AGENT_VOC_RUN_MAX_TOKENS:'100000',AGENT_VOC_RUN_MAX_COST_MICROS:'1000000',AGENT_VOC_DAILY_MAX_TOKENS:'100000',AGENT_VOC_DAILY_MAX_COST_MICROS:'1000000',AGENT_VOC_WORKER_OWNER_ID:'worker'};

test('shape explanation identity is isolated while shared model policy changes both configurations',async()=>{
 const registry=await SkillRegistry.open('skills-src');
 const manifests=new Map<MarketSemanticTaskName,SkillManifest>(await Promise.all(marketSemanticTaskDefinitions.map(async d=>[d.id,(await registry.load(d.skill.id,d.skill.version)).manifest] as const)));
 const legacy=(await registry.load(marketOverviewLegacySkill.id,marketOverviewLegacySkill.version)).manifest,base=loadVocPositioningRuntimeConfig(env);
 const initial=buildMarketModelRuntimeIdentityVersions(base,manifests,legacy);
 // Captured immediately before shape-only single-product partitioning; the
 // previous configuration must never dispatch newly reinterpreted batches.
 assert.notEqual(initial.configurationVersion,'market-model-config:7c89df25afc9b22467e604970862ef4af3c2bdec2ce8c378172f5ccf3dacc93a');
 // Validate the deliberate shared US/USD -> multi-market contract change,
 // then characterize isolation rather than refreshing an opaque golden hash.
 assertCurrentMarketScopeIdentityContracts();
 assert.equal(initial.promptVersion,'market-prompts:9a265d1274f6cf08bdb1e3bf50c9937b578bd2d5022469035a0b4acd580f725c');
 const beforeAddition=new Map(manifests);beforeAddition.delete('market-shape-structure-explanation');
 const oldIdentity=buildLegacyMarketModelIdentityVersions(base,beforeAddition,legacy);
 assert.equal(initial.configurationVersion,oldIdentity.configurationVersion);
 assert.equal(initial.promptVersion,oldIdentity.promptVersion);
 const changedShape=new Map(manifests);changedShape.set('market-shape-structure-explanation',{...changedShape.get('market-shape-structure-explanation')!,contentHash:'f'.repeat(64)});
 const promptChanged=buildMarketModelRuntimeIdentityVersions(base,changedShape,legacy);
 assert.equal(promptChanged.configurationVersion,initial.configurationVersion);
 assert.equal(promptChanged.promptVersion,initial.promptVersion);
 assert.equal(promptChanged.overviewSynthesisConfigurationVersion,initial.overviewSynthesisConfigurationVersion);
 assert.equal(promptChanged.overviewSynthesisPromptVersion,initial.overviewSynthesisPromptVersion);
 assert.notEqual(promptChanged.shapeExplanationConfigurationVersion,initial.shapeExplanationConfigurationVersion);
 assert.notEqual(promptChanged.shapeExplanationPromptVersion,initial.shapeExplanationPromptVersion);
 const changedModel=buildMarketModelRuntimeIdentityVersions({...base,model:{...base.model,name:'model-b'}},manifests,legacy);
 assert.notEqual(changedModel.configurationVersion,initial.configurationVersion);
 assert.notEqual(changedModel.shapeExplanationConfigurationVersion,initial.shapeExplanationConfigurationVersion);
 const credentialRotation=buildMarketModelRuntimeIdentityVersions({...base,apiKey:'rotated-secret'},manifests,legacy);
 assert.equal(credentialRotation.configurationVersion,initial.configurationVersion);
 assert.equal(credentialRotation.shapeExplanationConfigurationVersion,initial.shapeExplanationConfigurationVersion);
 const changedLegacy=new Map(manifests);changedLegacy.set('market-keyword-semantics',{...changedLegacy.get('market-keyword-semantics')!,contentHash:'a'.repeat(64)});
 const legacyDrift=buildMarketModelRuntimeIdentityVersions(base,changedLegacy,legacy);
 assert.notEqual(legacyDrift.configurationVersion,initial.configurationVersion);
 assert.equal(legacyDrift.shapeExplanationConfigurationVersion,initial.shapeExplanationConfigurationVersion);
 assert.doesNotMatch(initial.configurationVersion,/secret-not-hashed/);
 assert.doesNotMatch(initial.shapeExplanationConfigurationVersion,/secret-not-hashed/);
});
