import {overviewPeriodLabel} from '../shared/market-overview-period';
"use client";
import React,{useId,useState} from 'react';
import type {z} from 'zod';
import type {MarketOverviewDetailsResponseSchema,MarketOverviewReportEntrySchema} from '../shared/market-overview-report-contracts';
import {MarketOverviewDistributionEntrySchema} from '../shared/market-overview-distribution-contracts';
import {overviewPresentationSections,selectOverviewDistributionEntries,selectOverviewSalesPoints,selectOverviewReportedMetric,selectOverviewRawConcentration} from './lib/market-overview-presentation';
import {MarketOverviewDistributions} from './market-overview-distributions';
import {MarketOverviewConcentrationChart} from './market-overview-concentration-chart';
import {MarketOverviewDemandTrend} from './market-overview-demand-trend';
import {MarketOverviewProductDemand,overviewExternalFailure} from './market-overview-product-demand';
import {MarketOverviewSynthesis} from './market-overview-synthesis';
import {marketSites} from '../shared/market-sites';
type Details=z.infer<typeof MarketOverviewDetailsResponseSchema>;
type Entry=z.infer<typeof MarketOverviewReportEntrySchema>;
type Chapter=NonNullable<Details['numbers']['chapterSynthesis']>['chapters'] extends infer T ? T extends readonly (infer I)[] ? I : never : never;

function ChapterExplanation({chapter}:{chapter:Chapter|undefined}) {
 const status=chapter?.status==='ready'?'依据充分':chapter?.status==='partial'?'部分依据':'依据不足';
 return <section className="market-overview-business-explanation" data-explanation-status={chapter?.status??'missing'}>
  <h5>业务解释 · {status}</h5>
  {chapter?<><dl><div><dt>数据表现</dt><dd>{chapter.performance}</dd></div><div><dt>数据含义</dt><dd>{chapter.meaning}</dd></div><div><dt>业务结论</dt><dd>{chapter.conclusion}</dd></div>{chapter.opportunity&&<div><dt>开发机会</dt><dd>{chapter.opportunity}</dd></div>}</dl>
   {chapter.missing.length>0&&<p className="market-research-note">待补证据：{chapter.missing.join('；')}</p>}
  </>:<p className="market-research-note">当前报告暂无可用业务总结。</p>}
 </section>;
}

function SavedSalesChart({detail}:{detail:Details}){
 const [hover,setHover]=useState<string|null>(null);
 const external=detail.numbers.externalData;
 const toPoints=(rows:Array<{month:string;value:number}>,metricId:string)=>rows.map(p=>({...p,metricId,requestBound:true}));
 const volume=external?toPoints(external.salesTrend.points,'Sorftime SalesCount'):selectOverviewSalesPoints(detail,'totalUnits'),amount=external?toPoints(external.salesAmountTrend.points,'Sorftime SalesCount × AvgPrice'):selectOverviewSalesPoints(detail,'totalRevenue');
 const volumeByMonth=new Map(volume.map(point=>[point.month,point]));
 const amountByMonth=new Map(amount.map(point=>[point.month,point]));
 const months=Array.from(new Set([...volume,...amount].map(point=>point.month))).sort();
 const format=(n:number)=>new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(n);
 const axisFormat=(n:number)=>new Intl.NumberFormat('zh-CN',{notation:'compact',maximumFractionDigits:1}).format(n);
 const width=920,height=228,left=46,right=52,top=26,chartHeight=174,chartWidth=width-left-right;
 const maxVolume=Math.max(1,...volume.map(point=>point.value)),maxAmount=Math.max(1,...amount.map(point=>point.value));
 const x=(index:number)=>left+(index+.5)*chartWidth/Math.max(months.length,1);
 const yVolume=(n:number)=>top+(1-n/maxVolume)*chartHeight,yAmount=(n:number)=>top+(1-n/maxAmount)*chartHeight;
 const amountSegments:string[][]=[];let segment:string[]=[];
 months.forEach((month,index)=>{const previous=months[index-1];if(previous){const [yr,mo]=previous.split('-').map(Number),next=String(mo===12?yr+1:yr)+'-'+String(mo===12?1:mo+1).padStart(2,'0');if(next!==month&&segment.length){amountSegments.push(segment);segment=[];}}const point=amountByMonth.get(month);if(point){segment.push(`${x(index)},${yAmount(point.value)}`);}else if(segment.length){amountSegments.push(segment);segment=[];}});
 if(segment.length)amountSegments.push(segment);
 return <>
  {external&&[external.salesTrend,external.salesAmountTrend].map((series,i)=>series.status!=='ready'?<p key={i} className="market-research-note">{i?'销售额':'销量'}：{series.status==='failed'?overviewExternalFailure(series.errorCode):series.status==='empty'?'来源本次未返回可用数据':series.status==='partial'?'部分月份可用，已保留成功结果':'尚未保存，查看任务进度'}。</p>:null)}{months.length===0?<p className="ss-report-empty">尚无可展示的已保存销量、销售额序列。</p>:<div className="ss-report-trend">
   <div className="ss-report-trend-legend"><span><i style={{background:'#c4b5fd'}}/>{external?'类目月销量':'样本月销量'}{volume.length?` · ${format(volume.at(-1)!.value)} 件`:''}</span><span><i className="ss-report-legend-line"/>{external?'月销售额（原版推算）':'样本月销售额'}{amount.length?` · ${detail.entry.report.scope.currency} ${format(amount.at(-1)!.value)}`:' · 尚未取得'}</span></div>
   {months.length===1&&<p className="market-research-note">目前只有一个月，不能判断升降趋势。</p>}
   <div className="ss-report-trend-stage"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={external?'类目月销量与推算月销售额趋势':'样本月销量与月销售额趋势'} style={{height:228,width:'100%'}} onMouseLeave={()=>setHover(null)}>
    <text x={left} y={12} className="ss-dist-axis-title">月销量</text><text x={width-right} y={12} textAnchor="end" className="ss-dist-axis-title">月销售额</text>
    {[0,1,2,3].map(i=><line key={i} x1={left} x2={width-right} y1={top+i*chartHeight/3} y2={top+i*chartHeight/3} stroke="#eef2f6" strokeDasharray="4 4"/>)}
    {[.25,.5,.75,1].map(ratio=><g key={ratio}><text x={left-8} y={yVolume(maxVolume*ratio)+3} textAnchor="end" className="ss-report-trend-axis">{volume.length?axisFormat(maxVolume*ratio):'—'}</text><text x={width-right+8} y={yAmount(maxAmount*ratio)+3} className="ss-report-trend-axis">{amount.length?axisFormat(maxAmount*ratio):'—'}</text></g>)}
    {months.map((month,index)=>{const point=volumeByMonth.get(month);return point?<rect key={`bar-${month}`} x={x(index)-8} y={yVolume(point.value)} width={16} height={Math.max(1,top+chartHeight-yVolume(point.value))} fill="#c4b5fd" rx={2}/>:null;})}
    {amountSegments.filter(points=>points.length>1).map((points,index)=><polyline key={index} points={points.join(' ')} fill="none" stroke="#7c3aed" strokeWidth={2.2}/>)}
    {months.map((month,index)=>{const point=amountByMonth.get(month);return point?<circle key={`amount-${month}`} cx={x(index)} cy={yAmount(point.value)} r={3} fill="#fff" stroke="#7c3aed" strokeWidth={2}/>:null;})}
    {months.map((month,index)=><g key={month}><text x={x(index)} y={height-8} textAnchor="middle" className="ss-report-trend-axis">{months.length<=8||index===months.length-1||index%Math.ceil(months.length/7)===0?month:''}</text><rect x={x(index)-chartWidth/months.length/2} y={0} width={chartWidth/months.length} height={height} fill="transparent" role="button" tabIndex={0} aria-label={`查看 ${month} 销量与销售额`} onFocus={()=>setHover(month)} onBlur={()=>setHover(null)} onMouseMove={()=>setHover(month)}/></g>)}
   </svg>{hover&&<div className="ss-report-trend-tip"><b>{hover}</b><span>月销量 {volumeByMonth.has(hover)?`${format(volumeByMonth.get(hover)!.value)} 件`:'未取得'}</span><span>月销售额 {amountByMonth.has(hover)?`${detail.entry.report.scope.currency} ${format(amountByMonth.get(hover)!.value)}`:'未取得'}</span></div>}</div>
  </div>}{!external&&detail.numbers.trendGaps.length>0&&<details><summary>趋势缺口</summary>{detail.numbers.trendGaps.map((gap,i)=><p key={i}>{gap.metricId}：{gap.reason}</p>)}</details>}</>;
}

function SavedOverviewFacts({detail}:{detail:Details}){
 const facts=[['样本商品数','sampleProducts'],['样本销量','totalUnits'],['品牌数','brands'],['卖家数','sellers'],['新品数','newCount']] as const;
  const known=facts.flatMap(([label,key])=>{const metric=selectOverviewReportedMetric(detail,key);return metric?[{label,value:new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(metric.value)}]:[];});
 if(!known.length)return null;
 return <div className="ss-report-facts"><strong>本次返回样本 · {detail.entry.report.scope.overviewPeriod?'最近30天':detail.entry.report.scope.toMonth}</strong><dl>{known.map(f=><div key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}</dl></div>;
}

function SavedProductConcentration({detail,headTopN}:{detail:Details;headTopN:number}){
 const [expanded,setExpanded]=useState(false),bodyId=useId();
 const source=detail.numbers.distributions?.find(e=>e.month===detail.entry.report.scope.toMonth&&e.operation==='market_product_concentration');
 const distribution=source?.distribution;
 if(distribution?.rows.length){
  const rows=distribution.rows.slice(0,headTopN),format=(value:number|null)=>value===null?'未知':new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(value),amazonDomain=marketSites.find(site=>site.code===detail.entry.report.scope.marketplace)?.amazonDomain;
  return <div className="market-reference-product-concentration">
   <MarketOverviewConcentrationChart rows={distribution.rows.filter(row=>row.group==='sample')} kind="product" headTopN={headTopN} currency={distribution.currency}/>
   <div className="market-overview-distribution-table overview-product-details" role="region" aria-label="商品集中度明细" tabIndex={0}><table><thead><tr><th scope="col">商品标题</th><th scope="col">ASIN</th><th scope="col">月销量</th><th scope="col"><span className="overview-detail-heading">返回商品销量占比<button type="button" aria-expanded={expanded} aria-controls={bodyId} aria-label={expanded?'收起商品明细':'展开商品明细'} onClick={()=>setExpanded(value=>!value)}>{expanded?'收起':'展开'}{expanded?' ▴':' ▾'}</button></span></th></tr></thead><tbody id={bodyId} hidden={!expanded}>{rows.map(row=>{const item=row.productItems?.[0],asin=item?.asin??row.asins[0]??null;return <tr key={row.id}><th scope="row">{item?.title??row.label}</th><td>{asin?(amazonDomain?<a key={asin} href={`https://www.${amazonDomain}/dp/${encodeURIComponent(asin)}`} target="_blank" rel="noreferrer">{asin}</a>:<span>{asin}</span>):'未知'}</td><td>{format(item?.units??row.units)}</td><td>{row.unitsSharePct===null?'不可计算':`${format(row.unitsSharePct)}%`}</td></tr>})}</tbody></table></div>
  </div>;
 }
 const raw=selectOverviewRawConcentration(detail);
 return raw===null?<p className="ss-report-empty">{overviewPresentationSections.find(s=>s.id==='product-crn')?.missing}</p>:<div className="ss-report-facts"><strong>商品集中度 · 来源原始值 {new Intl.NumberFormat('zh-CN',{maximumFractionDigits:6}).format(raw)}</strong><p>比例单位未确认，暂不换算百分比；商品 TopN 明细未保存，无法绘制集中度明细图。</p></div>;
}

function SavedPriceBandDetails({detail,entries}:{detail:Details;entries:readonly z.infer<typeof MarketOverviewDistributionEntrySchema>[]}){
 const month=detail.entry.report.scope.toMonth;
 const source=entries.find(entry=>entry.month===month);
 const distribution=source?.distribution;
 if(!source)return <p className="ss-report-empty">当前报告月份未保存价格分布，暂不展示价格带明细。</p>;
 if(!distribution?.rows.length)return <p className="ss-report-empty">当前报告月份没有可展示的价格带数据。</p>;
 const profits=detail.numbers.externalData?.asinProfits.items??{};
 const fmt=(value:number|null|undefined,digits=1)=>value===null||value===undefined||!Number.isFinite(value)?'未知':new Intl.NumberFormat('zh-CN',{maximumFractionDigits:digits}).format(value);
 const mid=(label:string)=>{const values=label.match(/\d+(?:\.\d+)?/g)?.map(Number)??[];if(!values.length)return null;return values.length>1?(values[0]!+values[1]!)/2:values[0]!;};
 const rows=distribution.rows.filter(row=>row.group==='sample');
 return <div className="market-overview-distribution-table market-overview-price-band-details" role="region" aria-label="价格带明细" tabIndex={0}>
  <h5>价格带明细</h5>
  <table><thead><tr><th scope="col">价格带</th><th scope="col">价格区间中点（原版售价中位口径）</th><th scope="col">链接数</th><th scope="col">月销量</th><th scope="col">链接均销</th><th scope="col">销量占比</th><th scope="col">需求效率</th><th scope="col">毛利率</th><th scope="col">依据结论</th></tr></thead><tbody>{rows.map(row=>{
   const avg=row.products&&row.products>0&&row.units!==null?row.units/row.products:null;
   const efficiency=row.unitsSharePct!==null&&row.productsSharePct!==null&&row.productsSharePct>0?row.unitsSharePct/row.productsSharePct:null;
   const margins=row.asins.map(asin=>profits[asin]?.profit).filter((value):value is number=>typeof value==='number'&&Number.isFinite(value));
   const margin=margins.length?margins.reduce((sum,value)=>sum+value,0)/margins.length:null;
   const conclusion=margin===null?'需求数据已保存，毛利率待验证':efficiency===null?'需求效率依据不足':margin>65&&efficiency>=1?'首选切入':margin>65?'优先机会':efficiency>=1?'需求验证':'待验证';
   return <tr key={row.id}><th scope="row">{row.label}</th><td>{fmt(mid(row.label),1)}</td><td>{fmt(row.products,0)}</td><td>{fmt(row.units,0)}</td><td>{fmt(avg,1)}</td><td>{fmt(row.unitsSharePct)}%</td><td>{efficiency===null?'未知':fmt(efficiency,2)}</td><td>{margin===null?'毛利率待验证':`${fmt(margin)}%`}</td><td>{conclusion}</td></tr>;
  })}</tbody></table>
 </div>;
}

/** Original chapter layout, over immutable saved report facts. */
export function MarketOverviewReferenceSections({entry,detail,overview,headTopN=10}:{entry:Entry;detail:Details;overview:React.ReactNode;headTopN?:number}){
 const chapters=detail.numbers.chapterSynthesis?.chapters??detail.numbers.originalSynthesis?.chapters??[];
 return <>{detail.numbers.chapterSynthesis?.derivation&&<p className="market-research-note">历史来源保持不变；章节解释按规则 {detail.numbers.chapterSynthesis.derivation.ruleVersion} 派生，非原保存结论。结果版本 {detail.numbers.chapterSynthesis.derivation.projectionHash.slice(0,12)}。</p>}{overviewPresentationSections.map(section=>{
  const entries=section.operation?selectOverviewDistributionEntries(detail.numbers.distributions??[],section.operation):[];
  return <section key={section.id} className="ss-report-block" data-report-section={section.id}><header><div><h4>{section.title}</h4><small>{overviewPeriodLabel(entry.report.scope)} · 当前保存报告</small></div></header>
   {section.id==='overview'?<><SavedOverviewFacts detail={detail}/>{overview}</>:section.id==='demand-keywords'?<MarketOverviewDemandTrend demand={detail.numbers.industryDemand} hasDemandStage={['market-overview-flow/rules-v3','market-overview-flow/rules-v4'].includes(entry.report.versions.planner)}/>:section.id==='sales-trend'?<SavedSalesChart detail={detail}/>:section.id==='product-demand'&&detail.numbers.productDemand?<MarketOverviewProductDemand demand={detail.numbers.productDemand} hasStage={entry.report.versions.planner==='market-overview-flow/rules-v4'}/>:section.id==='product-crn'?<SavedProductConcentration detail={detail} headTopN={headTopN}/>:section.operation?entries.length?<MarketOverviewDistributions key={`${entry.attemptId}/${section.id}`} entries={entries} currency={entry.report.scope.currency} rolling={!!entry.report.scope.overviewPeriod} embedded headTopN={headTopN}/>:<p className="ss-report-empty">此版本尚无该维度的已保存数据，其他可用结果继续保留。</p>:<p className="ss-report-empty">{section.missing}</p>}
   {section.id==='price'&&<SavedPriceBandDetails detail={detail} entries={entries}/>}
   {section.id==='price'&&detail.numbers.externalData&&(detail.numbers.externalData.asinProfits.errorCode||detail.numbers.externalData.asinProfits.missingAsins.length>0)&&<div className="market-research-note">{detail.numbers.externalData.asinProfits.errorCode&&<p>{overviewExternalFailure(detail.numbers.externalData.asinProfits.errorCode)}；已取得的数据保留，请查看任务进度。</p>}{detail.numbers.externalData.asinProfits.missingAsins.length>0&&<p>尚未取得利润的商品：{detail.numbers.externalData.asinProfits.missingAsins.join('、')}</p>}</div>}
   {entry.report.reportVersion==='market-overview-report/v2'&&section.id!=='overview'&&(section.operation||section.id==='sales-trend')&&<MarketOverviewSynthesis synthesis={entry.report.synthesis} semantic={detail.semantic?.task==='market-overview-explanation'?detail.semantic:null} dimensionPrefix={section.operation??'sample-trend'}/>}
   <ChapterExplanation chapter={chapters.find(chapter=>chapter.id===section.id)}/>
  </section>;
 })}</>;
}
