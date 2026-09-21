import assert from 'node:assert/strict';
import {z} from 'zod';
import {marketSites} from '../../../shared/market-sites';
import {MarketAnalysisScopeSchema} from '../../../shared/market-analysis-contracts';
import {marketSemanticContracts} from '../../../server/skills/market-semantic-task-definitions';
import {canonicalJsonSha256} from '../../../server/runtime/model-request-accounting';
/** 0c7cc29 pinned US/USD; today's identity must bind the multi-site input contract. */
export function assertCurrentMarketScopeIdentityContracts(){
 const base={organizationId:'org-test',researchId:'a9000000-0000-4000-8000-000000000001',nodeIdPath:'1:2',fromMonth:'2026-07',toMonth:'2026-08'};
 for(const {code,currency} of marketSites){
  assert.equal(MarketAnalysisScopeSchema.safeParse({...base,marketplace:code,currency}).success,true);
  const {organizationId:_organizationId,...scope}=base;
  for(const contract of Object.values(marketSemanticContracts)){
   const inputScope=contract.input.shape.scope;
   assert.equal(inputScope.safeParse({...scope,marketplace:code,currency}).success,true);
   assert.equal(inputScope.safeParse({...scope,marketplace:code,currency:currency==='USD'?'EUR':'USD'}).success,false);
   const schema=JSON.parse(JSON.stringify(z.toJSONSchema(inputScope))),legacy={...schema,properties:{...schema.properties,marketplace:{type:'string',const:'US'},currency:{type:'string',const:'USD'}}};
   assert.notEqual(canonicalJsonSha256(schema),canonicalJsonSha256(legacy),'the US-only schema golden cannot characterize the current contract');
  }
 }
}
