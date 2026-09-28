"use client";
import React,{useState} from 'react';
import type {MarketOverviewDistribution} from '../shared/market-overview-distribution-contracts';

const labels=['有A+有视频','有A+无视频','无A+有视频','无A+无视频'];
const colors=['#FFAD33','#95DE64','#FF8564','#B5C7FF'];
const percent=(value:number|null)=>value==null?'不可计算':`${Number(value.toFixed(2))}%`;

function ContentPie({distribution,groupId}:{distribution:MarketOverviewDistribution;groupId:'sample'|'new-products'}){
 const [selected,setSelected]=useState<string|null>(null);
 const group=distribution.groups.find(group=>group.id===groupId);
 const rows=labels.map(label=>distribution.rows.find(row=>row.group===groupId&&row.label===(groupId==='sample'?label:`新品${label}`)));
 const sum=rows.reduce((sum,row)=>sum+(row?.unitsSharePct??0),0);
 const ready=group?.membership!=='invalid'&&group?.units!=null&&group.units>0&&rows.every(row=>row&&row.unitsSharePct!=null)&&Math.abs(sum-100)<0.01;
 const title=groupId==='sample'?'A+视频销量占比':'新品A+视频销量占比';
 let offset=0;
 const active=rows.find(row=>row?.id===selected);
 return <div className="overview-content-card"><h5>{title}</h5>
  {ready?<svg className="overview-content-pie" viewBox="0 0 260 260" role="img" aria-label={title}>
   {rows.map((row,index)=>{const value=row!.unitsSharePct!,start=offset;offset+=value;return value>0?<circle key={row!.id} data-share={value} cx="130" cy="130" r="70" fill="none" stroke={colors[index]} strokeWidth="36" pathLength="100" strokeDasharray={`${value} ${100-value}`} strokeDashoffset={-start} transform="rotate(-90 130 130)"><title>{`${labels[index]} ${percent(value)}`}</title></circle>:null;})}
   <text x="130" y="128" textAnchor="middle" className="overview-pie-center">{groupId==='sample'?'全样本':'新品'}</text><text x="130" y="148" textAnchor="middle" className="ss-report-trend-axis">销量占比</text>
  </svg>:<p className="ss-report-empty">{group?.units===0?'该组销量为0，暂无可计算占比。':'销量占比分母未确认，暂不绘制饼图。'}</p>}
  <div className="overview-pie-legend">{rows.map((row,index)=><button type="button" key={labels[index]} disabled={!row} aria-pressed={!!row&&selected===row.id} onClick={()=>setSelected(id=>id===row?.id?null:row!.id)}><i style={{background:colors[index]}}/>{labels[index]}<strong>{percent(row?.unitsSharePct??null)}</strong></button>)}</div>
  {active&&<p role="status">{active.label} · 商品 {active.products??'未知'} · 销量 {active.units??'未知'} · 销量占比 {percent(active.unitsSharePct)}</p>}
 </div>;
}

/** Each pie uses its saved group's own denominator; overlapping summaries stay in source details. */
export function MarketOverviewContentPies({distribution}:{distribution:MarketOverviewDistribution}){
 return <div className="overview-content-pair"><ContentPie distribution={distribution} groupId="sample"/><ContentPie distribution={distribution} groupId="new-products"/></div>;
}
