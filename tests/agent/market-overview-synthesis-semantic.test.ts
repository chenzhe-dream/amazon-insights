import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {createMarketSourceEvidence} from '../../server/domain/market-research/source-evidence';
import {createMarketInputSnapshot} from '../../server/domain/market-research/snapshot';
import {createMarketOverviewSynthesisChildren,buildMarketOverviewDimensionSynthesisInput} from '../../server/domain/market-research/overview-synthesis';
import {planMarketSemanticBatches} from '../../server/domain/market-research/semantic-batch-plan';
import {validateMarketSemanticInput,validateMarketOverviewSynthesisOutput} from '../../server/domain/market-research/semantic-validation';
import {MarketSemanticRecordSchema} from '../../shared/market-semantic-contracts';
import {canonicalJsonSha256 as digest} from '../../server/runtime/model-request-accounting';
import type {MarketOverviewSynthesisBasis} from '../../shared/market-overview-synthesis-contracts';
import {synthesisWireFixture} from './helpers/market-overview-synthesis-wire-fixture';

async function fixture(){
 const scope={organizationId:randomUUID(),researchId:randomUUID(),marketplace:'US' as const,nodeIdPath:'1:2',fromMonth:'2026-08',toMonth:'2026-08',currency:'USD' as const},at='2026-09-01T00:00:00.000Z';
 const source=createMarketSourceEvidence({scope,provider:'sorftime',operation:'market_research',requestIdentity:{marketplace:'US',nodeIdPath:'1:2'},responseIdentityPaths:{},payload:{synthetic:true},fetchedAt:at,observationPeriod:{kind:'unknown',reason:'Synthetic period'},units:{},coverage:{receivedCount:1,expectedCount:1,truncation:{status:'unknown',reason:'Synthetic'}}});
 const sourceRef=`market-source:${digest(source)}`,g=synthesisWireFixture(),fact={...g.evidenceFacts[0],sourceRefs:[sourceRef]},metric={...g.metrics[0],sourceRefs:[sourceRef]};
 const statement={parts:g.children[0].section.data.parts,factIds:[fact.factId],gapIds:['gap']};
 const section={dimensionId:g.dimensionId,data:statement,meaning:statement,conclusion:statement,limitations:[statement],verification:[statement]};
 const basis:MarketOverviewSynthesisBasis={version:'market-overview-synthesis-basis/v1',basisId:'basis:synthetic',contentHash:'a'.repeat(64),scope,catalogSnapshotId:'market-input:'+'b'.repeat(64),catalogContentHash:'c'.repeat(64),planContentHash:'d'.repeat(64),numericInputSnapshotId:'market-input:'+'e'.repeat(64),dataCutoffAt:at,selectionRevision:'selection',configurationVersion:'synthetic',scopeStatement:g.scopeStatement,dimensions:[{id:g.dimensionId,label:'Competition',factIds:[fact.factId],gapIds:['gap']}],facts:[fact],metrics:[metric],gaps:[{gapId:'gap',metricId:null,reason:'period-incompatible',sourceRefs:[sourceRef]}],factLabels:g.labels,leaves:['leaf-a','leaf-b'].map(leafId=>({leafId,inputSnapshotId:'market-input:'+'f'.repeat(64),attemptId:randomUUID(),agentRunId:randomUUID(),dimensionId:g.dimensionId,primaryFactIds:[fact.factId],primaryGapIds:['gap'],coveredFactIds:[fact.factId],coveredGapIds:['gap'],section}))};
 const children=createMarketOverviewSynthesisChildren(basis),leaves=basis.leaves.map(x=>x.leafId),synthesis=await buildMarketOverviewDimensionSynthesisInput(basis,g.dimensionId,children,leaves,()=>true);
 const semantic={task:'market-overview-synthesis' as const,synthesis,sourceRefs:[sourceRef],sourceReportAttemptId:randomUUID()};
 const snapshot=createMarketInputSnapshot({scope,kind:'overview',sourceVersion:'synthetic',ruleVersion:'synthetic',collectedAt:at,expectedRecordIds:[synthesis.nodeId],records:[{id:synthesis.nodeId,scope,data:{semantic}}]});
 const planning={task:semantic.task,moduleRunId:randomUUID(),snapshot,sources:{[sourceRef]:source},selectionRevision:basis.selectionRevision,configurationVersion:basis.configurationVersion,dataCutoffAt:at,overviewSynthesisBasis:basis,overviewSynthesisChildren:children,overviewSynthesisExpectedLeaves:leaves};
 const plan=await planMarketSemanticBatches(planning,async()=>true);return {planning,semantic,basis,plan};
}

test('canonical native overview synthesis binds authorized evidence, cutoff, node and source-report provenance',async()=>{
 const f=await fixture(),batch=f.plan.batches[0];assert.equal(f.plan.batches.length,1);
 assert.deepEqual(validateMarketSemanticInput(batch.input,batch.validationBinding),batch.input);
 const input=batch.input;assert.equal(input.task,'market-overview-synthesis');if(input.task!=='market-overview-synthesis')throw new Error('Wrong task');
 const output={schemaVersion:'1.0.0',task:input.task,batchId:input.batchId,inputDigest:input.inputDigest,result:{mode:'dimension-reduce',dimensionSection:input.synthesis.children[0].section}};
 assert.deepEqual(validateMarketOverviewSynthesisOutput(input,output,batch.validationBinding),output);
 assert.equal(MarketSemanticRecordSchema.safeParse({...f.semantic,sourceReportAttemptId:'forged'}).success,false);
 assert.throws(()=>validateMarketSemanticInput(input,{...batch.validationBinding,overviewSynthesisChildren:[]}));
 assert.throws(()=>validateMarketSemanticInput(input,{...batch.validationBinding,overviewSynthesisExpectedLeaves:['foreign']}));
 assert.throws(()=>validateMarketSemanticInput(input,{...batch.validationBinding,overviewSynthesisBasis:{...f.basis,scope:{...f.basis.scope,nodeIdPath:'2:3'}}}));
 assert.throws(()=>validateMarketSemanticInput(input,{...batch.validationBinding,overviewSynthesisBasis:{...f.basis,dataCutoffAt:'2026-08-31T00:00:00.000Z'}}));
 const forged=structuredClone(input);forged.synthesis.evidenceFacts[0].statementTemplateId='forged';const {inputDigest:_old,...body}=forged;assert.equal(_old,input.inputDigest);forged.inputDigest=digest(body);
 assert.throws(()=>validateMarketSemanticInput(forged,{...batch.validationBinding,inputDigest:forged.inputDigest}));
 assert.throws(()=>validateMarketOverviewSynthesisOutput(input,{...output,result:{...output.result,dimensionSection:{...output.result.dimensionSection,dimensionId:'foreign'}}},batch.validationBinding));
});
