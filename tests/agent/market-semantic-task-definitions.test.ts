import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { marketSemanticExecutionDefinition,marketSemanticOutputContract,marketSemanticTaskDefinitions, marketSemanticContracts, marketSemanticSchemaDefinitions, validateMarketSemanticTaskDefinitions, assertMarketSemanticModelLimits } from '../../server/skills/market-semantic-task-definitions';
import { agentDefinitions, validateAgentDefinitions } from '../../server/skills/agent-definitions';
import { SkillRegistry } from '../../server/skills/registry';
import { validateSkillArchiveSource } from '../../server/skills/archive';
import { createStructuredResponseFormat } from '../../server/runtime/structured-response-format';
import { StageNameSchema } from '../../shared/agent-contracts';
import { canonicalJsonSha256 } from '../../server/runtime/model-request-accounting';
import type { MarketSemanticOutput } from '../../shared/market-semantic-contracts';

function inlineDefinitions(root: Record<string, unknown>): unknown {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== 'object') return value;
    const object = value as Record<string, unknown>;
    if (typeof object.$ref === 'string') {
      assert.ok(object.$ref.startsWith('#/definitions/'));
      assert.deepEqual(Object.keys(object), ['$ref']);
      const target = object.$ref.slice('#/definitions/'.length).replace(/~1/g, '/').replace(/~0/g, '~');
      const definition = (root.definitions as Record<string, unknown>)[target];
      assert.ok(definition);
      return walk(definition);
    }
    return Object.fromEntries(Object.entries(object).filter(([key]) => key !== 'definitions').map(([key, child]) => [key, walk(child)]));
  };
  return walk(root);
}

test('compact wire schemas preserve every expanded constraint in all six market tasks', () => {
  for (const task of marketSemanticTaskDefinitions) {
    const schema = marketSemanticContracts[task.id].output;
    const expanded = createStructuredResponseFormat<MarketSemanticOutput>(schema, task.outputSchema);
    const compact = createStructuredResponseFormat<MarketSemanticOutput>(schema, task.outputSchema, marketSemanticSchemaDefinitions[task.id]);
    assert.deepEqual(inlineDefinitions(compact.format.schema), inlineDefinitions(expanded.format.schema), task.id);
    if (task.id === 'market-keyword-semantics') assert.ok(JSON.stringify(compact.format.schema).length < JSON.stringify(expanded.format.schema).length / 2);
  }
});

test('seven native market tasks resolve content hashes, strict schemas and their own limits without adding legacy stages',async()=>{
  const registry=await SkillRegistry.open(path.resolve('skills-src'));
  const definitions=await validateMarketSemanticTaskDefinitions(marketSemanticTaskDefinitions,registry);
  assert.equal(definitions.length,7);assert.equal((await validateAgentDefinitions(agentDefinitions,registry)).length,4);
  for(const d of definitions){
    assert.equal(StageNameSchema.safeParse(d.id).success,false);
    const loaded=await registry.load(d.skill.id,d.skill.version);assert.equal(loaded.manifest.inputSchema,d.inputSchema);assert.equal(loaded.manifest.outputSchema,d.outputSchema);
    // The bundled Python validator lacks PyYAML; use the installed YAML parser and strict metadata checks.
    const yaml=createRequire(import.meta.url)('js-yaml') as {load(text:string):unknown};
    const frontmatter=/^---\r?\n([\s\S]+?)\r?\n---/.exec(loaded.instructions);assert.ok(frontmatter);
    z.object({name:z.literal(d.skill.id),description:z.string().min(1).max(1024).refine(s=>!s.startsWith('[TODO:')&&!/[<>]/.test(s))}).strict().parse(yaml.load(frontmatter[1]));
    assert.ok(d.skill.id.length<=64);
    const contracts=marketSemanticContracts[d.id];assert.equal(createStructuredResponseFormat<MarketSemanticOutput>(contracts.output,d.outputSchema).format.strict,true);
    await validateSkillArchiveSource(path.resolve(`${d.skill.id}.zip`),path.resolve('skills-src',d.skill.id),d.skill.id);
    const input=contracts.input.safeParse({});assert.equal(input.success,false);
    for(const fixtureId of loaded.manifest.fixtures){
      const fixture=JSON.parse(await readFile(path.resolve('skills-src',d.skill.id,'fixtures',`${fixtureId}.json`),'utf8'));
      contracts.input.parse(fixture.input);contracts.output.parse(fixture.output);
      const {inputDigest,...body}=fixture.input;assert.equal(canonicalJsonSha256(body),inputDigest);assert.equal(fixture.output.inputDigest,inputDigest);assert.equal(fixture.output.task,d.id);
    }
  }
});
test('definition drift, duplicate tasks and missing mandatory abilities reject before model execution',async()=>{
  const registry=await SkillRegistry.open(path.resolve('skills-src'));
  for(const change of [marketSemanticTaskDefinitions.slice(1),[...marketSemanticTaskDefinitions.slice(0,3),marketSemanticTaskDefinitions[0]],marketSemanticTaskDefinitions.map((d,i)=>i===0?{...d,skill:{...d.skill,id:'amazon-voc-insight'}}:d),marketSemanticTaskDefinitions.map((d,i)=>i===0?{...d,budget:{...d.budget,maxOutputTokens:8000}}:d)])await assert.rejects(()=>validateMarketSemanticTaskDefinitions(change,registry));
});

test('A4 catalog-only instructions are a new immutable skill version and the original archive remains reproducible',async()=>{
  const registry=await SkillRegistry.open(path.resolve('skills-src'));
  const old=await registry.load('market-map-customer-themes','1.0.0'),current=await registry.load('market-map-customer-themes','1.1.0');
  assert.notEqual(current.manifest.contentHash,old.manifest.contentHash);assert.match(current.instructions,/catalog-only/);assert.doesNotMatch(old.instructions,/catalog-only/);
  assert.equal(current.manifest.inputSchema,'MarketCustomerThemeMappingInput@1.1.0');
  await validateSkillArchiveSource(path.resolve('market-map-customer-themes-v1.0.0.zip'),path.resolve('skills-src/market-map-customer-themes-v1.0.0'),'market-map-customer-themes');
});

test('A1 prose analysis has a versioned skill while original template skill stays readable',async()=>{
  const registry=await SkillRegistry.open(path.resolve('skills-src'));
  const old=await registry.load('market-explain-overview','1.0.0'),current=await registry.load('market-explain-overview','1.1.0');
  assert.notEqual(current.manifest.contentHash,old.manifest.contentHash);assert.match(current.instructions,/analysisBrief/);assert.match(current.instructions,/数据表现/);
  assert.doesNotMatch(old.instructions,/analysisBrief/);assert.equal(current.manifest.outputSchema,'MarketOverviewExplanationOutput@1.1.0');
  await validateSkillArchiveSource(path.resolve('market-explain-overview-v1.0.0.zip'),path.resolve('skills-src/market-explain-overview-v1.0.0'),'market-explain-overview');
});
test('model settings obey actual market task caps rather than borrowing larger VOC allowances',()=>{
  for(const d of marketSemanticTaskDefinitions){
    const m={name:'synthetic-model',estimatedInputTokens:d.budget.maxInputTokens,maxOutputTokens:4000,timeoutMs:d.budget.timeoutMs,pricing:{inputUsdPerMillionTokens:1,outputUsdPerMillionTokens:2}};
    assert.doesNotThrow(()=>assertMarketSemanticModelLimits(d.id,m));
    for(const drift of [{maxOutputTokens:8000},{estimatedInputTokens:d.budget.maxInputTokens+1},{timeoutMs:d.budget.timeoutMs+1},{estimatedInputTokens:NaN},{pricing:{inputUsdPerMillionTokens:-1,outputUsdPerMillionTokens:2}}])assert.throws(()=>assertMarketSemanticModelLimits(d.id,{...m,...drift}));
  }
});


test('local-reference analysis uses empty legacy slots and retains the complete prose contract',()=>{
 const contract=marketSemanticOutputContract({task:'market-overview-explanation',analysisBrief:{referenceEncoding:'local-identifiers/v1'}} as any);
 const schema=createStructuredResponseFormat<MarketSemanticOutput>(contract.output,'overview-local/v1',contract.schemaDefinitions);
 assert.equal(schema.format.strict,true);assert.ok(JSON.stringify(schema.format.schema).length<3500);
 assert.equal((contract.output as any).shape.findings.safeParse([]).success,true);
 assert.equal((contract.output as any).shape.findings.safeParse([{findingId:'x',mode:'observed',factIds:['f0'],evidenceRefs:['s0']}]).success,false);
 assert.equal((contract.output as any).shape.analysis.safeParse(null).success,false);
});


test('metric table skill is versioned independently and archived prose contract stays byte-identical',async()=>{
 const registry=await SkillRegistry.open(path.resolve('skills-src'));
 const old=await registry.load('market-explain-overview','1.1.0'),current=await registry.load('market-explain-overview','1.2.0');
 assert.equal(old.manifest.contentHash,'bc5249ed6bba52f43c4ed37f14cb6ecff2befd2dc0e8c3b7ac936031638543e2');
 assert.match(current.instructions,/metricColumns/);assert.match(current.instructions,/metricContexts/);
 assert.equal(current.manifest.inputSchema,'MarketOverviewExplanationInput@1.2.0');
 assert.equal(current.manifest.outputSchema,'MarketOverviewExplanationOutput@1.1.0');
 await validateSkillArchiveSource(path.resolve('market-explain-overview-v1.1.0.zip'),path.resolve('skills-src/market-explain-overview-v1.1.0'),'market-explain-overview');
 await validateSkillArchiveSource(path.resolve('market-explain-overview.zip'),path.resolve('skills-src/market-explain-overview'),'market-explain-overview');
});


test('table-only instructions never inflate the legacy overview request',async()=>{
 const fixture=JSON.parse(await readFile('skills-src/market-explain-overview/fixtures/market-explain-overview-synthetic-v1.json','utf8'));
 const old=marketSemanticContracts['market-overview-explanation'].input.parse(fixture.input);
 assert.equal(marketSemanticExecutionDefinition(old).skill.version,'1.1.0');
 for(const encoding of ['local-identifiers/v1','metric-table/v1'] as const){
  const input=marketSemanticContracts['market-overview-explanation'].input.parse({...old,analysisBrief:{mode:'dimension',referenceEncoding:encoding,scopeStatement:'Synthetic scope',dimensions:[{id:'sample',label:'sample',factIds:old.facts.map(f=>f.factId),gapIds:old.gaps.map(g=>g.gapId)}],factLabels:[]}});
  const definition=marketSemanticExecutionDefinition(input);
  assert.equal(definition.skill.version,encoding==='metric-table/v1'?'1.2.0':'1.1.0');
  assert.equal(definition.inputSchema,encoding==='metric-table/v1'?'MarketOverviewExplanationInput@1.2.0':'MarketOverviewExplanationInput@1.1.0');
 }
});
