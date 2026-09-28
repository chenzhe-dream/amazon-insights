"use client";
import React,{useState} from 'react';

type Series={keyword:string;status:string;points:Array<{month:string;value:number}>;errorCode?:string|null};
type Demand={status:string;seed:string|null;referenceMonth:string;series:Series[];issues:Array<{operation:string;code:string;retryable:boolean}>};
const colors=['#7c3aed','#3b82f6','#10b981','#f59e0b','#ec4899'];
const format=(value:number)=>new Intl.NumberFormat('zh-CN',{maximumFractionDigits:0}).format(value);
const nextMonth=(month:string)=>{const [y,m]=month.split('-').map(Number);return `${m===12?y+1:y}-${String(m===12?1:m+1).padStart(2,'0')}`;};
const failureLabel=(code:string)=>({'timeout':'请求超时','configuration':'来源尚未配置','authentication':'来源认证失败','rate-limit':'来源限流','upstream-temporary':'来源暂时不可用','upstream-permanent':'来源拒绝请求','malformed-response':'来源响应格式异常','scope-mismatch':'来源范围不匹配','interrupted':'采集已中断','local-admission':'等待来源调用额度','category-seed-unavailable':'未取得类目关键词种子'} as Record<string,string>)[code]??'来源步骤未完成';

/** Saved per-keyword searches only. Missing months stay gaps, not zero or a category total. */
export function MarketOverviewDemandTrend({demand,hasDemandStage=false}:{demand?:Demand|null;hasDemandStage?:boolean}){
 const [hover,setHover]=useState<string|null>(null);
 if(!demand||demand.status==='not-collected')return <p className="ss-report-empty">{hasDemandStage?'此版本已保存市场基础数据，行业关键词趋势尚未保存；请在任务进度中查看采集状态。':'此历史报告尚未采集行业关键词趋势。重新采集总览时将按原版流程补齐；查看此报告不会自动发起采集。'}</p>;
 const series=demand.series.filter(row=>row.points.length).map(row=>({...row,points:[...row.points].sort((a,b)=>a.month.localeCompare(b.month))})),months=[...new Set(series.flatMap(row=>row.points.map(p=>p.month)))].sort();
 const width=920,height=220,left=60,right=22,top=18,bottom=30,plotWidth=width-left-right,plotHeight=height-top-bottom;
 const max=Math.max(1,...series.flatMap(row=>row.points.map(p=>p.value))),x=(i:number)=>left+(i*plotWidth)/Math.max(months.length-1,1),y=(value:number)=>top+(1-value/max)*plotHeight;
 const ticks=months.length<=8?months.map((_,i)=>i):Array.from({length:8},(_,i)=>Math.round(i*(months.length-1)/7));
 return <div className="overview-demand-trend">
  <p className="market-research-note">{demand.seed?`${demand.seed} · `:''}关键词月搜索量，参考截止 {demand.referenceMonth}。按原版选取最多5个类目关键词，来源为卖家精灵 ABA 月度趋势；不代表全类目总需求。</p>
  {demand.status==='partial'&&<p className="market-research-note">部分趋势可用，已保留成功数据；未取得的词和月份不补零。</p>}
  {!months.length?<p className="ss-report-empty">{demand.status==='failed'?'行业关键词趋势采集失败，已有市场基础报告继续保留。':'本次来源未返回可用的关键词月搜索趋势。'}</p>:<>
   <div className="ss-report-trend-legend">{series.map((row,index)=><span key={row.keyword}><i style={{background:colors[index%colors.length]}}/>{row.keyword} · {row.points.at(-1)!.month}：{format(row.points.at(-1)!.value)} 次</span>)}</div>
   <div className="ss-report-trend-stage">
    <svg style={{height:220,width:'100%',minWidth:640}} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="行业关键词月搜索趋势" onMouseLeave={()=>setHover(null)}>
     {[0,1,2,3].map(i=><g key={i}><line x1={left} x2={width-right} y1={top+i*plotHeight/3} y2={top+i*plotHeight/3} stroke="#eef2f6"/><text x={left-8} y={top+i*plotHeight/3+3} textAnchor="end" className="ss-report-trend-axis">{format(max*(1-i/3))}</text></g>)}
     {series.map((row,index)=>{const segments:Array<Array<{month:string;value:number}>>=[];for(const point of row.points){const last=segments.at(-1);if(!last||nextMonth(last.at(-1)!.month)!==point.month)segments.push([point]);else last.push(point);}return <g key={row.keyword} data-keyword-series={row.keyword}>{segments.filter(s=>s.length>1).map((segment,i)=><polyline key={i} points={segment.map(p=>`${x(months.indexOf(p.month))},${y(p.value)}`).join(' ')} fill="none" stroke={colors[index%colors.length]} strokeWidth="2.2"/>)}{row.points.map(p=><circle key={p.month} data-search-month={p.month} cx={x(months.indexOf(p.month))} cy={y(p.value)} r={3} fill="white" stroke={colors[index%colors.length]} strokeWidth={2}><title>{`${row.keyword} ${p.month} ${format(p.value)} 次`}</title></circle>)}</g>;})}
     {ticks.map(i=><text key={i} x={x(i)} y={height-8} textAnchor="middle" className="ss-report-trend-axis">{months[i]}</text>)}
     {months.map((month,i)=><rect key={month} x={Math.max(left,x(i)-plotWidth/Math.max(months.length-1,1)/2)} y={top} width={months.length===1?plotWidth:Math.min(plotWidth/(months.length-1),width-right-Math.max(left,x(i)-plotWidth/(months.length-1)/2))} height={plotHeight} fill="transparent" tabIndex={0} style={{outlineColor:colors[0]}} role="button" aria-label={`查看 ${month} 搜索量`} onMouseMove={()=>setHover(month)} onFocus={()=>setHover(month)} onBlur={()=>setHover(null)}/>) }
    </svg>
    {hover&&<div className="ss-report-trend-tip" role="status"><b>{hover}</b>{series.map(row=><span key={row.keyword}>{row.keyword}：{row.points.find(p=>p.month===hover)?format(row.points.find(p=>p.month===hover)!.value)+' 次':'未返回'}</span>)}</div>}
   </div>
   {months.length===1&&<p className="market-research-note">只有一个月的数据，暂不能判断升降趋势。</p>}
  </>}
  {demand.series.some(s=>!s.points.length)&&<p className="market-research-note">{demand.series.filter(s=>!s.points.length).map(s=>`${s.keyword}：${s.status==='failed'?failureLabel(s.errorCode??''):'来源未返回趋势'}`).join('；')}</p>}
  {demand.issues.length>0&&<details><summary>来源与未完成步骤</summary>{demand.issues.map((issue,i)=><p key={i}>{issue.operation}：{failureLabel(issue.code)}{issue.retryable?'，可在任务进度中重试失败步骤':''}</p>)}</details>}
 </div>;
}
