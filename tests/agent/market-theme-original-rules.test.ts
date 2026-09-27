import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { calculateMarketThemeMappingRules } from '../../server/domain/market-research/customer-theme-mapping-rules';
import { deriveThemeSelection } from '../../server/domain/market-research/customer-theme-selection';
import { restoreMarketThemeDetails, readMarketThemeDetailPage } from '../../server/domain/market-research/customer-theme-details';
import { collectMarketProductPool } from '../../server/services/market-product-pool-collector';
import { collectMarketCustomerThemes } from '../../server/services/market-customer-themes-collector';
import { selectMarketThemeMembers } from '../../server/domain/market-research/customer-theme-source-pool';
import { createMarketInputSnapshot } from '../../server/domain/market-research/snapshot';
import { canonicalJsonSha256 as digest } from '../../server/runtime/model-request-accounting';
import { MarketInputRecordSchema } from '../../shared/market-analysis-contracts';
import { MARKET_SOURCE_HANDLER_VERSION } from '../../shared/market-source-contracts';

const at = '2026-09-01T00:00:00.000Z', a = 'B000000001', b = 'B000000002';
async function fixture() {
 const scope = { organizationId: randomUUID(), researchId: randomUUID(), marketplace: 'US' as const, nodeIdPath: '12:34', fromMonth: '2026-07', toMonth: '2026-08', currency: 'USD' as const };
 const p = await collectMarketProductPool({scope,month:'2026-08',poolSize:100,newProductMonths:6,jobId:'synthetic',connector:{id:'sellerSprite',probe:async()=>{throw Error('unused');},execute:async r=>({data:{code:'OK',data:[{asin:a},{asin:b}]},source:{connectorId:'sellerSprite',operation:r.operation,fetchedAt:at,attemptCount:1}})}});
 assert.ok(p.evidence); const productRef = `market-source:${digest(p.evidence)}`;
 const products = createMarketInputSnapshot({scope,kind:'products',sourceVersion:MARKET_SOURCE_HANDLER_VERSION,ruleVersion:'source-normalization/v1',collectedAt:at,expectedRecordIds:[a,b],records:p.products.map(product=>({id:product.asin,scope,data:{collection:'product-month',month:'2026-08',product,sourceRef:productRef}}))});
 const selection = selectMarketThemeMembers({snapshot:products,sources:{[productRef]:p.evidence},count:20});
 const observations = [], sources: Record<string, NonNullable<typeof p.evidence>> = {};
 for (const asin of [a,b]) {
  const details = asin === a ? [
   {keyword:' Brightness ',content:'Original brightness summary',mention:100,positive:80,negative:20},
   {keyword:'Easy  Assembly',content:'Internal spaces retained',mention:100,positive:0,negative:100},
   {keyword:'Novel waveform mode',content:'Unknown source wording',mention:0,positive:0,negative:0},
  ] : [
   {keyword:'brightness',content:'Second source summary',mention:50,positive:0,negative:50},
   {keyword:'Easy Assembly',content:'Separate keyword',mention:50,positive:45,negative:40},
  ];
  const t = await collectMarketCustomerThemes({scope,asin,jobId:'synthetic',connector:{id:'sorftime',probe:async()=>{throw Error('unused');},execute:async r=>({data:{data:{details:details.map(t=>({...t,update_time:'2026-08-01'}))}},source:{connectorId:'sorftime',operation:r.operation,fetchedAt:at,attemptCount:1}})}});
  assert.ok(t.evidence); const sourceRef = `market-source:${digest(t.evidence)}`; sources[sourceRef] = t.evidence;
  observations.push({sourceRef,snapshot:createMarketInputSnapshot({scope,kind:'customer-themes',sourceVersion:MARKET_SOURCE_HANDLER_VERSION,ruleVersion:'source-normalization/v1',collectedAt:at,expectedRecordIds:[asin],records:[{id:asin,scope,data:{collection:'customer-themes',result:t.result,sourceRef}}]})});
 }
 return {scope,poolInput:{selection:selection.snapshot,selectedAsins:[a,b],catalog:{task:'market-customer-theme-mapping' as const,mappingVersion:'mapping/v1',groupCatalog:[]},dataCutoffAt:at,observations,sources,failures:[]},batches:[]};
}
function save(f:Awaited<ReturnType<typeof fixture>>, result:ReturnType<typeof calculateMarketThemeMappingRules>) {
 const {aggregation:{groups,perAsin,mappings,...aggregation},groups:labels,decisions,...summary} = result;
 const chunks=(name:string,items:unknown[],size:number)=>Array.from({length:Math.ceil(items.length/size)},(_,i)=>({id:`${name}:${i}`,data:{kind:name,items:items.slice(i*size,(i+1)*size)}}));
 const records=[{id:'summary',data:{...summary,artifactLayout:'theme-rules-chunks/v1',aggregation}},...perAsin.map(a=>({id:`asin:${a.asin}`,data:a})),...chunks('groups',groups,32),...chunks('mappings',mappings,128),...chunks('labels',labels,128),...chunks('decisions',decisions,128)].map(r=>({...r,scope:f.scope,data:MarketInputRecordSchema.shape.data.parse(r.data)}));
 return createMarketInputSnapshot({scope:f.scope,kind:'customer-themes',sourceVersion:MARKET_SOURCE_HANDLER_VERSION,ruleVersion:`market-theme-mapping-rules/v1:${result.resultHash}`,collectedAt:at,expectedRecordIds:records.map(r=>r.id),records});
}
test('original rules merge exact trimmed lowercase keywords across ASINs without changing old rules or source facts',async()=>{
 const f=await fixture();
 const old=calculateMarketThemeMappingRules(f), result=calculateMarketThemeMappingRules({...f,originalRules:true});
 assert.equal(old.aggregation.groups.length,5);assert.equal(old.groups.length,0);
 assert.equal(result.aggregation.groups.length,4);
 const brightness=result.aggregation.groups.find(g=>g.members.length===2)!;
 assert.equal(brightness.totals.mention,150);assert.equal(brightness.topicShare.denominator,300);assert.equal(brightness.topicShare.valuePct,50);
 assert.deepEqual([...brightness.members].sort((x,y)=>x.asin.localeCompare(y.asin)).map(m=>m.keyword),[' Brightness ','brightness']);
 assert.deepEqual([...brightness.members].sort((x,y)=>x.asin.localeCompare(y.asin)).map(m=>m.content),['Original brightness summary','Second source summary']);
 assert.ok(result.groups.every(g=>g.origin==='local-rule'&&g.batchId===null&&g.proposalId===null));
 assert.equal(result.groups.find(g=>g.groupId===brightness.groupId)!.labelZh,'亮度');
 assert.ok(result.groups.some(g=>g.labelZh==='Novel waveform mode'));
 assert.deepEqual(result.aggregation.perAsin,old.aggregation.perAsin);assert.deepEqual(result.aggregation.totals,old.aggregation.totals);
 assert.deepEqual(result.batches,[]);assert.equal(result.semantics.unavailableMemberIds.length,0);
 assert.deepEqual(calculateMarketThemeMappingRules({...f,originalRules:true}),result);
});
test('local-rule mappings survive saved detail replay and exclusion reclassifies retained sentiment',async()=>{
 const f=await fixture(),result=calculateMarketThemeMappingRules({...f,originalRules:true}),snapshot=save(f,result);
 const facts=restoreMarketThemeDetails(snapshot),before=JSON.stringify(facts);
 assert.deepEqual(facts.aggregation,result.aggregation);
 assert.ok(readMarketThemeDetailPage(snapshot,{}).items.every(g=>g.kind==='group'&&g.labelOrigin==='local-rule'));
 const baseline=deriveThemeSelection(facts,[],false,false,true,true);
 assert.deepEqual(baseline.sentimentGroupCounts,{positive:0,negative:4});
 assert.equal(baseline.groups.length,4);
 const subset=deriveThemeSelection(facts,[b],false,false,true,true);
 assert.deepEqual(subset.sentimentGroupCounts,{positive:1,negative:2});assert.equal(subset.totals!.mention,200);
 assert.deepEqual(deriveThemeSelection(facts,[],false,false,true,true),baseline);assert.equal(JSON.stringify(facts),before);
 assert.deepEqual(deriveThemeSelection(facts,[],false,false,true).sentimentGroupCounts,{positive:2,negative:3});
});
test('original sentiment threshold is strict, disputed and zero counts stay in negative/disputed, old reports retain overlap',async()=>{
 const rules=await import('../../shared/market-theme-original-rules');
 assert.equal(rules.isOriginalThemeFlow('market-theme-flow/rules-v3'),true);
 for(const version of ['market-theme-flow/rules-v2','market-theme-flow/rules-v1','market-theme-flow/v1'])assert.equal(rules.isOriginalThemeFlow(version),false);
 for(const [positive,negative,tab] of [[80,20,'positive'],[20,80,'negative'],[45,40,'negative'],[12,10,'negative'],[0,0,'negative']] as const){
  assert.equal(rules.themeMatchesSentiment({positive,negative},tab,true),true);
  assert.equal(rules.themeMatchesSentiment({positive,negative},tab==='positive'?'negative':'positive',true),false);
 }
 assert.equal(rules.themeMatchesSentiment({positive:80,negative:20},'negative',false),true);
});
test('local translations preserve unknown wording and source meaning instead of substring guesses',async()=>{
 const {localizeThemeLabel,localizeThemeSnippet}=await import('../../shared/market-theme-original-rules');
 assert.equal(localizeThemeLabel('Brightness'),'亮度');assert.equal(localizeThemeLabel('brightness'),'亮度');assert.equal(localizeThemeLabel('Storage'),'收纳空间');
 assert.equal(localizeThemeLabel('Novel waveform mode'),'Novel waveform mode');assert.equal(localizeThemeLabel('ageing resistance'),'ageing resistance');
 assert.equal(localizeThemeSnippet('Assembly','Customers find easy to assemble.'),'顾客认为安装方便。');
 assert.equal(localizeThemeSnippet('Brightness','Unknown source wording'),'Unknown source wording');
 assert.equal(localizeThemeSnippet('Assembly','Customers do not find it easy to assemble.'),'Customers do not find it easy to assemble.');
});



test('original preview keeps a disputed theme visible beside twelve positive themes without truncating counts',async()=>{
 const {aggregateCustomerThemes}=await import('../../server/domain/market-research/customer-themes');
 const themes=[...Array.from({length:13},(_,i)=>({sourceThemeId:`p-${i}`,keyword:`Positive ${i}`,content:'Saved',mention:1000,positive:900,negative:100})),{sourceThemeId:'disputed',keyword:'Disputed',content:'Saved dispute',mention:2,positive:1,negative:1}];
 const mappings=themes.map(t=>({sourceThemeId:t.sourceThemeId,groupId:t.sourceThemeId}));
 for(const topN of [undefined,0]){
  const facts={aggregation:aggregateCustomerThemes({selectedAsins:[a],results:[{asin:a,status:'success',source:{sourceRecordId:'source',fetchedAt:at,sourceUpdatedAt:null},themes}],mappings,topN}),labels:mappings.map(m=>({groupId:m.groupId,labelZh:m.groupId,definition:'Exact source keyword',origin:'local-rule' as const,batchId:null,proposalId:null})),decisions:mappings.map(m=>({...m,status:'mapped' as const,reason:null,batchId:null}))};
  const selected=deriveThemeSelection(facts,[],false,false,true,true);
  assert.deepEqual(selected.sentimentGroupCounts,{positive:13,negative:1});assert.equal(selected.totals!.mention,13002);
  if(topN===undefined){assert.equal(selected.groups.length,13);assert.ok(selected.groups.some(g=>g.groupId==='disputed'));assert.equal(selected.previewOmittedGroupCount,1);}
  else assert.deepEqual(selected.groups,[]);
 }
});
test('original rules retain all facts under topN and reject model inputs instead of mixing origins',async()=>{
 const f=await fixture(),result=calculateMarketThemeMappingRules({...f,originalRules:true,topN:0});
 assert.equal(result.aggregation.groups.length,0);assert.equal(result.aggregation.display.totalGroupCount,4);
 assert.equal(result.aggregation.totals!.mention,300);assert.equal(result.aggregation.mappings.length,5);
 const facts=restoreMarketThemeDetails(save(f,result));assert.equal(facts.labels.length,4);
 assert.deepEqual(deriveThemeSelection(facts,[],false,false,true,true).sentimentGroupCounts,{positive:0,negative:4});
 assert.throws(()=>calculateMarketThemeMappingRules({...f,originalRules:true,batches:[{} as never]}),/cannot include model batches/);
});
