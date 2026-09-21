"use client";
import React from 'react';
import type {z} from 'zod';
import type {MarketOverviewDetailsResponseSchema,MarketOverviewReportEntrySchema} from '../shared/market-overview-report-contracts';
import {overviewPresentationSections,selectOverviewDistributionEntries,selectOverviewSalesPoints} from './lib/market-overview-presentation';
import {MarketOverviewDistributions} from './market-overview-distributions';
import {MarketOverviewSynthesis} from './market-overview-synthesis';
type Details=z.infer<typeof MarketOverviewDetailsResponseSchema>;
type Entry=z.infer<typeof MarketOverviewReportEntrySchema>;

function SavedSalesChart({detail}:{detail:Details}){
 const series=[{id:'totalUnits' as const,title:'样本月销量',unit:'件',points:selectOverviewSalesPoints(detail,'totalUnits')},{id:'totalRevenue' as const,title:'样本月销售额',unit:detail.entry.report.scope.currency,points:selectOverviewSalesPoints(detail,'totalRevenue')}];
 return <><p className="market-research-note">仅展示报告中已确认自然月的样本数据；缺月不补零，不把不同范围的样本当作全市场。</p><div className="market-reference-sales-charts">{series.map(s=>{
  if(!s.points.length)return <div className="ss-report-empty" key={s.id}><strong>{s.title}</strong><p>尚无已确认月份和单位的可展示序列。</p></div>;
  const width=860,height=240,left=65,top=24,plotHeight=156,max=Math.max(1,...s.points.map(p=>p.value)),step=(width-left-25)/s.points.length;
  return <div className="ss-report-trend" key={s.id}><strong>{s.title} · {s.unit}</strong><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${s.title}已保存月度数据`}>
   {[0,1,2,3,4].map(i=><g key={i}><line x1={left} x2={width-25} y1={top+i*plotHeight/4} y2={top+i*plotHeight/4} stroke="#eef2f6" strokeDasharray="4 4"/><text x={left-10} y={top+i*plotHeight/4+4} textAnchor="end" className="ss-report-trend-axis">{Number((max*(1-i/4)).toFixed(1))}</text></g>)}
   {s.points.map((point,i)=>{const x=left+step*(i+.5),h=point.value/max*plotHeight;return <g key={point.metricId}><title>{`${point.month}：${point.value} ${s.unit}`}</title><rect x={x-12} y={top+plotHeight-h} width={24} height={h} rx={2} fill="#c4b5fd"/><circle cx={x} cy={top+plotHeight-h} r={3} fill="#7c3aed"/><text x={x} y={top+plotHeight+23} textAnchor="middle" className="ss-report-trend-axis">{point.month}</text></g>;})}
  </svg><details><summary>月度数字与指标引用</summary><ul>{s.points.map(point=><li key={point.metricId}>{point.month}：{point.value} {s.unit} · {point.metricId}</li>)}</ul></details></div>;
 })}</div>{detail.numbers.trendGaps.length>0&&<details><summary>趋势缺口</summary>{detail.numbers.trendGaps.map((gap,i)=><p key={i}>{gap.metricId}：{gap.reason}</p>)}</details>}</>;
}

/** Original chapter layout, over immutable saved report facts. */
export function MarketOverviewReferenceSections({entry,detail,overview}:{entry:Entry;detail:Details;overview:React.ReactNode}){
 return <>{overviewPresentationSections.map(section=>{
  const entries=section.operation?selectOverviewDistributionEntries(detail.numbers.distributions??[],section.operation):[];
  return <section key={section.id} className="ss-report-block" data-report-section={section.id}><header><div><h4>{section.title}</h4><small>{entry.report.scope.fromMonth} 至 {entry.report.scope.toMonth} · 当前保存报告</small></div></header>
   {section.id==='overview'?overview:section.id==='sales-trend'?<SavedSalesChart detail={detail}/>:section.operation?entries.length?<MarketOverviewDistributions entries={entries} currency={entry.report.scope.currency} embedded/>:<p className="ss-report-empty">此版本尚无该维度的已保存数据，其他可用结果继续保留。</p>:<p className="ss-report-empty">{section.missing}</p>}
   {section.id==='listing-trend'&&<p className="market-research-note">上架时间分布反映返回样本的构成，不等于历年新增销量。</p>}
   {entry.report.reportVersion==='market-overview-report/v2'&&section.id!=='overview'&&(section.operation||section.id==='sales-trend')&&<MarketOverviewSynthesis synthesis={entry.report.synthesis} semantic={detail.semantic?.task==='market-overview-explanation'?detail.semantic:null} dimensionPrefix={section.operation??'sample-trend'}/>}
  </section>;
 })}</>;
}
