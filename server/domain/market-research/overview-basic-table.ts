import {MarketOverviewTableMetricsSchema} from '../../../shared/market-overview-table-metrics';
import type {MarketResearchScope} from '../../../shared/market-research-contracts';

/** Called only after both aggregate responses have passed the collector's scope checks. */
export function projectBasicOverviewTableMetrics(main:Record<string,unknown>,stats:Record<string,unknown>,scope:MarketResearchScope){
  const n=(v:unknown):number|null=>{
    if(typeof v!=='number'&&(typeof v!=='string'||!v.trim()))return null;
    const x=Number(v);return Number.isFinite(x)&&x>=0?x:null;
  };
  const metric=(key:string)=>n(main[key])??n(stats[key]);
  const pct=(v:unknown)=>{const x=n(v);return x===null?null:x<=1?x*100:x;};
  const head=(key:string,fallback:string)=>{const x=n(main[`top${scope.headTopN}${key}`]);return x===null?n(stats[fallback]):x/scope.headTopN;};
  return MarketOverviewTableMetricsSchema.parse({
    hlAvgUnits:head('ProductSales','hlAvgUnits'),hlAvgRevenue:head('ProductRevenue','hlAvgRevenue'),
    avgRevenue:metric('avgRevenue'),avgBsr:metric('avgBsr'),hlAvgBsr:n(stats.hlAvgBsr),avgSellers:metric('avgSellers'),
    productCrn:pct(main[`top${scope.headTopN}ProductCrn`]),brandCrn:pct(main[`top${scope.headTopN}BrandCrn`]),sellerCrn:pct(main[`top${scope.headTopN}SellerCrn`]),
    newRatio:pct(main[`l${scope.newProductMonths}NewRatio`])??n(stats.newProductProportion),
    fbaProportion:n(main.fbaProportion),amazonSelfProportion:n(main.amazonSelfProportion),fbmProportion:n(main.fbmProportion),
    totalProducts:n(main.totalProducts),returnRatio:n(main.returnRatio),avgReturnRatio:n(main.avgReturnRatio),
  });
}
