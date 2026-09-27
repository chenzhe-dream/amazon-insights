"use client";
import {TopSalesMultiSelectFilter} from './top-sales-multi-select-filter';
import type {TopSalesMultiSelectFilterState} from './multi-filter';
import type {ReferenceGroupRow} from './rules';
export type SectionSort='source'|'volume'|'share'|'links'|'average';
export function sortSectionRows(rows:ReferenceGroupRow[],sort:SectionSort){
 const value=(row:ReferenceGroupRow)=>sort==='volume'?row.sales.last6Months:sort==='share'?row.sharePct.last6Months:sort==='links'?row.linkCount:row.avgLast6MonthsMonthlyPerLink;
 return sort==='source'?rows:[...rows].sort((a,b)=>value(a)===null?value(b)===null?0:1:value(b)===null?-1:value(b)!-value(a)!);
}
export function SectionFilter({name,options,filter,onFilter,sort,onSort}:{name:string;options:string[];filter:TopSalesMultiSelectFilterState;onFilter:(value:TopSalesMultiSelectFilterState)=>void;sort:SectionSort;onSort:(value:SectionSort)=>void}){
 return <div className="market-theme-actions"><TopSalesMultiSelectFilter prefix="本区范围" ariaLabel={`${name}局部筛选`} options={options} filter={filter} onChange={onFilter} searchable/><label>排序 <select aria-label={`${name}排序`} value={sort} onChange={e=>onSort(e.target.value as SectionSort)}><option value="source">原顺序</option><option value="volume">近6个月销量</option><option value="share">近6个月占比</option><option value="links">链接数</option><option value="average">近6个月单链月均</option></select></label><span className="market-research-note">仅改变本区统计与结论，不改变商品纳入。</span></div>;
}
