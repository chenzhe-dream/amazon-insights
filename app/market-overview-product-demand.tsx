"use client";
import React,{useState} from 'react';

type ProductDemand={status:string;points:Array<{month:string;value:number}>;asinCount:number|null;returnRatio:number|null;avgReturnRatio:number|null;searchToPurchaseRatio:number|null;avgSearchToPurchaseRatio:number|null;sourceRef:string|null;errorCode?:string|null};
const format=(n:number|null,unit='')=>n===null?'未返回':`${new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(n)}${unit}`;
export const overviewExternalFailure=(code:string|null|undefined)=>({'timeout':'请求超时','authentication':'来源认证失败','configuration':'来源尚未配置','rate-limit':'来源限流','local-admission':'等待来源调用额度','upstream-temporary':'来源暂时不可用','upstream-permanent':'来源拒绝请求','scope-mismatch':'来源范围不匹配','source-mismatch':'来源范围不匹配','malformed-response':'来源格式异常','invalid-data':'来源数据异常','interrupted':'采集已中断','prices-not-collected':'类目均价尚未保存','price-month-missing':'部分月份缺少类目均价','profit-page-budget-exhausted':'本次分页达到上限，部分商品尚未返回','requested-asins-missing':'来源未返回部分请求商品的利润','profit-not-collected':'商品利润尚未保存'} as Record<string,string>)[code??'']??'来源步骤未完成';

/** Original page-view and return/search metric panels over immutable source data. */
export function MarketOverviewProductDemand({demand,hasStage=false}:{demand?:ProductDemand|null;hasStage?:boolean}){
 const [hover,setHover]=useState<string|null>(null);
 if(!demand||demand.status==='not-collected')return <p className="ss-report-empty">{hasStage?'商品需求趋势尚未保存，请查看任务进度。':'此历史报告尚未采集商品需求趋势；查看报告不会自动补采。'}</p>;
 if(demand.status==='failed')return <p className="ss-report-empty">商品需求趋势采集失败：{overviewExternalFailure(demand.errorCode)}。其他已保存结果继续保留，可在任务进度重试此来源。</p>;
 if(demand.status==='empty')return <p className="ss-report-empty">商品需求接口请求成功，但本次未返回浏览量及需求指标。需要重新采集的旧报告不会在查看时自动更新。</p>;
 const points=demand.points,width=580,height=220,left=60,right=20,top=20,bottom=34,plotWidth=width-left-right,plotHeight=height-top-bottom;
 const max=Math.max(1,...points.map(p=>p.value)),x=(i:number)=>left+(points.length===1?.5:i/Math.max(1,points.length-1))*plotWidth,y=(n:number)=>top+(1-n/max)*plotHeight;
 const segments:Array<Array<{month:string;value:number}>>=[];
 for(const p of points){const last=segments.at(-1),previous=last?.at(-1)?.month.slice(0,7),current=p.month.slice(0,7);const [yr,mo]=(previous??'0-0').split('-').map(Number),next=`${mo===12?yr+1:yr}-${String(mo===12?1:mo+1).padStart(2,'0')}`;if(!last||next!==current)segments.push([p]);else last.push(p);}
 const ticks=points.length<=6?points.map((_,i)=>i):Array.from({length:6},(_,i)=>Math.round(i*(points.length-1)/5));
 const metrics=[{name:'退货率',unit:'%',values:[demand.returnRatio,demand.avgReturnRatio]},{name:'搜索购买比',unit:'‰',values:[demand.searchToPurchaseRatio,demand.avgSearchToPurchaseRatio]}];
 return <div className="ss-product-demand">
  {demand.status==='partial'&&<p className="market-research-note">部分商品需求数据存在异常，已保留可用月份和指标；冲突月份不参与展示或计算。</p>}
  <div className="ss-product-demand-head"><span>来源最新数据：{points.at(-1)?.month??'未返回浏览量'}</span><span>商品总数：{format(demand.asinCount)}</span></div>
  <div className="ss-product-demand-grid">
   <div className="ss-product-demand-chart"><div className="ss-product-demand-legend"><span><i className="ss-product-demand-line" style={{background:'#7c3aed'}}/>浏览量</span></div>
    {!points.length?<p className="ss-report-empty">本次未返回浏览量序列；已返回的需求指标继续保留。</p>:<div className="ss-report-trend-stage">
     <svg style={{width:'100%',height:220}} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="类目浏览量趋势" onMouseLeave={()=>setHover(null)}>
      {[0,1,2,3].map(i=><g key={i}><line x1={left} x2={width-right} y1={top+i*plotHeight/3} y2={top+i*plotHeight/3} stroke="#eef2f6"/><text x={left-8} y={top+i*plotHeight/3+3} textAnchor="end" className="ss-report-trend-axis">{new Intl.NumberFormat('zh-CN',{notation:'compact',maximumFractionDigits:1}).format(max*(1-i/3))}</text></g>)}
      {segments.filter(s=>s.length>1).map((s,i)=><polyline key={i} points={s.map(p=>`${x(points.indexOf(p))},${y(p.value)}`).join(' ')} fill="none" stroke="#7c3aed" strokeWidth={2}/>)}
      {points.map((p,i)=><g key={p.month}><circle data-views-month={p.month} cx={x(i)} cy={y(p.value)} r={3.5} fill="white" stroke="#7c3aed" strokeWidth={2}/><rect x={Math.max(left,x(i)-plotWidth/Math.max(points.length-1,1)/2)} y={top} width={points.length===1?plotWidth:Math.min(plotWidth/(points.length-1),width-right-Math.max(left,x(i)-plotWidth/(points.length-1)/2))} height={plotHeight} fill="transparent" tabIndex={0} role="button" aria-label={`查看 ${p.month} 浏览量`} onFocus={()=>setHover(p.month)} onBlur={()=>setHover(null)} onMouseMove={()=>setHover(p.month)}/></g>)}
      {ticks.map(i=><text key={i} x={x(i)} y={height-9} textAnchor="middle" className="ss-report-trend-axis">{points[i].month.slice(0,7)}</text>)}
     </svg>{hover&&<div className="ss-report-trend-tip" role="status"><b>{hover}</b><span>浏览量 {format(points.find(p=>p.month===hover)?.value??null)}</span></div>}
    </div>}
    {points.length===1&&<p className="market-research-note">仅一个月，暂不能判断趋势。</p>}
   </div>
   <div className="ss-product-demand-chart"><div className="ss-product-demand-legend"><span><i style={{background:'#c4b5fd'}}/>市场平均值</span><span><i style={{background:'#7c3aed'}}/>同类目平均值</span></div>
    <svg style={{width:'100%',height:220}} viewBox="0 0 320 220" role="img" aria-label="退货率与搜索购买比">
     {metrics.map((m,i)=>{const maximum=Math.max(1,...m.values.filter((v):v is number=>v!==null));return <g key={m.name}><text x={i*150+80} y={16} textAnchor="middle" className="ss-dist-axis-title">{m.name}（{m.unit}）</text><line x1={i*150+22} x2={i*150+138} y1={180} y2={180} stroke="#e5e7eb"/>{m.values.map((v,j)=>v===null?<text key={j} x={i*150+57+j*44} y={165} textAnchor="middle" className="ss-report-trend-axis">未返回</text>:<g key={j}><rect x={i*150+41+j*44} y={180-v/maximum*135} width={32} height={Math.max(1,v/maximum*135)} rx={2} fill={j?'#7c3aed':'#c4b5fd'}/><text x={i*150+57+j*44} y={173-v/maximum*135} textAnchor="middle" className="ss-report-trend-axis">{format(v,m.unit)}</text></g>)}<text x={i*150+57} y={204} textAnchor="middle" className="ss-report-trend-axis">市场</text><text x={i*150+101} y={204} textAnchor="middle" className="ss-report-trend-axis">同类目</text></g>;})}
    </svg>
   </div>
  </div>
 </div>;
}
