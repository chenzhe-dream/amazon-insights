import type {z} from 'zod';
import type {MarketOverviewDetailsResponseSchema} from '../../shared/market-overview-report-contracts';
import type {MarketOverviewDistributionEntry} from '../../shared/market-overview-distribution-contracts';
type Details=z.infer<typeof MarketOverviewDetailsResponseSchema>;
type Section={id:string;title:string;operation?:MarketOverviewDistributionEntry['operation'];missing?:string};
/** Original presentation order; no provider, scoring or inference runs here. */
export const overviewPresentationSections:readonly Section[]=[
 {id:'overview',title:'市场概览'},
 {id:'demand-keywords',title:'行业需求及趋势',missing:'当前总览报告尚未提供关键词搜索量序列。类目关键词洞察中的独立任务结果不会自动混入此报告。'},
 {id:'sales-trend',title:'行业销售趋势'},
 {id:'product-crn',title:'商品集中度',missing:'当前报告尚无商品集中度明细，不能从品牌或卖家分布代替推算。已保存的总体指标仍保留在顶部卡片。'},
 {id:'brand-crn',title:'品牌集中度',operation:'market_brand_concentration'},
 {id:'seller-crn',title:'卖家集中度',operation:'market_seller_concentration'},
 {id:'seller-type',title:'卖家类型分布',operation:'market_seller_type_concentration'},
 {id:'ebc',title:'A+视频分布',operation:'market_ebc_distribution'},
 {id:'seller-country',title:'卖家所属地分布',operation:'market_seller_country_distribution'},
 {id:'product-demand',title:'商品需求趋势',operation:'market_product_demand_trend'},
 {id:'listing-age',title:'上架时间分布',operation:'market_listing_date_distribution'},
 {id:'listing-trend',title:'上架趋势分布',operation:'market_listing_trend_distribution'},
 {id:'rating-count',title:'评分数分布',operation:'market_ratings_count_distribution'},
 {id:'rating-value',title:'评分值分布',operation:'market_rating_distribution'},
 {id:'price',title:'价格分布',operation:'market_price_distribution'},
];
export function selectOverviewDistributionEntries(entries:readonly MarketOverviewDistributionEntry[],operation:MarketOverviewDistributionEntry['operation']){
 return entries.filter(e=>e.operation===operation).sort((a,b)=>a.month.localeCompare(b.month));
}
/** Display saved monthly numeric facts; request-bound months remain explicitly marked. */
export function selectOverviewSalesPoints(detail:Details,metric:'totalUnits'|'totalRevenue'){
 return detail.numbers.months.flatMap(row=>{
  const saved=row.metrics[metric];
  if(!saved||saved.state!=='known'||saved.value===null||saved.unit?.status!=='known'||!saved.observations.length)return [];
  if(metric==='totalUnits'&&saved.unit.unit!=='count'||metric==='totalRevenue'&&(saved.unit.unit!=='currency'||saved.unit.currency!==detail.entry.report.scope.currency))return [];
  if(row.month<detail.entry.report.scope.fromMonth||row.month>detail.entry.report.scope.toMonth)return [];
  return [{month:row.month,value:saved.value,metricId:`${row.month}/${metric}`,requestBound:saved.observations.some(o=>o.scopeBasis==='request-bound')}];
 }).sort((a,b)=>a.month.localeCompare(b.month));
}

/** Single saved source value, labelled as a returned sample rather than a trend. */
export function selectOverviewReportedMetric(detail:Details,metric:string){
 const month=detail.entry.report.scope.toMonth;
 const saved=detail.numbers.months.find(row=>row.month===month)?.metrics[metric];
 if(!saved||saved.state!=='known'||saved.value===null||saved.unit?.status!=='known')return null;
 if(['sampleProducts','totalUnits','brands','sellers','newCount'].includes(metric)&&saved.unit.unit!=='count')return null;
 if(metric==='totalRevenue'&&(saved.unit.unit!=='currency'||saved.unit.currency!==detail.entry.report.scope.currency))return null;
 if(saved.observations.length===0)return null;
 return {month,value:saved.value,unit:saved.unit,requestBound:saved.observations.some(o=>o.scopeBasis==='request-bound')};
}

/** The upstream concentration number is visible without interpreting its unknown ratio/percent unit. */
export function selectOverviewRawConcentration(detail:Details){
 const saved=detail.numbers.months.find(row=>row.month===detail.entry.report.scope.toMonth)?.metrics.productConcentrationRaw;
 if(!saved||saved.state!=='missing'||saved.reason!=='unit-unknown'||saved.value!==null||saved.observations.length===0)return null;
 const values=saved.observations.map(o=>o.raw);
 if(!values.every(value=>typeof value==='number'&&Number.isFinite(value)&&value===values[0]))return null;
 return values[0] as number;
}
