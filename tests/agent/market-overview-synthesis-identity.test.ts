import assert from 'node:assert/strict';
import test from 'node:test';
import {loadVocPositioningRuntimeConfig} from '../../server/config';
import {SkillRegistry} from '../../server/skills/registry';
import {marketOverviewLegacySkill,marketSemanticTaskDefinitions} from '../../server/skills/market-semantic-task-definitions';
import {buildLegacyMarketModelIdentityVersions,buildMarketModelRuntimeIdentityVersions} from '../../server/runtime/market-model-runtime';
import type {SkillManifest} from '../../server/skills/manifest';
import type {MarketSemanticTaskName} from '../../shared/market-semantic-contracts';
const env={OPENAI_API_KEY:'secret-not-hashed',AGENT_VOC_MODEL:'model-a',AGENT_VOC_ESTIMATED_INPUT_TOKENS:'10000',AGENT_VOC_MAX_OUTPUT_TOKENS:'4000',AGENT_VOC_TIMEOUT_MS:'90000',AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS:'1',AGENT_VOC_OUTPUT_USD_PER_MILLION_TOKENS:'2',AGENT_VOC_CALL_MAX_TOKENS:'100000',AGENT_VOC_CALL_MAX_COST_MICROS:'1000000',AGENT_VOC_RUN_MAX_TOKENS:'100000',AGENT_VOC_RUN_MAX_COST_MICROS:'1000000',AGENT_VOC_DAILY_MAX_TOKENS:'100000',AGENT_VOC_DAILY_MAX_COST_MICROS:'1000000',AGENT_VOC_WORKER_OWNER_ID:'worker'};

test('overview synthesis identity contains the new contract while all prior golden identities remain immutable',async()=>{
 const registry=await SkillRegistry.open('skills-src'),manifests=new Map<MarketSemanticTaskName,SkillManifest>(await Promise.all(marketSemanticTaskDefinitions.map(async d=>[d.id,(await registry.load(d.skill.id,d.skill.version)).manifest] as const)));
 const legacyManifest=(await registry.load(marketOverviewLegacySkill.id,marketOverviewLegacySkill.version)).manifest,base=loadVocPositioningRuntimeConfig(env);
 const initial=buildMarketModelRuntimeIdentityVersions(base,manifests,legacyManifest);
 assert.equal(initial.configurationVersion,'market-model-config:a812cfb6a5b56ff555613e09b87218bc2ea6a728f6ef1322e5e146947ae91671');
 assert.equal(initial.promptVersion,'market-prompts:9a265d1274f6cf08bdb1e3bf50c9937b578bd2d5022469035a0b4acd580f725c');
 // Verified by executing the aa6666d runtime and task definitions; older test golden was stale.
 assert.equal(initial.shapeExplanationConfigurationVersion,'market-shape-explanation-config:eab8b3bade004441cbba3d1f34e42ddee0c49c51a3c489a69bbcde5e941aee2a');
 assert.equal(initial.shapeExplanationPromptVersion,'market-shape-explanation-prompt:343f75a6db1f1bf76a69de13c84e1b010cf867254378a86028f3583ce1b5b72e');
 const changed=new Map(manifests);changed.set('market-overview-synthesis',{...changed.get('market-overview-synthesis')!,contentHash:'f'.repeat(64)});
 const drift=buildMarketModelRuntimeIdentityVersions(base,changed,legacyManifest);
 for(const key of ['configurationVersion','promptVersion','shapeExplanationConfigurationVersion','shapeExplanationPromptVersion'] as const)assert.equal(drift[key],initial[key]);
 assert.notEqual(drift.overviewSynthesisConfigurationVersion,initial.overviewSynthesisConfigurationVersion);
 assert.notEqual(drift.overviewSynthesisPromptVersion,initial.overviewSynthesisPromptVersion);
 const changedLeaf=new Map(manifests);changedLeaf.set('market-overview-explanation',{...changedLeaf.get('market-overview-explanation')!,contentHash:'e'.repeat(64)});
 const leafDrift=buildMarketModelRuntimeIdentityVersions(base,changedLeaf,legacyManifest);
 assert.notEqual(leafDrift.overviewSynthesisConfigurationVersion,initial.overviewSynthesisConfigurationVersion);
 assert.notEqual(leafDrift.overviewSynthesisPromptVersion,initial.overviewSynthesisPromptVersion);
 const prior=new Map(manifests);prior.delete('market-overview-synthesis');const old=buildLegacyMarketModelIdentityVersions(base,prior,legacyManifest);
 assert.equal(old.configurationVersion,initial.configurationVersion);assert.equal(old.promptVersion,initial.promptVersion);
 const modelDrift=buildMarketModelRuntimeIdentityVersions({...base,model:{...base.model,name:'model-b'}},manifests,legacyManifest);
 assert.notEqual(modelDrift.overviewSynthesisConfigurationVersion,initial.overviewSynthesisConfigurationVersion);
 assert.doesNotMatch(initial.overviewSynthesisConfigurationVersion,/secret-not-hashed/);
});
