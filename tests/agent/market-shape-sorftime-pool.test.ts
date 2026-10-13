import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizeSorftimeShapePool,collectSorftimeShapePoolPage,resolveReferenceMarginEntry} from '../../server/services/market-shape-sorftime-pool';
const scope={organizationId:'22222222-2222-4222-8222-222222222222',researchId:'71000000-0000-4000-8000-000000000001',marketplace:'US',currency:'USD',nodeIdPath:'12:34',fromMonth:'2026-06',toMonth:'2026-08'} as const;
const row={asin:'B099WTN2TR',title:'Lamp',brand:'Brand',price:'29.99',monthly_sales_volume:'10',monthly_sales_amount:'290.5',gross_profit_margin:'70',category_rank:'Floor Lamps (Rank: 1)',online_date:'2021-07-01',main_image:'https://m.media-amazon.com/images/I/a.jpg'};
test('Sorftime report products retain source numbers and margin; unknown is not zero',()=>{
 const got=normalizeSorftimeShapePool({data:{category_stats_report:{},top100_products:[row,{...row,asin:'B07Z5NQPDS',price:'',gross_profit_margin:null,monthly_sales_volume:null}]}},'category_report');
 assert.equal(got.categoryName,'Floor Lamps');assert.equal(got.products[0].revenue,290.5);assert.equal(got.products[0].grossProfitMargin,70);assert.equal(got.products[0].imageUrl,row.main_image);
 assert.equal(got.products[1].price,null);assert.equal(got.products[1].units,null);assert.equal(got.products[1].grossProfitMargin,null);
 assert.deepEqual([null,0,49.9,50,60,70].map(resolveReferenceMarginEntry),['未知','不建议进入','不建议进入','谨慎进入','建议进入','优先进入']);
 assert.throws(()=>normalizeSorftimeShapePool({data:{top100_products:[row,{...row,price:'31'}]}},'category_report'));
});
test('non-positive Sorftime price is normalized to unknown',()=>{
 const got=normalizeSorftimeShapePool({data:{category_stats_report:{},top100_products:[{...row,price:0}]}},'category_report');
 assert.equal(got.products[0].price,null);
});
test('expansion filters other categories, handles duplicates, preserves source row positions',()=>{
 const got=normalizeSorftimeShapePool({data:[{...row,subcategory:'Desk Lamps (Rank: 101)'},{...row,subcategory:'Floor Lamps (Rank: 102)'},{...row,subcategory:'Floor Lamps (Rank: 102)'}]},'product_search','Floor Lamps');
 assert.equal(got.products.length,1);assert.equal(got.products[0].sourceIndex,1);assert.equal(got.products[0].sourceRank,102);
});
test('pool collector persists recent period and rejects currency/site mismatch',async()=>{
 const requests:unknown[]=[];const connector={id:'sorftime' as const,probe:async()=>{throw Error('unused')},execute:async(r:any)=>{requests.push(r);return {data:{data:{top100_products:[row]}},source:{connectorId:'sorftime' as const,operation:r.operation,fetchedAt:'2026-09-24T01:00:00.000Z',attemptCount:1}}}};
 const got=await collectSorftimeShapePoolPage({scope,jobId:'test',replayOperation:'category_report',connector});assert.notEqual(got.status,'failed');if(got.status==='failed')return;
 assert.equal(got.evidence.observationPeriod.kind,'trailing-days');assert.equal(got.evidence.requestIdentity.month,undefined);assert.equal(got.products.length,1);
 for(const data of [{currency:'EUR',data:{top100_products:[row]}},{data:{amz_site:'DE',top100_products:[row]}},{success:false,data:{top100_products:[row]}}])assert.equal((await collectSorftimeShapePoolPage({scope,jobId:'test',replayOperation:'category_report',connector:{...connector,execute:async r=>({data,source:{connectorId:'sorftime' as const,operation:r.operation,fetchedAt:'2026-09-24T01:00:00.000Z',attemptCount:1}})}})).status,'failed');
 assert.equal(requests.length,1);
});

test('expansion rejects unverified and out-of-request ranks even for the same category',()=>{
 const rows=[1,100,101,150,151,999].map((n,i)=>({...row,asin:`B${String(i).padStart(9,'0')}`,subcategory:`Floor Lamps (Rank: ${n})`}));
 const got=normalizeSorftimeShapePool({data:[...rows,{...row,subcategory:'Floor Lamps'}]},'product_search','Floor Lamps',150);
 assert.deepEqual(got.products.map(p=>p.sourceRank),[101,150]);
});

test('real report category rank format resolves the shared leaf instead of the first unrelated category',()=>{
 const got=normalizeSorftimeShapePool({data:{category_stats_report:{category_name:null},top100_products:[{...row,category_rank:'Category: Plant Growing Lamps, Rank: 1\r\nCategory: Floor Lamps, Rank: 72',product_category:'LAMP'},{...row,asin:'B000000002',category_rank:'Category: Floor Lamps, Rank: 2'}]}},'category_report');
 assert.equal(got.categoryName,'Floor Lamps');assert.equal(got.products.find(p=>p.asin===row.asin)!.sourceRank,72);
 const ambiguous=normalizeSorftimeShapePool({data:{top100_products:[{...row,category_rank:'Category: A, Rank: 1'},{...row,asin:'B000000002',category_rank:'Category: B, Rank: 2'}]}},'category_report');assert.equal(ambiguous.categoryName,null);
});
