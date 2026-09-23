import {MarketShapeSourceMetadataSchema} from '../../shared/market-shape-source-metadata-contracts';
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MarketShapeReport} from '../../app/market-shape-report';
import {shapeRunSummary} from '../../app/market-shape-section';
import {MarketShapeProductTable} from '../../app/market-shape-product-table';
import {shapePageRun,shapeStructureRevision} from './helpers/market-shape-page-fixture';
import {buildMarketShapePeriodProjection} from '../../server/domain/market-research/shape-period-projection';
test('existing report tables display backend period and listing-year rows and explain the fixed cohort',()=>{
 const report=shapeStructureRevision();report.scope.fromMonth='2026-03';
 report.structure!.products[0].listing.value='2025-01-01';
 report.products[0].observations=['03','04','05','06','07','08'].map(m=>({month:`2026-${m}`,units:7,rawUnits:7,issues:[]}));
 report.periodProjection=buildMarketShapePeriodProjection(report);
 const html=renderToStaticMarkup(<MarketShapeReport report={report}/>);
 assert.ok(html.includes('21'));assert.ok(html.includes('42'));assert.ok(html.includes('market-shape-period-projection/v1'));
 assert.doesNotMatch(html,/按上架年份汇总的保存统计未提供/);
 assert.match(html,/共同可比/);assert.match(html,/test\/v1/);
});
test('existing product cells consume source metadata and backend period totals',()=>{
 const run=shapePageRun().run,field=(name:string,value:number|string)=>({rawValue:value,value,issues:[],evidence:{sourceRef:'market-source:'+'1'.repeat(64),inputSnapshotId:run.source!.referenceSnapshotId,payloadPath:['data',0,name]}});
 run.source!.products[0].metadata=MarketShapeSourceMetadataSchema.parse({basis:'reference-observation',referenceMonth:'2026-08',revenue:field('totalRevenue',123.45),rating:field('rating',4.7),ratingCount:field('ratings',81),sellerName:field('sellerName','Seller test'),sellerType:field('sellerType','FBA'),listedAt:field('shelfDate','2025-02-01')});
 const html=renderToStaticMarkup(<MarketShapeProductTable run={run} selected={[]} assignments={{}} disabled={false} onSelected={()=>{}} onAssignment={()=>{}} bands="0,20,40"/>);
 for(const value of ['123.45','4.7','81','Seller test','FBA','2025-02'])assert.ok(html.includes(value),value);
});

test('rules-only shape run and saved report show rule completion without implying a pending model',()=>{
 const run=shapePageRun().run;
 run.ruleStatus='complete';run.semanticStatus='skipped';
 assert.match(shapeRunSummary(run),/待人工确认/);
 run.latestRevision=shapeStructureRevision();
 assert.match(shapeRunSummary(run),/规则统计已保存/);
 run.status='failed';
 assert.match(shapeRunSummary(run),/规则统计已保存.*步骤失败/);
 run.status='partial';
 const html=renderToStaticMarkup(<MarketShapeReport report={run.latestRevision} semanticSkipped/>);
 assert.match(html,/商品形态 · 销量占比分析/);
 assert.match(html,/语义解释未启用/);
 assert.doesNotMatch(html,/模型仅提供建议|待生成解释|等待本版本的保存解释/);
 const historical=renderToStaticMarkup(<MarketShapeReport report={run.latestRevision}/>);
 assert.match(historical,/等待本版本的保存解释/);
 const products=renderToStaticMarkup(<MarketShapeProductTable run={run} selected={[]} assignments={{}} disabled={false} onSelected={()=>{}} onAssignment={()=>{}} bands="0,20,40"/>);
 assert.match(products,/人工确认与来源/);
 assert.doesNotMatch(products,/模型建议与依据|暂无建议/);
});
