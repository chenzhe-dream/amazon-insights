import assert from 'node:assert/strict';
import test from 'node:test';
import {loadVocPositioningRuntimeConfig} from '../../server/config';
import {SkillRegistry} from '../../server/skills/registry';
import {buildMarketKeywordDiscoveryIdentityVersions,buildMarketKeywordReconciliationIdentityVersions,buildMarketKeywordExplicitIdentityVersions} from '../../server/runtime/market-keyword-model-identity';
import {MarketKeywordStartRequestSchema,MarketKeywordFlowParamsSchema,MARKET_KEYWORD_FLOW_VERSION} from '../../shared/market-keyword-flow-contracts';

const base=()=>loadVocPositioningRuntimeConfig({OPENAI_API_KEY:'synthetic-key',AGENT_VOC_MODEL:'synthetic-model',AGENT_VOC_ESTIMATED_INPUT_TOKENS:'10000',AGENT_VOC_MAX_OUTPUT_TOKENS:'4000',AGENT_VOC_TIMEOUT_MS:'90000',AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS:'1',AGENT_VOC_OUTPUT_USD_PER_MILLION_TOKENS:'2',AGENT_VOC_CALL_MAX_TOKENS:'100000',AGENT_VOC_CALL_MAX_COST_MICROS:'1000000',AGENT_VOC_RUN_MAX_TOKENS:'100000',AGENT_VOC_RUN_MAX_COST_MICROS:'1000000',AGENT_VOC_DAILY_MAX_TOKENS:'100000',AGENT_VOC_DAILY_MAX_COST_MICROS:'1000000',AGENT_VOC_WORKER_OWNER_ID:'synthetic-worker'});
test('v1 identities remain exactly equal to the committed native runtime while v2 pins both new immutable prompts',async()=>{
 const registry=await SkillRegistry.open('skills-src');const manifest=async(version:string)=>(await registry.load('market-classify-keyword-demand',version)).manifest;
 const [discovery,reconciliation,nextDiscovery,nextReconciliation]=await Promise.all(['1.1.0','1.2.0','1.3.0','1.4.0'].map(manifest));
 assert.deepEqual({...buildMarketKeywordDiscoveryIdentityVersions(base(),discovery),...buildMarketKeywordReconciliationIdentityVersions(base(),discovery,reconciliation)},
  {keywordDiscoveryConfigurationVersion:'market-keyword-discovery-config:fa9d4e1b2ba693442b9e32f6eaba5e45f70304e0cac0af95a884736463d329f1',keywordDiscoveryPromptVersion:'market-keyword-discovery-prompt:9c21f1ffeb66924a9abca77d2dc87f13f3b0aefb05157f840134ba3a1c1e6e9f',keywordReconciliationPromptVersion:'market-keyword-reconciliation-prompt:a69092652e54b81b8f5f69d1dfc967a90f7845b2b70c42c9e9038f49add17eee',keywordReconciliationConfigurationVersion:'market-keyword-reconciliation-config:bc77f0f06844a98df1b8068d1b6044c5669549d997eef53a45e62852a48a2b73'});
 const first=buildMarketKeywordExplicitIdentityVersions(base(),discovery,reconciliation,nextDiscovery,nextReconciliation);
 for(const index of [0,1]){const prompts=[nextDiscovery,nextReconciliation];prompts[index]={...prompts[index],contentHash:'f'.repeat(64)};
  const changed=buildMarketKeywordExplicitIdentityVersions(base(),discovery,reconciliation,prompts[0],prompts[1]);assert.notEqual(first.keywordExplicitConfigurationVersion,changed.keywordExplicitConfigurationVersion);assert.notEqual(first.keywordExplicitPromptVersion,changed.keywordExplicitPromptVersion);}
 assert.doesNotMatch(JSON.stringify(first),/synthetic-key/);
});
test('new protocol cannot be smuggled into old configuration identity or persisted without the v2 discovery mode',()=>{
 const catalog={task:'market-keyword-semantics',dictionaryVersion:'v1',categoryContext:'lighting',dimensionLabels:{W1:[],W2:[],W3:[],W4:[]},clusterCatalog:[],discoveryMode:'labels-and-clusters/v1'};
 const old={plannedPages:[{seed:'floor lamps',page:1}],maxMembers:20,catalog};
 assert.equal(MarketKeywordStartRequestSchema.safeParse(old).success,true);
 const valid={...old,analysisMode:'global-reconciliation/v2',catalog:{...catalog,outputProtocol:'explicit-shape/v1'}};
 assert.equal(MarketKeywordStartRequestSchema.safeParse(valid).success,true);assert.equal(MarketKeywordFlowParamsSchema.safeParse({...valid,flow:MARKET_KEYWORD_FLOW_VERSION}).success,true);
 for(const value of [{...valid,analysisMode:'global-reconciliation/v1'},{...valid,analysisMode:undefined},{...valid,catalog},{...valid,catalog:{...valid.catalog,discoveryMode:undefined}}]){
  assert.equal(MarketKeywordStartRequestSchema.safeParse(value).success,false);assert.equal(MarketKeywordFlowParamsSchema.safeParse({...value,flow:MARKET_KEYWORD_FLOW_VERSION}).success,false);
 }
});
