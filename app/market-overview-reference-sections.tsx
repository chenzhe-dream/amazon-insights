"use client";
import React,{useId,useState} from 'react';
import type {z} from 'zod';
import type {MarketOverviewDetailsResponseSchema,MarketOverviewReportEntrySchema} from '../shared/market-overview-report-contracts';
import {overviewPresentationSections,selectOverviewDistributionEntries,selectOverviewSalesPoints,selectOverviewReportedMetric,selectOverviewRawConcentration} from './lib/market-overview-presentation';
import {MarketOverviewDistributions} from './market-overview-distributions';
import {MarketOverviewConcentrationChart} from './market-overview-concentration-chart';
import {MarketOverviewDemandTrend} from './market-overview-demand-trend';
import {MarketOverviewSynthesis} from './market-overview-synthesis';
type Details=z.infer<typeof MarketOverviewDetailsResponseSchema>;
type Entry=z.infer<typeof MarketOverviewReportEntrySchema>;

function SavedSalesChart({detail}:{detail:Details}){
 const [hover,setHover]=useState<string|null>(null);
 const volume=selectOverviewSalesPoints(detail,'totalUnits'),amount=selectOverviewSalesPoints(detail,'totalRevenue');
 const volumeByMonth=new Map(volume.map(point=>[point.month,point]));
 const amountByMonth=new Map(amount.map(point=>[point.month,point]));
 const months=Array.from(new Set([...volume,...amount].map(point=>point.month))).sort();
 const format=(n:number)=>new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(n);
 const width=920,height=228,left=46,right=52,top=26,chartHeight=174,chartWidth=width-left-right;
 const maxVolume=Math.max(1,...volume.map(point=>point.value)),maxAmount=Math.max(1,...amount.map(point=>point.value));
 const x=(index:number)=>left+(index+.5)*chartWidth/Math.max(months.length,1);
 const yVolume=(n:number)=>top+(1-n/maxVolume)*chartHeight,yAmount=(n:number)=>top+(1-n/maxAmount)*chartHeight;
 const amountSegments:string[][]=[];let segment:string[]=[];
 months.forEach((month,index)=>{const point=amountByMonth.get(month);if(point){segment.push(`${x(index)},${yAmount(point.value)}`);}else if(segment.length){amountSegments.push(segment);segment=[];}});
 if(segment.length)amountSegments.push(segment);
 const requestBound=[...volume,...amount].some(point=>point.requestBound);
 return <><p className="market-research-note">仅展示报告已保存的各月样本数据；缺月不补零，不把不同范围的样本当作全市场。</p>
  {months.length===0?<p className="ss-report-empty">尚无已确认月份和单位的销量、销售额序列。</p>:<div className="ss-report-trend">
   <div className="ss-report-trend-legend"><span><i style={{background:'#c4b5fd'}}/>样本月销量{volume.length?` · ${format(volume.at(-1)!.value)} 件`:''}</span><span><i className="ss-report-legend-line"/>样本月销售额{amount.length?` · ${detail.entry.report.scope.currency} ${format(amount.at(-1)!.value)}`:' · 尚未取得'}</span></div>
   {requestBound&&<p className="market-research-note">部分月份来源未回显确认范围；图中仅比较各月返回样本。</p>}
   {months.length===1&&<p className="market-research-note">目前只有一个月，不能判断升降趋势。</p>}
   <div className="ss-report-trend-stage"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="样本月销量与月销售额趋势" onMouseLeave={()=>setHover(null)}>
    <text x={left} y={12} className="ss-dist-axis-title">月销量</text><text x={width-right} y={12} textAnchor="end" className="ss-dist-axis-title">月销售额</text>
    {[0,1,2,3].map(i=><line key={i} x1={left} x2={width-right} y1={top+i*chartHeight/3} y2={top+i*chartHeight/3} stroke="#eef2f6" strokeDasharray="4 4"/>)}
    {[.25,.5,.75,1].map(ratio=><g key={ratio}><text x={left-8} y={yVolume(maxVolume*ratio)+3} textAnchor="end" className="ss-report-trend-axis">{volume.length?format(maxVolume*ratio):'—'}</text><text x={width-right+8} y={yAmount(maxAmount*ratio)+3} className="ss-report-trend-axis">{amount.length?format(maxAmount*ratio):'—'}</text></g>)}
    {months.map((month,index)=>{const point=volumeByMonth.get(month);return point?<rect key={`bar-${month}`} x={x(index)-8} y={yVolume(point.value)} width={16} height={Math.max(1,top+chartHeight-yVolume(point.value))} fill="#c4b5fd" rx={2}/>:null;})}
    {amountSegments.filter(points=>points.length>1).map((points,index)=><polyline key={index} points={points.join(' ')} fill="none" stroke="#7c3aed" strokeWidth={2.2}/>)}
    {months.map((month,index)=>{const point=amountByMonth.get(month);return point?<circle key={`amount-${month}`} cx={x(index)} cy={yAmount(point.value)} r={3} fill="#fff" stroke="#7c3aed" strokeWidth={2}/>:null;})}
    {months.map((month,index)=><g key={month}><text x={x(index)} y={height-8} textAnchor="middle" className="ss-report-trend-axis">{month}</text><rect x={x(index)-chartWidth/months.length/2} y={0} width={chartWidth/months.length} height={height} fill="transparent" onMouseMove={()=>setHover(month)}/></g>)}
   </svg>{hover&&<div className="ss-report-trend-tip"><b>{hover}</b><span>月销量 {volumeByMonth.has(hover)?`${format(volumeByMonth.get(hover)!.value)} 件`:'未取得'}</span><span>月销售额 {amountByMonth.has(hover)?`${detail.entry.report.scope.currency} ${format(amountByMonth.get(hover)!.value)}`:'未取得'}</span></div>}</div>
   <details><summary>月度数字与指标引用</summary><ul>{months.map(month=><li key={month}>{month}：月销量 {volumeByMonth.has(month)?`${format(volumeByMonth.get(month)!.value)} 件 · ${volumeByMonth.get(month)!.metricId}`:'未取得'}；月销售额 {amountByMonth.has(month)?`${detail.entry.report.scope.currency} ${format(amountByMonth.get(month)!.value)} · ${amountByMonth.get(month)!.metricId}`:'未取得'}</li>)}</ul></details>
  </div>}{detail.numbers.trendGaps.length>0&&<details><summary>趋势缺口</summary>{detail.numbers.trendGaps.map((gap,i)=><p key={i}>{gap.metricId}：{gap.reason}</p>)}</details>}</>;
}

function SavedOverviewFacts({detail}:{detail:Details}){
 const facts=[['样本商品数','sampleProducts'],['样本销量','totalUnits'],['品牌数','brands'],['卖家数','sellers'],['新品数','newCount']] as const;
 const known=facts.flatMap(([label,key])=>{const metric=selectOverviewReportedMetric(detail,key);return metric?[{label,value:new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(metric.value),requestBound:metric.requestBound}]:[];});
 if(!known.length)return null;
 return <div className="ss-report-facts"><strong>本次返回样本 · {detail.entry.report.scope.toMonth}</strong><dl>{known.map(f=><div key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}</dl>{known.some(f=>f.requestBound)&&<small>来源按该月请求，响应未回显确认范围；只描述返回样本。</small>}</div>;
}

function SavedProductConcentration({detail,headTopN}:{detail:Details;headTopN:number}){
 const [expanded,setExpanded]=useState(false),bodyId=useId();
 const source=detail.numbers.distributions?.find(e=>e.month===detail.entry.report.scope.toMonth&&e.operation==='market_product_concentration');
 const distribution=source?.distribution;
 if(distribution?.rows.length){
  const rows=distribution.rows.slice(0,headTopN),format=(value:number|null)=>value===null?'未知':new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(value);
  return <div className="market-reference-product-concentration"><p className="market-research-note">图表按来源顺序展示返回商品，明细表展示前 {rows.length} 条 Listing；销量占比以该接口返回的 {format(distribution.groups.find(g=>g.id==='sample')?.units??null)} 件销量为分母（共 {format(distribution.groups.find(g=>g.id==='sample')?.products??null)} 条商品），与顶部市场基础指标的样本不可混算。</p>
   {source?.scopeBasis==='request-bound'&&<p className="market-research-note">来源未回显类目和月份；以下仅为按所选条件返回的商品样本。</p>}
   <MarketOverviewConcentrationChart rows={distribution.rows.filter(row=>row.group==='sample')} kind="product" headTopN={headTopN} currency={distribution.currency}/>
   <div className="market-overview-distribution-table overview-product-details" role="region" aria-label="商品集中度明细" tabIndex={0}><table><thead><tr><th scope="col">Listing</th><th scope="col">月销量</th><th scope="col"><span className="overview-detail-heading">返回商品销量占比<button type="button" aria-expanded={expanded} aria-controls={bodyId} aria-label={expanded?'收起商品明细':'展开商品明细'} onClick={()=>setExpanded(value=>!value)}>{expanded?'收起':'展开'}{expanded?' ▴':' ▾'}</button></span></th></tr></thead><tbody id={bodyId} hidden={!expanded}>{rows.map(row=><tr key={row.id}><th scope="row">{row.label}</th><td>{format(row.units)}</td><td>{row.unitsSharePct===null?'不可计算':`${format(row.unitsSharePct)}%`}</td></tr>)}</tbody></table></div>
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
   {section.id==='overview'?<><SavedOverviewFacts detail={detail}/>{overview}</>:section.id==='demand-keywords'?<MarketOverviewDemandTrend demand={detail.numbers.industryDemand}/>:section.id==='sales-trend'?<SavedSalesChart detail={detail}/>:section.id==='product-crn'?<SavedProductConcentration detail={detail} headTopN={headTopN}/>:section.operation?entries.length?<MarketOverviewDistributions key={`${entry.attemptId}/${section.id}`} entries={entries} currency={entry.report.scope.currency} embedded/>:<p className="ss-report-empty">此版本尚无该维度的已保存数据，其他可用结果继续保留。</p>:<p className="ss-report-empty">{section.missing}</p>}
   {section.id==='listing-trend'&&<p className="market-research-note">上架时间分布反映返回样本的构成，不等于历年新增销量。</p>}
   {entry.report.reportVersion==='market-overview-report/v2'&&section.id!=='overview'&&(section.operation||section.id==='sales-trend')&&<MarketOverviewSynthesis synthesis={entry.report.synthesis} semantic={detail.semantic?.task==='market-overview-explanation'?detail.semantic:null} dimensionPrefix={section.operation??'sample-trend'}/>}
  </section>;
 })}</>;
}
