'use client';
import React,{useState} from 'react';
import {LaunchSection,LaunchTable} from './launch-section';
import type {MarketKeywordRunResponse} from '../shared/market-keyword-public-contracts';
import type {MarketKeywordReconciliationReport} from '../shared/market-keyword-reconciliation-contracts';
import {keywordDimensions} from './market-keyword-result-view-model';

/** Reference taxonomy position, populated only with the saved task's actual vocabulary. */
export function MarketKeywordTaxonomyView({catalog,reconciliation,semanticSkipped=false}:{catalog?:MarketKeywordRunResponse['run']['params']['catalog'];reconciliation?:MarketKeywordReconciliationReport;semanticSkipped?:boolean}){
 const [open,setOpen]=useState(true);
 const rows=reconciliation?.catalog.filter(c=>c.dimension!=='cluster').map(c=>({id:c.candidateId,dimension:c.dimension,label:c.label,definition:c.definition}))??keywordDimensions.flatMap(([dimension])=>(catalog?.dimensionLabels[dimension]??[]).map(c=>({id:c.labelId,dimension,label:c.label,definition:c.definition})));
 return <LaunchSection title="关键词含义分类标准" description="当前任务保存的 W1–W4 标签与定义" badge={<button type="button" className="ghost-btn kw-toggle-taxonomy" aria-expanded={open} onClick={()=>setOpen(value=>!value)}>{open?'收起':'展开词表'}</button>}>
  <p className="category-cs-note">{semanticSkipped?'12 类含义分类尚未提供对应的已保存结果；以下是本次输入的 W1–W4 目录，保存目录未用于自动分类。':'12 类含义分类尚未提供对应的已保存结果；以下展示本次分析实际使用的 W1–W4 词表。'}</p>
  {open?(rows.length?<LaunchTable className="kw-taxonomy-table"><thead><tr><th>关键词类型</th><th>说明</th><th>维度</th></tr></thead><tbody>{rows.map(row=><tr key={`${row.dimension}:${row.id}`}><th>{row.label}</th><td>{row.definition}</td><td>{row.dimension}</td></tr>)}</tbody></LaunchTable>:<div className="pending-box">当前尚无可展示的已保存分类词表；未分类原词保留未知。</div>):<p className="launch-muted">点击「展开词表」查看本次保存的标签定义。</p>}
 </LaunchSection>;
}
