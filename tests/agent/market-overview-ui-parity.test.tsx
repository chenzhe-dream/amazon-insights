import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MarketResearchSection,MarketOverviewResult} from '../../app/market-research-section';
import type {MarketOverviewReport} from '../../shared/market-research-contracts';
import {MarketOverviewMetricCards} from '../../app/market-overview-report';
import {overviewDetails} from './helpers/market-overview-page-fixture';
test('overview preserves supplied chip rows, search field and filter actions',()=>{
 const html=renderToStaticMarkup(<MarketResearchSection sessionIdentity="parity"/>);
 for(const cls of ['ss-market-query','ss-market-query-row','ss-market-chip','ss-market-node-field','ss-market-filter-btn','ss-market-reset-btn'])assert.ok(html.includes(cls),cls);
 for(const text of ['选择站点','选择月份','选择类目','筛选口径','筛选市场','重置条件','类目节点市场概览'])assert.ok(html.includes(text),text);
 assert.match(html,/英国站/);assert.match(html,/disabled=""[^>]*title="当前四模块的数据源支持范围尚未覆盖此站点"|title="当前四模块的数据源支持范围尚未覆盖此站点"[^>]*disabled=""/);
});

test('reference KPI groups use saved metrics and retain unknown head values and units',()=>{
 const metrics=overviewDetails().numbers.months[0].metrics;
 metrics.newCount={...metrics.totalUnits,value:0};
 metrics.productConcentrationRaw={...metrics.totalUnits,value:0.6,unit:{status:'unknown',rawUnit:null,reason:'unit-unknown'},reason:'unit-unknown'};
 const html=renderToStaticMarkup(<MarketOverviewMetricCards metrics={metrics} headTopN={20} newProductMonths={3}/>);
 assert.equal((html.match(/<article>/g)??[]).length,3);
 assert.match(html,/头部 Top 20/);assert.match(html,/上架 3 个月内/);
 assert.match(html,/<dd>42<\/dd>/);assert.match(html,/<b>0<\/b>/);
 assert.match(html,/头部平均价格尚无已保存指标/);
 assert.doesNotMatch(html,/60%|0\.6%/);
});
test('overview restores original table columns without manufacturing unavailable numbers',()=>{
 const report:MarketOverviewReport={schemaVersion:'market-overview/v1',scope:{marketplace:'US',nodeQuery:'123',month:'2026-08',headTopN:10,newProductMonths:6},nodeId:'123',nodeIdPath:'123',categoryName:'Lamps',currency:'USD',collectedAt:'2026-09-12T00:00:00.000Z',metrics:{sampleProducts:20,brands:null,sellers:null,totalUnits:100,totalRevenue:null,avgPrice:20,avgUnits:5,avgRatings:null,avgRating:null,productConcentrationRaw:0.6,brandConcentrationRaw:null,sellerConcentrationRaw:null,newCount:2,newAvgPrice:null,newAvgUnits:null},evidence:[],issues:[],boundaries:[]};
 const html=renderToStaticMarkup(<MarketOverviewResult report={report}/>);
 assert.match(html,/ss-niche-table/);for(const label of ['细分市场','月均销量 / 头部','退货率 / 同类目','操作'])assert.ok(html.includes(label),label);
 assert.match(html,/未知/);assert.doesNotMatch(html,/60%|0\.6%/);
});
