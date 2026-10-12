import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSorftimeCategoryRecords } from '../../scripts/build-sorftime-category-trend.mjs';
import * as listing from '../../scripts/lib/sorftime-listing-parse.mjs';
import { createProductDetailEvidence } from '../../scripts/lib/scoped-sorftime-evidence.mjs';
const asin = 'B0BWCQHCWX';
const current = { doc: {}, data: { asin, price: 59.99, a_plus: true, category: ['Home & Kitchen','home-garden'], sub_category: [['Chairs & Seats','14109871','5','20261012']] } };
async function category(raw) {
  return collectSorftimeCategoryRecords({key:'fixture',marketplace:'US',catalog:[{asin}],existing:{},fetchedAt:'2026-10-12',wait:async()=>{},callTool:async(_key,tool)=>tool==='product_detail'?raw:{'2026年09月':10}});
}
test('current identified category tuple resolves without top-level node', async()=>{
  const result=await category(current);
  assert.equal(result.nodePlan.get('14109871')?.categoryName,'Chairs & Seats');
  assert.equal(result.nodePlan.get('14109871')?.topCategory,'Home & Kitchen');
});
test('identified empty current category is empty; ambiguous and mismatched category reject',async()=>{
  const empty=await category({data:{asin,sub_category:[]}});
  assert.equal(empty.records[`asin-error:${asin}`].status,'empty');
  for(const data of [{...current.data,asin:'B0DPFDXJL3'},{...current.data,sub_category:[],node_id:'14109871'},{...current.data,sub_category:[['bad']]},{...current.data,sub_category:[...current.data.sub_category,['Other','999','1','20261012']]}]) {
    assert.equal((await category({data})).diagnostics[0]?.causeCode,'MCP_SCHEMA');
  }
});
test('scoped A+ without gallery must not short-circuit gallery collection',()=>{
  const evidence=createProductDetailEvidence({jobId:'job',marketplace:'US',asin,detail:{asin,a_plus:true}});
  assert.equal(listing.selectScopedListingRecord({evidence,requireScopedEvidence:true}),null);
});
test('content collection preserves detail signals and separate content provenance',async()=>{
  const calls=[];
  const result=await listing.collectListingProductData({asin,marketplace:'US',key:'fixture',detailEvidence:{data:{hasAplus:true}},callTool:async(_key,tool,args)=>{calls.push([tool,args]);return {data:{asin,main_image:['https://img.test/one.jpg'],a_plus_images:['https://img.test/aplus.jpg']}};}});
  assert.deepEqual(calls.map(([tool])=>tool),['product_content']);
  assert.equal(result.hasAplus,true);
  assert.deepEqual(result.galleryImages,['https://img.test/one.jpg']);
  assert.equal(result.operation,'product_content');
  await assert.rejects(listing.collectListingProductData({asin,marketplace:'US',key:'fixture',detailEvidence:{data:{hasAplus:true}},callTool:async()=>({data:{asin:'B0DPFDXJL3',main_image:['https://img.test/one.jpg']}})}),/ASIN/);
});
test('legacy direct galleries and same-job galleries require no content fetch',async()=>{
  for (const scoped of [true,false]) {
    const calls=[];
    const result=await listing.collectListingProductData({asin,marketplace:'US',key:'fixture',detailEvidence:scoped?{data:{galleryImages:['https://img.test/legacy.jpg'],hasAplus:false}}:null,callTool:async(_key,tool)=>{calls.push(tool);assert.equal(tool,'product_detail');return {asin,main_image:'https://img.test/legacy.jpg',a_plus:false};}});
    assert.deepEqual(calls,scoped?[]:['product_detail']);
    assert.equal(result.operation,'product_detail');
    assert.equal(result.hasAplus,false);
  }
});
test('image refresh requests content even when detail has a legacy gallery',async()=>{
  const calls=[];
  const result=await listing.collectListingProductData({asin,marketplace:'US',key:'fixture',refreshImages:true,detailEvidence:{data:{galleryImages:['https://img.test/old.jpg'],hasAplus:true}},callTool:async(_key,tool)=>{calls.push(tool);return {data:{asin,main_image:['https://img.test/new.jpg']}};}});
  assert.deepEqual(calls,['product_content']);
  assert.deepEqual(result.galleryImages,['https://img.test/new.jpg']);
});
test('image refresh retains a newly fetched legacy detail gallery without a content call',async()=>{
  const calls=[];
  const result=await listing.collectListingProductData({asin,marketplace:'US',key:'fixture',refreshImages:true,callTool:async(_key,tool)=>{calls.push(tool);assert.equal(tool,'product_detail');return {asin,main_image:['https://img.test/fresh.jpg'],a_plus:true};}});
  assert.deepEqual(calls,['product_detail']);
  assert.deepEqual(result.galleryImages,['https://img.test/fresh.jpg']);
});
test('content failures retain validated detail signals without claiming image readiness',async()=>{
  const upstream=new Error('fixture content failure');
  await assert.rejects(listing.collectListingProductData({asin,marketplace:'US',key:'fixture',detailEvidence:{data:{hasAplus:true}},callTool:async()=>{throw upstream;}}),error=>{
    assert.equal(error,upstream);
    assert.deepEqual(error.listingDetailSignals,{hasAplus:true,operation:'product_detail'});
    const record=listing.buildListingFailureRecord({asin,marketplace:'US',jobId:'job',fetchedAt:'2026-10-12',error});
    assert.equal(record.status,'error');
    assert.equal(record.hasAplus,true);
    assert.deepEqual(record.galleryImages,[]);
    assert.equal(record.provenance.operation,'product_detail');
    return true;
  });
});
test('gallery provenance identifies content tool and immutable collection scope',()=>{
  assert.deepEqual(listing.createDirectListingProvenance({jobId:'job',marketplace:'us',asin,fetchedAt:'2026-10-12',operation:'product_content'}),{jobId:'job',marketplace:'US',asin,fetchedAt:'2026-10-12',operation:'product_content',tool:'product_content',connector:'sorftime',stageId:'listing'});
});
test('identified empty content remains empty and A+ images never become gallery images',async()=>{
  const result=await listing.collectListingProductData({asin,marketplace:'US',key:'fixture',detailEvidence:{data:{hasAplus:true}},callTool:async()=>({data:{asin,main_image:[],a_plus_images:['https://img.test/aplus.jpg']}})});
  assert.deepEqual(result.galleryImages,[]);
  assert.equal(result.hasAplus,true);
});
test('current detail evidence retains tuple category and rejects a mismatched product',()=>{
  const evidence=createProductDetailEvidence({jobId:'job',marketplace:'US',asin,detail:current});
  assert.equal(evidence.data.nodeId,'14109871');
  assert.equal(evidence.data.categoryName,'Chairs & Seats');
  assert.equal(evidence.data.price,59.99);
  assert.throws(()=>createProductDetailEvidence({jobId:'job',marketplace:'US',asin,detail:{...current.data,asin:'B0DPFDXJL3'}}),/ASIN/);
});
