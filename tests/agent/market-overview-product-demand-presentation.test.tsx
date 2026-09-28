import assert from 'node:assert/strict';import test from 'node:test';import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
import {MarketOverviewProductDemand} from '../../app/market-overview-product-demand';
const demand={status:'ready',points:[{month:'2026-06-01',value:200},{month:'2026-08-01',value:0}],asinCount:100,returnRatio:5.6257,avgReturnRatio:5.9325,searchToPurchaseRatio:3.27833,avgSearchToPurchaseRatio:null,sourceRef:'market-source:example',errorCode:null};
test('product demand preserves original percentage/per-mille units, zero and missing-month gap',()=>{
 const html=renderToStaticMarkup(<MarketOverviewProductDemand demand={demand}/>);
 assert.match(html,/5.63%/);assert.match(html,/3.28‰/);assert.match(html,/未返回/);
 assert.equal((html.match(/data-views-month=/g)??[]).length,2);assert.equal((html.match(/<polyline/g)??[]).length,0);
 assert.match(html,/商品总数/);assert.match(html,/类目浏览量趋势/);
});
test('product demand shows failed, empty, legacy and collecting states distinctly',()=>{
 assert.match(renderToStaticMarkup(<MarketOverviewProductDemand demand={{...demand,status:'failed',errorCode:'timeout'}}/>),/采集失败：请求超时/);
 assert.match(renderToStaticMarkup(<MarketOverviewProductDemand demand={{...demand,status:'empty',points:[]}}/>),/请求成功，但本次未返回/);
 assert.match(renderToStaticMarkup(<MarketOverviewProductDemand/>),/此历史报告尚未采集/);
 assert.match(renderToStaticMarkup(<MarketOverviewProductDemand hasStage/>),/尚未保存，请查看任务进度/);
});
test('single month keeps a visible centered point and cannot imply a trend',()=>{
 const html=renderToStaticMarkup(<MarketOverviewProductDemand demand={{...demand,points:[{month:'2026-08',value:0}]}}/>);
 assert.match(html,/cx="310"/);assert.match(html,/仅一个月/);assert.match(html,/查看 2026-08 浏览量/);
});
test('partial source keeps usable chart and metrics without offering an unavailable retry',()=>{
 const html=renderToStaticMarkup(<MarketOverviewProductDemand demand={{...demand,status:'partial',errorCode:'invalid-data'}}/>);
 assert.match(html,/已保留可用月份和指标/);assert.match(html,/类目浏览量趋势/);assert.match(html,/5.63%/);assert.doesNotMatch(html,/重试此来源/);
});
