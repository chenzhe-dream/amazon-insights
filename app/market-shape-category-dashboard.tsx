'use client';
import type {ShapeCategoryDashboard} from '../shared/market-shape-category-contracts';
import {shapeNumber} from './market-shape-dashboard';
type Series={label:string;color:string;points:{month:string;value:number|null}[];right?:boolean};
function HistoryChart({series,percent=false}:{series:Series[];percent?:boolean}){
 const observed=[...new Set(series.flatMap(s=>s.points.map(p=>p.month)))].sort();
 const index=(m:string)=>Number(m.slice(0,4))*12+Number(m.slice(5))-1;
 const start=observed.length?index(observed[0]):0,end=observed.length?index(observed.at(-1)!):-1;
 const months=Array.from({length:Math.min(120,end-start+1)},(_,i)=>{const n=start+i;return `${Math.floor(n/12)}-${String(n%12+1).padStart(2,'0')}`;});
 if(!series.some(s=>s.points.some(p=>p.value!==null)))return <div className="empty-chart">等待类目历史；未返回有效数据的指标保持未知。</div>;
 const max=(right:boolean)=>percent?100:Math.max(1,...series.filter(s=>!!s.right===right).flatMap(s=>s.points.map(p=>p.value??0)));
 const x=(i:number)=>months.length===1?480:52+i*852/(months.length-1),y=(n:number,right=false)=>170-n/max(right)*140;
 return <><div className="sales-trend-popover-legend category-combo-legend">{series.map(s=><span key={s.label}><i className="sales-trend-legend-line" style={{borderColor:s.color}}/>{s.label}</span>)}</div><div className="chart-stage"><svg viewBox="0 0 960 205" role="img" aria-label={percent?'Top3 销售额占比趋势':'类目月销量与估算销售额趋势'}>
  {[0,.25,.5,.75,1].map(t=><g key={t}><line x1="52" x2="904" y1={170-t*140} y2={170-t*140} stroke="#e8edf5"/><text x="46" y={174-t*140} textAnchor="end" className="sales-trend-axis-label">{shapeNumber(max(false)*t)}{percent?'%':''}</text>{series.some(s=>s.right)&&<text x="910" y={174-t*140} className="sales-trend-axis-label">{shapeNumber(max(true)*t)}</text>}</g>)}
  {series.map(s=>{const values=new Map(s.points.map(p=>[p.month,p.value]));return <g key={s.label}>{months.map((month,i)=>{const value=values.get(month),previous=i?values.get(months[i-1]):null;return value==null?null:<g key={month}>{previous!=null&&<line x1={x(i-1)} x2={x(i)} y1={y(previous,s.right)} y2={y(value,s.right)} stroke={s.color} strokeWidth="2"/>}<circle cx={x(i)} cy={y(value,s.right)} r="3" fill={s.color}><title>{`${month} · ${s.label}：${shapeNumber(value)}${percent?'%':''}`}</title></circle></g>;})}</g>;})}
  {months.map((month,i)=>i%Math.max(1,Math.ceil(months.length/10))===0||i===months.length-1?<text key={month} x={x(i)} y="195" textAnchor="middle" className="sales-trend-axis-label">{month}</text>:null)}
 </svg></div><details><summary>查看月度数据</summary><div className="table-scroll"><table><thead><tr><th>月份</th>{series.map(s=><th key={s.label}>{s.label}</th>)}</tr></thead><tbody>{months.map(month=><tr key={month}><td>{month}</td>{series.map(s=><td key={s.label}>{shapeNumber(s.points.find(p=>p.month===month)?.value)}{percent&&s.points.find(p=>p.month===month)?.value!=null?'%':''}</td>)}</tr>)}</tbody></table></div></details></>;
}
export function MarketShapeCategoryDashboard({data,node,marketplace,poolSize}:{data:ShapeCategoryDashboard;node:string;marketplace:string;poolSize:number}){
 const report=data.sources.find(s=>s.metric==='report'),stats=report?.stats,history=(metric:string)=>data.sources.find(s=>s.metric===metric)?.points??[],latest=history('SalesCount').at(-1);
 const pct=(n:number|null|undefined)=>n==null?'未知':`${shapeNumber(n)}%`,money=(n:number|null|undefined)=>n==null?'未知':`${data.currency} ${shapeNumber(n)}`;
 const kpis=[['Top100 近30天销量',shapeNumber(stats?.top100Units),'来源报告汇总'],['Top100 近30天销售额',money(stats?.top100Amount),'来源报告汇总'],['最近完整月销量',shapeNumber(latest?.value),latest?.month??'等待历史'],['最近完整月估算销售额',money(data.estimatedAmount.at(-1)?.value),'同月销量 × 均价'],['Top3 Listing 占比',pct(stats?.top3ProductPct),'近30天 · 销量占比'],['类目退货率',pct(stats?.returnRatePct),'近30天 · 来源报告']];
 return <section className="card compare-chart-card sales-combined-card category-node-trend-card">
  <div className="section-head"><div><h3>{node.split(':').at(-1)} · 类目销量看板</h3><p>{marketplace} · 类目历史截至 {data.referenceMonth}；近30天统计采集于 {report?.fetchedAt?.slice(0,10)??'等待采集'}</p></div><span className="source-badge">Sorftime · 已保存类目来源</span></div>
  <div className="category-trend-kpis category-trend-kpis-wide">{kpis.map(([label,value,note])=><div key={label}><span>{label}</span><b>{value}</b><small>{note}</small></div>)}</div>
  <div className="market-overview-kpis">{[['Top3 品牌销量占比',pct(stats?.top3BrandPct)],['Top3 卖家销量占比',pct(stats?.top3SellerPct)],['Amazon 自营销量占比',pct(stats?.amazonOwnedPct)],['Top80% 均价',money(stats?.averagePrice)],['Top80% 中位价',money(stats?.medianPrice)],['本次商品池链接数',String(poolSize)]].map(([label,value])=><div key={label}><span>{label}</span><b>{value}</b></div>)}</div>
  <div className="comparison-chart category-combo-chart"><HistoryChart series={[{label:'类目月销量（左轴）',color:'#4f7df3',points:history('SalesCount')},{label:`估算销售额 ${data.currency}（右轴）`,color:'#fb923c',right:true,points:data.estimatedAmount}]}/></div>
  <div className="comparison-chart category-monopoly-chart"><HistoryChart percent series={[{label:'Top3 Listing',color:'#4f7df3',points:history('Top3ProductSalesAmountShare')},{label:'Top3 品牌',color:'#a855f7',points:history('Top3BrandSalesAmountShare')},{label:'Top3 卖家',color:'#14b8a6',points:history('Top3SellerSalesAmountShare')}]}/><p className="category-monopoly-note">趋势口径：Top3 销售额占比；上方近30天卡片为销量占比。</p></div>
  {data.sources.some(s=>s.status==='failed')&&<p role="status" className="market-research-error">部分类目来源采集失败，已成功的数据保留，可在任务详情重试失败项。</p>}
  <p className="market-research-note">近30天统计对应采集时点，不是所选历史月份。类目趋势由 Sorftime 返回，估算销售额为同月销量 × 均价；不与下方 SellerSprite 固定商品池合并。缺月不补零。</p>
 </section>;
}
