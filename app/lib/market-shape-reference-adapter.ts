import type {MarketShapeReferenceRevisionData} from '../../shared/market-shape-reference-revision-contracts';
import type {SorftimeCategoryDashboardReport,SorftimeProductSalesSummary} from '../market-shape-reference/types';
import {sumKnown,formatPriceBand,getReferencePeriodTotals} from '../market-shape-reference/rules';
import {resolveShapeMarginObservation} from '../../shared/market-shape-margin-observation';
import {calendarHistoryWindows,CALENDAR_HISTORY_POLICY} from '../../shared/product-history-windows';

/** Only persisted observations enter the original presentation. No network or model calls. */
export function toShapeReferenceReport(data:MarketShapeReferenceRevisionData):SorftimeCategoryDashboardReport {
 const stats=data.categoryDashboard.sources.find(s=>s.metric==='report')?.stats;
 const points=(metric:string)=>data.categoryDashboard.sources.find(s=>s.metric===metric)?.points??[];
 const products=data.pool.products.map(p=>{
  const volume=(data.productHistory.products.find(h=>h.asin===p.asin)?.points??[]).filter(v=>v.month<=data.scope.toMonth).sort((a,b)=>a.month.localeCompare(b.month));
  const amount=(data.productAmountHistory.products.find(h=>h.asin===p.asin)?.points??[]).filter(v=>v.month<=data.scope.toMonth).sort((a,b)=>a.month.localeCompare(b.month));
  const sales:SorftimeProductSalesSummary={last3Months:sumKnown(volume.slice(-3).map(v=>v.units)),last6Months:sumKnown(volume.slice(-6).map(v=>v.units)),y2024:sumKnown(volume.filter(v=>v.month.startsWith('2024-')).map(v=>v.units)),y2025:sumKnown(volume.filter(v=>v.month.startsWith('2025-')).map(v=>v.units)),monthsAvailable:volume.filter(v=>v.units!==null).length};
  const history=data.productHistory.products.find(h=>h.asin===p.asin);
  const calendar=history?.periodPolicy===CALENDAR_HISTORY_POLICY;
  const windows=calendar?calendarHistoryWindows(volume,data.scope.toMonth):[];
  if(calendar){
   const value=(id:string)=>windows.find(w=>w.id===id)?.value??null;
   Object.assign(sales,{last3Months:value('last-3'),last6Months:value('last-6'),y2024:value('year-2024'),y2025:value('year-2025')});
  }
  const margin=resolveShapeMarginObservation(p,data.productImages?.products.find(i=>i.asin===p.asin));
  const price=typeof p.price==='number'&&Number.isFinite(p.price)&&p.price>0?p.price:null;
  return {salesHistory:history?{status:history.status,errorCode:history.errorCode,...(calendar?{periodPolicy:CALENDAR_HISTORY_POLICY,windowGaps:Object.fromEntries(windows.map(w=>[w.id,w.missingMonths]))}:{})}:undefined,rank:p.sourceRank??p.sourceIndex+1,asin:p.asin,title:p.title??'',brand:p.brand??'',imageUrl:data.productImages?.products.find(i=>i.asin===p.asin)?.imageUrl??p.imageUrl??'',monthlySalesVolume:p.units,monthlySalesAmount:p.revenue,sales,monthlyTrend:{volume:volume.map(v=>({month:v.month,value:v.units})),amount:amount.map(v=>({month:v.month,value:v.amount}))},price,categoryRank:p.categoryRank??'',productCategory:p.productCategory??'',productShape:'未分类',productShapeHint:null,bsrRank:p.sourceRank,deliveryType:p.sellerType??'',reviewCount:p.ratingCount,starRating:p.rating,seller:p.sellerName??'',sellerOrigin:p.sellerOrigin,onlineDate:p.listedAt,grossProfitMargin:margin.value,marginSource:{basis:margin.basis,note:margin.note},priceBand:formatPriceBand(price,data.scope.currency)};
 });
 const totals=getReferencePeriodTotals(products,data.calculationVersion??'shape-reference/1'),total=(key:'last3Months'|'last6Months'|'y2024'|'y2025')=>totals[key];
 return {calculationVersion:data.calculationVersion??'shape-reference/1',marketplace:data.scope.marketplace,sorftimeSite:data.scope.marketplace,nodeId:data.scope.nodeIdPath.split(':').at(-1)!,categoryName:data.pool.categoryName??data.scope.nodeIdPath,fetchedAt:data.pool.fetchedAt,
 note:`商品池为 ${data.pool.provider==='sellerSprite'?'卖家精灵插件':data.pool.provider==='mixed'?'多来源':'Sorftime'} 原采集时点的近30天数据；月度销量与销售额来自独立历史来源。${data.productHistory.products.some(h=>h.periodPolicy===CALENDAR_HISTORY_POLICY)?'新版插件历史按近3月、近6月和全年分别校验完整日历窗口；缺失月份待补，不补零，已有有效窗口参与分析。旧来源仍保留各自保存口径。':'近3/6个月按原版取截至研究结束月最近返回的3/6个数据点，缺失不补零。已确认上市前的年份不适用，汇总贡献为0；上市后的缺失仍为未知。'}毛利润率为来源口径，不等同于净利润。`,
 stats:{top100MonthlyVolume:stats?.top100Units??null,top100MonthlyAmount:stats?.top100Amount??null,top3ProductSharePct:stats?.top3ProductPct??null,top3BrandSharePct:stats?.top3BrandPct??null,top3SellerSharePct:stats?.top3SellerPct??null,amazonOwnedSharePct:stats?.amazonOwnedPct??null,averagePrice:stats?.averagePrice??null,medianPrice:stats?.medianPrice??null,returnRatePct:stats?.returnRatePct??null},
 history:{volume:points('SalesCount'),avgPrice:points('AvgPrice'),amount:data.categoryDashboard.estimatedAmount,listingMonopoly:points('Top3ProductSalesAmountShare'),brandMonopoly:points('Top3BrandSalesAmountShare'),sellerMonopoly:points('Top3SellerSalesAmountShare')},products,productSalesTotals:{last3Months:total('last3Months'),last6Months:total('last6Months'),y2024:total('y2024'),y2025:total('y2025'),monthsAvailable:Math.max(0,...products.map(p=>p.sales.monthsAvailable))},topLinkCount:products.length};
}
