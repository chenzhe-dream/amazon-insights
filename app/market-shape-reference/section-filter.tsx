"use client";
import {TopSalesMultiSelectFilter} from './top-sales-multi-select-filter';
import type {TopSalesMultiSelectFilterState} from './multi-filter';
import type {ReactNode} from 'react';
import {DEFAULT_SECTION_SORT,toggleSectionSort,type SectionSort,type SectionSortMetric} from './sorting';
export {sortSectionRows,type SectionSort} from './sorting';
const metrics:[SectionSortMetric,string][]=[['label','名称'],['last3Months','近3个月销量'],['last3MonthsSharePct','近3个月占比'],['last6Months','近6个月销量'],['last6MonthsSharePct','近6个月占比'],['y2025','2025年销量'],['y2025SharePct','2025年占比'],['y2024','2024年销量'],['y2024SharePct','2024年占比'],['linkCount','链接数'],['avgLast6MonthsMonthlyPerLink','近6个月单链月均'],['avgY2025MonthlyPerLink','2025年单链月均']];
export function SectionSortButton({metric,sort,onSort,children}:{metric:SectionSortMetric;sort:SectionSort;onSort:(sort:SectionSort)=>void;children:ReactNode}){
 const current=sort??DEFAULT_SECTION_SORT,active=current.metric===metric;
 return <button type="button" className="shape-section-sort" onClick={()=>onSort(toggleSectionSort(sort,metric))} aria-label={`${String(children)}排序`} title={`按${String(children)}${active&&current.dir==='desc'?'升序':'降序'}排序`}>{children}<span aria-hidden="true">{active?(current.dir==='desc'?' ↓':' ↑'):' ↕'}</span></button>;
}
export function SectionFilter({name,options,filter,onFilter,sort,onSort}:{name:string;options:string[];filter:TopSalesMultiSelectFilterState;onFilter:(value:TopSalesMultiSelectFilterState)=>void;sort:SectionSort;onSort:(value:SectionSort)=>void}){
 const current=sort??DEFAULT_SECTION_SORT;
 return <div className="market-theme-actions"><TopSalesMultiSelectFilter prefix="本区范围" ariaLabel={`${name}局部筛选`} options={options} filter={filter} onChange={onFilter} searchable/><label>排序 <select aria-label={`${name}排序`} value={current.metric} onChange={e=>onSort({metric:e.target.value as SectionSortMetric,dir:current.dir})}>{metrics.map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label><button type="button" className="ghost-btn" aria-label={`${name}切换排序方向`} onClick={()=>onSort({...current,dir:current.dir==='asc'?'desc':'asc'})}>{current.dir==='asc'?'升序 ↑':'降序 ↓'}</button><span className="market-research-note">仅改变本区统计与结论，不改变商品纳入。</span></div>;
}
