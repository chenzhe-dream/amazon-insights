import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {overviewDistributionDetails,overviewAnalysisDetails} from './helpers/market-overview-page-fixture';
import {overviewPresentationSections,selectOverviewDistributionEntries,selectOverviewSalesPoints,selectOverviewReportedMetric} from '../../app/lib/market-overview-presentation';
import {MarketOverviewReportView} from '../../app/market-overview-report-view';
import {MarketOverviewSynthesis} from '../../app/market-overview-synthesis';
import {MarketOverviewReportSchema} from '../../shared/market-overview-report-contracts';
import {MarketOverviewDetailsResponseSchema} from '../../shared/market-overview-report-contracts';
import {synthesisDetails} from './helpers/market-overview-synthesis-page-fixture';
import {overviewReportStartMonth} from '../../app/lib/market-overview-period';
import {normalizeMarketOverviewDistribution} from '../../server/domain/market-research/overview-distributions';

test('opening a monthly result retains a chosen range or requests three completed months',()=>{
 assert.equal(overviewReportStartMonth('2026-08','2026-06'),'2026-06');
 assert.equal(overviewReportStartMonth('2026-08','2026-08'),'2026-06');
 assert.equal(overviewReportStartMonth('2026-01','2026-01'),'2025-11');
});

test('saved report keeps all fifteen original chapters in original order with visible missing states',()=>{
 const detail=overviewDistributionDetails();
 const html=renderToStaticMarkup(<MarketOverviewReportView entry={detail.entry} detail={detail} error={null} onRetry={()=>{}}/>);
 const sections=[...html.matchAll(/data-report-section="([^"]+)"/g)].map(m=>m[1]);
 assert.deepEqual(sections,overviewPresentationSections.map(s=>s.id));
 for(const text of ['行业需求及趋势','行业销售趋势','商品集中度','A+视频分布','商品需求趋势','价格分布','尚未提供关键词搜索量序列','42'])assert.ok(html.includes(text),text);
 assert.match(html,/50%/);assert.doesNotMatch(html,/99\.9%/);
 assert.match(html,/数据源未回显完整范围/);
});
test('presentation selection preserves source entry identity and deterministic month order',()=>{
 const detail=overviewDistributionDetails(),entry=detail.numbers.distributions![0];
 const earlier={...entry,month:'2026-07'};const input=[entry,earlier];
 const selected=selectOverviewDistributionEntries(input,'market_price_distribution');
 assert.equal(selected[0],earlier);assert.equal(selected[1],entry);assert.equal(input[0],entry);
 assert.deepEqual(selectOverviewDistributionEntries(input,'market_brand_concentration'),[]);
});
test('sales chart consumes saved monthly numeric facts without inventing missing months',()=>{
 const detail=overviewDistributionDetails();
 assert.deepEqual(selectOverviewSalesPoints(detail,'totalUnits'),[{month:'2026-08',value:42,metricId:'2026-08/totalUnits',requestBound:false}]);
 const missing=overviewAnalysisDetails();assert.deepEqual(selectOverviewSalesPoints(missing,'totalUnits'),[{month:'2026-08',value:0,metricId:'2026-08/totalUnits',requestBound:false}]);
 const html=renderToStaticMarkup(<MarketOverviewReportView entry={missing.entry} detail={missing} error={null} onRetry={()=>{}}/>);
 assert.match(html,/来源没有确认月份/);assert.match(html,/已保存的分段解释/);
 assert.doesNotMatch(html,/NaN|Infinity/);
});

test('monthly chart uses saved numeric source values when the semantic layer is skipped',()=>{
 const detail=overviewDistributionDetails();
 detail.semantic=null;
 const row=detail.numbers.months[0];
 row.metrics.totalUnits.observations[0].scopeBasis='request-bound';
 detail.numbers.months.push({...structuredClone(row),month:'2026-07',metrics:{...structuredClone(row.metrics),totalUnits:{...structuredClone(row.metrics.totalUnits),value:30}}});
 assert.deepEqual(selectOverviewSalesPoints(detail,'totalUnits'),[
  {month:'2026-07',value:30,metricId:'2026-07/totalUnits',requestBound:true},
  {month:'2026-08',value:42,metricId:'2026-08/totalUnits',requestBound:true},
 ]);
});

test('reported samples reject units that do not match the saved metric and scope',()=>{
 const detail=overviewDistributionDetails(),metric=detail.numbers.months[0].metrics.totalUnits;
 assert.ok(selectOverviewReportedMetric(detail,'totalUnits'));
 metric.unit={status:'known',unit:'currency',rawUnit:'currency',currency:'EUR'};
 assert.equal(selectOverviewReportedMetric(detail,'totalUnits'),null);
});

test('rule-only report shows saved sample facts and unconverted concentration raw value in the original chapters',()=>{
 const detail=overviewDistributionDetails();
 const report=detail.entry.report;
 report.semanticStatus='skipped';
 report.ruleStatus='partial';
 detail.semantic!.metrics[0].period={kind:'unknown',reason:'Source did not confirm the requested month'};
 const sample=detail.numbers.months[0].metrics.totalUnits;
 detail.numbers.months[0].metrics.sampleProducts={...structuredClone(sample),value:100,observations:sample.observations.map(o=>({...o,raw:100,value:100,field:'sampleProducts'}))};
 detail.numbers.months[0].metrics.productConcentrationRaw={state:'missing',value:null,unit:null,reason:'unit-unknown',observations:sample.observations.map(o=>({...o,raw:0.3583,value:0.3583,field:'productConcentrationRaw',unit:{status:'unknown',rawUnit:null,reason:'ratio or percent not confirmed'},reason:'unit-unknown'}))};
 const html=renderToStaticMarkup(<MarketOverviewReportView entry={detail.entry} detail={MarketOverviewDetailsResponseSchema.parse(detail)} error={null} onRetry={()=>{}}/>);
 assert.match(html,/本地规则结果已保存/);
 assert.doesNotMatch(html,/当前输入的分析分段已执行完成/);
 const overview=html.match(/data-report-section="overview"[\s\S]*?(?=data-report-section="demand-keywords")/)?.[0]??'';
 const sales=html.match(/data-report-section="sales-trend"[\s\S]*?(?=data-report-section="product-crn")/)?.[0]??'';
 const concentration=html.match(/data-report-section="product-crn"[\s\S]*?(?=data-report-section="brand-crn")/)?.[0]??'';
 assert.match(overview,/<dt>样本商品数<\/dt><dd>100<\/dd>/);
 assert.match(overview,/<dt>样本销量<\/dt><dd>42<\/dd>/);
 assert.match(sales,/42/);assert.match(sales,/单月样本|只有一个月/);
 assert.match(concentration,/0\.3583/);assert.match(concentration,/单位未确认/);
 assert.doesNotMatch(concentration,/35\.83%/);
});

test('product concentration uses its own returned-product denominator and preserves source limits',()=>{
 const detail=overviewDistributionDetails();
 const distribution=normalizeMarketOverviewDistribution('market_product_concentration',{code:'OK',data:[{asin:'B000000001',totalUnits:30},{asin:'B000000002',totalUnits:70}]});
 detail.numbers.distributions!.push({month:'2026-08',operation:'market_product_concentration',status:'partial',sourceRef:'market-source:example',fetchedAt:'2026-09-12T06:00:00.000Z',scopeBasis:'request-bound',distribution,issues:[{code:'identity-request-bound',retryable:false}]});
 const html=renderToStaticMarkup(<MarketOverviewReportView entry={detail.entry} detail={MarketOverviewDetailsResponseSchema.parse(detail)} error={null} onRetry={()=>{}} headTopN={1}/>);
 const product=html.match(/data-report-section="product-crn"[\s\S]*?(?=data-report-section="brand-crn")/)?.[0]??'';
 assert.match(html,/头部 Top 1 · 返回商品/);assert.match(html,/该商品接口返回样本的月销量占比/);
 assert.match(product,/B000000001/);assert.doesNotMatch(product,/B000000002/);
 assert.match(product,/30%/);assert.match(product,/2 条商品/);
 assert.match(product,/来源未回显类目和月份/);
});

test('section synthesis matches exact dimensions or colon-delimited groups and retains original evidence',()=>{
 const detail=synthesisDetails(),report=MarketOverviewReportSchema.parse(detail.entry.report),semantic=detail.semantic;
 if(report.reportVersion!=='market-overview-report/v2'||semantic?.task!=='market-overview-explanation')throw Error('saved overview synthesis required');
 const base=report.synthesis.dimensionChildren[0];
 const dimensions=[
  ['market_price_distribution:sample','保存的全样本价格结论'],
  ['market_price_distribution:new-products','保存的新品价格结论'],
  ['market_price_distribution_other:sample','不可串入的相似前缀结论'],
  ['market_brand_concentration:sample','不可串入的品牌结论'],
  ['sample-trend','保存的销量趋势结论'],
 ] as const;
 report.synthesis.dimensionChildren=dimensions.map(([dimensionId,text],index)=>({
  ...structuredClone(base),childId:`child:${index}`,leafSectionIds:[`leaf:${index}`],
  section:{...structuredClone(base.section),dimensionId,data:{...structuredClone(base.section.data),parts:[{kind:'text',text},...base.section.data.parts]}},
 }));
 const before=JSON.stringify(report.synthesis);
 const render=(dimensionPrefix:string)=>renderToStaticMarkup(<MarketOverviewSynthesis synthesis={report.synthesis} semantic={semantic} dimensionPrefix={dimensionPrefix}/>);
 const price=render('market_price_distribution');
 assert.match(price,/保存的全样本价格结论/);assert.match(price,/保存的新品价格结论/);
 assert.doesNotMatch(price,/不可串入|保存的销量趋势结论|跨维综合判断/);
 assert.match(price,/查看综合依据/);assert.match(price,/返回样本销量/);assert.match(price,/>0</);
 assert.ok(price.includes(semantic.metrics[0].metricId),'filtered child retains its metric identity');
 assert.ok(price.includes(semantic.facts[0].sourceRefs[0]),'filtered child retains its source identity');
 assert.match(price,/period-missing/);assert.match(price,/来源未确认/);
 const trend=render('sample-trend');assert.match(trend,/保存的销量趋势结论/);assert.doesNotMatch(trend,/价格结论|品牌结论/);
 assert.equal(render('market_seller_concentration'),'');
 assert.equal(JSON.stringify(report.synthesis),before,'filtering cannot mutate saved synthesis');
});
