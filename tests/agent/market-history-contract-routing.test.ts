import assert from 'node:assert/strict';
import test from 'node:test';
import {findHttpContract} from '../../shared/agent-contracts';

test('all three market revision paths resolve through the public proxy contract registry',()=>{
 const run='10000000-0000-4000-8000-000000000001',attempt='20000000-0000-4000-8000-000000000001';
 for(const suffix of ['shape-price/revisions','keywords/revisions',`reports/${attempt}/theme-selection`]){
  for(const revision of [`market-revision:${'a'.repeat(64)}`,`market-revision%3A${'a'.repeat(64)}`]){
   const contract=findHttpContract('GET',`/v1/market-analysis/runs/${run}/${suffix}/${revision}`);
   assert.ok(contract,`${suffix} revision must reach schema validation`);
   assert.ok(contract.path.endsWith('/:revisionId'));
   assert.equal(findHttpContract('GET',`/v1/market-analysis/runs/${run}/${suffix}/${revision}/extra`),undefined);
  }
 }
});
