import test from 'node:test';
import assert from 'node:assert/strict';
import {MarketLinkedRequestSchema,linkedModuleParams} from '../../shared/market-linked-contracts';

test('linked request keeps plugin-first and saved-only intent',()=>{
 const request=MarketLinkedRequestSchema.parse({scope:{marketplace:'US',nodeQuery:'3024183011',month:'2026-09',headTopN:10,newProductMonths:6},fromMonth:'2026-09',acquisitionMode:'plugin-priority/v1',mcpFallbackPolicy:'saved-only/v1'});
 assert.equal((request as any).acquisitionMode,'plugin-priority/v1');
 for(const module of ['overview','shapes','themes','keywords'] as const){
  const params=linkedModuleParams(module,'Darts',6,10,request) as any;
  assert.equal(params.acquisitionMode,'plugin-priority/v1');
  assert.equal(params.mcpFallbackPolicy,'saved-only/v1');
 }
});

test('historical request parsing does not add fields or change legacy identity',()=>{
 const request={scope:{marketplace:'CA',nodeQuery:'123',month:'2026-09',headTopN:10,newProductMonths:6},fromMonth:'2026-09'};
 assert.deepEqual(MarketLinkedRequestSchema.parse(request),request);
 assert.equal(Object.hasOwn(linkedModuleParams('shapes','Darts',6) as object,'acquisitionMode'),false);
});

test('an explicitly missing batch snapshot remains frozen across every module',()=>{
 for(const module of ['overview','shapes','themes','keywords'] as const){
  const params=linkedModuleParams(module,'Darts',6,10,{acquisitionMode:'plugin-priority/v1',mcpFallbackPolicy:'saved-only/v1',pluginSourceSnapshotId:null}) as any;
  assert.ok(Object.hasOwn(params,'pluginSourceSnapshotId'));assert.equal(params.pluginSourceSnapshotId,null);
 }
});
