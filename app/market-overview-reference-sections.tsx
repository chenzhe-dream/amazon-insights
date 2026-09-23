"use client";
import React from 'react';
import type {z} from 'zod';
import type {MarketOverviewDetailsResponseSchema,MarketOverviewReportEntrySchema} from '../shared/market-overview-report-contracts';
import {overviewPresentationSections,selectOverviewDistributionEntries,selectOverviewSalesPoints,selectOverviewReportedMetric,selectOverviewRawConcentration} from './lib/market-overview-presentation';
import {MarketOverviewDistributions} from './market-overview-distributions';
import {MarketOverviewSynthesis} from './market-overview-synthesis';
type Details=z.infer<typeof MarketOverviewDetailsResponseSchema>;
type Entry=z.infer<typeof MarketOverviewReportEntrySchema>;

function SavedSalesChart({detail}:{detail:Details}){
 const series=[{id:'totalUnits' as const,title:'样本月销量',unit:'件',points:selectOverviewSalesPoints(detail,'totalUnits')},{id:'totalRevenue' as const,title:'样本月销售额',unit:detail.entry.report.scope.currency,points:selectOverviewSalesPoints(detail,'totalRevenue')}];
 return <><p className="market-research-note">仅展示报告已保存的各月样本数据；缺月不补零，不把不同范围的样本当作全市场。未获来源范围回显的月份会单独标注。</p><div className="market-reference-sales-charts">{series.map(s=>{
  if(!s.points.length){const sample=selectOverviewReportedMetric(detail,s.id);return <div className="ss-report-empty" key={s.id}><strong>{s.title}</strong>{sample?<><p>{sample.month} 单月样本：{new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(sample.value)} {s.unit}</p><p>仅有单月返回样本，不能形成趋势；{sample.requestBound?'来源未回显确认范围。':'缺少可比较的第二个月。'}</p></>:<p>尚无已确认月份和单位的可展示序列。</p>}</div>;}
  const width=860,height=240,left=65,top=24,plotHeight=156,max=Math.max(1,...s.points.map(p=>p.value)),step=(width-left-25)/s.points.length;
  return <div className="ss-report-trend" key={s.id}><strong>{s.title} · {s.unit}</strong>{s.points.some(p=>p.requestBound)&&<p className="market-research-note">部分月份只按请求范围取得，来源未回显确认；曲线仅比较各月返回样本。</p>}{s.points.length===1&&<p className="market-research-note">目前只有一个月，不能判断升降趋势。</p>}<svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${s.title}已保存月度数据`}>
   {[0,1,2,3,4].map(i=><g key={i}><line x1={left} x2={width-25} y1={top+i*plotHeight/4} y2={top+i*plotHeight/4} stroke="#eef2f6" strokeDasharray="4 4"/><text x={left-10} y={top+i*plotHeight/4+4} textAnchor="end" className="ss-report-trend-axis">{Number((max*(1-i/4)).toFixed(1))}</text></g>)}
   {s.points.map((point,i)=>{const x=left+step*(i+.5),h=point.value/max*plotHeight;return <g key={point.metricId}><title>{`${point.month}：${point.value} ${s.unit}`}</title><rect x={x-12} y={top+plotHeight-h} width={24} height={h} rx={2} fill="#c4b5fd"/><circle cx={x} cy={top+plotHeight-h} r={3} fill="#7c3aed"/><text x={x} y={top+plotHeight+23} textAnchor="middle" className="ss-report-trend-axis">{point.month}</text></g>;})}
  </svg><details><summary>月度数字与指标引用</summary><ul>{s.points.map(point=><li key={point.metricId}>{point.month}：{point.value} {s.unit} · {point.metricId}</li>)}</ul></details></div>;
 })}</div>{detail.numbers.trendGaps.length>0&&<details><summary>趋势缺口</summary>{detail.numbers.trendGaps.map((gap,i)=><p key={i}>{gap.metricId}：{gap.reason}</p>)}</details>}</>;
}

function SavedOverviewFacts({detail}:{detail:Details}){
 const facts=[['样本商品数','sampleProducts'],['样本销量','totalUnits'],['品牌数','brands'],['卖家数','sellers'],['新品数','newCount']] as const;
 const known=facts.flatMap(([label,key])=>{const metric=selectOverviewReportedMetric(detail,key);return metric?[{label,value:new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(metric.value),requestBound:metric.requestBound}]:[];});
 if(!known.length)return null;
 return <div className="ss-report-facts"><strong>本次返回样本 · {detail.entry.report.scope.toMonth}</strong><dl>{known.map(f=><div key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}</dl>{known.some(f=>f.requestBound)&&<small>来源按该月请求，响应未回显确认范围；只描述返回样本。</small>}</div>;
}

function SavedProductConcentration({detail,headTopN}:{detail:Details;headTopN:number}){
 const source=detail.numbers.distributions?.find(e=>e.month===detail.entry.report.scope.toMonth&&e.operation==='market_product_concentration');
 const distribution=source?.distribution;
 if(distribution?.rows.length){
  const rows=distribution.rows.slice(0,headTopN),format=(value:number|null)=>value===null?'未知':new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(value);
  return <div className="market-reference-product-concentration"><p className="market-research-note">按来源顺序展示前 {rows.length} 条 Listing；销量占比以该接口返回的 {format(distribution.groups.find(g=>g.id==='sample')?.units??null)} 件销量为分母（共 {format(distribution.groups.find(g=>g.id==='sample')?.products??null)} 条商品），与顶部市场基础指标的样本不可混算。</p>
   {source?.scopeBasis==='request-bound'&&<p className="market-research-note">来源未回显类目和月份；以下仅为按所选条件返回的商品样本。</p>}
   <div className="market-overview-distribution-table" role="region" aria-label="商品集中度明细" tabIndex={0}><table><thead><tr><th scope="col">Listing</th><th scope="col">月销量</th><th scope="col">返回商品销量占比</th></tr></thead><tbody>{rows.map(row=><tr key={row.id}><th scope="row">{row.label}</th><td>{format(row.units)}</td><td>{row.unitsSharePct===null?'不可计算':`${format(row.unitsSharePct)}%`}</td></tr>)}</tbody></table></div>
   <details><summary>来源与分母</summary><p>来源：{source?.sourceRef}；采集时间：{source?.fetchedAt}。</p><p>返回商品总销量：{format(distribution.groups.find(g=>g.id==='sample')?.units??null)}；未验证为全类目 Top Listing。</p></details>
  </div>;
 }
 const raw=selectOverviewRawConcentration(detail);
 return raw===null?<p className="ss-report-empty">{overviewPresentationSections.find(s=>s.id==='product-crn')?.missing}</p>:<div className="ss-report-facts"><strong>商品集中度 · 来源原始值 {new Intl.NumberFormat('zh-CN',{maximumFractionDigits:6}).format(raw)}</strong><p>比例单位未确认，暂不换算百分比；商品 TopN 明细未保存，无法绘制集中度明细图。</p></div>;
}

/** Original chapter layout, over immutable saved report facts. */
export function MarketOverviewReferenceSections({entry,detail,overview,headTopN=10}:{entry:Entry;detail:Details;overview:React.ReactNode;headTopN?:number}){
 return <>{overviewPresentationSections.map(section=>{
  const entries=section.operation?selectOverviewDistributionEntries(detail.numbers.distributions??[],section.operation):[];
  return <section key={section.id} className="ss-report-block" data-report-section={section.id}><header><div><h4>{section.title}</h4><small>{entry.report.scope.fromMonth} 至 {entry.report.scope.toMonth} · 当前保存报告</small></div></header>
   {section.id==='overview'?<><SavedOverviewFacts detail={detail}/>{overview}</>:section.id==='sales-trend'?<SavedSalesChart detail={detail}/>:section.id==='product-crn'?<SavedProductConcentration detail={detail} headTopN={headTopN}/>:section.operation?entries.length?<MarketOverviewDistributions entries={entries} currency={entry.report.scope.currency} embedded/>:<p className="ss-report-empty">此版本尚无该维度的已保存数据，其他可用结果继续保留。</p>:<p className="ss-report-empty">{section.missing}</p>}
   {section.id==='listing-trend'&&<p className="market-research-note">上架时间分布反映返回样本的构成，不等于历年新增销量。</p>}
   {entry.report.reportVersion==='market-overview-report/v2'&&section.id!=='overview'&&(section.operation||section.id==='sales-trend')&&<MarketOverviewSynthesis synthesis={entry.report.synthesis} semantic={detail.semantic?.task==='market-overview-explanation'?detail.semantic:null} dimensionPrefix={section.operation??'sample-trend'}/>}
  </section>;
 })}</>;
}
