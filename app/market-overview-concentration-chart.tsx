"use client";
import React,{useState} from 'react';
import type {MarketOverviewDistribution} from '../shared/market-overview-distribution-contracts';

type Row=MarketOverviewDistribution['rows'][number];
const format=(n:number|null)=>n===null?'未知':new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(n);

/** Original concentration chart layout, reading only one saved source group. */
export function MarketOverviewConcentrationChart({rows,kind,headTopN,currency}:{rows:Row[];kind:'product'|'brand'|'seller';headTopN:number;currency:string|null}){
 const [metric,setMetric]=useState<'units'|'revenue'>('units');
 const [range,setRange]=useState<'head'|'half'|'all'>('all');
 const [selected,setSelected]=useState<string|null>(null);
 const revenueReady=currency!==null&&rows.length>0&&rows.every(row=>row.revenue!==null&&row.revenueSharePct!==null);
 const shareReady=rows.length>0&&rows.every(row=>metric==='units'?row.unitsSharePct!==null:row.revenueSharePct!==null);
 const share=(row:Row)=>metric==='units'?row.unitsSharePct:row.revenueSharePct;
 const value=(row:Row)=>metric==='units'?row.units:row.revenue;
 const halfIndex=shareReady?rows.findIndex((_,index)=>rows.slice(0,index+1).reduce((sum,row)=>sum+(share(row)??0),0)>=50):-1;
 const halfCount=halfIndex<0?rows.length:halfIndex+1;
 const visible=range==='head'?rows.slice(0,headTopN):range==='half'&&shareReady?rows.slice(0,halfCount):rows;
 const count=visible.length,left=kind==='product'?48:72,right=kind==='product'?46:56,top=22,plotHeight=190;
 const barGap=count>40?1.5:3,barWidth=Math.max(5,Math.min(kind==='product'?10:16,760/Math.max(count,1)));
 const width=Math.max(860,left+right+count*(barWidth+barGap)+8),height=248,plotWidth=width-left-right;
 const ticks=new Set(count<=12?visible.map((_,i)=>i):Array.from({length:10},(_,i)=>Math.round(i*(count-1)/9)));
 const maxValue=Math.max(1,...visible.flatMap(row=>value(row)===null?[]:[value(row)!]));
 const maxShare=Math.max(1,...visible.flatMap(row=>share(row)===null?[]:[share(row)!]));
 const x=(index:number)=>left+(index+.5)*plotWidth/Math.max(visible.length,1);
 const yValue=(n:number)=>top+(1-n/maxValue)*plotHeight,yShare=(n:number)=>top+(1-n/maxShare)*plotHeight;
 const label=kind==='product'?'商品':kind==='brand'?'品牌':'卖家';
 const active=visible.find(row=>row.id===selected);
 const points:string[][]=[];let segment:string[]=[];
 visible.forEach((row,index)=>{const n=share(row);if(n!==null)segment.push(`${x(index)},${yShare(n)}`);else if(segment.length){points.push(segment);segment=[];}});
 if(segment.length)points.push(segment);
 if(!rows.some(row=>row.units!==null||row.unitsSharePct!==null))return <p className="ss-report-empty">该来源尚无可绘制的销量或占比，原始分组仍保留在下方明细中。</p>;
 return <div className="ss-crn">
  <div className="ss-crn-tabs"><button type="button" className={metric==='units'?'selected':''} onClick={()=>setMetric('units')}>销量分布</button><button type="button" className={metric==='revenue'?'selected':''} disabled={!revenueReady} title={revenueReady?undefined:'销售额或币种未确认'} onClick={()=>{setMetric('revenue');setRange('all');}}>销售额分布</button></div>
  <div className="ss-crn-legend"><span><i style={{background:'#c4b5fd'}}/>{metric==='units'?'销量':'销售额'}</span><span><i className="ss-crn-line" style={{background:'#7c3aed'}}/>{metric==='units'?'销量占比':'销售额占比'}</span></div>
  <div className="ss-crn-layout"><div className="ss-crn-stage"><svg style={{height:260,minWidth:width}} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${label}集中度`}>
   <text x={left} y={14} className="ss-dist-axis-title">{metric==='units'?'销量':'销售额'}</text><text x={width-right} y={14} textAnchor="end" className="ss-dist-axis-title">{metric==='units'?'销量占比':'销售额占比'}</text>
   {[0,1,2,3].map(i=><line key={i} x1={left} x2={width-right} y1={top+i*plotHeight/3} y2={top+i*plotHeight/3} stroke="#eef2f6" strokeDasharray="4 4"/>)}
   {[.25,.5,.75,1].map(ratio=><g key={ratio}><text x={left-8} y={yValue(maxValue*ratio)+3} textAnchor="end" className="ss-report-trend-axis">{format(maxValue*ratio)}</text><text x={width-right+8} y={yShare(maxShare*ratio)+3} className="ss-report-trend-axis">{format(maxShare*ratio)}%</text></g>)}
   {visible.map((row,index)=>{const amount=value(row);return amount===null?null:<rect key={`bar-${row.id}`} x={x(index)-barWidth/2} y={yValue(amount)} width={barWidth} height={Math.max(1,top+plotHeight-yValue(amount))} rx={2} fill="#c4b5fd"/>;})}
   {points.filter(part=>part.length>1).map((part,index)=><polyline key={index} points={part.join(' ')} fill="none" stroke="#7c3aed" strokeWidth={2}/>)}
   {visible.map((row,index)=>share(row)===null?null:<circle key={`share-${row.id}`} cx={x(index)} cy={yShare(share(row)!)} r={3} fill="#fff" stroke="#7c3aed" strokeWidth={2}/>)}
   {visible.map((row,index)=><g key={`label-${row.id}`}><title>{`${row.label} · ${metric==='units'?'销量':'销售额'} ${format(value(row))} · 占比 ${share(row)===null?'不可计算':`${format(share(row))}%`}`}</title>{ticks.has(index)&&<text x={x(index)} y={height-8} textAnchor="middle" className="ss-report-trend-axis">{kind==='product'?String(index+1):row.label.length>13?`${row.label.slice(0,13)}…`:row.label}</text>}<rect role="button" tabIndex={0} aria-label={`查看${label} ${row.label}`} aria-pressed={selected===row.id} x={x(index)-plotWidth/visible.length/2} y={0} width={plotWidth/visible.length} height={height} fill="transparent" style={{cursor:'pointer'}} onClick={()=>setSelected(id=>id===row.id?null:row.id)} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();setSelected(id=>id===row.id?null:row.id);}}}/></g>)}
  </svg></div><div className="ss-crn-range"><button type="button" className={range==='head'?'selected':''} onClick={()=>setRange('head')}>返回前{headTopN}{label}</button><button type="button" className={range==='half'?'selected':''} disabled={!shareReady} title={shareReady?undefined:'占比或分母尚未确认'} onClick={()=>setRange('half')}>前50%</button><button type="button" className={range==='all'?'selected':''} onClick={()=>setRange('all')}>全部({rows.length})</button></div></div>
  {active&&<div className="ss-report-empty" role="status"><strong>{active.label}</strong><p>{metric==='units'?'月销量':'月销售额'}：{format(value(active))}{metric==='revenue'&&currency?` ${currency}`:''} · 占比：{share(active)===null?'不可计算':`${format(share(active))}%`}</p><p>来源 ASIN：{active.asins.length?active.asins.join('、'):'未提供商品列表'}</p></div>}
 </div>;
}
