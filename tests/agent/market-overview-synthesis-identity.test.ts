import assert from 'node:assert/strict';
import test from 'node:test';
import {loadVocPositioningRuntimeConfig} from '../../server/config';
import {SkillRegistry} from '../../server/skills/registry';
import {marketOverviewLegacySkill,marketSemanticTaskDefinitions} from '../../server/skills/market-semantic-task-definitions';
import {buildLegacyMarketModelIdentityVersions,buildMarketModelRuntimeIdentityVersions} from '../../server/runtime/market-model-runtime';
import type {SkillManifest} from '../../server/skills/manifest';
import type {MarketSemanticTaskName} from '../../shared/market-semantic-contracts';
const env={OPENAI_API_KEY:'secret-not-hashed',AGENT_VOC_MODEL:'model-a',AGENT_VOC_ESTIMATED_INPUT_TOKENS:'10000',AGENT_VOC_MAX_OUTPUT_TOKENS:'4000',AGENT_VOC_TIMEOUT_MS:'90000',AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS:'1',AGENT_VOC_OUTPUT_USD_PER_MILLION_TOKENS:'2',AGENT_VOC_CALL_MAX_TOKENS:'100000',AGENT_VOC_CALL_MAX_COST_MICROS:'1000000',AGENT_VOC_RUN_MAX_TOKENS:'100000',AGENT_VOC_RUN_MAX_COST_MICROS:'1000000',AGENT_VOC_DAILY_MAX_TOKENS:'100000',AGENT_VOC_DAILY_MAX_COST_MICROS:'1000000',AGENT_VOC_WORKER_OWNER_ID:'worker'};

test('overview synthesis identity is isolated from legacy and shape identities under the current shared contracts',async()=>{
 const registry=await SkillRegistry.open('skills-src'),manifests=new Map<MarketSemanticTaskName,SkillManifest>(await Promise.all(marketSemanticTaskDefinitions.map(async d=>[d.id,(await registry.load(d.skill.id,d.skill.version)).manifest] as const)));
 const legacyManifest=(await registry.load(marketOverviewLegacySkill.id,marketOverviewLegacySkill.version)).manifest,base=loadVocPositioningRuntimeConfig(env);
 const initial=buildMarketModelRuntimeIdentityVersions(base,manifests,legacyManifest);
 // Shared marketplace/currency schemas legitimately change configuration hashes.
 // This regression owns synthesis isolation, not the old US-only schema golden.
 const prior=new Map(manifests);prior.delete('market-overview-synthesis');
 const old=buildLegacyMarketModelIdentityVersions(base,prior,legacyManifest);
 assert.equal(initial.configurationVersion,old.configurationVersion);
 assert.equal(initial.promptVersion,old.promptVersion);
 const changed=new Map(manifests);changed.set('market-overview-synthesis',{...changed.get('market-overview-synthesis')!,contentHash:'f'.repeat(64)});
 const drift=buildMarketModelRuntimeIdentityVersions(base,changed,legacyManifest);
 for(const key of ['configurationVersion','promptVersion','shapeExplanationConfigurationVersion','shapeExplanationPromptVersion'] as const)assert.equal(drift[key],initial[key]);
 assert.notEqual(drift.overviewSynthesisConfigurationVersion,initial.overviewSynthesisConfigurationVersion);
 assert.notEqual(drift.overviewSynthesisPromptVersion,initial.overviewSynthesisPromptVersion);
 const changedLeaf=new Map(manifests);changedLeaf.set('market-overview-explanation',{...changedLeaf.get('market-overview-explanation')!,contentHash:'e'.repeat(64)});
 const leafDrift=buildMarketModelRuntimeIdentityVersions(base,changedLeaf,legacyManifest);
 assert.notEqual(leafDrift.overviewSynthesisConfigurationVersion,initial.overviewSynthesisConfigurationVersion);
 assert.notEqual(leafDrift.overviewSynthesisPromptVersion,initial.overviewSynthesisPromptVersion);
 const modelDrift=buildMarketModelRuntimeIdentityVersions({...base,model:{...base.model,name:'model-b'}},manifests,legacyManifest);
 assert.notEqual(modelDrift.overviewSynthesisConfigurationVersion,initial.overviewSynthesisConfigurationVersion);
 assert.doesNotMatch(initial.overviewSynthesisConfigurationVersion,/secret-not-hashed/);
});
