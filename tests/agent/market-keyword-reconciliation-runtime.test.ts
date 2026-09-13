import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {SkillRegistry} from '../../server/skills/registry';
import {marketSemanticExecutionDefinition,marketSemanticOutputContract} from '../../server/skills/market-semantic-task-definitions';
import {marketSemanticWire} from '../../server/runtime/market-semantic-wire';

test('reclassification uses its immutable catalog-only skill and excludes proposal output while preserving discovery input schema',async()=>{
 const {input}=JSON.parse(await readFile('skills-src/market-classify-keyword-demand/fixtures/market-classify-keyword-demand-synthetic-v1.json','utf8'));
 const reconcile={...input,reconciliationDimension:'W1'},definition=marketSemanticExecutionDefinition(reconcile);
 assert.equal(definition.skill.version,'1.2.0');
 const registry=await SkillRegistry.open('skills-src'),skill=await registry.load(definition.skill.id,definition.skill.version);
 assert.equal(skill.manifest.inputSchema,definition.inputSchema);assert.equal(skill.manifest.outputSchema,definition.outputSchema);
 const output=marketSemanticOutputContract(reconcile).output as any;
 assert.equal(output.shape.labelProposals,undefined);assert.equal(output.shape.proposals.safeParse([{}]).success,false);
 const discovery=marketSemanticWire({...input,discoveryMode:'labels-and-clusters/v1'}).inputSchema as any;
 assert.equal(discovery.shape.reconciliationDimension,undefined);
 const old=marketSemanticWire(input).inputSchema as any;assert.equal(old.shape.discoveryMode,undefined);
 const next=marketSemanticWire(reconcile).inputSchema as any;assert.ok(next.shape.reconciliationDimension);
});
