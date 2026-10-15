"use client";

import { useId, useMemo, useState, type ReactNode } from "react";
import { LaunchSection, LaunchTable } from "../launch-section";
import type { SorftimeCategoryDashboardProduct, SorftimeCategoryDashboardReport } from "./types";
import { referenceMonthlyAverage, buildReferenceShapeAnalysis, resolveListingYear, parseReferenceListingDate, resolveProductPriceBand, resolveSorftimeMarginEntryLabel, isReferencePeriodBeforeLaunch, hasReferencePeriodDateConflict, type ReferenceGroupRow } from "./rules";
import { TopSalesMultiSelectFilter } from "./top-sales-multi-select-filter";
import type { TopSalesMultiSelectFilterState } from "./multi-filter";
import { CategoryComboChart, MonopolyTrendChart } from "./charts";
import { buildReferenceConclusions } from "./conclusions";
import { ReferenceBrandPriceConclusion, ReferenceListingYearConclusion, ReferenceMarginConclusion, ReferenceSummaryMetrics, ReferenceShapePriceConclusion, ReferenceShapeSalesConclusion, ReferenceSynthesisConclusion } from "./conclusions/view";
import { ResizeHeader, TOP_SALES_COLUMNS, useReferenceColumnWidths, type TopSalesColumnId } from "./column-resize";
import {MarketAdminContent} from '../market-admin-tools';
import {ReferenceHistoryCoverage} from './history-coverage';
import {referenceSalesGapReason} from './history-status';
import {ShapeCatalog,fixedShapeLabels} from './shape-catalog';
import {SectionFilter,SectionSortButton,sortSectionRows,type SectionSort} from './section-filter';
import {sortGroupedPriceBands,type SectionSortMetric} from './sorting';
import {ProductTrend} from './product-trend';
import { marketSites } from "../../shared/market-sites";

export type { SorftimeCategoryDashboardProduct, SorftimeCategoryDashboardReport } from "./types";

export type MarketShapeReferenceViewProps = {
  report: SorftimeCategoryDashboardReport;
  assignments: Record<string, string>;
  selectedAsins: string[];
  onAssignment: (asin: string, label: string) => void;
  onSelected: (asins: string[]) => void;
  catalogLabels?: string[];
  onCatalogLabels?: (labels:string[])=>void;
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
const year = resolveListingYear;
const shape = (assignments: Record<string, string>, p: SorftimeCategoryDashboardProduct) => Object.hasOwn(assignments,p.asin)?assignments[p.asin].trim()||"未分类":p.productShape?.trim()||"未分类";
const periodValue = (p: SorftimeCategoryDashboardProduct, key: Period) => known(p.sales[key]);

function DataQualitySummary({ report }: { report: SorftimeCategoryDashboardReport }) {
  const grouped = new Map<string, { label: string; reason: string; count: number }>();
  const add = (label: string, reason: string) => {
    const key = `${label}\u0000${reason}`;
    const current = grouped.get(key);
    if (current) current.count += 1;
    else grouped.set(key, { label, reason, count: 1 });
  };
  for (const product of report.products) {
    if (product.monthlySalesVolume == null) add("近30天销量", "商品池未返回有效销量");
    if (product.monthlySalesAmount == null) add("近30天销售额", "商品池未返回有效销售额");
    if (product.price == null) add("价格/价格带", "商品池未返回有效正数价格");
    if (product.grossProfitMargin == null) add("毛利润率", product.marginSource?.note ?? "报告没有可采用的毛利润率");
    if (!product.imageUrl) add("商品图片", "报告未保存可用图片地址");
    const listing = parseReferenceListingDate(product.onlineDate);
    if (listing.status === "missing") add("上架日期", "来源未返回上架日期");
    else if (listing.status === "uncertain") add("上架日期", "来源日期格式无法确认，保留原值待核实");
    if (product.sales.last6Months == null) add("近6个月历史销量", referenceSalesGapReason(product, "last6Months", report.calculationVersion) ?? "来源未返回该期间历史销量");
  }
  const gaps = [...grouped.values()];
  if (!gaps.length) return null;
  const total = gaps.reduce((sum, item) => sum + item.count, 0);
  return <details className="shape-data-quality"><summary>未知数据原因（{total} 个字段）</summary><p className="shape-summary-note">“未知”表示保存的来源没有可采用的值；缺失不会补成 0，也不代表连接失败。</p><ul>{gaps.map(item => <li key={`${item.label}/${item.reason}`}><strong>{item.label}：{item.count} 条</strong> · {item.reason}</li>)}</ul></details>;
}


function MetricBars({ rows }: { rows: { label: string; value: number | null }[] }) {
  const max = Math.max(1, ...rows.map(row => row.value ?? 0));
  return <div className="shape-ref-metric-bars">{rows.map(row => <div key={row.label} className="shape-ref-bar-row"><span>{row.label}</span><div><span style={{ width: `${row.value === null ? 0 : row.value / max * 100}%` }} title={`${row.label}：${n(row.value)}`} /></div><b>{n(row.value)}</b></div>)}</div>;
}

export function MarketShapeReferenceView({ report, assignments, selectedAsins, onAssignment, onSelected, catalogLabels=[], onCatalogLabels, disabled = false, requestedPoolSize = report.topLinkCount, onPoolSizeChange, poolSizeDisabled = false }: MarketShapeReferenceViewProps) {
  const catalogId=useId();
  const [localLabels,setLocalLabels]=useState<string[]>([]);
  const [localShape,setLocalShape]=useState<TopSalesMultiSelectFilterState>(null),[localBandShape,setLocalBandShape]=useState<TopSalesMultiSelectFilterState>(null),[localBrand,setLocalBrand]=useState<TopSalesMultiSelectFilterState>(null);
  const [shapeSort,setShapeSort]=useState<SectionSort>(null),[bandSort,setBandSort]=useState<SectionSort>(null),[brandSort,setBrandSort]=useState<SectionSort>(null);
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
  const [editingAsin,setEditingAsin]=useState<string|null>(null);
  const { widths, setWidth } = useReferenceColumnWidths();
  const selected = new Set(selectedAsins);
  const fixedLabels=fixedShapeLabels(report.categoryName,report.nodeId);
  const analysis = useMemo(() => buildReferenceShapeAnalysis(report, assignments, selectedAsins, fixedLabels), [report, assignments, selectedAsins, fixedLabels]);
  const conclusions = useMemo(() => buildReferenceConclusions(report, assignments, selectedAsins, fixedLabels), [report, assignments, selectedAsins, fixedLabels]);
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
    (!priceBand?.length || priceBand.includes(band(p))) && (p.asin===editingAsin || !shapeFilter?.length || shapeFilter.includes(shape(assignments, p))) &&
    (!marginFilter?.length || marginFilter.includes(marginLabel(p.grossProfitMargin))) &&
    (!query || `${p.asin} ${p.title}`.toLowerCase().includes(query.toLowerCase()))
  ).sort((a, b) => {
    if (sort === "rank") return (a.rank - b.rank) * (descending ? 1 : -1);
    const av = sort === "sales30" ? known(a.monthlySalesVolume) : periodValue(a, sort);
    const bv = sort === "sales30" ? known(b.monthlySalesVolume) : periodValue(b, sort);
    if (av === null) return 1;
    if (bv === null) return -1;
    return (av - bv) * (descending ? -1 : 1) || a.rank - b.rank;
  });
  const toggleSort = (key: typeof sort) => { setDescending(sort === key ? !descending : true); setSort(key); };
  // Counts describe included products before this section's local filter.
  const sectionCounts = (get: (p: SorftimeCategoryDashboardProduct) => string) => {
    const result = new Map<string, number>();
    for (const product of active) { const label = get(product); result.set(label, (result.get(label) ?? 0) + 1); }
    return result;
  };
  const shapeCounts = sectionCounts(p => shape(assignments, p));
  const brandCounts = sectionCounts(p => p.brand || "未知");
  const localIds=(filter:TopSalesMultiSelectFilterState,get:(p:SorftimeCategoryDashboardProduct)=>string)=>active.filter(p=>!filter?.length||filter.includes(get(p))).map(p=>p.asin);
  const shapeIds=localIds(localShape,p=>shape(assignments,p)),bandIds=localIds(localBandShape,p=>shape(assignments,p)),brandIds=localIds(localBrand,p=>p.brand||'未知');
  const shapeAnalysis=buildReferenceShapeAnalysis(report,assignments,shapeIds,fixedLabels),bandAnalysis=buildReferenceShapeAnalysis(report,assignments,bandIds,fixedLabels),brandAnalysis=buildReferenceShapeAnalysis(report,assignments,brandIds,fixedLabels);
  const shapeConclusion=buildReferenceConclusions(report,assignments,shapeIds).shapeSales,bandConclusion=buildReferenceConclusions(report,assignments,bandIds).shapePrice,brandConclusion=buildReferenceConclusions(report,assignments,brandIds).brandPrice;
  const yearly=analysis.listingYears,byShape=sortSectionRows(shapeAnalysis.shapes,shapeSort),shapeBands=sortGroupedPriceBands(bandAnalysis.shapePriceBands,bandAnalysis.shapes,bandSort,'shape'),brandBands=sortGroupedPriceBands(brandAnalysis.brandPriceBands,brandAnalysis.brands,brandSort,'brand');
  const labelOptions=[...new Set([...fixedLabels,...catalogLabels,...localLabels,...Object.values(assignments).map(v=>v.trim())])].filter(v=>v&&v!=='未分类');
  const setLabels=(labels:string[])=>{setLocalLabels(labels);onCatalogLabels?.(labels)};
  const currentUnits = analysis.synthesis.currentMonthlyVolume, currentAmount = analysis.synthesis.currentMonthlyAmount;
  const periodTotal = (key: Period) => analysis.synthesis.totalSales[key];
  const marginGroups = Object.entries(analysis.synthesis.marginCounts).filter(([, count]) => count > 0);
  const marginConclusion = conclusions.margin.status === "ready" ? conclusions.margin.result : null;
  const completedVolume = [...report.history.volume].sort((a, b) => a.month.localeCompare(b.month));
  const latest = completedVolume.at(-1), previous = completedVolume.at(-2);
  const mom = latest?.value == null || previous?.value == null || previous.value <= 0 ? null : (latest.value / previous.value - 1) * 100;
  const headers: Record<TopSalesColumnId, ReactNode> = {
    bulk: <label className="shape-ref-bulk-heading">批量<input type="checkbox" aria-label="批量选择可见商品" disabled={disabled} checked={visible.length > 0 && visible.every(p => bulkSelected.includes(p.asin))} onChange={e => setBulkSelected(e.target.checked ? [...new Set([...bulkSelected, ...visible.map(p => p.asin)])] : bulkSelected.filter(asin => !visible.some(p => p.asin === asin)))} /></label>,
    rank: <button type="button" onClick={() => toggleSort("rank")}>排名</button>, product: "商品", brand: "品牌", shape: "商品形态", launch: "上架年月", margin: "毛利润率", entry: "准入", price: "价格", band: "价格带",
    sales30: <button type="button" onClick={() => toggleSort("sales30")}>近30天销量</button>, amount30: "近30天销售额", trend: "月度趋势",
    last3: <button type="button" onClick={() => toggleSort("last3Months")}>近3个月</button>, last6: <button type="button" onClick={() => toggleSort("last6Months")}>近6个月</button>,
    y2025: <button type="button" onClick={() => toggleSort("y2025")}>2025年</button>, y2024: <button type="button" onClick={() => toggleSort("y2024")}>2024年</button>,
    rating: "星级", reviews: "评论数", delivery: "配送", seller: "卖家", action: "操作",
  };

  return <div className="market-ui-reference market-shape-reference-view">
    <style>{`.market-shape-reference-view{display:grid;gap:18px}.market-shape-reference-view .top-sales-table{width:${TOP_SALES_COLUMNS.reduce((sum,[id])=>sum+widths[id],0)}px;min-width:0;table-layout:fixed}.market-shape-reference-view .top-sales-table th,.market-shape-reference-view .top-sales-table td{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.market-shape-reference-view .top-sales-table th button{border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;font-weight:inherit}.market-shape-reference-view .top-sales-product-cell{min-width:220px;max-width:300px}.market-shape-reference-view .top-sales-product-cell small{display:block;white-space:normal}.market-shape-reference-view .top-sales-product-cell img{object-fit:contain;flex:none}.market-shape-reference-view input[aria-label$=" 人工形态"]{width:100%;min-width:0;box-sizing:border-box}.market-shape-reference-view .top-sales-table-toolbar{margin-bottom:12px}.shape-ref-metric-bars{display:grid;gap:6px;margin:12px 0}.shape-ref-bar-row{display:grid;grid-template-columns:minmax(80px,160px) minmax(80px,1fr) 70px;gap:10px;align-items:center;font-size:.88rem}.shape-ref-bar-row>div{height:10px;border-radius:8px;background:#edf2f7;overflow:hidden}.shape-ref-bar-row>div>span{display:block;height:100%;background:#2f80ed;border-radius:inherit}.shape-ref-bar-row b{text-align:right}`}</style>
    <LaunchSection title={`${report.categoryName} · 类目销量看板`} description={`${report.marketplace} · Node ${report.nodeId} · 来源获取于 ${report.fetchedAt}`} badge={<span className="source-badge">已保存商品来源</span>}>
      <p className="market-research-note">{report.note || "商品当前销量与销售额为来源近30天观测；历史销量和金额按实际日历月显示。"}</p>
      <DataQualitySummary report={report} />
      <div className="market-overview-kpis">{[
        ["来源 TOP100 近30天销量", n(report.stats.top100MonthlyVolume)], ["来源 TOP100 近30天销售额", n(report.stats.top100MonthlyAmount, 2)],
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
        {onPoolSizeChange&&<label>当前报告商品池容量（优先复用缓存） <select aria-label="当前报告商品池采集上限" disabled={disabled||poolSizeDisabled} value={requestedPoolSize} onChange={e => onPoolSizeChange(Number(e.target.value))}>{[...new Set([requestedPoolSize,50,100,150,200,250,300])].sort((a,b)=>a-b).map(v => <option key={v} value={v}>{v}</option>)}</select></label>}
        <TopSalesMultiSelectFilter prefix="品牌" ariaLabel="筛选品牌" options={brands} optionCounts={counts(p => p.brand || "未知")} filter={brand} onChange={setBrand} searchable />
        <TopSalesMultiSelectFilter prefix="上架年份" ariaLabel="筛选上架年份" options={years} optionCounts={counts(p => year(p.onlineDate))} filter={listingYear} onChange={setListingYear} />
        <TopSalesMultiSelectFilter prefix="价格带" ariaLabel="筛选价格带" options={bands} optionCounts={counts(band)} filter={priceBand} onChange={setPriceBand} />
        <TopSalesMultiSelectFilter prefix="市场准入" ariaLabel="筛选市场准入" options={margins} optionCounts={counts(p => marginLabel(p.grossProfitMargin))} filter={marginFilter} onChange={setMarginFilter} showShare shareTotal={report.products.length} />
        <TopSalesMultiSelectFilter prefix="商品形态" ariaLabel="筛选商品形态" options={shapes} optionCounts={counts(p => shape(assignments, p))} filter={shapeFilter} onChange={setShapeFilter} searchable showShare shareTotal={report.products.length} />
        <label>搜索 <input aria-label="搜索商品" value={query} onChange={e => setQuery(e.target.value)} placeholder="标题或 ASIN" /></label>
      </div></div>
      <div className="top-sales-shape-bulk-bar"><span className="top-sales-shape-bulk-count">批量选择 {bulkSelected.length} 链接</span><input className="shape-annotation-input" maxLength={60} list={catalogId} aria-label="批量形态" value={bulkShape} onChange={e => setBulkShape(e.target.value)} placeholder="例如：层架式落地灯" disabled={disabled} /><button type="button" className="primary-btn" disabled={disabled || !bulkSelected.length || !bulkShape.trim()||(fixedLabels.length>0&&!fixedLabels.includes(bulkShape.trim()))} onClick={() => { for (const asin of bulkSelected) onAssignment(asin, bulkShape.trim()); setBulkSelected([]); }}>批量设为此形态</button><button type="button" className="ghost-btn" disabled={disabled||!bulkSelected.length} onClick={()=>{for(const asin of bulkSelected)onAssignment(asin,'');}}>批量清除形态</button><button type="button" className="ghost-btn" disabled={disabled || !bulkSelected.length} onClick={() => setBulkSelected([])}>清空批量选择</button></div>
      <datalist id={catalogId}>{(fixedLabels.length?fixedLabels:labelOptions).map(label=><option key={label} value={label}/>)}</datalist><ShapeCatalog labels={labelOptions} fixed={fixedLabels} assignments={assignments} onAssignment={onAssignment} onLabels={setLabels} disabled={disabled}/>
      <p className="market-research-note">直接输入商品形态，或勾选批量框统一填写；编辑结束后按当前形态筛选，修改会自动保存至数据库。</p>
      <LaunchTable stickyHeader className="top-sales-table"><colgroup>{TOP_SALES_COLUMNS.map(([id]) => <col key={id} style={{ width: widths[id] }} />)}</colgroup><thead><tr>{TOP_SALES_COLUMNS.map(([id]) => <ResizeHeader key={id} id={id} width={widths[id]} stickyLeft={id==='bulk'?0:id==='rank'?widths.bulk:id==='product'?widths.bulk+widths.rank:undefined} onWidth={setWidth}>{headers[id]}</ResizeHeader>)}</tr></thead><tbody>
        {visible.map(p => <tr key={p.asin} className={selected.has(p.asin) ? "top-sales-row-selected" : ""}>
          <td className="shape-ref-frozen" style={{left:0}}><input type="checkbox" aria-label={`批量选择 ${p.asin}`} checked={bulkSelected.includes(p.asin)} disabled={disabled} onChange={e => setBulkSelected(e.target.checked ? [...bulkSelected, p.asin] : bulkSelected.filter(asin => asin !== p.asin))} /></td><td className="shape-ref-frozen" style={{left:widths.bulk}}>{p.rank}</td>
          <td className="shape-ref-frozen" style={{left:widths.bulk+widths.rank}}><div className="traffic-conclusion-product top-sales-product-cell">{p.imageUrl ? <img src={p.imageUrl} alt="" width={48} height={48} /> : null}<div>{amazonDomain ? <a href={`https://www.${amazonDomain}/dp/${p.asin}`} target="_blank" rel="noreferrer">{p.asin} ↗</a> : <strong>{p.asin}</strong>}<small>{p.title}</small></div></div></td>
          <td>{p.brand || "未知"}</td><td>{fixedLabels.length?<select className="shape-annotation-input" aria-label={`${p.asin} 人工形态`} value={assignments[p.asin]??''} disabled={disabled} onChange={e=>onAssignment(p.asin,e.target.value)}><option value="">未分类</option>{fixedLabels.map(label=><option key={label}>{label}</option>)}{assignments[p.asin]?.trim()&&!fixedLabels.includes(assignments[p.asin].trim())&&<option disabled value={assignments[p.asin]}>旧标签待确认：{assignments[p.asin]}</option>}</select>:<input className="shape-annotation-input" placeholder="输入形态" list={catalogId} maxLength={60} onFocus={()=>setEditingAsin(p.asin)} onBlur={()=>setEditingAsin(null)} aria-label={`${p.asin} 人工形态`} value={assignments[p.asin] ?? ""} disabled={disabled} onChange={e => onAssignment(p.asin, e.target.value)} />}{fixedLabels.length>0&&assignments[p.asin]?.trim()&&!fixedLabels.includes(assignments[p.asin].trim())&&<small>旧标签待确认，请选择固定形态</small>}</td>
          <td><span title={p.onlineDate??undefined}>{parseReferenceListingDate(p.onlineDate).status==='uncertain'?'日期待核实':parseReferenceListingDate(p.onlineDate).status==='known'?`${parseReferenceListingDate(p.onlineDate).year}-${String(parseReferenceListingDate(p.onlineDate).month).padStart(2,'0')}`:'未知'}</span></td><td title={p.marginSource?.note}>{p.grossProfitMargin == null ? "未知" : `${n(p.grossProfitMargin, 1)}%`}</td><td>{marginLabel(p.grossProfitMargin)}</td><td>{n(p.price, 2)}</td><td>{band(p)}</td><td>{n(p.monthlySalesVolume)}</td><td>{n(p.monthlySalesAmount, 2)}</td><td><ProductTrend product={p} currency={`${marketSites.find(site=>site.code===report.marketplace)?.currency??''} `} /></td>
          {periods.map(period => <td key={period.key} title={referenceSalesGapReason(p,period.key,report.calculationVersion)??undefined}>{hasReferencePeriodDateConflict(p,period.key,report.calculationVersion)?'日期冲突':isReferencePeriodBeforeLaunch(p,period.key,report.calculationVersion)?'不适用':n(periodValue(p, period.key))}</td>)}<td>{n(p.starRating, 1)}</td><td>{n(p.reviewCount)}</td><td>{p.deliveryType || "未知"}</td><td>{p.seller || "未知"}</td><td><button type="button" className="ghost-btn danger" disabled={disabled} onClick={() => { if (selected.has(p.asin)) { if (!window.confirm(`确定从样本中移除「${p.asin}」？移除后不会参与下方价格带、上架年份等分析。`)) return; onSelected(selectedAsins.filter(a => a !== p.asin)); setBulkSelected(current => current.filter(asin => asin !== p.asin)); } else onSelected([...selectedAsins, p.asin]); }}>{selected.has(p.asin) ? "移除" : "恢复"}</button></td>
        </tr>)}
      </tbody></LaunchTable>
      <p className="market-research-note">毛利准入：≥70% 优先进入；≥60% 建议进入；≥50% 谨慎进入；低于50% 不建议进入。未知保持未知。</p>
      <MetricBars rows={marginGroups.map(([label, count]) => ({ label, value: count }))} />
      {marginConclusion ? <ReferenceMarginConclusion result={marginConclusion} /> : <div className="listing-age-conclusion listing-age-entry-gray shape-summary-panel"><h4 className="listing-age-conclusion-title">毛利准入结论待补数据</h4><p className="shape-summary-note">{conclusions.margin.status === "insufficient" ? conclusions.margin.reason : "缺失历史销量保留未知，补齐后可生成分层结论。"}</p></div>}
    </LaunchSection>

    <LaunchSection title="上架年份 · 销量结构分析" description="按已选商品的真实历史销量汇总；缺失历史不补零" badge={<span className="source-badge">{yearly.length} 年份组</span>}>
      <ReferenceHistoryCoverage context="上架年份" calculationVersion={report.calculationVersion} products={active} />
      <AggregateTable calculationVersion={analysis.calculationVersion} rows={yearly} total={analysis.synthesis.totalSales} yearBasis />
      {conclusions.listingYear.status === "ready" ? <ReferenceListingYearConclusion result={conclusions.listingYear.result} embedded /> : <p className="market-research-note">{conclusions.listingYear.reason}</p>}
    </LaunchSection>
    <LaunchSection title="商品形态 · 销量占比分析" description="按人工确认形态汇总 TOP 链接历史销量" badge={<span className="source-badge">{byShape.length} 形态</span>}>
      <SectionFilter name="形态销量" options={shapes} optionCounts={shapeCounts} filter={localShape} onFilter={setLocalShape} sort={shapeSort} onSort={setShapeSort}/><ReferenceHistoryCoverage context="形态销量" calculationVersion={report.calculationVersion} products={shapeAnalysis.products}/>
      <AggregateTable sort={shapeSort} onSort={setShapeSort} calculationVersion={analysis.calculationVersion} rows={byShape} total={shapeAnalysis.synthesis.totalSales} />
      <MetricBars rows={byShape.map(row => ({ label: row.label, value: row.sales.last6Months }))} />
      {shapeConclusion.status === "ready" ? <ReferenceShapeSalesConclusion result={shapeConclusion.result} embedded /> : <p className="market-research-note">{shapeConclusion.reason}</p>}
    </LaunchSection>
    <LaunchSection title="商品形态 · 价格带分析" description="按商品形态与 10 美元价格带交叉汇总" badge={<span className="source-badge">{shapeBands.length} 组</span>}>
      <SectionFilter name="形态价格带" options={shapes} optionCounts={shapeCounts} filter={localBandShape} onFilter={setLocalBandShape} sort={bandSort} onSort={setBandSort}/><ReferenceHistoryCoverage context="形态价格带" calculationVersion={report.calculationVersion} products={bandAnalysis.products}/>
      <ShapePriceBandTable sort={bandSort} onSort={setBandSort} shapes={sortSectionRows(bandAnalysis.shapes,bandSort)} bands={shapeBands} total={bandAnalysis.synthesis.totalSales} />
      {bandConclusion.status === "ready" ? <ReferenceShapePriceConclusion result={bandConclusion.result} embedded /> : <p className="market-research-note">{bandConclusion.reason}</p>}
    </LaunchSection>
    <LaunchSection title="品牌 · 价格带分析" description="按品牌与 10 美元价格带交叉汇总" badge={<span className="source-badge">{brandBands.length} 组</span>}>
      <SectionFilter name="品牌价格带" options={brands} optionCounts={brandCounts} filter={localBrand} onFilter={setLocalBrand} sort={brandSort} onSort={setBrandSort}/><ReferenceHistoryCoverage context="品牌价格带" calculationVersion={report.calculationVersion} products={brandAnalysis.products}/>
      <AggregateTable sort={brandSort} onSort={setBrandSort} calculationVersion={analysis.calculationVersion} rows={brandBands} total={brandAnalysis.synthesis.totalSales} />
      {brandConclusion.status === "ready" ? <ReferenceBrandPriceConclusion result={brandConclusion.result} embedded /> : <p className="market-research-note">{brandConclusion.reason}</p>}
    </LaunchSection>
    <LaunchSection title="市场结构综合结论" description="汇总形态、价格带、品牌与毛利准入证据" badge={<span className="source-badge">{conclusions.synthesis.status === "ready" ? "规则结论已生成" : "综合结论待补数据"}</span>}>
      <div className="shape-summary-panel shape-summary-overview">
        <ReferenceSummaryMetrics items={[["所选商品链接", n(active.length)], ["近30天销量", n(currentUnits)], ["近30天销售额（来源值）", n(currentAmount, 2)], ["近6个月历史销量", n(periodTotal("last6Months"))], ["形态分组（含未分类）", n(analysis.shapes.length)], ["品牌 × 价格带组合", n(analysis.brandPriceBands.length)]]} />
        <div className="shape-summary-selection"><strong>毛利准入分布</strong>{marginGroups.length ? marginGroups.map(([label, count]) => <span key={label}>{label.replace("—", "未知")} <b>{count} 条</b></span>) : <span>暂无所选样本</span>}</div>
        {conclusions.synthesis.status === "ready" ? <ReferenceSynthesisConclusion result={conclusions.synthesis.result} warnings={conclusions.synthesis.warnings} embedded /> : <div className="shape-summary-gap"><strong>综合判断尚缺数据</strong><p>{conclusions.synthesis.reason}。上方已获取的指标仍可查看。</p></div>}
        <MarketAdminContent><details className="shape-summary-source"><summary>数据范围与口径</summary><p className="shape-summary-note">{report.note || "所有统计限于当前所选商品与已保存来源；数据缺口显示未知。"}</p></details></MarketAdminContent>
      </div>
    </LaunchSection>
  </div>;
}

function AggregateTable({ rows, total, yearBasis = false,calculationVersion,sort,onSort }: { calculationVersion: SorftimeCategoryDashboardReport['calculationVersion']; rows: ReferenceGroupRow[]; total: Record<Period, number | null>; yearBasis?: boolean;sort?:SectionSort;onSort?:(sort:SectionSort)=>void }) {
  const [localSort,setLocalSort]=useState<SectionSort>(null);
  const currentSort=onSort?sort??null:localSort;
  const sorted = onSort ? rows : localSort ? sortSectionRows(rows,localSort) : rows;
  const update=onSort??setLocalSort;
  const header=(metric:SectionSortMetric,label:string)=><SectionSortButton metric={metric} sort={currentSort} onSort={update}>{label}</SectionSortButton>;
  return <LaunchTable stickyHeader className="shape-price-table"><thead><tr><th>{header('label','分组')}</th>{periods.map(p => <th key={p.key}>{header(p.key,`${p.label}销量`)} / {header(`${p.key}SharePct`,'已知销量内占比')}</th>)}<th>{header('linkCount','链接数')}</th><th>{header('avgLast6MonthsMonthlyPerLink','近6个月单链月均')}</th><th>{header('avgY2025MonthlyPerLink','2025年单链月均')}</th></tr></thead><tbody>
    {sorted.map(row => <tr key={JSON.stringify([row.shape,row.brand,row.priceBand,row.label])}><th>{row.label}</th>{periods.map(period => <td key={period.key}>{yearBasis && (period.key === "y2024" || period.key === "y2025") && Number(row.label) > Number(period.key.slice(1)) ? "不适用" : <><RowSales row={row} period={period.key}/> / {row.sharePct[period.key]===null?"不可计算":`${n(row.sharePct[period.key],2)}%`}</>}</td>)}<td>{row.linkCount}</td><td>{n(row.avgLast6MonthsMonthlyPerLink, 1)}</td><td>{yearBasis&&Number(row.label)>2025?"不适用":n(row.avgY2025MonthlyPerLink, 1)}</td></tr>)}
    <tr className="shape-price-total-row"><th>合计</th>{periods.map(period => <td key={period.key}>{totalSalesText(total[period.key], rows, period.key)} / {total[period.key] === null || total[period.key]===0 ? "不可计算" : "100%"}</td>)}<td>{rows.reduce((sum, row) => sum + row.linkCount, 0)}</td><td>{n(referenceMonthlyAverage(total.last6Months, combinedCoverage(rows, "last6Months"), 6, calculationVersion, false), 1)}</td><td>—</td></tr>
  </tbody></LaunchTable>;
}

function ShapePriceBandTable({ shapes, bands, total,sort,onSort }: { shapes: ReferenceGroupRow[]; bands: ReferenceGroupRow[]; total: Record<Period, number | null>;sort:SectionSort;onSort:(sort:SectionSort)=>void }) {
  const header=(metric:SectionSortMetric,label:string)=><SectionSortButton metric={metric} sort={sort} onSort={onSort}>{label}</SectionSortButton>;
  return <LaunchTable stickyHeader className="shape-price-table shape-price-band-table"><thead><tr><th>{header('label','商品形态 / 价格带')}</th>{periods.map(p => <th key={p.key}>{header(p.key,`${p.label}销量`)} / {header(`${p.key}SharePct`,'形态内已知销量占比')}</th>)}<th>{header('linkCount','链接数')}</th><th>{header('avgLast6MonthsMonthlyPerLink','近6个月单链月均')}</th><th>{header('avgY2025MonthlyPerLink','2025年单链月均')}</th></tr></thead><tbody>
    {shapes.map(shapeRow => <FragmentRows key={shapeRow.label} shape={shapeRow} bands={bands.filter(row => row.shape===shapeRow.label)} />)}
    <tr className="shape-price-total-row"><th>全部形态</th>{periods.map(p => <td key={p.key}>{totalSalesText(total[p.key], shapes, p.key)}</td>)}<td>{shapes.reduce((sum, row) => sum + row.linkCount, 0)}</td><td>—</td><td>—</td></tr>
  </tbody></LaunchTable>;
}

function FragmentRows({ shape: row, bands }: { shape: ReferenceGroupRow; bands: ReferenceGroupRow[] }) {
  return <><tr className="shape-price-subtotal-row"><th>{row.label} · 合计</th>{periods.map(p => <td key={p.key}><RowSales row={row} period={p.key}/> / {row.sales[p.key] === null || row.sales[p.key] === 0 ? "未知" : "100%"}</td>)}<td>{row.linkCount}</td><td>{n(row.avgLast6MonthsMonthlyPerLink)}</td><td>{n(row.avgY2025MonthlyPerLink)}</td></tr>
    {bands.map(bandRow => <tr className="shape-price-band-row" key={JSON.stringify([bandRow.shape,bandRow.priceBand])}><th>{bandRow.priceBand}</th>{periods.map(p => <td key={p.key}><RowSales row={bandRow} period={p.key}/> / {bandRow.sharePct[p.key] === null ? "未知" : `${n(bandRow.sharePct[p.key], 2)}%`}</td>)}<td>{bandRow.linkCount}</td><td>{n(bandRow.avgLast6MonthsMonthlyPerLink)}</td><td>{n(bandRow.avgY2025MonthlyPerLink)}</td></tr>)}
  </>;
}

function RowSales({row,period}:{row:ReferenceGroupRow;period:Period}){const c=row.coverage[period];return <span title={`可计算 ${c.known}/${c.total}${c.notApplicable?` · 不适用 ${c.notApplicable}`:''}${c.missing?` · 缺失 ${c.missing}`:''}`}>{c.notApplicable===c.total&&c.total>0?'不适用':`${c.missing>0&&row.sales[period]!==null?'已知 ':''}${n(row.sales[period])}`}</span>;}

function combinedCoverage(rows: ReferenceGroupRow[], period: Period) {
  return rows.reduce((sum, row) => ({known:sum.known+row.coverage[period].known, total:sum.total+row.linkCount, missing:sum.missing+row.coverage[period].missing, notApplicable:sum.notApplicable+row.coverage[period].notApplicable}), {known:0,total:0,missing:0,notApplicable:0});
}
function totalSalesText(value:number|null, rows:ReferenceGroupRow[], period:Period) {
  return `${value !== null && combinedCoverage(rows, period).missing > 0 ? '已知 ' : ''}${n(value)}`;
}
