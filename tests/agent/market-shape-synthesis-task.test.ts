import type {SkillManifest} from '../../server/skills/manifest';
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {loadVocPositioningRuntimeConfig} from '../../server/config';
import {SkillRegistry} from '../../server/skills/registry';
import {validateSkillArchiveSource} from '../../server/skills/archive';
import {marketOverviewLegacySkill,marketSemanticContracts,marketSemanticSchemaDefinitions,marketSemanticTaskDefinitions,validateMarketSemanticTaskDefinitions} from '../../server/skills/market-semantic-task-definitions';
import {buildLegacyMarketModelIdentityVersions,buildMarketModelRuntimeIdentityVersions} from '../../server/runtime/market-model-runtime';
import {createStructuredResponseFormat} from '../../server/runtime/structured-response-format';
import {canonicalJsonSha256} from '../../server/runtime/model-request-accounting';
import {MarketSemanticRecordSchema,MarketShapeSynthesisInputSchema,MarketShapeSynthesisOutputSchema,type MarketSemanticTaskName,type MarketSemanticOutput} from '../../shared/market-semantic-contracts';
import {assertCurrentMarketScopeIdentityContracts} from './helpers/market-current-scope-identity';

const env={OPENAI_API_KEY:'secret-not-hashed',AGENT_VOC_MODEL:'model-a',AGENT_VOC_ESTIMATED_INPUT_TOKENS:'10000',AGENT_VOC_MAX_OUTPUT_TOKENS:'4000',AGENT_VOC_TIMEOUT_MS:'90000',AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS:'1',AGENT_VOC_OUTPUT_USD_PER_MILLION_TOKENS:'2',AGENT_VOC_CALL_MAX_TOKENS:'100000',AGENT_VOC_CALL_MAX_COST_MICROS:'1000000',AGENT_VOC_RUN_MAX_TOKENS:'100000',AGENT_VOC_RUN_MAX_COST_MICROS:'1000000',AGENT_VOC_DAILY_MAX_TOKENS:'100000',AGENT_VOC_DAILY_MAX_COST_MICROS:'1000000',AGENT_VOC_WORKER_OWNER_ID:'worker'};

test('sixth native semantic task registers canonical synthesis and governed skill',async()=>{
 const definition=marketSemanticTaskDefinitions.find(item=>item.id==='market-shape-synthesis');
 assert.deepEqual(definition,{id:'market-shape-synthesis',skill:{id:'market-synthesize-shape-structure',version:'1.0.0'},inputSchema:'MarketShapeSynthesisInput@1.0.0',outputSchema:'MarketShapeSynthesisOutput@1.0.0',budget:{maxInputTokens:12000,maxOutputTokens:4000,timeoutMs:60000},batchTimeoutMs:250000,stageTimeoutMs:2700000});
 const registry=await SkillRegistry.open('skills-src');assert.equal((await validateMarketSemanticTaskDefinitions(marketSemanticTaskDefinitions,registry)).length,7);
 const loaded=await registry.load(definition!.skill.id,definition!.skill.version);assert.match(loaded.instructions,/audited|已审计/i);assert.match(loaded.instructions,/source/i);
 await validateSkillArchiveSource('market-synthesize-shape-structure.zip','skills-src/market-synthesize-shape-structure','market-synthesize-shape-structure');
 const fixture=JSON.parse(await readFile('skills-src/market-synthesize-shape-structure/fixtures/market-synthesize-shape-structure-synthetic-v1.json','utf8'));
 const input=MarketShapeSynthesisInputSchema.parse(fixture.input),output=MarketShapeSynthesisOutputSchema.parse(fixture.output);const {inputDigest,...body}=input;assert.equal(inputDigest,canonicalJsonSha256(body));assert.equal(output.inputDigest,inputDigest);
 assert.equal(MarketSemanticRecordSchema.safeParse({task:input.task,synthesis:input.synthesis,sourceRefs:input.sourceRefs}).success,true);
 assert.equal(createStructuredResponseFormat<MarketSemanticOutput>(marketSemanticContracts[input.task].output,definition!.outputSchema,marketSemanticSchemaDefinitions[input.task]).format.strict,true);
});

test('legacy tasks remain isolated while shape tasks share drift identity under current multi-market contracts',async()=>{
 const registry=await SkillRegistry.open('skills-src'),manifests=new Map<MarketSemanticTaskName,SkillManifest>(await Promise.all(marketSemanticTaskDefinitions.map(async d=>[d.id,(await registry.load(d.skill.id,d.skill.version)).manifest] as const)));
 const legacyManifest=(await registry.load(marketOverviewLegacySkill.id,marketOverviewLegacySkill.version)).manifest,base=loadVocPositioningRuntimeConfig(env);
 const identity=buildMarketModelRuntimeIdentityVersions(base,manifests,legacyManifest),legacy=buildLegacyMarketModelIdentityVersions(base,manifests,legacyManifest);
 assertCurrentMarketScopeIdentityContracts();
 assert.equal(identity.configurationVersion,legacy.configurationVersion);assert.equal(identity.promptVersion,legacy.promptVersion);
 assert.equal(identity.shapeExplanationPromptVersion,'market-shape-explanation-prompt:343f75a6db1f1bf76a69de13c84e1b010cf867254378a86028f3583ce1b5b72e');
 assert.equal(legacy.promptVersion,'market-prompts:9a265d1274f6cf08bdb1e3bf50c9937b578bd2d5022469035a0b4acd580f725c');
 const changed=new Map(manifests),manifest=changed.get('market-shape-synthesis')!;changed.set('market-shape-synthesis',{...manifest,contentHash:'f'.repeat(64)});const drift=buildMarketModelRuntimeIdentityVersions(base,changed,legacyManifest);
 assert.equal(drift.configurationVersion,identity.configurationVersion);assert.equal(drift.promptVersion,identity.promptVersion);assert.notEqual(drift.shapeExplanationConfigurationVersion,identity.shapeExplanationConfigurationVersion);assert.notEqual(drift.shapeExplanationPromptVersion,identity.shapeExplanationPromptVersion);
});
