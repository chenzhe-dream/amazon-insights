'use client';
import { Fragment, useState } from 'react';
import type { MarketShapeExplanationPresentation } from '../shared/market-shape-explanation-presentation';
import {shapeSavedPeriodColumns} from './market-shape-period-columns';
import {MarketShapeSavedConclusion} from './market-shape-saved-conclusion';
import {LaunchSection} from './launch-section';
import { MARKET_LISTING_AGE_BANDS, type MarketShapeStructure } from '../shared/market-shape-structure-contracts';
import type { MarketShapePublicRevision } from '../shared/market-shape-public-contracts';
const number = (n: number | null) => n === null ? '未知' : n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
type Ratio = MarketShapeStructure['segments'][number]['brands'][number]['stats']['salesShare'];
const share = (v: Ratio) => `${v.value === null ? '未知' : (v.value * 100).toFixed(1) + '%'}（${number(v.numerator)} / ${number(v.denominator)}）`;
const issueLabels: Record<string, string> = { 'scope-unconfirmed': '来源范围未确认', 'brand-missing': '品牌缺失', 'listing-date-missing': '上架日期缺失', 'listing-date-invalid': '上架日期无效', 'listed-after-reference-month': '上架日期晚于研究结束月' };
const segmentKey = (s: MarketShapeStructure['segments'][number]) => s.kind === 'all' ? 'all' : `shape:${s.labelId ?? ''}`;
export function MarketShapeStructureReport({ structure, report, section = 'all', presentation }: {
    section?: 'all' | 'age' | 'brand';
    presentation?: MarketShapeExplanationPresentation | null;
    structure: MarketShapeStructure;
    report: MarketShapePublicRevision;
}) {
    const [selected, setSelected] = useState('all'), labels = new Map(report.labels.map(l => [l.labelId, l.label]));
    const segment = structure.segments.find(s => segmentKey(s) === selected) ?? structure.segments[0];
    const priceBand = (id: string | null) => { if (id === null)
        return '价格未知或未分档'; const b = report.bands.find(b => b.id === id); return b ? `${number(b.minInclusive)} ≤ 价格${b.maxExclusive === null ? '' : ` < ${number(b.maxExclusive)}`}` : '价格带不可用'; };
    const periods = shapeSavedPeriodColumns(report.scope,report.periodProjection);
    const projectedBrand=(period:typeof periods[number],brand:string|null,bandId?:string|null)=>{const row=period.projection?.segments.find(s=>s.kind===segment.kind&&s.labelId===segment.labelId)?.brands.find(b=>b.brand===brand);return bandId===undefined?row?.stats:row?.bands.find(b=>b.bandId===bandId)?.stats};
    const products = structure.products.filter(p => segment.requestedAsins.includes(p.asin));
    return <section role="region" aria-label={section === 'age' ? '上架年龄结构' : section === 'brand' ? '品牌结构' : '品牌与上架年龄结构'} className="market-shape-structure">

    <label>结构比较范围<select value={segmentKey(segment)} onChange={e => setSelected(e.target.value)} aria-label={section === 'all' ? '结构比较范围' : `${section === 'age' ? '上架年龄' : '品牌'}结构比较范围`}>{structure.segments.map(s => <option key={segmentKey(s)} value={segmentKey(s)}>{s.kind === 'all' ? '全部所选商品' : s.labelId === null ? '未分类' : labels.get(s.labelId) ?? s.labelId}</option>)}</select></label>
    <p>本范围所选 {segment.requestedAsins.length} 个，共同可比 {segment.eligibleAsins.length} 个；品牌未知 {products.filter(p => p.brand.value === null).length} 个，上架年龄未知 {products.filter(p => p.listing.ageMonths === null).length} 个。</p>
    {section !== 'age' && <LaunchSection title="品牌 · 价格带分析" description="品牌 × 参考价格带；研究窗口共同可比销量" badge={<span className="source-badge">{segment.requestedAsins.length} 链接 · {segment.brands.length} 品牌</span>}>
    <div className="market-shape-table launch-table-wrap launch-table-wrap-sticky" role="region" aria-label="品牌与价格带交叉表" tabIndex={0}><table className="launch-table shape-price-table brand-price-band-table"><thead><tr><th rowSpan={2} className="shape-price-label-col">品牌 / 参考价格带（{report.scope.currency}）</th>{periods.map(period=><th key={period.label} colSpan={2}>{period.label}</th>)}<th rowSpan={2}>所选 / 可比链接</th><th rowSpan={2}>价格带内链接份额</th><th rowSpan={2}>单链月均销量</th></tr><tr>{periods.map(period=><Fragment key={period.label}><th>可比销量</th><th>销量份额</th></Fragment>)}</tr></thead><tbody>{segment.brands.map(b=><Fragment key={b.brand??'unknown'}><tr className="shape-price-subtotal-row"><th className="shape-price-label-col">{b.brand??'未知品牌'} · 合计</th>{periods.map(period=><Fragment key={period.label}><td className="shape-price-num">{period.projection?number(projectedBrand(period,b.brand)?.units??null):period.saved?number(b.stats.units):'未知'}</td><td className="shape-price-pct" title="本品牌销量占当前比较范围全部可比销量">{period.projection?share(projectedBrand(period,b.brand)?.salesShare??{numerator:null,denominator:null,value:null}):period.saved?share(b.stats.salesShare):'未知'}</td></Fragment>)}<td>{b.stats.requestedLinks} / {b.stats.comparableLinks}</td><td>—</td><td>{number(b.stats.monthlyUnitsPerLink)}</td></tr>{b.bands.map(p=><tr className="shape-price-band-row" key={p.bandId??'unknown'}><td className="shape-price-label-col"><span className="shape-price-band-label">{priceBand(p.bandId)}</span></td>{periods.map(period=><Fragment key={period.label}><td className="shape-price-num">{period.projection?number(projectedBrand(period,b.brand,p.bandId)?.units??null):period.saved?number(p.stats.units):'未知'}</td><td className="shape-price-pct" title="当前价格带内的品牌销量份额">{period.projection?share(projectedBrand(period,b.brand,p.bandId)?.salesShare??{numerator:null,denominator:null,value:null}):period.saved?share(p.stats.salesShare):'未知'}</td></Fragment>)}<td>{p.stats.requestedLinks} / {p.stats.comparableLinks}</td><td>{share(p.stats.linkShare)}</td><td>{number(p.stats.monthlyUnitsPerLink)}</td></tr>)}</Fragment>)}</tbody></table></div>
    <p className="market-research-note">历史周期仅在完整月份已保存时展示，并保留整个研究窗口的共同可比商品；品牌合计销量份额的分母为比较范围全部可比销量。链接份额：该品牌在此价格带的所选链接 ÷ 本范围此价格带全部所选链接。销量份额：该品牌在此价格带的共同可比销量 ÷ 本范围此价格带全部共同可比销量。未知品牌单列，缺价格不当作零元；品牌名称按来源区分，不自动合并别名。</p>
    <MarketShapeSavedConclusion title="品牌与价格带机会结论" dimension="brand" presentation={presentation}/>
    </LaunchSection>}{section !== 'brand' && <LaunchSection title="上架年龄分析" description="上架年龄 × 销量；本版本按月龄分档，非上架年份分组" badge={<span className="source-badge">{segment.requestedAsins.length} 链接</span>}>
    <p className="market-research-note">截至 {structure.referenceMonth}，上架月龄按研究结束月与来源上架月份的日历月差计算。分档用于比较，不代表新品潜力或产品生命周期；品牌与日期均来自参考快照。</p>
    <div className="market-shape-table launch-table-wrap launch-table-wrap-sticky" role="region" aria-label="上架年龄与销量表" tabIndex={0}><table className="launch-table shape-price-table"><thead><tr><th>上架月龄</th><th>所选 / 可比链接</th><th>可比销量</th><th>范围内链接份额</th><th>范围内销量份额</th><th>单链月均销量</th></tr></thead><tbody>{segment.ages.map(a => <tr className="shape-price-band-row" key={a.bucketId ?? 'unknown'}><th>{a.bucketId === null ? '年龄未知' : MARKET_LISTING_AGE_BANDS.find(b => b.id === a.bucketId)?.label ?? a.bucketId}</th><td>{a.stats.requestedLinks} / {a.stats.comparableLinks}</td><td>{number(a.stats.units)}</td><td>{share(a.stats.linkShare)}</td><td>{share(a.stats.salesShare)}</td><td>{number(a.stats.monthlyUnitsPerLink)}</td></tr>)}</tbody></table></div>
    <p className="market-research-note">销量仅使用整个研究窗口共同可比商品；无可比销量或分母为0时显示未知。单链月均分母为可比链接数 × {structure.monthCount} 个月。未返回的月份不补0，以上结构不是全市场占比。</p>
    <MarketShapeSavedConclusion title="上架年龄与销量结论" dimension="age" presentation={presentation}/>
    </LaunchSection>}<details className="market-shape-structure-source"><summary>品牌及上架日期来源</summary>{products.map(p => <div key={p.asin}><strong>{p.asin}</strong><p>品牌原文：{p.brand.rawValue ?? '未提供'}；{p.brand.issues.length ? p.brand.issues.map(i => issueLabels[i] ?? i).join('、') : '品牌可用'}{p.brand.scopeBasis==='request-bound'?'（范围按请求绑定）':''}</p><p>上架日期原文：{p.listing.rawValue ?? '未提供'}；{p.listing.issues.length ? p.listing.issues.map(i => issueLabels[i] ?? i).join('、') : `上架月龄 ${p.listing.ageMonths} 个月`}{p.listing.scopeBasis==='request-bound'?'（范围按请求绑定）':''}</p><p>快照：<code>{p.brand.evidence.inputSnapshotId}</code></p><p>来源：<code>{p.brand.evidence.sourceRef}</code></p><p>原文位置：<code>{JSON.stringify(p.brand.evidence.payloadPath)}</code>、<code>{JSON.stringify(p.listing.evidence.payloadPath)}</code></p></div>)}</details>
  </section>;
}
