import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MarketOverviewDistributions} from '../../app/market-overview-distributions';
import {MarketOverviewReferenceSections} from '../../app/market-overview-reference-sections';
import {normalizeMarketOverviewDistribution} from '../../server/domain/market-research/overview-distributions';
import {projectMarketOverviewOriginalSynthesis} from '../../server/domain/market-research/overview-original-synthesis';
import type {MarketOverviewDistribution} from '../../shared/market-overview-distribution-contracts';
import {overviewDistributionDetails,overviewScope} from './helpers/market-overview-page-fixture';
const render=(d:MarketOverviewDistribution,headTopN:number=10)=>renderToStaticMarkup(<MarketOverviewDistributions embedded headTopN={headTopN} entries={[{month:'2026-08',operation:d.operation,status:'partial',sourceRef:null,fetchedAt:null,scopeBasis:'request-bound',distribution:d,issues:[]}]}/>);
test('seller chart displays source-normalized product shares rather than counts',()=>{
 const d=normalizeMarketOverviewDistribution('market_seller_type_concentration',{data:[{label:'FBA',asinNum:120,units:90},{label:'FBM',asinNum:30,units:10}]});
 const html=render(d);assert.match(html,/商品占比与销量占比/);assert.match(html,/商品占比 80%/);assert.doesNotMatch(html,/商品占比 120%/);
 d.rows[0].productsSharePct=null;assert.match(render(d),/商品占比 不可计算/);
});
test('brand and seller charts use the saved overview headTopN instead of a hardcoded ten',()=>{
 const d=normalizeMarketOverviewDistribution('market_brand_concentration',{data:Array.from({length:6},(_,i)=>({brand:`Brand ${i+1}`,asins:[`B${String(i+1).padStart(9,'0')}`],products:1,totalUnits:10-i}))});
 const html=render(d,5);assert.match(html,/返回前5品牌/);assert.doesNotMatch(html,/返回前10品牌/);
});
test('A+ charts use separate complete sample and new-product denominators',()=>{
 const labels=['有A+有视频','有A+无视频','无A+有视频','无A+无视频'];
 const data=labels.flatMap((label,i)=>[{label,products:1,units:(i+1)*10},{label:`新品${label}`,products:1,units:5}]);
 const d=normalizeMarketOverviewDistribution('market_ebc_distribution',{data});const before=JSON.stringify(d),html=render(d);
 assert.equal((html.match(/class="overview-content-pie"/g)??[]).length,2);
 assert.match(html,/A\+视频销量占比/);assert.match(html,/新品A\+视频销量占比/);assert.match(html,/data-share="10"/);assert.match(html,/data-share="25"/);assert.equal(JSON.stringify(d),before);
 const missing=normalizeMarketOverviewDistribution('market_ebc_distribution',{data:data.filter(r=>r.label!=='新品无A+无视频')});
 const partial=render(missing);assert.match(partial,/销量占比分母未确认/);assert.equal((partial.match(/class="overview-content-pie"/g)??[]).length,1);
 const zero=normalizeMarketOverviewDistribution('market_ebc_distribution',{data:labels.map(label=>({label,products:0,units:0}))});
 assert.doesNotMatch(render(zero),/class="overview-content-pie"/);
});
test('price section exposes saved price-band detail without inventing margin',()=>{
 const detail=overviewDistributionDetails();
 const html=renderToStaticMarkup(<MarketOverviewReferenceSections entry={detail.entry} detail={detail} overview={null}/>);
 assert.match(html,/价格带明细/);
 assert.match(html,/价格区间中点（原版售价中位口径）/);
 assert.match(html,/需求效率/);
 assert.match(html,/0-15/);
 assert.match(html,/毛利率待验证/);
});

test('price-band detail does not fall back to a different saved month',()=>{
 const detail=overviewDistributionDetails();
 detail.numbers.distributions![0].month='2026-07';
 const html=renderToStaticMarkup(<MarketOverviewReferenceSections entry={detail.entry} detail={detail} overview={null}/>);
 assert.match(html,/当前报告月份未保存价格分布/);
 const priceDetail=html.slice(html.lastIndexOf('aria-label="价格带明细"'));
 assert.doesNotMatch(priceDetail,/0-15/);
});

test('chart sections show business explanations and omit technical chart notes',()=>{
 const detail=overviewDistributionDetails();
 const synthesis=projectMarketOverviewOriginalSynthesis({scope:overviewScope,parameters:{headTopN:10,newProductMonths:6},sources:[]});
 detail.numbers.chapterSynthesis={...synthesis,chapters:synthesis.chapters!.map(chapter=>({...chapter,conclusion:`${chapter.id}业务结论`}))};
 const html=renderToStaticMarkup(<MarketOverviewReferenceSections entry={detail.entry} detail={detail} overview={null}/>);
 assert.doesNotMatch(html,/按原版展示 Sorftime 类目历史/);
 assert.doesNotMatch(html,/月度数字与指标引用/);
 assert.match(html,/业务解释 · 依据不足/);
 assert.match(html,/数据表现/);
 assert.match(html,/数据含义/);
 assert.match(html,/业务结论/);
 assert.match(html,/sales-trend业务结论/);
 assert.match(html,/brand-crn业务结论/);
 assert.match(html,/price业务结论/);
});

test('chart sections show a clear fallback when chapter explanations are absent',()=>{
 const detail=overviewDistributionDetails();
 const html=renderToStaticMarkup(<MarketOverviewReferenceSections entry={detail.entry} detail={detail} overview={null}/>);
 assert.match(html,/当前报告暂无可用业务总结/);
});

test('product concentration preserves frozen title and per-ASIN monthly sales for drilldown',()=>{
 const d=normalizeMarketOverviewDistribution('market_product_concentration',{data:[{asin:'B000000001',title:'Sample Product',totalUnits:321,totalRevenue:1234}]});
 assert.deepEqual(d.rows[0]?.productItems?.[0],{asin:'B000000001',title:'Sample Product',units:321,imageUrl:null});
});
