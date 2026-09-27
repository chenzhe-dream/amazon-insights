import type {ReferenceGroupRow,ReferencePeriod} from './rules';

export type SectionSortMetric='label'|ReferencePeriod|`${ReferencePeriod}SharePct`|'linkCount'|'avgLast6MonthsMonthlyPerLink'|'avgY2025MonthlyPerLink';
export type SectionSort={metric:SectionSortMetric;dir:'asc'|'desc'}|null;
export const DEFAULT_SECTION_SORT={metric:'last6MonthsSharePct',dir:'desc'} as const;
export function toggleSectionSort(sort:SectionSort,metric:SectionSortMetric):SectionSort {
 const current=sort??DEFAULT_SECTION_SORT;
 return {metric,dir:current.metric===metric?(current.dir==='desc'?'asc':'desc'):metric==='label'?'asc':'desc'};
}
function value(row:ReferenceGroupRow,metric:Exclude<SectionSortMetric,'label'>):number|null {
 const n=metric.endsWith('SharePct')?row.sharePct[metric.slice(0,-8) as ReferencePeriod]
  :metric in row.sales?row.sales[metric as ReferencePeriod]:row[metric as 'linkCount'];
 return typeof n==='number'&&Number.isFinite(n)?n:null;
}
export function sortSectionRows(rows:readonly ReferenceGroupRow[],sort:SectionSort):ReferenceGroupRow[] {
 const {metric,dir}=sort??DEFAULT_SECTION_SORT,sign=dir==='asc'?1:-1;
 return [...rows].sort((a,b)=>{
  const names=a.label.localeCompare(b.label,'zh-CN',{numeric:true,sensitivity:'base'});
  if(metric==='label')return names*sign;
  const av=value(a,metric),bv=value(b,metric);
  if(av===null)return bv===null?names:1;
  if(bv===null)return -1;
  return (av-bv)*sign||names;
 });
}
/** The chosen metric orders whole groups; price bands within each group stay numeric ascending. */
export function sortGroupedPriceBands(rows:readonly ReferenceGroupRow[],groups:readonly ReferenceGroupRow[],sort:SectionSort,kind:'shape'|'brand'):ReferenceGroupRow[] {
 const order=new Map(sortSectionRows(groups,sort).map((row,index)=>[row.label,index]));
 const price=(row:ReferenceGroupRow)=>{const match=row.priceBand?.match(/\d+(?:\.\d+)?/);return match?Number(match[0]):Infinity};
 return [...rows].sort((a,b)=>{
  const group=(order.get(a[kind]??'')??Infinity)-(order.get(b[kind]??'')??Infinity);
  return (Number.isNaN(group)?0:group)||(a[kind]??'').localeCompare(b[kind]??'','zh-CN')||price(a)-price(b)||(a.priceBand??'').localeCompare(b.priceBand??'');
 });
}
