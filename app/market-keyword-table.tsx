'use client';
import React, {useState} from 'react';
import {marketSites} from '../shared/market-sites';
import {useMarketTableColumns} from './lib/market-table-columns';
import type {MarketKeywordFacts,MarketKeywordRunResponse} from '../shared/market-keyword-public-contracts';
import type {MarketKeywordReconciliationReport} from '../shared/market-keyword-reconciliation-contracts';
type Member=MarketKeywordFacts['members'][number];
type Sort='keyword'|'rank'|'volume'|`year:${string}`;
const dimensions=['W1','W2','W3','W4'] as const;
const format=(n:number|null)=>n===null?'未知':n.toLocaleString('zh-CN',{maximumFractionDigits:2});
function tagsFor(member:Member,facts:MarketKeywordFacts,catalog:MarketKeywordRunResponse['run']['params']['catalog']|undefined,reconciliation:MarketKeywordReconciliationReport|undefined){
 const global=reconciliation?.decisions.find(d=>d.keywordId===member.keywordId);
 if(global)return dimensions.flatMap(d=>global[d].status==='supported'?global[d].candidateIds.map(id=>({dimension:d,label:reconciliation!.catalog.find(c=>c.candidateId===id)?.label??'标签名称缺失'})):[]);
 return facts.semantics.batches.flatMap(batch=>{const row=batch.output.keywords.find(k=>k.keywordId===member.keywordId);return row?dimensions.flatMap(d=>{const cell=row[d];return cell.status==='supported'?cell.labelIds.map(id=>({dimension:d,label:batch.output.labelProposals?.find(p=>p.dimension===d&&p.labelId===id)?.label??catalog?.dimensionLabels[d].find(l=>l.labelId===id)?.label??'标签名称未取得'})):[];}):[];});
}
/** Only a full, known set of twelve calendar months can be labelled annual search volume. */
export function keywordAnnualVolume(member:Member,year:string){
 const months=Array.from({length:12},(_,i)=>member.trend.months.find(m=>m.month===`${year}-${String(i+1).padStart(2,'0')}`));
 return months.every(m=>m?.searchVolume.value!==null&&m?.searchVolume.value!==undefined)?months.reduce((n,m)=>n+m!.searchVolume.value!,0):null;
}
function Trend({member}:{member:Member}){
 const points=[...member.trend.months].sort((a,b)=>a.month.localeCompare(b.month));
 const known=points.filter(p=>p.searchVolume.value!==null);
 if(!known.length)return <span className="kw-trend-empty">{({pending:'待采集',failed:'采集失败',cancelled:'已取消',ready:'无有效月份',partial:'月份缺失',empty:'暂无趋势'})[member.trend.status]}</span>;
 const width=84,height=30,pad=2,minimum=Math.min(...known.map(p=>p.searchVolume.value!)),maximum=Math.max(...known.map(p=>p.searchVolume.value!));
 const ordinal=(month:string)=>Number(month.slice(0,4))*12+Number(month.slice(5));
 const first=ordinal(points[0].month),last=ordinal(points.at(-1)!.month);
 const plotted=points.map(p=>({...p,x:pad+(ordinal(p.month)-first)/(last-first||1)*(width-pad*2),y:p.searchVolume.value===null?null:pad+(1-(p.searchVolume.value-minimum)/(maximum-minimum||1))*(height-pad*2)}));
 return <div className="kw-trend-cell kw-trend-cell-interactive"><svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={`${member.keyword} 月搜索趋势；缺失月份断线`}><title>{points.map(p=>`${p.month}：${format(p.searchVolume.value)}`).join('；')}</title>{plotted.map((p,i)=>{const previous=plotted[i-1];return p.y===null?null:<React.Fragment key={p.month}>{previous?.y!==null&&previous?.y!==undefined&&ordinal(p.month)-ordinal(previous.month)===1?<line x1={previous.x} y1={previous.y} x2={p.x} y2={p.y} stroke="#2563eb" strokeWidth="1.5" strokeLinecap="round"/>:<circle cx={p.x} cy={p.y} r="1.5" fill="#2563eb"/>}</React.Fragment>;})}</svg></div>;
}

export function MarketKeywordTable({facts,catalog,reconciliation,details,queryName}:{queryName?:string;facts:MarketKeywordFacts;catalog?:MarketKeywordRunResponse['run']['params']['catalog'];reconciliation?:MarketKeywordReconciliationReport;details:(member:Member)=>React.ReactNode}){
 const [search,setSearch]=useState(''),[page,setPage]=useState(1),[pageSize,setPageSize]=useState(20),[sort,setSort]=useState<{metric:Sort;direction:'asc'|'desc'}>({metric:'volume',direction:'desc'});
 const tags=new Map(facts.members.map(m=>[m.keywordId,tagsFor(m,facts,catalog,reconciliation)]));
 const years=[...new Set(facts.members.flatMap(m=>m.trend.months.map(p=>p.month.slice(0,4))))].sort();
 const columnOrder=useMarketTableColumns([{id:'keyword',label:'关键词',width:240,fixed:true,stickyLeft:0},{id:'category',label:'关键词分类',width:180},{id:'trend',label:'热度趋势',width:128},{id:'season',label:'季节',width:90},{id:'rank',label:'周搜索排名',width:140},{id:'volume',label:'月搜索量',width:140},...years.map(year=>({id:`year:${year}`,label:`${year} 年搜索量`,width:160})),{id:'cpc',label:'CPC 建议',width:128}], '关键词');
 const filtered=facts.members.filter(m=>`${m.keyword} ${tags.get(m.keywordId)!.map(t=>t.label).join(' ')}`.toLowerCase().includes(search.trim().toLowerCase()));
 function value(m:Member):string|number|null{return sort.metric==='keyword'?m.keyword:sort.metric==='rank'?m.pageMetrics.weeklySearchRank.value:sort.metric==='volume'?m.reference.searchVolume:keywordAnnualVolume(m,sort.metric.slice(5));}
 const sorted=[...filtered].sort((a,b)=>{const av=value(a),bv=value(b);if(av===null)return bv===null?0:1;if(bv===null)return -1;return (typeof av==='string'?av.localeCompare(String(bv)):av-Number(bv))*(sort.direction==='asc'?1:-1);});
 const totalPages=Math.max(1,Math.ceil(sorted.length/pageSize)),current=Math.min(page,totalPages),shown=sorted.slice((current-1)*pageSize,current*pageSize);
 function header(metric:Sort,label:string){const active=sort.metric===metric;return <th aria-sort={active?(sort.direction==='asc'?'ascending':'descending'):'none'} className={active?'shape-price-sort-active':undefined}><button type="button" className={`shape-price-sort-btn${active?' active':''}`} onClick={()=>{setSort({metric,direction:active?(sort.direction==='desc'?'asc':'desc'):metric==='keyword'?'asc':'desc'});setPage(1);}}>{label}<span className="shape-price-sort-mark" aria-hidden="true">{active?(sort.direction==='desc'?'↓':'↑'):'↕'}</span></button></th>;}
 return <section className="card launch-block" aria-label="关键词事实明细"><div className="launch-section-head"><div className="launch-section-head-main"><h3>{queryName?`${queryName} · `:""}{marketSites.find(site=>site.code===facts.scope.marketplace)!.label} · 类目关键词洞察</h3><p>固定词池 {facts.members.length} 条 · 已取得 {facts.pool.receivedPageCount} 页 · 参考月 {facts.referenceMonth} · 排序与筛选覆盖全词池</p></div><div className="launch-section-head-tools"><span className="source-badge">来源事实</span><label className="st-keyword-table-search"><input type="search" aria-label="模糊搜索关键词" placeholder="模糊搜索关键词 / 分类" value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}}/>{search&&<button type="button" className="st-keyword-table-search-clear" aria-label="清除搜索" onClick={()=>{setSearch('');setPage(1);}}>×</button>}</label></div></div><div className="launch-section-body">
 <p className="market-research-note">月搜索量采用明确参考月；周排名与 CPC 建议来自来源未注明月份的指标。CPC 建议为 USD 推荐竞价，非实际 CPC。季节诊断尚无可验证结果，缺失年度月份不补全年总量。</p>
 <details className="market-insights-table-options"><summary>调整表格列顺序</summary>{columnOrder.controls}</details>
 {shown.length?<div className="launch-table-wrap launch-table-wrap-sticky" role="region" aria-label="关键词参考月指标" tabIndex={0} style={{maxHeight:'min(68vh, 560px)'}}><table className="launch-table shape-price-table" style={{minWidth:columnOrder.minWidth,tableLayout:'fixed'}}>{columnOrder.colgroup}<thead><tr>{columnOrder.cells(<>{header('keyword','关键词')}<th>关键词分类</th><th>热度趋势</th><th>季节</th>{header('rank','周搜索排名')}{header('volume','月搜索量')}{years.map(y=>header(`year:${y}`,`${y} 年搜索量`))}<th>CPC 建议</th></>,true)}</tr></thead><tbody>{shown.map(m=><tr key={m.keywordId}>{columnOrder.cells(<><th scope="row">{m.keyword}</th><td className="st-keyword-category-cell">{tags.get(m.keywordId)!.length?tags.get(m.keywordId)!.map((t,i)=><span key={i} className="kw-tag" style={{background:({W1:"#3b82f6",W2:"#8b5cf6",W3:"#10b981",W4:"#f59e0b"})[t.dimension]}} title={`${t.dimension} 语义建议，待校对`}>{t.dimension} {t.label}</span>):'未知（待分类）'}</td><td><Trend member={m}/></td><td>待验证</td><td>{format(m.pageMetrics.weeklySearchRank.value)}</td><td>{m.reference.searchVolume===null?'参考月未知':format(m.reference.searchVolume)}</td>{years.map(y=><td key={y}>{format(keywordAnnualVolume(m,y))}</td>)}<td>{m.pageMetrics.recommendedCpcUsd.value===null?'未知':`$${format(m.pageMetrics.recommendedCpcUsd.value)}`}</td></>)}</tr>)}</tbody></table></div>:<div className="pending-box">{search?`未匹配到「${search.trim()}」，请换关键词或清除搜索。`:'当前词池尚无关键词。'}</div>}
 <details><summary>当前页月份、来源指标与证据</summary>{shown.map(m=><section key={m.keywordId}><h4>{m.keyword}</h4>{details(m)}</section>)}</details>
 <div className="st-keyword-pagination"><button className="ss-market-reset-btn" type="button" disabled={current===1} aria-label="关键词事实明细首页" onClick={()=>setPage(1)}>首页</button><button className="ss-market-reset-btn" type="button" disabled={current===1} aria-label="关键词事实明细上一页" onClick={()=>setPage(current-1)}>上一页</button><span className="st-keyword-pagination-meta">第 {current} / {totalPages} 页 · 匹配 {sorted.length} / 全量 {facts.members.length} 条<label className="st-keyword-page-size">每页<select aria-label="关键词每页条数" value={pageSize} onChange={e=>{setPageSize(Number(e.target.value));setPage(1);}}>{[20,50,100].map(n=><option key={n}>{n}</option>)}</select>条</label></span><button className="ss-market-filter-btn" type="button" disabled={current===totalPages} aria-label="关键词事实明细下一页" onClick={()=>setPage(current+1)}>下一页</button></div></div></section>;
}
