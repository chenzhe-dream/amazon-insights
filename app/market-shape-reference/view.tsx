"use client";

import { useMemo, useState, type ReactNode } from "react";
import { LaunchSection, LaunchTable } from "../launch-section";
import type { SorftimeCategoryDashboardProduct, SorftimeCategoryDashboardReport } from "./types";
import { buildReferenceShapeAnalysis, resolveProductPriceBand, resolveSorftimeMarginEntryLabel, isReferencePeriodBeforeLaunch, hasReferencePeriodDateConflict, type ReferenceGroupRow } from "./rules";
import { TopSalesMultiSelectFilter } from "./top-sales-multi-select-filter";
import type { TopSalesMultiSelectFilterState } from "./multi-filter";
import { CategoryComboChart, MonopolyTrendChart } from "./charts";
import { buildReferenceConclusions } from "./conclusions";
import { ReferenceBrandPriceConclusion, ReferenceListingYearConclusion, ReferenceShapePriceConclusion, ReferenceShapeSalesConclusion, ReferenceSynthesisConclusion } from "./conclusions/view";
import { ResizeHeader, TOP_SALES_COLUMNS, useReferenceColumnWidths, type TopSalesColumnId } from "./column-resize";
import { marketSites } from "../../shared/market-sites";

export type { SorftimeCategoryDashboardProduct, SorftimeCategoryDashboardReport } from "./types";

export type MarketShapeReferenceViewProps = {
  report: SorftimeCategoryDashboardReport;
  assignments: Record<string, string>;
  selectedAsins: string[];
  onAssignment: (asin: string, label: string) => void;
  onSelected: (asins: string[]) => void;
  disabled?: boolean;
  requestedPoolSize?: number;
  onPoolSizeChange?: (size: number) => void;
  poolSizeDisabled?: boolean;
};

type Period = "last3Months" | "last6Months" | "y2025" | "y2024";
const periods: { key: Period; label: string }[] = [
  { key: "last3Months", label: "近3个月" }, { key: "last6Months", label: "近6个月" },
  { key: "y2025", label: "2025年" }, { key: "y2024", label: "2024年" },
];
const n = (value: number | null | undefined, digits = 0) => value == null || !Number.isFinite(value) ? "未知" : value.toLocaleString("zh-CN", { maximumFractionDigits: digits });
const known = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? null : value;
const band = (product: SorftimeCategoryDashboardProduct) => resolveProductPriceBand(product);
const marginLabel = (value: number | null | undefined) => resolveSorftimeMarginEntryLabel(value).label.replace("—", "未知");
const year = (value: string | null | undefined) => value && /^20\d{2}/.test(value) ? value.slice(0, 4) : "未知";
const shape = (assignments: Record<string, string>, p: SorftimeCategoryDashboardProduct) => assignments[p.asin]?.trim() || p.productShape?.trim() || "未分类";
const periodValue = (p: SorftimeCategoryDashboardProduct, key: Period) => known(p.sales[key]);

function Trend({ product }: { product: SorftimeCategoryDashboardProduct }) {
  const volume = product.monthlyTrend.volume;
  const amount = product.monthlyTrend.amount;
  const months = [...new Set([...volume, ...amount].map(point => point.month))].sort();
  const max = Math.max(1, ...volume.map(p => known(p.value) ?? 0));
  const maxAmount = Math.max(1, ...amount.map(p => known(p.value) ?? 0));
  return <div className="shape-ref-trend" aria-label={`${product.asin} 月度销量与销售额趋势`}>
    {months.length ? <div className="shape-ref-trend-bars">{months.map(month => {
      const units = volume.find(p => p.month === month)?.value;
      const revenue = amount.find(p => p.month === month)?.value;
      return <div key={month} className="shape-ref-trend-pair" title={`${month}：销量 ${n(units)}；销售额 ${n(revenue, 2)}`}>
        {known(units) === null ? null : <span style={{ height: `${Math.max(2, units! / max * 42)}px`, background: "#2f80ed" }} />}
        {known(revenue) === null ? null : <span style={{ height: `${Math.max(2, revenue! / maxAmount * 42)}px`, background: "#7a67d8" }} />}
      </div>;
    })}</div> : "未知"}
    <small>蓝：销量　紫：金额</small>
    <div className="shape-ref-trend-values">{months.slice(-3).map(month => <small key={month}>{month}　{n(volume.find(p => p.month === month)?.value)} / {n(amount.find(p => p.month === month)?.value, 2)}</small>)}</div>
  </div>;
}

function MetricBars({ rows }: { rows: { label: string; value: number | null }[] }) {
  const max = Math.max(1, ...rows.map(row => row.value ?? 0));
  return <div className="shape-ref-metric-bars">{rows.map(row => <div key={row.label} className="shape-ref-bar-row"><span>{row.label}</span><div><span style={{ width: `${row.value === null ? 0 : row.value / max * 100}%` }} title={`${row.label}：${n(row.value)}`} /></div><b>{n(row.value)}</b></div>)}</div>;
}

export function MarketShapeReferenceView({ report, assignments, selectedAsins, onAssignment, onSelected, disabled = false, requestedPoolSize = report.topLinkCount, onPoolSizeChange, poolSizeDisabled = false }: MarketShapeReferenceViewProps) {
  const [brand, setBrand] = useState<TopSalesMultiSelectFilterState>(null);
  const [listingYear, setListingYear] = useState<TopSalesMultiSelectFilterState>(null);
  const [priceBand, setPriceBand] = useState<TopSalesMultiSelectFilterState>(null);
  const [shapeFilter, setShapeFilter] = useState<TopSalesMultiSelectFilterState>(null);
  const [marginFilter, setMarginFilter] = useState<TopSalesMultiSelectFilterState>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"rank" | "sales30" | Period>("rank");
  const [descending, setDescending] = useState(true);
  const [bulkSelected, setBulkSelected] = useState<string[]>([]);
  const [bulkShape, setBulkShape] = useState("");
  const { widths, setWidth } = useReferenceColumnWidths();
  const selected = new Set(selectedAsins);
  const analysis = useMemo(() => buildReferenceShapeAnalysis(report, assignments, selectedAsins), [report, assignments, selectedAsins]);
  const conclusions = useMemo(() => buildReferenceConclusions(report, assignments, selectedAsins), [report, assignments, selectedAsins]);
  const active = analysis.products;
  const brands = [...new Set(report.products.map(p => p.brand || "未知"))].sort();
  const years = [...new Set(report.products.map(p => year(p.onlineDate)))].sort().reverse();
  const bands = [...new Set(report.products.map(band))].sort((a, b) => (parseInt(a.replace(/\D/g, "")) || Infinity) - (parseInt(b.replace(/\D/g, "")) || Infinity));
  const shapes = [...new Set(report.products.map(p => shape(assignments, p)))].sort();
  const margins = [...new Set(report.products.map(p => marginLabel(p.grossProfitMargin)))];
  const amazonDomain = marketSites.find(site => site.code === report.marketplace)?.amazonDomain;
  const counts = (get: (p: SorftimeCategoryDashboardProduct) => string) => new Map([...new Set(report.products.map(get))].map(value => [value, report.products.filter(p => get(p) === value).length]));
  const visible = report.products.filter(p =>
    (!brand?.length || brand.includes(p.brand || "未知")) && (!listingYear?.length || listingYear.includes(year(p.onlineDate))) &&
    (!priceBand?.length || priceBand.includes(band(p))) && (!shapeFilter?.length || shapeFilter.includes(shape(assignments, p))) &&
    (!marginFilter?.length || marginFilter.includes(marginLabel(p.grossProfitMargin))) &&
    (!query || `${p.asin} ${p.title}`.toLowerCase().includes(query.toLowerCase()))
  ).sort((a, b) => {
    if (sort === "rank") return a.rank - b.rank;
    const av = sort === "sales30" ? known(a.monthlySalesVolume) : periodValue(a, sort);
    const bv = sort === "sales30" ? known(b.monthlySalesVolume) : periodValue(b, sort);
    if (av === null) return 1;
    if (bv === null) return -1;
    return (av - bv) * (descending ? -1 : 1) || a.rank - b.rank;
  });
  const toggleSort = (key: typeof sort) => { setDescending(sort === key ? !descending : true); setSort(key); };
  const yearly = analysis.listingYears, byShape = analysis.shapes, shapeBands = analysis.shapePriceBands, brandBands = analysis.brandPriceBands;
  const currentUnits = analysis.synthesis.currentMonthlyVolume, currentAmount = analysis.synthesis.currentMonthlyAmount;
  const periodTotal = (key: Period) => analysis.synthesis.totalSales[key];
  const marginGroups = Object.entries(analysis.synthesis.marginCounts).filter(([, count]) => count > 0);
  const marginConclusion = conclusions.margin.status === "ready" ? conclusions.margin.result : null;
  const completedVolume = [...report.history.volume].sort((a, b) => a.month.localeCompare(b.month));
  const latest = completedVolume.at(-1), previous = completedVolume.at(-2);
  const mom = latest?.value == null || previous?.value == null || previous.value <= 0 ? null : (latest.value / previous.value - 1) * 100;
  const headers: Record<TopSalesColumnId, ReactNode> = {
    include: "纳入", bulk: <input type="checkbox" aria-label="批量选择可见商品" checked={visible.length > 0 && visible.every(p => bulkSelected.includes(p.asin))} onChange={e => setBulkSelected(e.target.checked ? [...new Set([...bulkSelected, ...visible.map(p => p.asin)])] : bulkSelected.filter(asin => !visible.some(p => p.asin === asin)))} />,
    rank: <button type="button" onClick={() => toggleSort("rank")}>排名</button>, product: "商品", brand: "品牌", shape: "人工形态", launch: "上架年月", margin: "毛利润率", entry: "准入", price: "价格", band: "价格带",
    sales30: <button type="button" onClick={() => toggleSort("sales30")}>近30天销量</button>, amount30: "近30天销售额", trend: "月度趋势",
    last3: <button type="button" onClick={() => toggleSort("last3Months")}>近3个月</button>, last6: <button type="button" onClick={() => toggleSort("last6Months")}>近6个月</button>,
    y2025: <button type="button" onClick={() => toggleSort("y2025")}>2025年</button>, y2024: <button type="button" onClick={() => toggleSort("y2024")}>2024年</button>,
    rating: "星级", reviews: "评论数", delivery: "配送", seller: "卖家", action: "操作",
  };

  return <div className="market-ui-reference market-shape-reference-view">
    <style>{`.market-shape-reference-view{display:grid;gap:18px}.market-shape-reference-view .top-sales-table{min-width:1780px;table-layout:fixed}.market-shape-reference-view .top-sales-table th,.market-shape-reference-view .top-sales-table td{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.market-shape-reference-view .top-sales-table th button{border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;font-weight:inherit}.market-shape-reference-view .top-sales-product-cell{min-width:220px;max-width:300px}.market-shape-reference-view .top-sales-product-cell small{display:block;white-space:normal}.market-shape-reference-view .top-sales-product-cell img{object-fit:contain;flex:none}.market-shape-reference-view input[aria-label$=" 人工形态"]{width:100px}.market-shape-reference-view .top-sales-table-toolbar{margin-bottom:12px}.market-shape-reference-view .top-sales-table-filters{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:end}.market-shape-reference-view .top-sales-table-filters label{display:grid;gap:4px}.shape-ref-trend{min-width:120px}.shape-ref-trend-bars{height:46px;display:flex;gap:2px;align-items:end}.shape-ref-trend-pair{height:46px;display:flex;gap:1px;align-items:end;flex:1}.shape-ref-trend-pair span{display:block;flex:1;min-width:2px;border-radius:2px 2px 0 0}.shape-ref-trend-values{display:grid;gap:2px;font-size:10px}.shape-ref-metric-bars{display:grid;gap:6px;margin:12px 0}.shape-ref-bar-row{display:grid;grid-template-columns:minmax(80px,160px) minmax(80px,1fr) 70px;gap:10px;align-items:center;font-size:.88rem}.shape-ref-bar-row>div{height:10px;border-radius:8px;background:#edf2f7;overflow:hidden}.shape-ref-bar-row>div>span{display:block;height:100%;background:#2f80ed;border-radius:inherit}.shape-ref-bar-row b{text-align:right}`}</style>
    <LaunchSection title={`${report.categoryName} · 类目销量看板`} description={`${report.marketplace} · Node ${report.nodeId} · 来源获取于 ${report.fetchedAt}`} badge={<span className="source-badge">已保存商品来源</span>}>
      <p className="market-research-note">{report.note || "商品当前销量与销售额为来源近30天观测；历史销量和金额按实际日历月显示。"}</p>
      <div className="market-overview-kpis">{[
        ["TOP 商品近30天销量", n(report.stats.top100MonthlyVolume)], ["TOP 商品近30天销售额", n(report.stats.top100MonthlyAmount, 2)],
        ["最近完整月销量", `${n(latest?.value)}${latest?.month ? ` · ${latest.month}` : ""}`], ["月环比", mom === null ? "未知" : `${mom.toFixed(1)}%`],
        ["TOP3 商品份额", report.stats.top3ProductSharePct == null ? "未知" : `${n(report.stats.top3ProductSharePct, 1)}%`],
        ["TOP3 品牌份额", report.stats.top3BrandSharePct == null ? "未知" : `${n(report.stats.top3BrandSharePct, 1)}%`],
        ["TOP3 卖家份额", report.stats.top3SellerSharePct == null ? "未知" : `${n(report.stats.top3SellerSharePct, 1)}%`],
        ["Amazon 自营份额", report.stats.amazonOwnedSharePct == null ? "未知" : `${n(report.stats.amazonOwnedSharePct, 1)}%`],
        ["平均价", n(report.stats.averagePrice, 2)], ["中位价", n(report.stats.medianPrice, 2)],
        ["类目退货率", report.stats.returnRatePct == null ? "未知" : `${n(report.stats.returnRatePct, 1)}%`],
      ].map(([label, value]) => <div key={label}><span>{label}</span><b>{value}</b></div>)}</div>
      <CategoryComboChart volume={report.history.volume} amount={report.history.amount} amountEstimated />
      <MonopolyTrendChart listing={report.history.listingMonopoly} brand={report.history.brandMonopoly} seller={report.history.sellerMonopoly} />
    </LaunchSection>

    <LaunchSection title="TOP 销售商品 · 形态与毛利准入" description="人工形态立即影响下方草稿统计；销量与金额为来源近30天观测" badge={<span className="source-badge">已选 {active.length} / 来源 {report.products.length} 链接</span>}>
      <div className="top-sales-table-toolbar"><div className="top-sales-table-filters">
        <span>来源 TOP {report.topLinkCount} · 共 {report.products.length} 链接</span>
        {onPoolSizeChange&&<label>商品池上限（更改后重新采集） <select aria-label="商品池采集上限" disabled={disabled||poolSizeDisabled} value={requestedPoolSize} onChange={e => onPoolSizeChange(Number(e.target.value))}>{[...new Set([requestedPoolSize,50,100,150,200,250,300])].sort((a,b)=>a-b).map(v => <option key={v} value={v}>{v}</option>)}</select></label>}
        <TopSalesMultiSelectFilter prefix="品牌" ariaLabel="筛选品牌" options={brands} optionCounts={counts(p => p.brand || "未知")} filter={brand} onChange={setBrand} searchable />
        <TopSalesMultiSelectFilter prefix="上架年份" ariaLabel="筛选上架年份" options={years} optionCounts={counts(p => year(p.onlineDate))} filter={listingYear} onChange={setListingYear} />
        <TopSalesMultiSelectFilter prefix="价格带" ariaLabel="筛选价格带" options={bands} optionCounts={counts(band)} filter={priceBand} onChange={setPriceBand} />
        <TopSalesMultiSelectFilter prefix="市场准入" ariaLabel="筛选市场准入" options={margins} optionCounts={counts(p => marginLabel(p.grossProfitMargin))} filter={marginFilter} onChange={setMarginFilter} showShare shareTotal={report.products.length} />
        <TopSalesMultiSelectFilter prefix="商品形态" ariaLabel="筛选商品形态" options={shapes} optionCounts={counts(p => shape(assignments, p))} filter={shapeFilter} onChange={setShapeFilter} searchable showShare shareTotal={report.products.length} />
        <label>搜索 <input aria-label="搜索商品" value={query} onChange={e => setQuery(e.target.value)} placeholder="标题或 ASIN" /></label>
      </div></div>
      <div className="top-sales-shape-bulk-bar"><span>批量选择 {bulkSelected.length} 链接</span><input aria-label="批量形态" value={bulkShape} onChange={e => setBulkShape(e.target.value)} placeholder="输入形态" disabled={disabled} /><button type="button" disabled={disabled || !bulkSelected.length || !bulkShape.trim()} onClick={() => { for (const asin of bulkSelected) onAssignment(asin, bulkShape.trim()); setBulkSelected([]); }}>批量设为此形态</button><button type="button" disabled={!bulkSelected.length} onClick={() => setBulkSelected([])}>清空批量选择</button></div>
      <LaunchTable stickyHeader className="top-sales-table"><colgroup>{TOP_SALES_COLUMNS.map(([id]) => <col key={id} style={{ width: widths[id] }} />)}</colgroup><thead><tr>{TOP_SALES_COLUMNS.map(([id]) => <ResizeHeader key={id} id={id} width={widths[id]} onWidth={setWidth}>{headers[id]}</ResizeHeader>)}</tr></thead><tbody>
        {visible.map(p => <tr key={p.asin} className={selected.has(p.asin) ? "top-sales-row-selected" : ""}>
          <td><input type="checkbox" aria-label={`选择 ${p.asin}`} checked={selected.has(p.asin)} disabled={disabled} onChange={e => onSelected(e.target.checked ? [...selectedAsins, p.asin] : selectedAsins.filter(a => a !== p.asin))} /></td>
          <td><input type="checkbox" aria-label={`批量选择 ${p.asin}`} checked={bulkSelected.includes(p.asin)} onChange={e => setBulkSelected(e.target.checked ? [...bulkSelected, p.asin] : bulkSelected.filter(asin => asin !== p.asin))} /></td><td>{p.rank}</td>
          <td><div className="traffic-conclusion-product top-sales-product-cell">{p.imageUrl ? <img src={p.imageUrl} alt="" width={48} height={48} /> : null}<div>{amazonDomain ? <a href={`https://www.${amazonDomain}/dp/${p.asin}`} target="_blank" rel="noreferrer">{p.asin} ↗</a> : <strong>{p.asin}</strong>}<small>{p.title}</small></div></div></td>
          <td>{p.brand || "未知"}</td><td><input aria-label={`${p.asin} 人工形态`} value={assignments[p.asin] ?? ""} disabled={disabled} onChange={e => onAssignment(p.asin, e.target.value)} /></td>
          <td>{p.onlineDate?.slice(0, 7) || "未知"}</td><td>{p.grossProfitMargin == null ? "未知" : `${n(p.grossProfitMargin, 1)}%`}</td><td>{marginLabel(p.grossProfitMargin)}</td><td>{n(p.price, 2)}</td><td>{band(p)}</td><td>{n(p.monthlySalesVolume)}</td><td>{n(p.monthlySalesAmount, 2)}</td><td><Trend product={p} /></td>
          {periods.map(period => <td key={period.key}>{hasReferencePeriodDateConflict(p,period.key)?'日期冲突':isReferencePeriodBeforeLaunch(p,period.key)?'不适用':n(periodValue(p, period.key))}</td>)}<td>{n(p.starRating, 1)}</td><td>{n(p.reviewCount)}</td><td>{p.deliveryType || "未知"}</td><td>{p.seller || "未知"}</td><td><button type="button" className="ghost-btn danger" disabled={disabled} onClick={() => onSelected(selected.has(p.asin) ? selectedAsins.filter(a => a !== p.asin) : [...selectedAsins, p.asin])}>{selected.has(p.asin) ? "移除" : "恢复"}</button></td>
        </tr>)}
      </tbody></LaunchTable>
      <p className="market-research-note">毛利准入：≥70% 优先进入；≥60% 建议进入；≥50% 谨慎进入；低于50% 不建议进入。未知保持未知。</p>
      <MetricBars rows={marginGroups.map(([label, count]) => ({ label, value: count }))} />
      <div className="listing-age-conclusion listing-age-entry-gray top-sales-margin-entry-conclusion"><div className="listing-age-conclusion-head"><div><p className="listing-age-conclusion-eyebrow">毛利润率 · 市场准入</p><h4 className="listing-age-conclusion-title">{marginConclusion?.headline ?? "历史销量不足，无法生成原版毛利准入结论"}</h4></div></div>
        {marginConclusion ? <><p>有效毛利 {marginConclusion.withMarginCount} / {marginConclusion.totalLinks} 链接；平均毛利 {n(marginConclusion.avgMarginPct, 1)}%。</p><ul>{marginConclusion.bullets.map((item, i) => <li key={i}>{item}</li>)}</ul></> : <p>缺失历史销量保留未知，补齐后可生成分层结论。</p>}
      </div>
    </LaunchSection>

    <LaunchSection title="上架年份 · 销量结构分析" description="按已选商品的真实历史销量汇总；缺失历史不补零" badge={<span className="source-badge">{yearly.length} 年份组</span>}>
      <AggregateTable rows={yearly} total={analysis.synthesis.totalSales} yearBasis />
      {conclusions.listingYear.status === "ready" ? <ReferenceListingYearConclusion result={conclusions.listingYear.result} embedded /> : <p className="market-research-note">{conclusions.listingYear.reason}</p>}
    </LaunchSection>
    <LaunchSection title="商品形态 · 销量占比分析" description="按人工确认形态汇总 TOP 链接历史销量" badge={<span className="source-badge">{byShape.length} 形态</span>}>
      <AggregateTable rows={byShape} total={analysis.synthesis.totalSales} />
      <MetricBars rows={byShape.map(row => ({ label: row.label, value: row.sales.last6Months }))} />
      {conclusions.shapeSales.status === "ready" ? <ReferenceShapeSalesConclusion result={conclusions.shapeSales.result} embedded /> : <p className="market-research-note">{conclusions.shapeSales.reason}</p>}
    </LaunchSection>
    <LaunchSection title="商品形态 · 价格带分析" description="按商品形态与 10 美元价格带交叉汇总" badge={<span className="source-badge">{shapeBands.length} 组</span>}>
      <ShapePriceBandTable shapes={byShape} bands={shapeBands} total={analysis.synthesis.totalSales} />
      {conclusions.shapePrice.status === "ready" ? <ReferenceShapePriceConclusion result={conclusions.shapePrice.result} embedded /> : <p className="market-research-note">{conclusions.shapePrice.reason}</p>}
    </LaunchSection>
    <LaunchSection title="品牌 · 价格带分析" description="按品牌与 10 美元价格带交叉汇总" badge={<span className="source-badge">{brandBands.length} 组</span>}>
      <AggregateTable rows={brandBands} total={analysis.synthesis.totalSales} />
      {conclusions.brandPrice.status === "ready" ? <ReferenceBrandPriceConclusion result={conclusions.brandPrice.result} embedded /> : <p className="market-research-note">{conclusions.brandPrice.reason}</p>}
    </LaunchSection>
    <LaunchSection title="市场结构综合结论" description="汇总形态、价格带、品牌与毛利准入证据" badge={<span className="source-badge">规则草稿</span>}>
      <p>所选 {active.length} 个链接；近30天销量 {n(currentUnits)}，销售额 {n(currentAmount, 2)}。近6个月历史销量 {n(periodTotal("last6Months"))}。</p>
      <p>形态数量 {byShape.length}；品牌价格带组合 {brandBands.length}。毛利准入：{marginGroups.map(([label, count]) => `${label.replace("—", "未知")} ${count}`).join("；") || "未知"}。</p>
      {conclusions.synthesis.status === "ready" ? <ReferenceSynthesisConclusion result={conclusions.synthesis.result} embedded /> : <p className="market-research-note">{conclusions.synthesis.reason}</p>}
      <p className="market-research-note">{report.note || "所有统计限于当前所选商品与已保存来源；数据缺口显示未知。"}</p>
    </LaunchSection>
  </div>;
}

function AggregateTable({ rows, total, yearBasis = false }: { rows: ReferenceGroupRow[]; total: Record<Period, number | null>; yearBasis?: boolean }) {
  const [sortKey, setSortKey] = useState<Period | null>(null);
  const [desc, setDesc] = useState(true);
  const sorted = [...rows].sort((a, b) => sortKey === null ? 0 : a.sales[sortKey] === null ? 1 : b.sales[sortKey] === null ? -1 : (a.sales[sortKey]! - b.sales[sortKey]!) * (desc ? -1 : 1));
  const toggle = (key: Period) => { setDesc(sortKey === key ? !desc : true); setSortKey(key); };
  return <LaunchTable stickyHeader className="shape-price-table"><thead><tr><th>分组</th>{periods.map(p => <th key={p.key}><button type="button" onClick={() => toggle(p.key)}>{p.label}销量 / 占比</button></th>)}<th>链接数</th><th>近6个月单链月均</th><th>2025年单链月均</th></tr></thead><tbody>
    {sorted.map(row => <tr key={row.label}><th>{row.label}</th>{periods.map(period => <td key={period.key}>{yearBasis && (period.key === "y2024" || period.key === "y2025") && Number(row.label) > Number(period.key.slice(1)) ? "不适用" : `${n(row.sales[period.key])} / ${row.sharePct[period.key] === null ? "未知" : `${n(row.sharePct[period.key], 2)}%`}`}</td>)}<td>{row.linkCount}</td><td>{n(row.avgLast6MonthsMonthlyPerLink, 1)}</td><td>{n(row.avgY2025MonthlyPerLink, 1)}</td></tr>)}
    <tr className="shape-price-total-row"><th>合计</th>{periods.map(period => <td key={period.key}>{n(total[period.key])} / {total[period.key] === null ? "未知" : "100%"}</td>)}<td>{rows.reduce((sum, row) => sum + row.linkCount, 0)}</td><td>{total.last6Months === null || !rows.length ? "未知" : n(total.last6Months / rows.reduce((sum, row) => sum + row.linkCount, 0) / 6, 1)}</td><td>—</td></tr>
  </tbody></LaunchTable>;
}

function ShapePriceBandTable({ shapes, bands, total }: { shapes: ReferenceGroupRow[]; bands: ReferenceGroupRow[]; total: Record<Period, number | null> }) {
  return <LaunchTable stickyHeader className="shape-price-table shape-price-band-table"><thead><tr><th>商品形态 / 价格带</th>{periods.map(p => <th key={p.key}>{p.label}销量 / 形态内占比</th>)}<th>链接数</th><th>近6个月单链月均</th></tr></thead><tbody>
    {shapes.map(shapeRow => <FragmentRows key={shapeRow.label} shape={shapeRow} bands={bands.filter(row => row.label.startsWith(`${shapeRow.label} · `))} />)}
    <tr className="shape-price-total-row"><th>全部形态</th>{periods.map(p => <td key={p.key}>{n(total[p.key])}</td>)}<td>{shapes.reduce((sum, row) => sum + row.linkCount, 0)}</td><td>—</td></tr>
  </tbody></LaunchTable>;
}

function FragmentRows({ shape: row, bands }: { shape: ReferenceGroupRow; bands: ReferenceGroupRow[] }) {
  return <><tr className="shape-price-subtotal-row"><th>{row.label} · 合计</th>{periods.map(p => <td key={p.key}>{n(row.sales[p.key])} / {row.sales[p.key] === null || row.sales[p.key] === 0 ? "未知" : "100%"}</td>)}<td>{row.linkCount}</td><td>{n(row.avgLast6MonthsMonthlyPerLink)}</td></tr>
    {bands.map(bandRow => <tr className="shape-price-band-row" key={bandRow.label}><th>{bandRow.label.split(" · ").at(-1)}</th>{periods.map(p => <td key={p.key}>{n(bandRow.sales[p.key])} / {bandRow.sharePct[p.key] === null ? "未知" : `${n(bandRow.sharePct[p.key], 2)}%`}</td>)}<td>{bandRow.linkCount}</td><td>{n(bandRow.avgLast6MonthsMonthlyPerLink)}</td></tr>)}
  </>;
}
