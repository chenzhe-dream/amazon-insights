import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { MarketShapeStructureExplanationInputSchema, MarketShapeStructureExplanationOutputSchema, MarketSemanticRecordSchema } from '../../shared/market-semantic-contracts';
import { marketSemanticContracts,marketSemanticSchemaDefinitions,marketSemanticTaskDefinitions,validateMarketSemanticTaskDefinitions } from '../../server/skills/market-semantic-task-definitions';
import { SkillRegistry } from '../../server/skills/registry';
import { createStructuredResponseFormat } from '../../server/runtime/structured-response-format';
import { canonicalJsonSha256 } from '../../server/runtime/model-request-accounting';

test('fifth native task registers its isolated window contract and governed limits',async()=>{
 const task=marketSemanticTaskDefinitions.find(item=>item.id==='market-shape-structure-explanation');
 assert.deepEqual(task,{id:'market-shape-structure-explanation',skill:{id:'market-explain-shape-structure',version:'1.0.0'},inputSchema:'MarketShapeStructureExplanationInput@1.0.0',outputSchema:'MarketShapeStructureExplanationOutput@1.0.0',budget:{maxInputTokens:12000,maxOutputTokens:4000,timeoutMs:60000},batchTimeoutMs:250000,stageTimeoutMs:2700000});
 const registry=await SkillRegistry.open(path.resolve('skills-src'));
 assert.equal((await validateMarketSemanticTaskDefinitions(marketSemanticTaskDefinitions,registry)).length,6);
 const loaded=await registry.load(task!.skill.id,task!.skill.version);
 assert.equal(loaded.manifest.inputSchema,task!.inputSchema);assert.equal(loaded.manifest.outputSchema,task!.outputSchema);
 assert.match(loaded.instructions,/当前窗|current window/i);assert.match(loaded.instructions,/综合|synthesis/i);
});

test('shape explanation fixture validates without embedding a complete catalog or audit paths',async()=>{
 const fixture=JSON.parse(await readFile('skills-src/market-explain-shape-structure/fixtures/market-explain-shape-structure-synthetic-v1.json','utf8'));
 const input=MarketShapeStructureExplanationInputSchema.parse(fixture.input),output=MarketShapeStructureExplanationOutputSchema.parse(fixture.output);
 const {inputDigest,...body}=input;assert.equal(inputDigest,canonicalJsonSha256(body));assert.equal(output.fragment.windowId,input.window.windowId);
 assert.equal(MarketSemanticRecordSchema.safeParse({task:input.task,window:input.window,sourceRefs:input.sourceRefs}).success,true);
 assert.equal('rows' in input,false);assert.doesNotMatch(JSON.stringify(input),/\.cells\[|analysis\./);
 const format=createStructuredResponseFormat(marketSemanticContracts[input.task].output,'shape-fragment/v1',marketSemanticSchemaDefinitions[input.task]);
 assert.equal(format.format.strict,true);assert.ok(JSON.stringify(format.format.schema).length<JSON.stringify(createStructuredResponseFormat(marketSemanticContracts[input.task].output,'expanded/v1').format.schema).length);
});
