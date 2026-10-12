import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import * as store from '../../server/db/postgres/project-display-version-store';
import { LocalDataStageOutputResponseSchema } from '../../shared/agent-contracts';
const asin='B0CSFDX9HM';
const scope={organizationId:'22222222-2222-4222-8222-222222222222',projectId:'c4e6e7a4-025a-4ab1-9cf0-858bfc47170d',runId:'e13be6a8-8fcb-49bf-b7c7-c0bae7cd60b5',jobId:'97a8b00e-90f4-4078-8190-08745abc6cd8',marketplace:'US',asins:[asin]};
function hash(value:unknown):string {
  const canonical=(item:unknown):unknown=>Array.isArray(item)?item.map(canonical):item&&typeof item==='object'?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
function fixture(price:Record<string,unknown>={}) {
  const data={strategyByAsin:{[asin]:{asin,marketplace:'US',source:'Sorftime',status:'ready',currentPrice:75.99,fetchedAt:'2026-10-12',anchor:'Current price',...price}}};
  return {stage:'price_strategy',stageStatus:'done',jobId:scope.jobId,projectId:scope.projectId,runId:scope.runId,jobVersion:1,outputVersion:1,updatedAt:'2026-10-12T08:20:11.857Z',contentHash:hash({stage:'price_strategy',data}),data};
}
function bind(output=fixture(),expected=scope,sourceOrganizationId=scope.organizationId) {
  return store.bindCapturedPriceStrategyProjection({output,scope:expected,sourceOrganizationId});
}
test('missing price provenance binds scoped immutable captured source without mutating raw output',()=>{
  const raw=fixture();const original=structuredClone(raw);
  const derived=bind(raw);
  assert.deepEqual(raw,original);
  const p=(derived.data!.strategyByAsin as Record<string,Record<string,unknown>>)[asin]!.provenance as Record<string,string>;
  assert.deepEqual(p,{jobId:scope.jobId,asin,marketplace:'US',fetchedAt:'2026-10-12',connector:'sorftime',operation:'persisted_stage_output',tool:'persisted_stage_output',stageId:'price_strategy',trendType:'not-recorded',observationPeriod:'not-recorded',sourceContentHash:raw.contentHash,captureJobId:scope.jobId,organizationId:scope.organizationId,projectId:scope.projectId,runId:scope.runId});
  assert.notEqual(derived.contentHash,raw.contentHash);
  assert.equal(derived.contentHash,hash({stage:'price_strategy',data:derived.data}));
  assert.equal(LocalDataStageOutputResponseSchema.safeParse(derived).success,true);
});
test('direct physical provenance keeps original source job and time while capture witness binds the current stage',()=>{
  const provenance={jobId:'earlier-job',asin,marketplace:'US',fetchedAt:'2026-10-11',connector:'sorftime',operation:'product_detail+product_trend',tool:'product_detail+product_trend'};
  const raw=fixture({fetchedAt:'2026-10-11',provenance});
  const derived=bind(raw);
  const p=(derived.data!.strategyByAsin as Record<string,Record<string,unknown>>)[asin]!.provenance as Record<string,string>;
  for(const [key,value] of Object.entries(provenance)) assert.equal(p[key],value);
  assert.equal(p.captureJobId,scope.jobId);
  assert.equal(p.sourceContentHash,raw.contentHash);
  assert.equal(derived.contentHash,hash({stage:'price_strategy',data:derived.data}));
});
test('captured price binding rejects tampered hash and ownership mismatches',()=>{
  for(const output of [{...fixture(),contentHash:'a'.repeat(64)},{...fixture(),jobId:'other-job'},{...fixture(),runId:'11111111-1111-4111-8111-111111111111'},{...fixture(),projectId:'11111111-1111-4111-8111-111111111111'},{...fixture(),stage:'listing'}]) assert.throws(()=>bind(output as ReturnType<typeof fixture>),store.ProjectDisplayVersionConflictError);
  assert.throws(()=>bind(fixture(),scope,'11111111-1111-4111-8111-111111111111'),store.ProjectDisplayVersionConflictError);
});
test('invalid price identities and incomplete provenance cannot gain source certification',()=>{
  for(const price of [{asin:'B0BWCQHCWX'},{marketplace:'UK'},{status:'error'},{currentPrice:0},{currentPrice:'75.99'},{currentPrice:NaN},{fetchedAt:'invalid'},{provenance:{}},{provenance:{jobId:'other-job',asin:'B0BWCQHCWX'}}]) assert.throws(()=>bind(fixture(price)),store.ProjectDisplayVersionConflictError);
  assert.throws(()=>bind(fixture(),{...scope,asins:['B0BWCQHCWX']}),store.ProjectDisplayVersionConflictError);
});
test('unknown provider data passes the original schema but never gains source certification',()=>{
  const raw=fixture({source:'Unknown'});
  assert.deepEqual(bind(raw),raw);
});
test('failed price output stays a failed gap and is never promoted to ready',()=>{
  const gap={state:'failed',reasonCode:'UPSTREAM_EMPTY'};
  const {data,...base}=fixture();
  const raw={...base,stageStatus:'failed',gap,contentHash:hash({stage:'price_strategy',gap})};
  assert.deepEqual(bind(raw as unknown as ReturnType<typeof fixture>),raw);
});
test('partial captured price projection preserves its gap and binds only captured ready records',()=>{
  const missing='B0BWCQHCWX';
  const gap={state:'partial',reasonCode:'UPSTREAM_EMPTY',items:[{asin:missing,causeCode:'UPSTREAM_EMPTY'}]};
  const raw={...fixture(),stageStatus:'partial',gap,contentHash:hash({stage:'price_strategy',data:fixture().data,gap})};
  const derived=bind(raw as unknown as ReturnType<typeof fixture>,{...scope,asins:[asin,missing]});
  assert.deepEqual(derived.gap,gap);
  assert.equal(derived.stageStatus,'partial');
  assert.deepEqual(Object.keys(derived.data!.strategyByAsin as object),[asin]);
  assert.equal(derived.contentHash,hash({stage:'price_strategy',data:derived.data,gap}));
});
