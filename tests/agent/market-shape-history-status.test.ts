import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {referenceSalesGapReason} from '../../app/market-shape-reference/history-status';
import {ReferenceHistoryCoverage} from '../../app/market-shape-reference/history-coverage';
import type {SorftimeCategoryDashboardProduct} from '../../app/market-shape-reference/types';
const product=(status?:NonNullable<SorftimeCategoryDashboardProduct["salesHistory"]>["status"],errorCode:string|null=null)=>({rank:1,title:'Lamp',brand:'Fixture',imageUrl:'',monthlySalesVolume:10,monthlySalesAmount:100,price:10,categoryRank:'',productCategory:'',productShape:'',productShapeHint:null,bsrRank:null,deliveryType:'',reviewCount:null,starRating:null,seller:'',sellerOrigin:null,grossProfitMargin:null,priceBand:'$10-20',asin:'B000000001',sales:{last3Months:null,last6Months:null,y2025:null,y2024:null,monthsAvailable:0},onlineDate:'2024-01',monthlyTrend:{volume:[],amount:[]},...(status?{salesHistory:{status,errorCode}}:{})}) as SorftimeCategoryDashboardProduct;
test('missing sales distinguish collection, failure, empty source and unconfirmed history',()=>{
 assert.match(referenceSalesGapReason(product('running'),'last6Months')!,/采集中/);
 assert.match(referenceSalesGapReason(product('queued'),'last6Months')!,/排队/);
 assert.match(referenceSalesGapReason(product('failed','timeout'),'last6Months')!,/请求失败.*超时/);
 assert.match(referenceSalesGapReason(product('empty'),'last6Months')!,/来源未返回/);
 assert.match(referenceSalesGapReason(product('ready'),'y2025')!,/来源未返回/);
 assert.match(referenceSalesGapReason(product(),'last6Months')!,/原因尚未确认/);
});
test('known zero and prelaunch periods do not become missing; inconsistent observations stay blocked',()=>{
 const p=product('ready');p.sales.last6Months=0;assert.equal(referenceSalesGapReason(p,'last6Months'),null);
 p.onlineDate='2026-08';assert.equal(referenceSalesGapReason(p,'y2025'),null);
 p.sales.y2025=10;assert.match(referenceSalesGapReason(p,'y2025')!,/冲突/);
});
test('a returned null point is a data validation issue instead of an upstream connection failure',()=>{
 const p=product('partial');p.monthlyTrend.volume=[{month:'2026-08',value:null}];assert.match(referenceSalesGapReason(p,'last6Months')!,/数据缺失或校验未通过/);
});
test('coverage separates prelaunch years and shows returned points without implying continuous months',()=>{
 const p=product('ready');p.onlineDate='2026-08-01';p.monthlyTrend.volume=[{month:'2026-06',value:10},{month:'2026-08',value:20}];
 const html=renderToStaticMarkup(createElement(ReferenceHistoryCoverage,{products:[p]}));
 assert.match(html,/2025年：可计算0\/1件，不适用1件/);
 assert.match(html,/近6个月：2–2\/6个返回点，范围2026-06～2026-08/);
 assert.match(html,/不代表连续自然月覆盖/);
});
