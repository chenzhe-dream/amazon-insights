import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {SkillRegistry} from '../../server/skills/registry';
import {SkillRunner} from '../../server/runtime/skill-runner';
import {createMarketSemanticBatchMeter} from '../../server/runtime/market-semantic-batch-meter';
import {planMarketSemanticBatches} from '../../server/domain/market-research/semantic-batch-plan';
import {planMarketOverviewSemanticWindows} from '../../server/domain/market-research/overview-semantic-windows';
import type {MarketSemanticRunnerConfiguration} from '../../server/runtime/market-semantic-runner';
import type {MarketInputSnapshot} from '../../shared/market-analysis-contracts';
import type {MarketSourceEvidence} from '../../shared/market-source-contracts';
import { MarketSemanticRecordSchema, MarketShapeSuggestionInputSchema } from '../../shared/market-semantic-contracts';
import { validateMarketShapeSuggestions } from '../../server/domain/market-research/semantic-validation';
import { canonicalJsonSha256 } from '../../server/runtime/model-request-accounting';

// Frozen public supplier evidence from the actual US pen-node test. This test
// never connects to a database/provider; any accidental execution fails loudly.
const noExternalWork = async (): Promise<never> => { throw new Error('Read-only metering must never execute or reserve model work'); };
const moduleRunId='94c92fa7-7e8a-4488-9dbf-1a8661d3f2d1';
function evidence(name: string): {snapshot:MarketInputSnapshot;sources:Record<string,MarketSourceEvidence>;selectionRevision:string;dataCutoffAt:string} {
  return JSON.parse(readFileSync(new URL(`../fixtures/market-${name}-meter-live-20260917.json`,import.meta.url),'utf8'));
}
async function configuration(task:MarketSemanticRunnerConfiguration['task']) {
  const registry=await SkillRegistry.open('skills-src');
  const runner=new SkillRunner({registry,providerName:'read-only-meter',provider:{generateStructured:noExternalWork},
    budgetCoordinator:{reserve:noExternalWork,dispatch:noExternalWork,release:noExternalWork,settle:noExternalWork}});
  const cap={maxTokens:100000,maxCostMicros:1000000};
  const config:MarketSemanticRunnerConfiguration={task,providerName:'read-only-meter',transport:'relay-chat-json',openAI:{},
    model:{name:'gpt-5.6',estimatedInputTokens:task==='market-product-shape-suggestion'?8000:12000,maxOutputTokens:4000,timeoutMs:60000,
      pricing:{inputUsdPerMillionTokens:1,outputUsdPerMillionTokens:2}},limits:{call:cap,run:cap,organizationUtcDay:cap}};
  return {meter:createMarketSemanticBatchMeter(runner,config),task,configurationVersion:'live-token-meter-regression/v2'};
}

test('all ten real shape members form ten individually admitted batches without dropping source evidence',async()=>{
  const {meter,...config}=await configuration('market-product-shape-suggestion'),data=evidence('shape');
  const plan=await planMarketSemanticBatches({...config,...data,moduleRunId},meter);
  assert.deepEqual(plan.rejectedMembers,[]);assert.deepEqual(plan.missingMemberIds,[]);
  assert.equal(plan.batches.length,10);
  assert.ok(plan.batches.every(batch=>batch.memberRefs.length===1));
  for (const batch of plan.batches) {
    assert.equal(batch.input.task,'market-product-shape-suggestion');
    if (batch.input.task!=='market-product-shape-suggestion') throw Error('Unexpected task');
    const original=data.snapshot.records.find(record=>record.id===batch.memberRefs[0])!;
    assert.deepEqual(batch.input.products[0],(original.data as {semantic:{product:unknown}}).semantic.product);
    assert.deepEqual(batch.validationBinding.sourceEvidenceByRef,data.sources);
  }
  assert.deepEqual(await planMarketSemanticBatches({...config,...data,moduleRunId},meter),plan);
  assert.deepEqual(plan.batches.flatMap(b=>b.memberRefs).sort(),[...data.snapshot.expectedRecordIds].sort());
  assert.equal(plan.expectedMemberIds.length,10);
});

test('saved v1 ten-product binding remains readable without recomputing its old planner identity', () => {
  const data=evidence('shape');
  const legacy=JSON.parse(readFileSync(new URL('../fixtures/market-shape-legacy-batch-live-20260917.json',import.meta.url),'utf8'));
  const originalHash=canonicalJsonSha256(legacy),input=MarketShapeSuggestionInputSchema.parse(legacy.input);
  assert.equal(legacy.plannerVersion,'market-semantic-batches/v1');
  assert.equal(input.products.length,10);
  // The historical reader invokes this same validator using saved input/refs;
  // the current planner is deliberately never called to reconstruct old IDs.
  const checked=validateMarketShapeSuggestions(input,{schemaVersion:input.schemaVersion,task:input.task,batchId:input.batchId,inputDigest:input.inputDigest,
    products:input.products.map(product=>({productId:product.productId,decision:{status:'unknown',reason:'insufficient-evidence',evidence:[]}}))},
    {scope:data.snapshot.scope,inputSnapshot:data.snapshot,sourceEvidenceByRef:data.sources,selectionRevision:input.selectionRevision,batchKey:input.batchKey,
      inputDigest:input.inputDigest,expectedIds:legacy.memberRefs,sourceCatalog:Object.fromEntries(data.snapshot.records.map(record=>[record.id,MarketSemanticRecordSchema.parse((record.data as {semantic:unknown}).semantic)]))});
  assert.deepEqual(checked.products.map(product=>product.productId),legacy.memberRefs);
  assert.equal(canonicalJsonSha256(legacy),originalHash);
});

test('real overview preserves all 142 primary facts and 167 gaps without 73 tiny windows',async()=>{
  const {meter,...config}=await configuration('market-overview-explanation'),data=evidence('overview');
  const plan=await planMarketOverviewSemanticWindows(data.snapshot,async snapshot=>{
    const batch=await planMarketSemanticBatches({...config,...data,moduleRunId,snapshot},meter);
    return batch.batches.length===1&&!batch.rejectedMembers.length;
  });
  assert.deepEqual(plan.rejected,[]);assert.ok(plan.windows.length<=10,`excessive windows: ${plan.windows.length}`);
  const facts=plan.windows.flatMap(w=>w.primaryFactIds),gaps=plan.windows.flatMap(w=>w.gapIds);
  assert.equal(facts.length,142);assert.equal(new Set(facts).size,142);assert.equal(gaps.length,167);assert.equal(new Set(gaps).size,167);
});
