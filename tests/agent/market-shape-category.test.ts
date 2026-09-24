import type {ShapeCategoryMetric} from '../../shared/market-shape-category-contracts';
import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizeShapeCategorySource,buildShapeCategoryDashboard} from '../../server/services/market-shape-category-collector';
const wrap=(metric:ShapeCategoryMetric,data:unknown)=>({metric,status:'ready' as const,sourceRef:'source',fetchedAt:'2026-09-24T01:00:00.000Z',...normalizeShapeCategorySource(metric,data,'2026-08')});
test('category fields preserve zero, percentages and unknowns; latest report is not historical August',()=>{
 const report=wrap('report',{data:{category_stats_report:{top100_monthly_sales_volume:'0',top100_monthly_sales_amount:'123.40',top3_product_sales_volume_share:'Top-3 products monthly sales share: 17.52%',average_price:'Top-80% products average price: 44.5785',return_rate:'Category return rate (last 30 days): 5.40%'}}});
 assert.equal(report.stats?.top100Units,0);assert.equal(report.stats?.top3ProductPct,17.52);assert.equal(report.stats?.averagePrice,44.5785);assert.equal(report.stats?.top3BrandPct,null);assert.equal(report.stats?.returnRatePct,5.4);
 assert.equal(normalizeShapeCategorySource('report',{data:{category_stats_report:{top100_monthly_sales_volume:'',top3_product_sales_volume_share:'17.52'}}},'2026-08').stats?.top3ProductPct,null);
});
test('category trends reject conflicting months and only derive amount where both sources exist',()=>{
 const volume=wrap('SalesCount',{data:['2026-06=10','2026-07=0','2026-08=20','2026-09=99']});
 const price=wrap('AvgPrice',{data:['2026-06=2.25','2026-08=3']});
 const share=wrap('Top3ProductSalesAmountShare',{data:['2026-06=17.82','2026-07=101','2026-08=20','2026-08=21']});
 const dashboard=buildShapeCategoryDashboard([volume,price,share],'USD','2026-08');
 assert.deepEqual(dashboard.estimatedAmount,[{month:'2026-06',value:22.5},{month:'2026-07',value:null},{month:'2026-08',value:60}]);
 assert.deepEqual(share.points,[{month:'2026-06',value:17.82},{month:'2026-07',value:null},{month:'2026-08',value:null}]);
 assert.throws(()=>normalizeShapeCategorySource('SalesCount',{error:'denied'},'2026-08'));
 assert.throws(()=>normalizeShapeCategorySource('SalesCount',{data:['2026-13=10']},'2026-08'));
});

test('collector rejects another category or site and preserves explicit failure as failure',async()=>{
 const {collectShapeCategory}=await import('../../server/services/market-shape-category-collector');
 const scope={organizationId:'22222222-2222-4222-8222-222222222222',researchId:'71000000-0000-4000-8000-000000000001',marketplace:'US',currency:'USD',nodeIdPath:'12:34',fromMonth:'2026-08',toMonth:'2026-08'} as const;
 for(const data of [{data:{category_stats_report:{node_id:'999',top100_monthly_sales_volume:'1'}}},{amz_site:'DE',data:{category_stats_report:{node_id:'34'}}},{currency:'EUR',data:{category_stats_report:{}}},{error:'rate limited',data:{category_stats_report:{}}}]){
  const result=await collectShapeCategory({scope,metric:'report',jobId:'test',connector:{id:'sorftime',probe:async()=>{throw Error('unused')},execute:async r=>({data,source:{connectorId:'sorftime',operation:r.operation,fetchedAt:new Date().toISOString(),attemptCount:1}})}});
  assert.equal(result.status,'failed');
 }
});
