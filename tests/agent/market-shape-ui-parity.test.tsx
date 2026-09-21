import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MarketShapeSection} from '../../app/market-shape-section';
import {MarketShapeReport} from '../../app/market-shape-report';
import {shapeRevision} from './helpers/market-shape-page-fixture';

test('shape entry keeps supplied site/category query composition and an empty report before any task',()=>{
 const html=renderToStaticMarkup(<MarketShapeSection selection={{nodeIdPath:'1:2:3',fromMonth:'2026-08',toMonth:'2026-08'}} onSelectionChange={()=>{}} maxMonth="2026-08"/>);
 assert.match(html,/ss-market-query--lilac/);
 assert.match(html,/选择站点/);
 assert.doesNotMatch(html,/<button[^>]*disabled=""[^>]*>日本站/);
 assert.match(html,/等待指定类目节点/);
 assert.match(html,/类目销量看板/);
});

test('empty shape dashboard describes the selected site',()=>{
 const html=renderToStaticMarkup(<MarketShapeSection selection={{marketplace:'JP',nodeIdPath:'1:2:3',fromMonth:'2026-08',toMonth:'2026-08'}} onSelectionChange={()=>{}} maxMonth="2026-08"/>);
 assert.match(html,/日本站 · 输入类目节点/);
 assert.doesNotMatch(html,/美国站\(com\) · 输入类目节点/);
});

test('saved shape report restores dashboard and shape subtotal presentation without inventing missing metrics',()=>{
 const report=shapeRevision();
 report.monthly.push({month:'2026-07',totalUnits:null,eligibleAsins:[]});
 const html=renderToStaticMarkup(<MarketShapeReport report={report}/>);
 assert.match(html,/category-trend-kpis category-trend-kpis-wide/);
 assert.match(html,/商品形态 · 销量占比分析/);
 assert.match(html,/商品形态 · 价格带分析/);
 assert.match(html,/shape-price-subtotal-row/);
 assert.match(html,/共同可比商品月销量趋势/);
 assert.match(html,/2026-07：未知/);
 assert.match(html,/可比销量：0/);
 assert.doesNotMatch(html,/近30天销量<\/span><b>0/);
 assert.doesNotMatch(html,/NaN|Infinity/);
});
import {MarketShapeProductTable} from '../../app/market-shape-product-table';
import {shapePageRun} from './helpers/market-shape-page-fixture';
test('product table preserves historical columns and never turns an incomplete window into a total',()=>{
 const run=shapePageRun().run;run.latestRevision=shapeRevision();
 const html=renderToStaticMarkup(<MarketShapeProductTable run={run} selected={[]} assignments={{}} disabled={false} onSelected={()=>{}} onAssignment={()=>{}} bands="0,20,40"/>);
 assert.match(html,/近3个月/);assert.match(html,/近6个月/);assert.match(html,/2025/);assert.match(html,/2024/);
 assert.match(html,/上架年份/);assert.match(html,/全选当前列表/);
 assert.doesNotMatch(html,/undefined|NaN/);
});

import {shapeStructureRevision} from './helpers/market-shape-page-fixture';
import {explanationPageRun} from './helpers/market-shape-explanation-page-fixture';
import {MarketShapeExplanationPresentationSchema} from '../../shared/market-shape-explanation-presentation';
import {shapeSavedPeriodColumns} from '../../app/market-shape-period-columns';

test('shape result preserves original report order, unavailable dimensions and saved conclusions',()=>{
 const report=shapeStructureRevision();
 const presentation=MarketShapeExplanationPresentationSchema.parse(explanationPageRun('succeeded',report.revisionId).run.presentation);
 presentation.dimensions.find(d=>d.dimension==='shape')!.summary.text='保存的形态结论原文';
 presentation.synthesis.summary.text='保存的综合判断原文';
 const html=renderToStaticMarkup(<MarketShapeReport report={report} presentation={presentation}/>);
 const headings=['上架年份分析','商品形态 · 销量占比分析','商品形态 · 价格带分析','品牌 · 价格带分析','类目商品链接调研 · 最终结论'];
 for(let index=1;index<headings.length;index++) assert.ok(html.indexOf(headings[index-1])<html.indexOf(headings[index]),headings.join(' -> '));
 assert.match(html,/保存的形态结论原文/);assert.match(html,/保存的综合判断原文/);
 assert.match(html,/按上架年份汇总的保存统计未提供/);assert.match(html,/原版综合评分<\/span><b>未提供/);
 assert.match(html,/年龄未知/);assert.match(html,/近3个月/);assert.match(html,/近6个月/);
 assert.doesNotMatch(html,/NaN|Infinity/);
 const stale={...presentation,revisionId:shapeRevision().revisionId};
 const staleHtml=renderToStaticMarkup(<MarketShapeReport report={report} presentation={stale}/>);
 assert.doesNotMatch(staleHtml,/保存的形态结论原文|保存的综合判断原文/);
});

test('historical column adapter selects only a matching saved window without aggregating or mutating',()=>{
 const report=shapeRevision(),before=JSON.stringify(report);
 const periods=shapeSavedPeriodColumns(report.scope);
 assert.deepEqual(periods.filter(period=>period.saved).map(period=>period.label),['2026-08 至 2026-08']);
 assert.deepEqual(periods.slice(0,4).map(period=>period.label),['近3个月','近6个月','2025','2024']);
 assert.equal(JSON.stringify(report),before);
 const matched=shapeSavedPeriodColumns({...report.scope,fromMonth:'2026-06'});
 assert.deepEqual(matched.filter(period=>period.saved).map(period=>period.label),['近3个月']);
 assert.equal(matched.length,4);
});
