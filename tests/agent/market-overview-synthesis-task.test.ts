import assert from 'node:assert/strict';
import test from 'node:test';
import {marketSemanticTaskDefinitions,validateMarketSemanticTaskDefinitions} from '../../server/skills/market-semantic-task-definitions';
import {SkillRegistry} from '../../server/skills/registry';

test('overview synthesis is a separate native task with exact bounded budgets and immutable skill',async()=>{
 const definition=marketSemanticTaskDefinitions.find(item=>(item.id as string)==='market-overview-synthesis');
 assert.deepEqual(definition,{id:'market-overview-synthesis',skill:{id:'market-synthesize-overview',version:'1.0.0'},inputSchema:'MarketOverviewSynthesisInput@1.0.0',outputSchema:'MarketOverviewSynthesisOutput@1.0.0',budget:{maxInputTokens:12000,maxOutputTokens:4000,timeoutMs:60000},batchTimeoutMs:250000,stageTimeoutMs:600000});
 const registry=await SkillRegistry.open('skills-src');
 assert.equal((await validateMarketSemanticTaskDefinitions(marketSemanticTaskDefinitions,registry)).length,7);
 const loaded=await registry.load('market-synthesize-overview','1.0.0');
 assert.match(loaded.instructions,/audited/);
});
