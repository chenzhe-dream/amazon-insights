import type {MarketKeywordGrowth,MarketKeywordMetric,MarketKeywordTrendData} from '../../../shared/market-keyword-source-contracts';
import type {MarketKeywordFacts} from '../../../shared/market-keyword-public-contracts';

function growth(value:number|null,month:string,delta:number,volumes:ReadonlyMap<string,MarketKeywordMetric<number>>):MarketKeywordGrowth{
 const [year,index]=month.split('-').map(Number);
 const baselineMonth=new Date(Date.UTC(year,index-1+delta,1)).toISOString().slice(0,7);
 const baselineValue=volumes.get(baselineMonth)?.value??null;
 const reason=value===null?'missing-current':baselineValue===null?'missing-baseline':baselineValue===0?'zero-baseline':null;
 return {value:reason===null?value!/baselineValue!-1:null,reason,baselineMonth,baselineValue,formulaVersion:'calendar-month-growth/v1'};
}
/** Call only after frozen-source replay. Research months and persisted snapshots stay unchanged. */
export function projectKeywordHistoryMonths(trend:MarketKeywordTrendData,referenceMonth:string):NonNullable<MarketKeywordFacts['members'][number]['trend']['historyMonths']>{
 const maps={searchVolume:new Map(trend.series.searchVolume.map(p=>[p.month,p.measurement])),searchRank:new Map(trend.series.searchRank.map(p=>[p.month,p.measurement])),recommendedBid:new Map(trend.series.recommendedBid.map(p=>[p.month,p.measurement]))};
 for(const key of ['searchVolume','searchRank','recommendedBid'] as const)if(maps[key].size!==trend.series[key].length)throw new TypeError('Duplicate history source month');
 const months=[...new Set([...Object.values(trend.series).flat().map(p=>p.month),...trend.months.map(p=>p.month)])].filter(month=>month<=referenceMonth).sort();
 const missing=():MarketKeywordMetric<number>=>({value:null,reason:'missing'});
 return months.map(month=>{
  const searchVolume=maps.searchVolume.get(month)??missing();
  return {month,searchVolume:{...searchVolume},searchRank:{...(maps.searchRank.get(month)??missing())},recommendedBid:{...(maps.recommendedBid.get(month)??missing())},
   yoyGrowth:growth(searchVolume.value,month,-12,maps.searchVolume),recentGrowth:growth(searchVolume.value,month,-1,maps.searchVolume)};
 });
}
