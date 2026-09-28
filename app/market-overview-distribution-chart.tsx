"use client";
import React,{useState} from 'react';
import type {MarketOverviewDistribution} from '../shared/market-overview-distribution-contracts';
/** Geometry, legend and colors follow the supplied DistributionComboChart; missing observations are not zero. */
export function MarketOverviewDistributionChart({rows,title,productShare=false}:{rows:MarketOverviewDistribution['rows'];title:string;productShare?:boolean}){
 const [selected,setSelected]=useState<string|null>(null);
 const bar=(row:MarketOverviewDistribution['rows'][number])=>productShare?row.productsSharePct:row.products;
 const barLabel=productShare?'商品占比':'产品数量';
 const barText=(value:number|null)=>value===null?(productShare?'不可计算':'未知'):`${Number(value.toFixed(2))}${productShare?'%':''}`;
 const known=rows.some(r=>bar(r)!==null||r.unitsSharePct!==null);if(!known)return <p className="ss-report-empty">该分布尚无可绘制数字，来源明细仍保留。</p>;
 const width=Math.max(860,rows.length*46+104),height=218,left=52,right=52,top=28,chartHeight=148,chartWidth=width-left-right;
 const maxCount=productShare?100:Math.max(4,Math.ceil(Math.max(0,...rows.flatMap(r=>r.products===null?[]:[r.products]))/4)*4),maxShare=Math.max(1,...rows.flatMap(r=>r.unitsSharePct===null?[]:[r.unitsSharePct]));
 const x=(i:number)=>left+(i+.5)*chartWidth/rows.length,yCount=(n:number)=>top+(1-n/maxCount)*chartHeight,yShare=(n:number)=>top+(1-n/maxShare)*chartHeight;
 const active=rows.find(r=>r.id===selected);
 return <div className="ss-dist-chart"><div className="ss-crn-legend"><span><i style={{background:'#C4B5FD'}}/>{barLabel}</span><span><i className="ss-crn-line" style={{background:'#7C3AED'}}/>销量占比</span></div>
  <div className="ss-dist-stage"><svg style={{height:218,minWidth:width}} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title}${barLabel}与销量占比`}><text x={left} y={14} className="ss-dist-axis-title">{productShare?'商品占比':'数量'}</text><text x={width-right} y={14} textAnchor="end" className="ss-dist-axis-title">销量占比</text>
   {[0,1,2,3,4].map(i=><g key={i}><line x1={left} x2={width-right} y1={top+i*chartHeight/4} y2={top+i*chartHeight/4} stroke="#eef2f6" strokeDasharray="4 4"/><text x={left-8} y={top+i*chartHeight/4+3} textAnchor="end" className="ss-report-trend-axis">{barText(Math.round(maxCount*(1-i/4)))}</text><text x={width-right+8} y={top+i*chartHeight/4+3} className="ss-report-trend-axis">{Number((maxShare*(1-i/4)).toFixed(1))}%</text></g>)}
   {rows.map((row,i)=><g key={row.id} role="button" tabIndex={0} aria-label={`查看分组 ${row.label}`} aria-pressed={selected===row.id} style={{cursor:'pointer'}} onClick={()=>setSelected(id=>id===row.id?null:row.id)} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();setSelected(id=>id===row.id?null:row.id);}}}><title>{`${row.label}：${barLabel} ${barText(bar(row))}；销量占比 ${row.unitsSharePct===null?'不可计算':row.unitsSharePct+'%'}`}</title>{bar(row)!==null&&<rect x={x(i)-14} y={yCount(bar(row)!)} width={28} height={top+chartHeight-yCount(bar(row)!)} fill="#C4B5FD" rx={2}/>} {row.unitsSharePct!==null&&<circle cx={x(i)} cy={yShare(row.unitsSharePct)} r={4} fill="#7C3AED"/>}{i>0&&row.unitsSharePct!==null&&rows[i-1].unitsSharePct!==null&&<line x1={x(i-1)} x2={x(i)} y1={yShare(rows[i-1].unitsSharePct!)} y2={yShare(row.unitsSharePct)} stroke="#7C3AED" strokeWidth={2}/>}
   <text x={x(i)} y={top+chartHeight+18} textAnchor="middle" className="ss-report-trend-axis">{row.label.length>18?row.label.slice(0,18)+'…':row.label}</text></g>)}
  </svg></div>
  {active&&<div className="ss-report-empty" role="status"><strong>{active.label}</strong> · 商品 {active.products??'未知'} · 销量 {active.units??'未知'} · 销量占比 {active.unitsSharePct===null?'不可计算':`${active.unitsSharePct}%`}<p>来源 ASIN：{active.asins.length?active.asins.join('、'):'未提供商品列表'}</p></div>}
 </div>;
}
