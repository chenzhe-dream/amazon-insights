"use client";

import { useMemo, useState } from "react";
import {
  sorftimeCategoryTrendData,
  sorftimeCategoryTrendMeta,
  type SorftimeCategoryTrendPoint,
  type SorftimeCategoryTrendRecord,
} from "./sorftime-category-trend-data";

type ProductRef = {
  asin: string;
  brand: string;
  subRankCategory: string;
};

type MergedPoint = {
  month: string;
  volume: number;
  amount: number;
};

const volumeColor = "#2F80ED";
const amountColor = "#7A67D8";
const listingMonopolyColor = "#2F80ED";
const brandMonopolyColor = "#29A7C7";
const sellerMonopolyColor = "#E65B6A";

type MonopolySeries = {
  listing: SorftimeCategoryTrendPoint[];
  brand: SorftimeCategoryTrendPoint[];
  seller: SorftimeCategoryTrendPoint[];
};

function formatMonthLabel(month: string) {
  const match = month.match(/^(\d{4})-(\d{2})$/);
  if (!match) return month;
  return `${Number(match[2])}月`;
}

function formatMonthTitle(month: string) {
  const match = month.match(/^(\d{4})-(\d{2})$/);
  if (!match) return month;
  return `${match[1]}年${Number(match[2])}月`;
}

function formatVolume(value: number) {
  return `${Math.round(value).toLocaleString()} 件`;
}

function formatAmount(value: number) {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${Math.round(value / 1_000).toLocaleString()}k`;
  return `$${Math.round(value).toLocaleString()}`;
}

function formatAmountExact(value: number) {
  return `$${Math.round(value).toLocaleString()}`;
}

function compactAxis(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(Math.round(value));
}

function pickCategoryRecords(products: ProductRef[]): SorftimeCategoryTrendRecord[] {
  const asinSet = new Set(products.map(product => product.asin));
  const matched = Object.values(sorftimeCategoryTrendData).filter(
    record =>
      record.asins.some(asin => asinSet.has(asin)) ||
      products.some(product => product.subRankCategory && product.subRankCategory === record.categoryName),
  );
  if (matched.length) {
    return matched.sort(
      (a, b) =>
        b.asins.filter(asin => asinSet.has(asin)).length - a.asins.filter(asin => asinSet.has(asin)).length,
    );
  }
  return Object.values(sorftimeCategoryTrendData).filter(record => record.status === "ready");
}

function mergeTrendPoints(volume: SorftimeCategoryTrendPoint[], amount: SorftimeCategoryTrendPoint[]): MergedPoint[] {
  const amountMap = new Map(amount.map(point => [point.month, point.value]));
  return volume.map(point => ({
    month: point.month,
    volume: point.value,
    amount: amountMap.get(point.month) ?? 0,
  }));
}

function CategoryComboChart({ series }: { series: MergedPoint[] }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const width = 960;
  const height = 168;
  const padLeft = 46;
  const padRight = 50;
  const padY = 16;
  const chartWidth = width - padLeft - padRight;
  const chartHeight = height - padY * 2;

  if (!series.length) return <div className="empty-chart">等待类目趋势同步</div>;

  const volMax = Math.max(...series.map(point => point.volume), 1);
  const amtMax = Math.max(...series.map(point => point.amount), 1);
  const count = series.length;
  const barWidth = Math.min(18, (chartWidth / Math.max(count, 1)) * 0.55);
  const xAt = (index: number) => padLeft + (index * chartWidth) / Math.max(count - 1, 1);
  const yVol = (value: number) => padY + (1 - value / volMax) * chartHeight;
  const yAmt = (value: number) => padY + (1 - value / amtMax) * chartHeight;
  const volTicks = [0.25, 0.5, 0.75, 1].map(ratio => Math.round(volMax * ratio));
  const amtTicks = [0.25, 0.5, 0.75, 1].map(ratio => Math.round(amtMax * ratio));
  const tickIndexes =
    series.length <= 12
      ? series.map((_, index) => index)
      : Array.from({ length: 8 }, (_, i) => Math.round((i * (series.length - 1)) / 7));

  return (
    <div className="comparison-chart category-combo-chart">
      <div className="sales-trend-popover-legend category-combo-legend">
        <span>
          <i className="sales-trend-legend-line" style={{ borderColor: volumeColor }} />
          月销量（折线）
        </span>
        <span>
          <i className="sales-trend-legend-bar" style={{ background: amountColor }} />
          月销售额（柱状）
        </span>
      </div>
      <div className="chart-stage">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="BSR 小类销量与销售额同屏趋势" onMouseLeave={() => setHoverIndex(null)}>
          {[0, 1, 2, 3].map(index => {
            const y = padY + (index * chartHeight) / 3;
            return <line key={index} x1={padLeft} x2={width - padRight} y1={y} y2={y} stroke="#EEF2F6" />;
          })}
          {volTicks.map(tick => (
            <text key={`vol-${tick}`} x={padLeft - 8} y={yVol(tick) + 3} textAnchor="end" className="sales-trend-axis-label sales-trend-axis-label-left">
              {compactAxis(tick)}
            </text>
          ))}
          {amtTicks.map(tick => (
            <text key={`amt-${tick}`} x={width - padRight + 8} y={yAmt(tick) + 3} textAnchor="start" className="sales-trend-axis-label sales-trend-axis-label-right">
              {compactAxis(tick)}
            </text>
          ))}
          {series.map((point, index) => {
            const x = xAt(index);
            const barHeight = height - padY - yAmt(point.amount);
            return (
              <rect
                key={`bar-${point.month}`}
                x={x - barWidth / 2}
                y={yAmt(point.amount)}
                width={barWidth}
                height={Math.max(1, barHeight)}
                fill={amountColor}
                opacity={hoverIndex === index ? 0.92 : 0.55}
                rx="2"
              />
            );
          })}
          <polyline
            points={series.map((point, index) => `${xAt(index)},${yVol(point.volume)}`).join(" ")}
            fill="none"
            stroke={volumeColor}
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {series.map((point, index) => (
            <circle
              key={`dot-${point.month}`}
              cx={xAt(index)}
              cy={yVol(point.volume)}
              r={hoverIndex === index ? 4.5 : 3.2}
              fill="#fff"
              stroke={volumeColor}
              strokeWidth="2"
              pointerEvents="none"
            />
          ))}
          {hoverIndex != null && (
            <line
              x1={xAt(hoverIndex)}
              x2={xAt(hoverIndex)}
              y1={padY}
              y2={height - padY}
              stroke="#C5CFDB"
              strokeDasharray="4 4"
            />
          )}
          {series.map((_, index) => {
            const x = xAt(index);
            const step = chartWidth / Math.max(count - 1, 1);
            const left = Math.max(0, index === 0 ? 0 : x - step / 2);
            const right = Math.min(width, index === count - 1 ? width : x + step / 2);
            return (
              <rect
                key={`zone-${index}`}
                className="chart-hover-zone"
                x={left}
                y="0"
                width={right - left}
                height={height}
                fill="transparent"
                onMouseEnter={() => setHoverIndex(index)}
              />
            );
          })}
        </svg>
        {hoverIndex != null && (
          <div
            className="chart-tooltip chart-tooltip-group category-light-tooltip"
            style={{
              left: `${(xAt(hoverIndex) / width) * 100}%`,
              top: "12px",
              transform:
                hoverIndex / Math.max(count - 1, 1) < 0.2
                  ? "translateX(0)"
                  : hoverIndex / Math.max(count - 1, 1) > 0.8
                    ? "translateX(-100%)"
                    : "translateX(-50%)",
            }}
          >
            <b className="chart-tooltip-title">{formatMonthTitle(series[hoverIndex].month)}</b>
            <div className="chart-tooltip-row">
              <span>
                <i style={{ background: volumeColor }} />
                月销量
              </span>
              <strong>{formatVolume(series[hoverIndex].volume)}</strong>
            </div>
            <div className="chart-tooltip-row">
              <span>
                <i style={{ background: amountColor }} />
                月销售额
              </span>
              <strong>{formatAmountExact(series[hoverIndex].amount)}</strong>
            </div>
          </div>
        )}
      </div>
      <div className="chart-months category-trend-months">
        {tickIndexes.map(index => (
          <span key={series[index].month} style={{ left: `${(xAt(index) / width) * 100}%` }}>
            {formatMonthLabel(series[index].month)}
          </span>
        ))}
      </div>
      <div className="category-combo-axis-hint">
        <span style={{ color: volumeColor }}>左轴 · 销量（件）</span>
        <span style={{ color: amountColor }}>右轴 · 销售额（USD）</span>
      </div>
    </div>
  );
}

function formatPct(value: number) {
  return `${value.toFixed(2)}%`;
}

function MonopolyTrendChart({ series }: { series: MonopolySeries }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const width = 960;
  const height = 156;
  const padLeft = 40;
  const padRight = 18;
  const padY = 14;
  const chartWidth = width - padLeft - padRight;
  const chartHeight = height - padY * 2;

  const months = useMemo(() => {
    const set = new Set<string>();
    for (const point of [...series.listing, ...series.brand, ...series.seller]) set.add(point.month);
    return [...set].sort();
  }, [series]);

  const listingMap = useMemo(() => new Map(series.listing.map(point => [point.month, point.value])), [series.listing]);
  const brandMap = useMemo(() => new Map(series.brand.map(point => [point.month, point.value])), [series.brand]);
  const sellerMap = useMemo(() => new Map(series.seller.map(point => [point.month, point.value])), [series.seller]);

  if (!months.length) return <div className="empty-chart">等待垄断系数同步</div>;

  const values = months.flatMap(month => [listingMap.get(month), brandMap.get(month), sellerMap.get(month)].filter((v): v is number => v != null));
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const yAt = (value: number) => padY + (1 - (value - min) / (max - min || 1)) * chartHeight;
  const xAt = (index: number) => padLeft + (index * chartWidth) / Math.max(months.length - 1, 1);
  const lineOf = (map: Map<string, number>) =>
    months
      .map((month, index) => {
        const value = map.get(month);
        if (value == null) return null;
        return `${xAt(index)},${yAt(value)}`;
      })
      .filter(Boolean)
      .join(" ");

  const tickIndexes =
    months.length <= 12
      ? months.map((_, index) => index)
      : Array.from({ length: 8 }, (_, i) => Math.round((i * (months.length - 1)) / 7));
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(ratio => min + (max - min) * ratio);

  return (
    <div className="comparison-chart category-monopoly-chart">
      <div className="sales-trend-popover-legend category-combo-legend">
        <span>
          <i className="sales-trend-legend-line" style={{ borderColor: listingMonopolyColor }} />
          Listing垄断系数
        </span>
        <span>
          <i className="sales-trend-legend-line" style={{ borderColor: brandMonopolyColor }} />
          品牌垄断系数
        </span>
        <span>
          <i className="sales-trend-legend-line" style={{ borderColor: sellerMonopolyColor }} />
          卖家垄断系数
        </span>
      </div>
      <div className="chart-stage">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="BSR 小类垄断系数趋势" onMouseLeave={() => setHoverIndex(null)}>
          {yTicks.map((tick, index) => (
            <g key={`ytick-${index}`}>
              <line x1={padLeft} x2={width - padRight} y1={yAt(tick)} y2={yAt(tick)} stroke="#EEF2F6" />
              <text x={padLeft - 8} y={yAt(tick) + 3} textAnchor="end" className="sales-trend-axis-label">
                {tick.toFixed(0)}%
              </text>
            </g>
          ))}
          <polyline points={lineOf(listingMap)} fill="none" stroke={listingMonopolyColor} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          <polyline points={lineOf(brandMap)} fill="none" stroke={brandMonopolyColor} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          <polyline points={lineOf(sellerMap)} fill="none" stroke={sellerMonopolyColor} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          {months.map((month, index) => {
            const points = [
              { color: listingMonopolyColor, value: listingMap.get(month) },
              { color: brandMonopolyColor, value: brandMap.get(month) },
              { color: sellerMonopolyColor, value: sellerMap.get(month) },
            ];
            return points.map((point, pointIndex) =>
              point.value == null ? null : (
                <circle
                  key={`${month}-${pointIndex}`}
                  cx={xAt(index)}
                  cy={yAt(point.value)}
                  r={hoverIndex === index ? 4 : 2.8}
                  fill="#fff"
                  stroke={point.color}
                  strokeWidth="2"
                  pointerEvents="none"
                />
              ),
            );
          })}
          {hoverIndex != null && (
            <line x1={xAt(hoverIndex)} x2={xAt(hoverIndex)} y1={padY} y2={height - padY} stroke="#C5CFDB" strokeDasharray="4 4" />
          )}
          {months.map((_, index) => {
            const x = xAt(index);
            const step = chartWidth / Math.max(months.length - 1, 1);
            const left = Math.max(0, index === 0 ? 0 : x - step / 2);
            const right = Math.min(width, index === months.length - 1 ? width : x + step / 2);
            return (
              <rect
                key={`zone-${index}`}
                className="chart-hover-zone"
                x={left}
                y="0"
                width={right - left}
                height={height}
                fill="transparent"
                onMouseEnter={() => setHoverIndex(index)}
              />
            );
          })}
        </svg>
        {hoverIndex != null && (
          <div
            className="chart-tooltip chart-tooltip-group category-light-tooltip"
            style={{
              left: `${(xAt(hoverIndex) / width) * 100}%`,
              top: "12px",
              transform:
                hoverIndex / Math.max(months.length - 1, 1) < 0.2
                  ? "translateX(0)"
                  : hoverIndex / Math.max(months.length - 1, 1) > 0.8
                    ? "translateX(-100%)"
                    : "translateX(-50%)",
            }}
          >
            <b className="chart-tooltip-title">{formatMonthTitle(months[hoverIndex])}</b>
            <div className="chart-tooltip-row">
              <span>
                <i style={{ background: listingMonopolyColor }} />
                Listing
              </span>
              <strong>{listingMap.has(months[hoverIndex]) ? formatPct(listingMap.get(months[hoverIndex])!) : "—"}</strong>
            </div>
            <div className="chart-tooltip-row">
              <span>
                <i style={{ background: brandMonopolyColor }} />
                品牌
              </span>
              <strong>{brandMap.has(months[hoverIndex]) ? formatPct(brandMap.get(months[hoverIndex])!) : "—"}</strong>
            </div>
            <div className="chart-tooltip-row">
              <span>
                <i style={{ background: sellerMonopolyColor }} />
                卖家
              </span>
              <strong>{sellerMap.has(months[hoverIndex]) ? formatPct(sellerMap.get(months[hoverIndex])!) : "—"}</strong>
            </div>
          </div>
        )}
      </div>
      <div className="chart-months category-trend-months">
        {tickIndexes.map(index => (
          <span key={months[index]} style={{ left: `${(xAt(index) / width) * 100}%` }}>
            {formatMonthLabel(months[index])}
          </span>
        ))}
      </div>
      <p className="category-monopoly-note">口径：Top3 Listing / 品牌 / 卖家销售额占比（Sorftime category_trend）</p>
    </div>
  );
}

function SourceBadge({ children }: { children: React.ReactNode }) {
  return <span className="source-badge">{children}</span>;
}

export function CategoryNodeTrendSection({ products }: { products: ProductRef[] }) {
  const records = useMemo(() => pickCategoryRecords(products), [products]);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);

  const activeRecord = useMemo(() => {
    if (!records.length) return null;
    return records.find(record => record.nodeId === activeNodeId) ?? records[0];
  }, [records, activeNodeId]);

  const series = useMemo(
    () => (activeRecord ? mergeTrendPoints(activeRecord.volume, activeRecord.amount) : []),
    [activeRecord],
  );

  const monopolySeries = useMemo<MonopolySeries>(
    () => ({
      listing: activeRecord?.listingMonopoly ?? [],
      brand: activeRecord?.brandMonopoly ?? [],
      seller: activeRecord?.sellerMonopoly ?? [],
    }),
    [activeRecord],
  );

  const latestListing = monopolySeries.listing.at(-1);
  const latestBrand = monopolySeries.brand.at(-1);
  const latestSeller = monopolySeries.seller.at(-1);

  // Prefer previous month when the latest month looks incomplete (common mid-month sync).
  const latestFull =
    series.length >= 2 && series.at(-1)!.volume < series.at(-2)!.volume * 0.25
      ? series.at(-2)!
      : series.at(-1) ?? null;
  const prev = latestFull
    ? series[Math.max(0, series.findIndex(point => point.month === latestFull.month) - 1)]
    : null;
  const volMom =
    latestFull && prev && prev.volume ? ((latestFull.volume - prev.volume) / prev.volume) * 100 : null;
  const amtMom =
    latestFull && prev && prev.amount ? ((latestFull.amount - prev.amount) / prev.amount) * 100 : null;

  return (
    <section className="card compare-chart-card sales-combined-card category-node-trend-card">
      <div className="section-head">
        <div>
          <h3>BSR 小类市场趋势</h3>
          <p>
            {activeRecord
              ? `${activeRecord.topCategory ? `${activeRecord.topCategory} › ` : ""}${activeRecord.categoryName} · Node ${activeRecord.nodeId} · Top100 口径 · 销量 / 销售额 / 垄断系数同屏`
              : "根据竞品 Best Seller Rank 小类节点拉取销量 / 销售额 / 垄断系数趋势"}
          </p>
        </div>
        <div className="chart-head-actions">
          {records.length > 1 ? (
            <label className="category-node-select">
              节点
              <select value={activeRecord?.nodeId ?? ""} onChange={event => setActiveNodeId(event.target.value)}>
                {records.map(record => (
                  <option key={record.nodeId} value={record.nodeId}>
                    {record.categoryName} ({record.nodeId})
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <SourceBadge>Sorftime MCP</SourceBadge>
        </div>
      </div>

      {!activeRecord || activeRecord.status !== "ready" ? (
        <div className="pending-box">
          <strong>待同步 BSR 小类趋势</strong>
          <span>数据源：Sorftime · product_detail（取 node_id）→ category_trend</span>
          <span>
            运行 <code>{sorftimeCategoryTrendMeta.syncCommand}</code> 后刷新页面
          </span>
        </div>
      ) : (
        <>
          <div className="category-trend-kpis category-trend-kpis-wide">
            <div>
              <span>最近月销量</span>
              <b>{latestFull ? formatVolume(latestFull.volume) : "—"}</b>
              <small>
                {latestFull ? formatMonthTitle(latestFull.month) : ""}
                {volMom == null ? "" : ` · 环比 ${volMom >= 0 ? "+" : ""}${volMom.toFixed(1)}%`}
              </small>
            </div>
            <div>
              <span>最近月销售额</span>
              <b>{latestFull ? formatAmountExact(latestFull.amount) : "—"}</b>
              <small>
                {latestFull ? formatAmount(latestFull.amount) : ""}
                {amtMom == null ? "" : ` · 环比 ${amtMom >= 0 ? "+" : ""}${amtMom.toFixed(1)}%`}
              </small>
            </div>
            <div>
              <span>Listing垄断系数</span>
              <b style={{ color: listingMonopolyColor }}>{latestListing ? formatPct(latestListing.value) : "—"}</b>
              <small>Top3 Listing 销售额占比</small>
            </div>
            <div>
              <span>品牌垄断系数</span>
              <b style={{ color: brandMonopolyColor }}>{latestBrand ? formatPct(latestBrand.value) : "—"}</b>
              <small>Top3 品牌销售额占比</small>
            </div>
            <div>
              <span>卖家垄断系数</span>
              <b style={{ color: sellerMonopolyColor }}>{latestSeller ? formatPct(latestSeller.value) : "—"}</b>
              <small>Top3 卖家销售额占比</small>
            </div>
            <div>
              <span>样本 / 竞品</span>
              <b>
                {series.length} 月 ·{" "}
                {activeRecord.asins.filter(asin => products.some(product => product.asin === asin)).length ||
                  activeRecord.asins.length}
                个
              </b>
              <small>更新 {activeRecord.fetchedAt}</small>
            </div>
          </div>
          <div className="category-charts-grid">
            <div>
              <h4 className="category-subchart-title">销量与销售额</h4>
              <CategoryComboChart key={`${activeRecord.nodeId}-sales`} series={series} />
            </div>
            <div>
              <h4 className="category-subchart-title">垄断系数趋势</h4>
              <MonopolyTrendChart key={`${activeRecord.nodeId}-monopoly`} series={monopolySeries} />
            </div>
          </div>
        </>
      )}
    </section>
  );
}
