import type {MarketShapeReferenceRevisionData} from '../../shared/market-shape-reference-revision-contracts';
import type {SorftimeCategoryDashboardReport,SorftimeProductSalesSummary} from '../market-shape-reference/types';
import {sumKnown,formatPriceBand,getReferencePeriodTotals} from '../market-shape-reference/rules';

/** Only persisted observations enter the original presentation. No network or model calls. */
export function toShapeReferenceReport(data:MarketShapeReferenceRevisionData):SorftimeCategoryDashboardReport {
 const stats=data.categoryDashboard.sources.find(s=>s.metric==='report')?.stats;
 const points=(metric:string)=>data.categoryDashboard.sources.find(s=>s.metric===metric)?.points??[];
 const products=data.pool.products.map(p=>{
  const volume=(data.productHistory.products.find(h=>h.asin===p.asin)?.points??[]).filter(v=>v.month<=data.scope.toMonth).sort((a,b)=>a.month.localeCompare(b.month));
  const amount=(data.productAmountHistory.products.find(h=>h.asin===p.asin)?.points??[]).filter(v=>v.month<=data.scope.toMonth).sort((a,b)=>a.month.localeCompare(b.month));
  const sales:SorftimeProductSalesSummary={last3Months:sumKnown(volume.slice(-3).map(v=>v.units)),last6Months:sumKnown(volume.slice(-6).map(v=>v.units)),y2024:sumKnown(volume.filter(v=>v.month.startsWith('2024-')).map(v=>v.units)),y2025:sumKnown(volume.filter(v=>v.month.startsWith('2025-')).map(v=>v.units)),monthsAvailable:volume.filter(v=>v.units!==null).length};
  return {rank:p.sourceRank??p.sourceIndex+1,asin:p.asin,title:p.title??'',brand:p.brand??'',imageUrl:data.productImages?.products.find(i=>i.asin===p.asin)?.imageUrl??p.imageUrl??'',monthlySalesVolume:p.units,monthlySalesAmount:p.revenue,sales,monthlyTrend:{volume:volume.map(v=>({month:v.month,value:v.units})),amount:amount.map(v=>({month:v.month,value:v.amount}))},price:p.price,categoryRank:p.categoryRank??'',productCategory:p.productCategory??'',productShape:'未分类',productShapeHint:null,bsrRank:p.sourceRank,deliveryType:p.sellerType??'',reviewCount:p.ratingCount,starRating:p.rating,seller:p.sellerName??'',sellerOrigin:p.sellerOrigin,onlineDate:p.listedAt,grossProfitMargin:p.grossProfitMargin,priceBand:formatPriceBand(p.price)};
 });
 const totals=getReferencePeriodTotals(products),total=(key:'last3Months'|'last6Months'|'y2024'|'y2025')=>totals[key];
 return {marketplace:data.scope.marketplace,sorftimeSite:data.scope.marketplace,nodeId:data.scope.nodeIdPath.split(':').at(-1)!,categoryName:data.pool.categoryName??data.scope.nodeIdPath,fetchedAt:data.pool.fetchedAt,
 note:'商品池为 Sorftime 抓取时近30天数据；月度销量与销售额来自独立历史来源。近3/6个月按原版取截至研究结束月最近返回的3/6个数据点，缺失不补零。已确认上市前的年份不适用，汇总贡献为0；上市后的缺失仍为未知。毛利润率为来源口径，不等同于净利润。',
 stats:{top100MonthlyVolume:stats?.top100Units??null,top100MonthlyAmount:stats?.top100Amount??null,top3ProductSharePct:stats?.top3ProductPct??null,top3BrandSharePct:stats?.top3BrandPct??null,top3SellerSharePct:stats?.top3SellerPct??null,amazonOwnedSharePct:stats?.amazonOwnedPct??null,averagePrice:stats?.averagePrice??null,medianPrice:stats?.medianPrice??null,returnRatePct:stats?.returnRatePct??null},
 history:{volume:points('SalesCount'),avgPrice:points('AvgPrice'),amount:data.categoryDashboard.estimatedAmount,listingMonopoly:points('Top3ProductSalesAmountShare'),brandMonopoly:points('Top3BrandSalesAmountShare'),sellerMonopoly:points('Top3SellerSalesAmountShare')},products,productSalesTotals:{last3Months:total('last3Months'),last6Months:total('last6Months'),y2024:total('y2024'),y2025:total('y2025'),monthsAvailable:Math.max(0,...products.map(p=>p.sales.monthsAvailable))},topLinkCount:products.length};
}
