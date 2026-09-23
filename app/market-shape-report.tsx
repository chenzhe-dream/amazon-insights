'use client';
import type { MarketShapeExplanationPresentation } from '../shared/market-shape-explanation-presentation';
import {shapeSavedPeriodColumns} from './market-shape-period-columns';
import {MarketShapeSavedConclusion, MarketShapeFinalConclusion} from './market-shape-saved-conclusion';
import {Fragment, useState} from 'react';
import {MarketShapeDashboard} from './market-shape-dashboard';
import {LaunchSection, LaunchTable} from './launch-section';
import type { MarketShapePublicRevision } from '../shared/market-shape-public-contracts';
import {MarketShapeStructureReport} from './market-shape-structure-report';
import {MarketShapeSourcePolicyNote} from './market-shape-source-policy-note';
const number = (n: number | null) => n === null ? '未知' : n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const issues: Record<string, string> = { 'scope-unconfirmed': '来源范围未确认', 'currency-unconfirmed': '币种未确认', 'period-unconfirmed': '月份未确认', 'price-missing': '价格缺失', 'units-missing': '销量缺失', 'not-collected': '该月未采集', 'member-missing': '该月未返回此商品','period-outside-provider-history':'超出供应商查询历史范围' };
export function MarketShapeReport({ report, showDashboard = true, presentation, semanticSkipped = false }: {
    presentation?: MarketShapeExplanationPresentation | null;
    semanticSkipped?: boolean;
    showDashboard?: boolean;
    report: MarketShapePublicRevision;
}) {
    // Never display an explanation from a different immutable revision.
    presentation = !semanticSkipped && presentation?.revisionId === report.revisionId ? presentation : null;
    const [shapeFilter,setShapeFilter]=useState('all');
    const groups=report.groups.filter(g=>shapeFilter==='all'||(g.labelId??'unknown')===shapeFilter);
    const periods = shapeSavedPeriodColumns(report.scope,report.periodProjection);
    const labels = new Map(report.labels.map(l => [l.labelId, l.label]));
    const periodShape=(period:typeof periods[number],labelId:string|null)=>period.projection?.segments.find(s=>s.kind==='shape'&&s.labelId===labelId);
    const listingPeriods=periods.filter(period=>!period.label.includes(' 至 '));
    const listingYears=report.periodProjection?.periods.find(p=>p.id==='study')?.segments.find(s=>s.kind==='all')?.listingYears;
    const percent=(value:number|null|undefined)=>value==null?'未知':`${(value*100).toFixed(1)}%`;
    return <section className="market-shape-report market-shape-reference-report" style={{display:"grid",gridTemplateColumns:"minmax(0, 1fr)",gap:16,padding:0,minWidth:0}} role="region" aria-label="形态价格带版本报告">{showDashboard&&<MarketShapeDashboard report={report}/>}
  <header className="market-shape-report-summary"><div><h3>形态与价格带 · 版本 {report.ordinal}</h3><p>{report.scope.marketplace} · 类目 {report.scope.nodeIdPath} · {report.scope.fromMonth} 至 {report.scope.toMonth}</p></div><div className="market-shape-report-coverage"><span>可比销量：{number(report.totalUnits)}</span><span>共同可比商品 {report.eligibleAsins.length} / 所选 {report.selectedAsins.length} 个</span></div></header>
  <LaunchSection title="上架年份分析" description="上架年份与保存周期销量结构" badge={<span className="source-badge">{listingYears?'已保存来源分组':'年份汇总未提供'}</span>}>
   <p className="market-research-note">按参考快照中的有效上架日期分组；年份未知单列。销量保持整个研究窗口共同可比商品集合，未保存完整周期显示未知。</p>
   <LaunchTable stickyHeader className="shape-price-table"><thead><tr><th rowSpan={2}>上架年份</th>{listingPeriods.map(period=><th colSpan={2} key={period.label}>{period.label}</th>)}<th rowSpan={2}>所选 / 可比链接</th><th rowSpan={2}>单链月均销量</th></tr><tr>{listingPeriods.map(period=><Fragment key={period.label}><th>销量</th><th>占比</th></Fragment>)}</tr></thead><tbody>{listingYears?listingYears.map(row=><tr key={row.year??'unknown'}><th>{row.year??'年份未知'}</th>{listingPeriods.map(period=>{const stats=period.projection?.segments.find(s=>s.kind==='all')?.listingYears.find(r=>r.year===row.year)?.stats;return <Fragment key={period.label}><td>{number(stats?.units??null)}</td><td>{percent(stats?.salesShare.value)}</td></Fragment>})}<td>{row.stats.requestedLinks} / {row.stats.comparableLinks}</td><td title="本版本完整研究窗口">{number(row.stats.monthlyUnitsPerLink)}</td></tr>):<tr><td colSpan={3+listingPeriods.length*2} className="top-sales-filter-empty">按上架年份汇总的保存统计未提供</td></tr>}</tbody></LaunchTable>
   {report.structure ? <MarketShapeStructureReport key={`${report.revisionId}/age`} structure={report.structure} report={report} section="age" presentation={presentation} semanticSkipped={semanticSkipped}/> : <div className="pending-box"><strong>上架年份与年龄统计未知</strong><span>此历史版本未保存上架日期结构。</span></div>}
  </LaunchSection>
  <LaunchSection title="商品形态 · 销量占比分析" description="按人工确认形态汇总研究窗口内共同可比商品销量" badge={<span className="source-badge">{report.selectedAsins.length} 链接 · {report.groups.length} 形态</span>}>
   <p className="market-research-note">原版历史周期保留；后端仅计算已保存完整月份的周期，所有周期固定采用整个研究窗口共同可比商品。单链月均采用本版本研究窗口。</p>
   <LaunchTable stickyHeader className="shape-price-table shape-sales-table"><thead><tr><th rowSpan={2} className="shape-price-label-col">商品形态</th>{periods.map(period=><th key={period.label} colSpan={2}>{period.label}</th>)}<th rowSpan={2}>可比链接数</th><th rowSpan={2}>单链月均销量</th></tr><tr>{periods.map(period=><Fragment key={period.label}><th>销量</th><th>占共同可比销量</th></Fragment>)}</tr></thead><tbody>{report.groups.map(g=><tr key={g.labelId??'unknown'}><td className="shape-price-label-col">{g.labelId===null?'未分类':labels.get(g.labelId)??g.labelId}</td>{periods.map(period=><Fragment key={period.label}><td className="shape-price-num">{period.projection?number(periodShape(period,g.labelId)?.stats.units??null):period.saved?number(g.units):'未知'}</td><td className="shape-price-pct">{period.projection?percent(periodShape(period,g.labelId)?.stats.salesShare.value):!period.saved||g.units===null||!report.totalUnits?'未知':`${(g.units/report.totalUnits*100).toFixed(1)}%`}</td></Fragment>)}<td className="shape-price-num">{g.links}</td><td className="shape-price-num">{number(g.monthlyUnitsPerLink)}</td></tr>)}</tbody></LaunchTable>
   <MarketShapeSavedConclusion title="形态销量占比" dimension="shape" presentation={presentation} semanticSkipped={semanticSkipped}/>
  </LaunchSection>
  <LaunchSection title="商品形态 · 价格带分析" description="按「商品形态 → 参考价格带」分层汇总；采用保存版本的真实研究月份和价格边界" badge={<span className="source-badge">{groups.length} 形态 · {report.bands.length} 价格带</span>}>
   <div className="top-sales-table-toolbar brand-price-band-toolbar"><div className="top-sales-table-filters"><label>商品形态 <select aria-label="价格带形态筛选" value={shapeFilter} onChange={e=>setShapeFilter(e.target.value)}><option value="all">全部</option>{report.groups.map(g=><option key={g.labelId??'unknown'} value={g.labelId??'unknown'}>{g.labelId===null?'未分类':labels.get(g.labelId)??g.labelId}（价格带）</option>)}</select></label></div></div>
   <div className="market-shape-table" role="region" aria-label="价格带统计表" tabIndex={0}><LaunchTable stickyHeader className="shape-price-table shape-price-band-table"><thead><tr><th rowSpan={2} className="shape-price-label-col">商品形态 / 参考价格带（{report.scope.currency}）</th>{periods.map(period=><th key={period.label} colSpan={2}>{period.label}</th>)}<th rowSpan={2}>可比链接</th><th rowSpan={2}>单链月均销量</th></tr><tr>{periods.map(period=><Fragment key={period.label}><th>销量</th><th>形态内销量份额</th></Fragment>)}</tr></thead><tbody>{groups.map(g=><Fragment key={g.labelId??'unknown'}><tr className="shape-price-subtotal-row"><th className="shape-price-label-col">{g.labelId===null?'未分类':labels.get(g.labelId)??g.labelId} · 合计</th>{periods.map(period=><Fragment key={period.label}><td className="shape-price-num">{period.projection?number(periodShape(period,g.labelId)?.stats.units??null):period.saved?number(g.units):'未知'}</td><td className="shape-price-pct">{period.projection?(periodShape(period,g.labelId)?.stats.units?'100.0%':'未知'):!period.saved||g.units===null||g.units===0?'未知':'100.0%'}</td></Fragment>)}<td className="shape-price-num">{g.links}</td><td className="shape-price-num">{number(g.monthlyUnitsPerLink)}</td></tr>{g.bands.map(b=>{const range=report.bands.find(r=>r.id===b.id);return <tr className="shape-price-band-row" key={b.id}><td className="shape-price-label-col"><span className="shape-price-band-label">{range?`${range.minInclusive} ≤ 价格${range.maxExclusive===null?'':` < ${range.maxExclusive}`}`:'价格边界未提供'}</span></td>{periods.map(period=><Fragment key={period.label}><td className="shape-price-num">{period.projection?number(periodShape(period,g.labelId)?.bands.find(row=>row.bandId===b.id)?.stats.units??null):period.saved?number(b.units):'未知'}</td><td className="shape-price-pct">{period.projection?percent(periodShape(period,g.labelId)?.bands.find(row=>row.bandId===b.id)?.stats.salesShare.value):!period.saved||b.share===null?'未知':`${(b.share*100).toFixed(1)}%`}{period.projection?<small>（{number(periodShape(period,g.labelId)?.bands.find(row=>row.bandId===b.id)?.stats.salesShare.numerator??null)} / {number(periodShape(period,g.labelId)?.bands.find(row=>row.bandId===b.id)?.stats.salesShare.denominator??null)}）</small>:period.saved&&<small>（{number(b.units)} / {number(b.denominatorUnits)}）</small>}</td></Fragment>)}<td className="shape-price-num">{b.links}</td><td className="shape-price-num">{b.units===null||!b.links||!report.monthly.length?'未知':number(b.units/b.links/report.monthly.length)}</td></tr>})}</Fragment>)}</tbody></LaunchTable></div>
   <MarketShapeSavedConclusion title="形态与价格带结构结论" dimension="price" presentation={presentation} semanticSkipped={semanticSkipped}/>
  </LaunchSection>
  {report.structure?<MarketShapeStructureReport key={`${report.revisionId}/brand`} structure={report.structure} report={report} section="brand" presentation={presentation} semanticSkipped={semanticSkipped}/>:<LaunchSection title="品牌 · 价格带分析" description="品牌与参考价格带交叉结构"><div className="pending-box"><strong>品牌与价格带统计未知</strong><span>此历史版本未保存品牌与上架年龄结构。</span></div><MarketShapeSavedConclusion title="品牌与价格带机会结论" dimension="brand" presentation={presentation} semanticSkipped={semanticSkipped}/></LaunchSection>}

  <MarketShapeFinalConclusion presentation={presentation} sampleSize={report.selectedAsins.length} semanticSkipped={semanticSkipped}/>
  <MarketShapeSourcePolicyNote report={report}/>
  <details className="market-shape-report-evidence"><summary>统计口径、各月可比销量与商品缺口</summary>
   <p className="market-research-note">形态分类版本：{report.taxonomyVersion}；{semanticSkipped?'本地规则任务未启用模型建议，':'模型仅提供建议，'}统计使用人工确认版本 {report.ordinal}。结构规则：{report.structure?.ruleVersion??'历史版本未保存'}；周期规则：{report.periodProjection?.version??'历史响应未提供'}。</p>
   <p className="market-research-note">周期边界按研究结束月的日历月确定：近3个月、近6个月及前两个完整自然年。未保存月份不补0，不因更短周期更换商品集合；所选 {report.selectedAsins.length} 个商品中共同可比 {report.eligibleAsins.length} 个。年份销量份额分母包含年份未知组的可比销量；链接份额按全部所选链接计数（含不可比链接）；毛利、退货率、图片识别未纳入本规则。</p>
   <p className="market-research-note">以本次观测参考价分组；当前来源未提供可信历史价格，不能据此判断涨价、降价或价格带迁移。各月比较固定使用整个时间窗口共同可比的商品。</p>
   <p className="market-research-note">份额分母为该形态全部可比销量；分母为 0 时份额未知。单链接月均销量按销量总和 ÷ 有效链接数 ÷ 月数计算。</p>
   <ul>{report.monthly.map(m => <li key={m.month}>{m.month}：{number(m.totalUnits)}，共同可比 {m.eligibleAsins.length} 个</li>)}</ul>
   {report.products.map(p => <div key={p.asin}><strong>{p.asin}</strong><p>来源观测价格原值：{number(p.rawPrice)}；{p.priceIssues.length ? p.priceIssues.map(i => issues[i] ?? i).join('、') : '参考价可用'}{p.provenance?`（范围：${p.provenance.scopeBasis==='request-bound'?'请求绑定':'响应回显'}；币种：${p.provenance.currencyBasis==='provider-contract'?'供应商约定':'响应回显'}）`:''}</p><ul>{p.observations.map(o => <li key={o.month}>{o.month} 销量原值 {number(o.rawUnits)} · {o.issues.length ? o.issues.map(i => issues[i] ?? i).join('、') : '销量可用'}{o.provenance?`（月份：${o.provenance.periodBasis==='request-bound'?'请求绑定':o.provenance.periodBasis==='response-verified'?'响应回显':'超出支持范围'}）`:''}</li>)}</ul></div>)}
  </details>
  <p className="market-research-note">{semanticSkipped?'本卡片保存人工分组与统计结果；语义解释未启用。':'本卡片保存人工分组与统计结果；对应版本的解释分析见下方。'}</p>
 </section>;
}
