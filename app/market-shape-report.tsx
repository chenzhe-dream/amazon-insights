'use client';
import type { MarketShapePublicRevision } from '../shared/market-shape-public-contracts';
import {MarketShapeStructureReport} from './market-shape-structure-report';
import {MarketShapeSourcePolicyNote} from './market-shape-source-policy-note';
const number = (n: number | null) => n === null ? '未知' : n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const issues: Record<string, string> = { 'scope-unconfirmed': '来源范围未确认', 'currency-unconfirmed': '币种未确认', 'period-unconfirmed': '月份未确认', 'price-missing': '价格缺失', 'units-missing': '销量缺失', 'not-collected': '该月未采集', 'member-missing': '该月未返回此商品','period-outside-provider-history':'超出供应商查询历史范围' };
export function MarketShapeReport({ report }: {
    report: MarketShapePublicRevision;
}) {
    const labels = new Map(report.labels.map(l => [l.labelId, l.label]));
    return <section className="card market-shape-report" role="region" aria-label="形态价格带版本报告"><h3>形态与价格带 · 版本 {report.ordinal}</h3>
  <p>{report.scope.marketplace} · 类目 {report.scope.nodeIdPath} · {report.scope.fromMonth} 至 {report.scope.toMonth}</p>
  <p>可比销量：{number(report.totalUnits)}</p><p>共同可比商品 {report.eligibleAsins.length} / 所选 {report.selectedAsins.length} 个</p>
  <MarketShapeSourcePolicyNote report={report}/>
  <p className="market-research-note">以本次观测参考价分组；当前来源未提供可信历史价格，不能据此判断涨价、降价或价格带迁移。各月比较固定使用整个时间窗口共同可比的商品。</p>
  <div className="market-shape-table" role="region" aria-label="价格带统计表" tabIndex={0}><table><thead><tr><th>人工形态</th><th>参考价格带（{report.scope.currency}）</th><th>可比链接</th><th>销量</th><th>形态内销量份额</th></tr></thead><tbody>{report.groups.flatMap(g => g.bands.map(b => { const range = report.bands.find(r => r.id === b.id)!; return <tr key={`${g.labelId}/${b.id}`}><th>{g.labelId === null ? '未分类' : labels.get(g.labelId) ?? g.labelId}</th><td>{range.minInclusive} ≤ 价格{range.maxExclusive === null ? '' : ` < ${range.maxExclusive}`}</td><td>{b.links}</td><td>{number(b.units)}</td><td>{b.share === null ? '未知' : `${(b.share * 100).toFixed(1)}%`} <small>（{number(b.units)} / {number(b.denominatorUnits)}）</small></td></tr>; }))}</tbody></table></div>
  <p className="market-research-note">份额分母为该形态全部可比销量；分母为 0 时份额未知。单链接月均销量按销量总和 ÷ 有效链接数 ÷ 月数计算。</p>
  <ul>{report.groups.map(g => <li key={g.labelId ?? 'unclassified'}>{g.labelId === null ? '未分类' : labels.get(g.labelId) ?? g.labelId}：单链接月均销量 {number(g.monthlyUnitsPerLink)}</li>)}</ul>
  <details><summary>各月可比销量与商品缺口</summary><ul>{report.monthly.map(m => <li key={m.month}>{m.month}：{number(m.totalUnits)}，共同可比 {m.eligibleAsins.length} 个</li>)}</ul>
   {report.products.map(p => <div key={p.asin}><strong>{p.asin}</strong><p>来源观测价格原值：{number(p.rawPrice)}；{p.priceIssues.length ? p.priceIssues.map(i => issues[i] ?? i).join('、') : '参考价可用'}{p.provenance?`（范围：${p.provenance.scopeBasis==='request-bound'?'请求绑定':'响应回显'}；币种：${p.provenance.currencyBasis==='provider-contract'?'供应商约定':'响应回显'}）`:''}</p><ul>{p.observations.map(o => <li key={o.month}>{o.month} 销量原值 {number(o.rawUnits)} · {o.issues.length ? o.issues.map(i => issues[i] ?? i).join('、') : '销量可用'}{o.provenance?`（月份：${o.provenance.periodBasis==='request-bound'?'请求绑定':o.provenance.periodBasis==='response-verified'?'响应回显':'超出支持范围'}）`:''}</li>)}</ul></div>)}
  </details>
  {report.structure?<MarketShapeStructureReport key={report.revisionId} structure={report.structure} report={report}/>:<p className="market-research-note">此历史版本未保存品牌与上架年龄结构。</p>}
  <p className="market-research-note">本卡片保存人工分组与统计结果；对应版本的解释分析见下方。</p>
 </section>;
}
