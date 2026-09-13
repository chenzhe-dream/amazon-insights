import {MarketKeywordComparisonMonthsSchema,keywordComparisonMonthKeys} from '../../../shared/market-keyword-comparison-contracts';
import type {MarketKeywordTrendData} from '../../../shared/market-keyword-source-contracts';

/** Input is the collector's verified complete series, not only its display months. */
export function projectKeywordComparisonMonths(trend:MarketKeywordTrendData,referenceMonth:string){
 const points=new Map(trend.series.searchVolume.map(point=>[point.month,point.measurement]));
 if(points.size!==trend.series.searchVolume.length)throw new TypeError('Duplicate comparison source month');
 return MarketKeywordComparisonMonthsSchema.parse({version:'keyword-comparison-months/v1',referenceMonth,
  months:keywordComparisonMonthKeys(referenceMonth).map(month=>({month,searchVolume:points.get(month)??{value:null,reason:'missing'}}))});
}
