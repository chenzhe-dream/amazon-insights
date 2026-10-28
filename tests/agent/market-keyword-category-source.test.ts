import assert from 'node:assert/strict';
import test from 'node:test';
import {collectMarketKeywordPage} from '../../server/services/market-keyword-collector';
import {normalizeSorftimeToolResult} from '../../scripts/lib/sorftime-mcp-client.mjs';
import {assembleMarketKeywordPool} from '../../server/domain/market-research/keyword-source-pool';
import {createMarketInputSnapshot} from '../../server/domain/market-research/snapshot';
import {canonicalJsonSha256 as digest} from '../../server/runtime/model-request-accounting';
import {MARKET_SOURCE_HANDLER_VERSION} from '../../shared/market-source-contracts';
import {linkedModuleParams} from '../../shared/market-linked-contracts';
import {keywordQueryFromRun,keywordQueryKey} from '../../app/lib/market-keyword-query-history';
import type {ConnectorRequest} from '../../server/connectors/connector-contract';
const at='2026-10-28T07:00:00.000Z';
const scope={organizationId:'22222222-2222-4222-8222-222222222222',researchId:'11111111-1111-4111-8111-111111111111',marketplace:'US' as const,nodeIdPath:'12:3024183011',fromMonth:'2026-09',toMonth:'2026-09',currency:'USD' as const};
// Synthetic metrics using the observed category_keywords string-field contract.
const rows=[{keyword:'synthetic dog seat',weekly_search_volume:'400',weekly_search_rank:'50',monthly_search_volume:'1600',cpc_exact_bid:'1.53',search_volume_peak_season:'均衡'}];
const catalog={task:'market-keyword-semantics' as const,dictionaryVersion:'synthetic/v1',categoryContext:'Booster & Car Seats',dimensionLabels:{W1:[],W2:[],W3:[],W4:[]},clusterCatalog:[]};
async function collect(extra:any={},payload:any={data:rows}){
 const calls:any[]=[];
 const result=await collectMarketKeywordPage({scope,seed:'Booster & Car Seats',page:1,sourceMode:'category-keywords',jobId:'category-test',...extra,connector:{id:'sorftime',probe:async()=>{throw Error('unused');},execute:async (r:ConnectorRequest)=>{calls.push(r);return {data:payload,source:{connectorId:'sorftime',operation:r.operation,fetchedAt:at,attemptCount:1}};}}} as any);
 return {result,calls};
}
test('linked keyword pages use category source and restored query keeps the mode',()=>{
 const params:any=linkedModuleParams('keywords','Booster & Car Seats',6);
 assert.ok(params.plannedPages.every((p:any)=>p.sourceMode==='category-keywords'));
 const query:any=keywordQueryFromRun({scope,params} as any);
 assert.equal(query.sourceMode,'category-keywords');
 assert.notEqual(keywordQueryKey(query),keywordQueryKey({...query,sourceMode:undefined}));
});
test('category page uses the exact node and site; parses counts without relabeling local exact CPC',async()=>{
 for(const [marketplace,currency,providerSite] of [['US','USD','US'],['UK','GBP','GB'],['DE','EUR','DE'],['CA','CAD','CA']]){
  const {result,calls}=await collect({scope:{...scope,marketplace,currency}});
  assert.notEqual(result.status,'failed');if(result.status==='failed')continue;
  assert.deepEqual(calls[0].input,{node_id:'3024183011',amz_site:providerSite,page:1});
  assert.equal(calls[0].operation,'category_keywords');assert.equal(result.evidence.operation,'category_keywords');
  assert.equal(result.evidence.requestIdentity.nodeId,'3024183011');assert.equal(result.evidence.requestIdentity.keyword,undefined);
  assert.equal(result.members[0].monthlySearchVolume.value,1600);assert.equal(result.members[0].weeklySearchRank.value,50);
  assert.equal(result.members[0].recommendedCpcUsd.value,null);assert.equal(result.members[0].seasonality.value,'均衡');
 }
});
test('category page remains strict about scope, numeric syntax and repeated members',async()=>{
 for(const payload of [{node_id:'999',data:rows},{amz_site:'DE',data:rows},{data:[{...rows[0],monthly_search_volume:'1e3'}]},{data:[rows[0],rows[0]]}]){
  assert.equal((await collect({},payload)).result.status,'failed');
 }
});
test('category evidence assembles and projects into the fixed pool, but cannot masquerade as a seed page',async()=>{
 const {result}=await collect();assert.notEqual(result.status,'failed');if(result.status==='failed')return;
 const ref=`market-source:${digest(result.evidence)}`;
 const snapshot=createMarketInputSnapshot({scope,kind:'keywords',sourceVersion:MARKET_SOURCE_HANDLER_VERSION,ruleVersion:'source-normalization/v1',collectedAt:at,expectedRecordIds:result.members.map(m=>m.id),records:result.members.map(member=>({id:member.id,scope,data:{collection:'keyword-page',member,sourceRef:ref}}))});
 const options={scope,catalog,dataCutoffAt:at,maxMembers:100,plannedPages:[{seed:'Booster & Car Seats',page:1,sourceMode:'category-keywords' as const}],pages:[{snapshot,sourceRef:ref}],sources:{[ref]:result.evidence}};
 const pool=assembleMarketKeywordPool(options);assert.equal(pool.rawSnapshot.records.length,1);assert.equal(pool.semanticSnapshot.records.length,1);
 assert.throws(()=>assembleMarketKeywordPool({...options,plannedPages:[{seed:'Booster & Car Seats',page:1}]}));
});
test('observed non-trending message is a query problem, never a valid empty result or malformed JSON',()=>{
 const text="The keyword you queried is not an Amazon trending keyword, but we found related keywords: car accessories,car phone holder. Which keyword's detail do you want to view?";
 const response={content:[{type:'text',text}]};
 assert.throws(()=>normalizeSorftimeToolResult('keyword_extends',response),(e:any)=>e.kind==='keyword-not-trending');
 assert.throws(()=>normalizeSorftimeToolResult('category_keywords',response),(e:any)=>e.kind==='malformed');
 assert.throws(()=>normalizeSorftimeToolResult('keyword_extends',{...response,isError:true}),(e:any)=>e.kind==='rpc');
 assert.throws(()=>normalizeSorftimeToolResult('keyword_extends',{content:[{type:'text',text:'not-json'}]}),(e:any)=>e.kind==='malformed');
});
