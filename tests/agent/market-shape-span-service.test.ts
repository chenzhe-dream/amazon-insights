import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {startPostgresTestContainer} from './helpers/postgres-test-container';
import {createMarketShapeSpanFixture} from './helpers/market-shape-span-fixture';
import {runPostgresMigrations} from '../../server/db/postgres/migrations';
import {SkillRegistry} from '../../server/skills/registry';
import {MarketSemanticExecutionService} from '../../server/runtime/market-semantic-execution-service';
import type {OpenAIProviderOptions} from '../../server/runtime/openai-provider';
test('live shape coordinate repair is durably audited and strict replay does not dispatch', {timeout:120000},async t=>{
 const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);
 const registry=await SkillRegistry.open('skills-src'); const manifest=(await registry.load('market-suggest-product-shape','1.0.0')).manifest;
 const f=await createMarketShapeSpanFixture(pg.pool,{manifest});
 await f.stores.steps.settleAndEnqueue({claim:f.modelClaim,outcome:{status:'failed',error:{code:'internal',retryable:false}}});
 await f.stores.steps.retryFailedSteps({actor:f.actor,moduleRunId:f.subject.moduleRunId,steps:[{stepId:f.modelClaim.stepId,failedAttemptId:f.modelClaim.attemptId}],idempotencyKey:randomUUID()});
 const claim=await f.stores.steps.claimStep({moduleRunId:f.subject.moduleRunId,leaseOwnerId:randomUUID(),leaseMs:30000});assert.ok(claim);
 const value={schemaVersion:'1.0.0',task:f.inputProjection.task,batchId:f.inputProjection.batchId,inputDigest:f.inputProjection.inputDigest,products:[{productId:'B000000001',decision:{status:'supported',candidates:[{labelId:'lamp',evidence:[{refId:'text-a',start:0,end:4,quote:'lamp'}]}],requiresManualConfirmation:true}}]};
 let calls=0;const client={responses:{create:async()=>{calls++;return {id:'shape-fixture',status:'completed',usage:{input_tokens:100,output_tokens:50,total_tokens:150},output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(value)}]}]};}}} as unknown as OpenAIProviderOptions['client'];
 const cap={maxTokens:100000,maxCostMicros:1000000};
 const configuration={task:'market-product-shape-suggestion' as const,configurationVersion:'fixture/v1',model:{name:'gpt-5.6',estimatedInputTokens:8000,maxOutputTokens:2400,timeoutMs:60000,pricing:{inputUsdPerMillionTokens:1,outputUsdPerMillionTokens:2}},providerName:'synthetic-openai',transport:'responses-strict' as const,limits:{call:cap,run:cap,organizationUtcDay:cap},openAI:{client}};
 const service=new MarketSemanticExecutionService(f.context,registry);const result=await service.executeBatch(claim,configuration);assert.equal(result.status,'succeeded');
 const metadata=result.agentRun.outcome?.terminalMetadata;assert.equal(metadata?.kind,'succeeded');if(metadata?.kind!=='succeeded')throw new Error('No success audit');
 assert.deepEqual(metadata.marketShapeSpanNormalizations,[{path:['products',0,'decision','candidates',0,'evidence',0],refId:'text-a',oldStart:0,oldEnd:4,newStart:8,newEnd:12,ruleVersion:'market-shape-exact-span/v1'}]);
 const replay=await service.executeBatch(claim,configuration);assert.equal(replay.replayed,true);assert.equal(calls,1);assert.deepEqual(replay.agentRun.outcome?.terminalMetadata,metadata);
});

