import assert from 'node:assert/strict';
import test from 'node:test';
import {collectSorftimeShapePoolPage,normalizeSorftimeShapePool} from '../../server/services/market-shape-sorftime-pool';
import {projectSorftimeThemeSample} from '../../server/domain/market-research/customer-theme-sorftime-sample';
const scope={organizationId:'22222222-2222-4222-8222-222222222222',researchId:'71000000-0000-4000-8000-000000000001',marketplace:'US',currency:'USD',nodeIdPath:'12:1063294',fromMonth:'2026-06',toMonth:'2026-08'} as const;
const row={asin:'B099WTN2TR',title:'Lamp',price:69.99,monthly_sales_volume:24374,monthly_sales_amount:1705936.26,ratings:4.4,rating_count:11965,buybox_seller:'Govee US',main_image:['https://m.media-amazon.com/images/I/61Scft3U3TL.jpg'],sub_category:[['Floor Lamps','1063294',1]],subcategory_rank:1};
const payload={doc:{main_image:'Main image url array.'},data:[row]};
const at='2026-10-13T05:57:26.231Z';
function connector(data:Record<string,unknown>=payload){return {id:'sorftime' as const,probe:async()=>{throw Error('unused')},execute:async(r:any)=>{assert.equal(r.operation,'category_products');assert.deepEqual(r.input,{node_id:'1063294',amz_site:'US'});return {data,source:{connectorId:'sorftime' as const,operation:r.operation,fetchedAt:at,attemptCount:1}}}};}
test('current category_products collector reads array images, new rating fields and verified node rank',async()=>{
 const got=await collectSorftimeShapePoolPage({scope,jobId:'test',connector:connector()});assert.notEqual(got.status,'failed');if(got.status==='failed')return;
 assert.equal(got.evidence.operation,'category_products');assert.equal(got.categoryName,'Floor Lamps');
 assert.deepEqual([got.products[0].rating,got.products[0].ratingCount,got.products[0].sellerName,got.products[0].imageUrl,got.products[0].sourceRank],[4.4,11965,'Govee US',row.main_image[0],1]);
 const sample=projectSorftimeThemeSample({asin:row.asin,sourceIndex:0,product:got.products[0],productSource:{ref:'market-source:'+ 'a'.repeat(64),snapshotId:'market-input:'+'b'.repeat(64),payload,operation:'category_products',nodeId:'1063294'}});
 assert.deepEqual(sample.imageUrl.evidence?.path,['data',0,'main_image',0]);assert.deepEqual(sample.sourceRank.evidence?.path,['data',0,'sub_category',0,2]);
});
test('new pool rejects wrong node, conflicting duplicate, error envelopes and malformed shape, but accepts actual empty array',async()=>{
 for(const data of [{data:[{...row,sub_category:[['Desk Lamps','123',1]]}]},{data:[row,{...row,price:10}]},{success:false,...payload},{data:{category_stats_report:{}}},{data:[{...row,sub_category:[]}]}])assert.equal((await collectSorftimeShapePoolPage({scope,jobId:'test',connector:connector(data)})).status,'failed');
 assert.equal((await collectSorftimeShapePoolPage({scope,jobId:'test',connector:connector({data:[]})})).status,'empty');
});
test('legacy category_report remains exactly normalized without new aliases',()=>{
 const legacy={data:{top100_products:[{...row,main_image:row.main_image[0],category_rank:'Floor Lamps (Rank: 1)'}]}};
 const result=normalizeSorftimeShapePool(legacy,'category_report');assert.equal(result.products[0].rating,null);assert.equal(result.products[0].sellerName,null);assert.equal(result.products[0].sourceRank,1);
});

import {replaySorftimeShapePoolPages} from '../../server/services/market-shape-sorftime-reader';
import {createMarketInputSnapshot} from '../../server/domain/market-research/snapshot';
import {canonicalJsonSha256 as digest} from '../../server/runtime/model-request-accounting';
import type {MarketModuleRunView} from '../../server/db/market-module-execution-repository';
import type {PostgresMarketAnalysisSnapshotStore} from '../../server/db/postgres/market-analysis-snapshot-store';
test('legacy frozen pool replays with the original operation, evidence and snapshot',async()=>{
 const legacyPayload={data:{category_stats_report:{category_name:'Floor Lamps'},top100_products:[{asin:row.asin,title:'Lamp',category_rank:'Floor Lamps (Rank: 1)',main_image:row.main_image[0]}]}};
 const result=await collectSorftimeShapePoolPage({scope,jobId:'legacy',replayOperation:'category_report',now:()=>new Date(at),connector:{id:'sorftime',probe:async()=>{throw Error('unused')},execute:async r=>({data:legacyPayload,source:{connectorId:'sorftime',operation:r.operation,fetchedAt:at,attemptCount:1}})}});assert.notEqual(result.status,'failed');if(result.status==='failed')return;
 const sourceRef='market-source:'+digest(result.evidence),snapshot=createMarketInputSnapshot({scope,kind:'products',sourceVersion:'market-source-handlers/v1',ruleVersion:'source-normalization/v1',collectedAt:at,expectedRecordIds:[row.asin],records:result.products.map(product=>({id:product.asin,scope,data:{collection:'sorftime-shape-pool',product,sourceRef}}))});
 const view={run:{id:'71000000-0000-4000-8000-000000000002',scope,params:{poolSize:100}},steps:[{id:'step',kind:'collect-shape-pool',input:{poolSize:100}}],attempts:[{id:'attempt',stepId:'step',status:'succeeded',output:{sourceRef,inputSnapshotId:snapshot.snapshotId,productCount:1,productAsins:[row.asin],receivedCount:1,categoryName:'Floor Lamps'}}]} as unknown as MarketModuleRunView;
 const snapshots={findSource:async()=>({id:sourceRef,evidence:result.evidence}),findInput:async()=>({snapshot})} as unknown as PostgresMarketAnalysisSnapshotStore;
 const replay=await replaySorftimeShapePoolPages({view,actor:{organizationId:scope.organizationId,userId:'22222222-2222-4222-8222-222222222223'},snapshots,pageAttemptIds:['attempt']});
 assert.deepEqual(replay.pages[0].evidence,result.evidence);assert.deepEqual(replay.pages[0].snapshot,snapshot);
});
import {readFileSync} from 'node:fs';
test('saved real 100-product response replays offline with complete images and target node ranks',async()=>{
 const saved=JSON.parse(readFileSync(new URL('../fixtures/market-category-products-floor-lamp-20261013.json',import.meta.url),'utf8'));
 let calls=0;const result=await collectSorftimeShapePoolPage({scope,jobId:'offline-saved-response',now:()=>new Date(saved.source.fetchedAt),connector:{id:'sorftime',probe:async()=>{throw Error('No probe')},execute:async request=>{calls++;assert.equal(request.operation,'category_products');return saved;}}});
 assert.notEqual(result.status,'failed');if(result.status==='failed')return;
 assert.equal(calls,1);assert.equal(result.receivedCount,100);assert.equal(new Set(result.products.map(p=>p.asin)).size,100);assert.equal(result.products.filter(p=>p.imageUrl).length,100);
 const raw=saved.data.data[0],first=result.products.find(p=>p.asin===raw.asin)!;assert.equal(first.sourceRank,1);assert.notEqual(raw.subcategory_rank,first.sourceRank,'global subcategory_rank must not replace requested leaf rank');
 const sourceRef='market-source:'+digest(result.evidence),snapshot=createMarketInputSnapshot({scope,kind:'products',sourceVersion:'market-source-handlers/v1',ruleVersion:'source-normalization/v1',collectedAt:result.evidence.fetchedAt,expectedRecordIds:result.products.map(p=>p.asin),records:result.products.map(product=>({id:product.asin,scope,data:{collection:'sorftime-shape-pool',product,sourceRef}}))});
 const view={run:{id:'71000000-0000-4000-8000-000000000002',scope,params:{poolSize:100}},steps:[{id:'step',kind:'collect-shape-pool',input:{poolSize:100}}],attempts:[{id:'attempt',stepId:'step',status:'succeeded',output:{sourceRef,inputSnapshotId:snapshot.snapshotId,productCount:100,productAsins:result.products.map(p=>p.asin),receivedCount:100,categoryName:'Floor Lamps'}}]} as unknown as MarketModuleRunView;
 const snapshots={findSource:async()=>({id:sourceRef,evidence:result.evidence}),findInput:async()=>({snapshot})} as unknown as PostgresMarketAnalysisSnapshotStore;
 const replay=await replaySorftimeShapePoolPages({view,actor:{organizationId:scope.organizationId,userId:'22222222-2222-4222-8222-222222222223'},snapshots,pageAttemptIds:['attempt']});
 assert.equal(digest(replay.pages[0].evidence),digest(result.evidence));assert.equal(replay.pages[0].snapshot.snapshotId,snapshot.snapshotId);assert.equal(calls,1,'reading frozen evidence must not recollect');
});
for(const poolSize of [150,200])test(`category_products head preserves verified expansion up to ${poolSize}`,async()=>{
 const products=Array.from({length:100},(_,i)=>({...row,asin:'B'+String(i+1).padStart(9,'0'),sub_category:[['Floor Lamps','1063294',i+1]]}));
 const head=await collectSorftimeShapePoolPage({scope,poolSize,jobId:'head',connector:connector({data:products})});assert.notEqual(head.status,'failed');if(head.status==='failed')return;
 const expansion=await collectSorftimeShapePoolPage({scope,poolSize,page:1,categoryName:head.categoryName!,jobId:'expand',connector:{id:'sorftime',probe:async()=>{throw Error('No probe')},execute:async r=>{
  assert.equal(r.operation,'product_search');assert.equal(r.input.subcategory_sales_volume_rank_min,101);assert.equal(r.input.subcategory_sales_volume_rank_max,poolSize);
  return {data:{data:Array.from({length:poolSize-99},(_,i)=>({...row,asin:'B'+String(i+101).padStart(9,'0'),subcategory:`Floor Lamps (Rank: ${i+101})`}))},source:{connectorId:'sorftime',operation:r.operation,fetchedAt:at,attemptCount:1}};
 }}});assert.notEqual(expansion.status,'failed');if(expansion.status==='failed')return;
 assert.equal(new Set([...head.products,...expansion.products].map(p=>p.asin)).size,poolSize);assert.equal(expansion.products.at(-1)!.sourceRank,poolSize);
});
