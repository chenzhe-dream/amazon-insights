import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import type {Pool} from 'pg';
import {SkillRegistry} from '../../server/skills/registry';
import {PostgresQueryContext} from '../../server/db/postgres/query-context';
import {createMarketSemanticSkillRunner,type MarketSemanticRunnerConfiguration} from '../../server/runtime/market-semantic-runner';
import {createMarketSemanticBatchMeter} from '../../server/runtime/market-semantic-batch-meter';
import {MarketOverviewSynthesisInputSchema} from '../../shared/market-semantic-contracts';
import {canonicalJsonSha256 as digest} from '../../server/runtime/model-request-accounting';
import type {OpenAIProviderOptions} from '../../server/runtime/openai-provider';

test('native admission meters real strict dimension and final requests without dispatch and refuses long prose',async()=>{
 let externalCalls=0;const forbidden=async()=>{externalCalls++;throw new Error('Admission must not dispatch');};
 const context=new PostgresQueryContext({query:forbidden,connect:forbidden} as unknown as Pool),registry=await SkillRegistry.open('skills-src'),cap={maxTokens:100000,maxCostMicros:1000000};
 const configuration:MarketSemanticRunnerConfiguration={task:'market-overview-synthesis',providerName:'synthetic',transport:'responses-strict',model:{name:'synthetic-capacity',estimatedInputTokens:12000,maxOutputTokens:4000,timeoutMs:60000,pricing:{inputUsdPerMillionTokens:1,outputUsdPerMillionTokens:2}},limits:{call:cap,run:cap,organizationUtcDay:cap},openAI:{client:{responses:{create:forbidden}} as unknown as OpenAIProviderOptions['client']}};
 const meter=createMarketSemanticBatchMeter(createMarketSemanticSkillRunner(context,registry,configuration),configuration);
 const fixture=JSON.parse(await readFile('skills-src/market-synthesize-overview/fixtures/market-synthesize-overview-synthetic-v1.json','utf8'));
 const input=MarketOverviewSynthesisInputSchema.parse(fixture.input);assert.equal(await meter(input),true);
 const final=MarketOverviewSynthesisInputSchema.parse({...input,synthesis:{...input.synthesis,mode:'final',dimensionId:'final'}});assert.equal(await meter(final),true);
 const long=structuredClone(final),child=long.synthesis.children[0];
 long.synthesis.children=Array.from({length:128},(_,i)=>({...structuredClone(child),childId:`child-${i}`,leafSectionIds:[`leaf-${i}`],section:{...structuredClone(child.section),meaning:{...child.section.meaning,parts:[{kind:'text',text:String.fromCharCode(65+i%26).repeat(220)+String.fromCharCode(65+Math.floor(i/26))}]}}}));
 long.synthesis.directChildIds=long.synthesis.children.map(c=>c.childId);long.synthesis.leafSectionIds=long.synthesis.children.flatMap(c=>c.leafSectionIds);
 const {inputDigest,...body}=long;assert.ok(inputDigest);long.inputDigest=digest(body);
 assert.equal(await meter(long),false);assert.equal(externalCalls,0);
});
