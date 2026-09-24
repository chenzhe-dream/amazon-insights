'use client';
import type {MarketShapeSourceSummary} from '../shared/market-shape-source-summary-contracts';
import type {MarketShapePublicRevision} from '../shared/market-shape-public-contracts';
export const shapeNumber = (n:number|null|undefined) => n == null ? '未知' : n.toLocaleString('zh-CN',{maximumFractionDigits:2});

/** Supplied dashboard composition; only validated common-member observations are charted. */
export function MarketShapeDashboard({report}:{report:MarketShapePublicRevision|MarketShapeSourceSummary}) {
 const collected='basis' in report;
 const series=[...report.monthly].sort((a,b)=>a.month.localeCompare(b.month));
 const latest=series.at(-1),max=Math.max(1,...series.map(p=>p.totalUnits??0));
 const xAt=(i:number)=>series.length===1?480:46+i*864/Math.max(series.length-1,1);
 const points=series.map((p,i)=>({x:xAt(i),y:152-(p.totalUnits??0)/max*136,p}));
 const kpis=[['共同可比商品销量',shapeNumber(report.totalUnits),'研究窗口汇总'],['研究窗口销售额','未知','未汇总跨月销售额'],['最近完整月 · 可比销量',shapeNumber(latest?.totalUnits),latest?.month??'无有效月份'],['参考月商品池 · 销售额',collected?shapeNumber(report.referenceRevenue):'未知',collected?`${report.scope.toMonth} · ${report.scope.currency} · 来源观测`:'保存版本未包含销售额'],['Top3 Listing 占比','未知','未核验 BSR TOP 样本'],['类目退货率','未知','当前来源未提供']];
 return <section className="card compare-chart-card sales-combined-card category-node-trend-card">
  <div className="section-head"><div><h3>{report.scope.nodeIdPath} · 类目销量看板</h3><p>{report.scope.marketplace} · Node {report.scope.nodeIdPath} · {report.scope.fromMonth} 至 {report.scope.toMonth} · {collected?'已采集商品池':`保存版本 ${report.ordinal}`}</p></div><span className="source-badge">已保存商品来源</span></div>
  <div className="category-trend-kpis category-trend-kpis-wide">{kpis.map(([label,value,note])=><div key={label}><span>{label}</span><b>{value}</b><small>{note}</small></div>)}</div>
  <div className="market-overview-kpis">{[['Top3 品牌占比','未知'],['Top3 卖家占比','未知'],['Amazon 自营占比','未知'],['Top80% 均价','未知'],['Top80% 中位价','未知'],['链接数',String(report.selectedAsins.length)]].map(([label,value])=><div key={label}><span>{label}</span><b>{value}</b></div>)}</div>
  <div className="comparison-chart category-combo-chart" role="img" aria-label="共同可比商品月销量趋势">
   <div className="sales-trend-popover-legend category-combo-legend"><span><i className="sales-trend-legend-line" style={{borderColor:'#4f7df3'}}/>共同可比商品月销量</span><span>{collected?'参考月销售额见上方；未绘制跨月金额趋势':'当前保存版本无销售额趋势'}</span></div>
   {series.filter(p=>p.totalUnits!==null).length===1&&<p className="market-research-note">当前仅有 1 个月数据，展示单月数据点，尚不能判断增长或下降趋势。</p>}
   <div className="chart-stage"><svg viewBox="0 0 960 168" aria-hidden="true">
    {[0,.25,.5,.75,1].map(t=><g key={t}><line x1="46" x2="910" y1={152-t*136} y2={152-t*136} stroke="#e8edf5"/><text x="38" y={155-t*136} textAnchor="end" className="sales-trend-axis-label">{shapeNumber(max*t)}</text></g>)}
    {points.map((point,i)=><g key={point.p.month}>{point.p.totalUnits!==null&&<>{i>0&&points[i-1].p.totalUnits!==null&&<line x1={points[i-1].x} y1={points[i-1].y} x2={point.x} y2={point.y} stroke="#4f7df3" strokeWidth="2"/>}<circle cx={point.x} cy={point.y} r="4" fill="#4f7df3"/><text x={point.x} y={point.y-12} textAnchor="middle" className="category-chart-point-label">{shapeNumber(point.p.totalUnits)}</text></>}</g>)}
   </svg></div>
   <div className="chart-months category-trend-months">{series.map((p,i)=><span key={p.month} style={{left:`${xAt(i)/960*100}%`}}>{p.month}</span>)}</div><details style={{fontSize:11}}><summary>月销量数据</summary>{series.map(p=><p key={p.month}>{p.month}：{shapeNumber(p.totalUnits)}</p>)}</details>
  </div>
  <div className="comparison-chart category-monopoly-chart"><div className="empty-chart">当前商品来源未提供类目垄断系数趋势</div></div>
  <p className="market-research-note">{collected?'来源数据已入库；形态分类待人工确认，修改表格选择后保存才更新分类统计。':''}固定商品池的共同可比销量，不代表全市场或 TOP100 近30天销量；缺失月份保持未知，未补零。</p>
 </section>;
}
