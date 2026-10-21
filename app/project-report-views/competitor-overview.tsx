"use client";
import {useEffect, useId, useRef, useState} from "react";
import {ComparisonOverviewCard} from "../comparison-overview-card";
import {CategoryNodeTrendSection, pickCategoryRecords} from "../category-node-trend-section";
import {SellingPointTranslation} from "../selling-point-translation";
import {CatalogProfileValue, CatalogSourceStatus, type CatalogFieldSources, type CatalogSource} from "../catalog-source-status";
import {amazonMediaSrc} from "../lib/amazon-image";
import {resolveOverviewPrice, resolveOverviewRank} from "../lib/competitor-overview-fallback";
import {resolveFbaMetric, resolvePriceMetric, resolveRatingMetric} from "../lib/competitor-metric-resolution";
import {sorftimePriceStrategyMeta, type sorftimePriceStrategies} from "../sorftime-price-strategy-data";
import {sorftimeFbaFeeMeta, type sorftimeFbaFeeData} from "../sorftime-fba-fee-data";
import {sorftimeChildSalesMeta, type sorftimeChildSales30d} from "../sorftime-child-sales-data";
import {sorftimeSalesTrendMeta, type sorftimeSalesTrendData} from "../sorftime-sales-trend-data";
import type {sorftimeRatingData} from "../sorftime-rating-data";
import type {sorftimeCategoryTrendData} from "../sorftime-category-trend-data";
import type {SellingTranslationResult} from "../../shared/selling-point-translation-contracts";
import {marketSites, marketSiteCurrency, type MarketSite} from "../../shared/market-sites";
import {hasValidListingSpecificationsProvenance} from "../../scripts/lib/sorftime-content-specifications.mjs";
import type {SorftimeListingContentRecord} from "../sorftime-listing-content-data";

type Keyword = {word: string; share: number; type: "自然" | "广告"};
type VariantDetail = {name: string; reviews: number | null; share: number | null; launch: string | null};

export type Product = {
  asin: string;
  brand: string;
  image: string;
  title: string;
  price: number | null;
  sales: number | null;
  rating: number | null;
  reviews: number | null;
  rank: number | null;
  subRank: number | null;
  rankCategory: string;
  subRankCategory: string;
  buyBoxSeller: string;
  fulfillment: string;
  packageSize: string;
  packageWeight: string;
  specifications: string[];
  launch: string;
  format: string;
  variants: string;
  history: number[];
  prices: number[];
  ranks: number[];
  variantShare: number[];
  variantDetails: VariantDetail[];
  sellingPoints: string[];
  productFamily?: "scooter" | "lighting" | "generic";
  strengths: string[];
  weaknesses: string[];
  unmet: string[];
  scenarios: string[];
  audiences: string[];
  keywords: Keyword[];
  traffic: { natural: number; sponsored: number; recommendation: number };
  catalogSource?: CatalogSource;
  catalogFieldSources?: CatalogFieldSources;
  synced: boolean;
};

export const colors = ["#2F80ED", "#7A67D8", "#29A7C7", "#F0A020", "#E65B6A", "#26A269", "#D45D9E", "#6C86B6", "#D26A3A", "#18A0A8"];
export type ChartMetric = "history" | "prices" | "ranks" | "revenue";

function formatTrendMonthLabel(month: string, showYear = false) {
  const match = month.match(/^(\d{4})-(\d{2})$/);
  if (!match) return month;
  const monthNum = Number(match[2]);
  if (showYear) return `${match[1].slice(2)}/${monthNum}月`;
  return `${monthNum}月`;
}

function formatTrendMonthTitle(month: string) {
  const match = month.match(/^(\d{4})-(\d{2})$/);
  return match ? `${match[1]}年${Number(match[2])}月` : month;
}

function sorftimeMetricKey(metric: ChartMetric): "volume" | "amount" | "price" | "rank" {
  if (metric === "history") return "volume";
  if (metric === "revenue") return "amount";
  if (metric === "prices") return "price";
  return "rank";
}

function isValidTrendValue(value: number | null | undefined) {
  return value != null && Number.isFinite(value) && value >= 0;
}

function collectChartMonthKeys(products: Product[], field: ReturnType<typeof sorftimeMetricKey>, trendByAsin: typeof sorftimeSalesTrendData) {
  const months = new Set<string>();
  for (const product of products) {
    for (const point of trendByAsin[product.asin]?.[field] ?? []) {
      if (isValidTrendValue(point.value)) months.add(point.month);
    }
  }
  return [...months].sort().slice(-12);
}
export const markets = {
  US: { label: "美国站", short: "US", option: "Amazon.com｜美国站", domain: "www.amazon.com" },
  UK: { label: "英国站", short: "UK", option: "Amazon.co.uk｜英国站", domain: "www.amazon.co.uk" },
  CA: { label: "加拿大站", short: "CA", option: "Amazon.ca｜加拿大站", domain: "www.amazon.ca" },
  DE: { label: "德国站", short: "DE", option: "Amazon.de｜德国站", domain: "www.amazon.de" },
} as const;
export type MarketCode = keyof typeof markets;
function AmazonStarRating({ rating, compact = false }: { rating: number; compact?: boolean }) {
  const clamped = Math.max(0, Math.min(5, rating));
  return (
    <div
      className={compact ? "amazon-star-rating amazon-star-rating-compact" : "amazon-star-rating"}
      aria-label={`${clamped.toFixed(1)} 星，满分 5 星`}
    >
      <span className="amazon-star-rating-stars" aria-hidden="true">
        <span className="amazon-star-rating-base">★★★★★</span>
        <span className="amazon-star-rating-fill" style={{ width: `${(clamped / 5) * 100}%` }}>★★★★★</span>
      </span>
      {!compact ? <span className="amazon-star-rating-value">{clamped.toFixed(1)}</span> : null}
    </div>
  );
}

function RatingCell({ rating, reviews }: { rating: number; reviews: number | null }) {
  return (
    <div className="rating-cell">
      <AmazonStarRating rating={rating} />
      {reviews !== null && <small>{reviews.toLocaleString()} 条</small>}
    </div>
  );
}

const childSalesBarPalette = ["#2F80ED", "#1AA8A1", "#7A67D8", "#E8912D", "#E65B6A", "#26A269"];

function ChildSalesBars({ items }: { items: Array<{ asin: string; variant: string; sales: number; observedAt: string }> }) {
  if (!items.length) {
    return <span className="no-data-text child-sales-empty" title={`${sorftimeChildSalesMeta.source}；核查时间 ${sorftimeChildSalesMeta.checkedAt}`}>{sorftimeChildSalesMeta.emptyMessage}</span>;
  }
  const max = Math.max(...items.map(item => item.sales));
  return <div className="child-sales-bars">{items.map((item, index) => <div key={item.asin} title={`${item.asin} · 数据核查 ${item.observedAt}`}><span>{item.variant}</span><i><b style={{ width: `${Math.max(10, (item.sales / max) * 100)}%`, background: childSalesBarPalette[index % childSalesBarPalette.length] }} /></i><strong>{item.sales.toLocaleString()}+</strong></div>)}</div>;
}

function SalesTrendSparkline({ asin, sales30d, color, trendByAsin }: { asin: string; sales30d: number | null; color: string; trendByAsin: typeof sorftimeSalesTrendData }) {
  const record = trendByAsin[asin];
  const [open, setOpen] = useState(false);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [pinned, setPinned] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelClose = () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const closeChart = () => {
    cancelClose();
    setOpen(false);
    setPinned(false);
    setHoverIndex(null);
  };
  const keepOpen = () => { cancelClose(); setOpen(true); };
  const scheduleClose = () => {
    cancelClose();
    if (!pinned) closeTimer.current = setTimeout(closeChart, 1000);
  };
  useEffect(() => () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
  }, []);
  useEffect(() => {
    if (!open) return;
    const dismiss = () => {
      if (closeTimer.current !== null) clearTimeout(closeTimer.current);
      closeTimer.current = null;
      setOpen(false); setPinned(false); setHoverIndex(null);
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !cardRef.current?.contains(event.target)) dismiss();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") dismiss(); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const volumeColor = "#5DAFE8";
  const amountColor = "#7A67D8";
  const volumeSeries = record?.status === "ready" ? record.volume : [];
  const amountByMonth = new Map((record?.amount ?? []).map(point => [point.month, point.value]));
  const merged = volumeSeries.map(point => ({
    month: point.month,
    volume: point.value,
    amount: amountByMonth.get(point.month) ?? 0,
  }));
  const sparkData = merged.slice(-18).map(point => point.volume);
  const latestVolume = [...volumeSeries]
    .filter(point => Number(point.value) > 0)
    .sort((a, b) => String(a.month).localeCompare(String(b.month)))
    .at(-1)?.value;
  const displaySales = latestVolume ?? sales30d;

  if (!sparkData.length) {
    return <strong>{displaySales === null || displaySales === undefined ? "—" : `${Number(displaySales).toLocaleString()}+`}</strong>;
  }

  const sparkW = 56;
  const sparkH = 22;
  const sparkPad = 2;
  const sparkMin = Math.min(...sparkData);
  const sparkMax = Math.max(...sparkData);
  const sparkPoints = sparkData
    .map((value, index) => {
      const x = sparkPad + (index * (sparkW - sparkPad * 2)) / Math.max(sparkData.length - 1, 1);
      const y = sparkPad + (1 - (value - sparkMin) / (sparkMax - sparkMin || 1)) * (sparkH - sparkPad * 2);
      return `${x},${y}`;
    })
    .join(" ");

  const width = 500;
  const height = 220;
  const padLeft = 46;
  const padRight = 54;
  const padY = 28;
  const chartWidth = width - padLeft - padRight;
  const volMax = Math.max(...merged.map(point => point.volume), 1);
  const amtMax = Math.max(...merged.map(point => point.amount), 1);
  const count = merged.length;
  const barWidth = Math.min(12, (chartWidth / Math.max(count, 1)) * 0.55);

  const xAt = (index: number) => padLeft + (index * chartWidth) / Math.max(count - 1, 1);
  const yVol = (value: number) => padY + (1 - value / volMax) * (height - padY * 2);
  const yAmt = (value: number) => padY + (1 - value / amtMax) * (height - padY * 2);
  const formatVolume = (value: number) => Math.round(value).toLocaleString();
  const formatAmount = (value: number) =>
    `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const axisMonths = merged.filter((_, index) => index % Math.ceil(merged.length / 8) === 0 || index === merged.length - 1);
  const volTicks = [0, 0.25, 0.5, 0.75, 1].map(ratio => Math.round(volMax * ratio));
  const amtTicks = [0, 0.25, 0.5, 0.75, 1].map(ratio => Math.round(amtMax * ratio));

  return (
    <div
      className="sales-trend-cell"
      ref={cardRef}
      onMouseEnter={keepOpen}
      onMouseLeave={scheduleClose}
      onFocus={keepOpen}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) scheduleClose(); }}
    >
      <div className="sales-trend-value">
        <strong>{displaySales === null || displaySales === undefined ? "—" : `${Number(displaySales).toLocaleString()}+`}</strong>
        <button type="button" className="sales-trend-spark" aria-label="查看历史销量趋势" aria-expanded={open} aria-pressed={pinned}
          title="悬停预览，点击固定展开" onClick={() => { if (pinned) closeChart(); else { keepOpen(); setPinned(true); } }}>
          <svg viewBox={`0 0 ${sparkW} ${sparkH}`} width={sparkW} height={sparkH} role="img">
            <polyline points={sparkPoints} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      {open && merged.length > 0 && (
        <div className="sales-trend-popover" onMouseEnter={keepOpen} onMouseLeave={scheduleClose}>
          <div className="sales-trend-popover-head">
            <span className="sales-trend-popover-title">
              <i />销量趋势
            </span>
            <span className="sales-trend-popover-actions">
              <small>{pinned ? "已固定 · 点击外部可关闭" : "点击缩略图可固定"}</small>
              <button type="button" aria-label="关闭销量趋势" onClick={closeChart}>×</button>
            </span>
          </div>
          <div className="sales-trend-popover-legend">
            <span>
              <i className="sales-trend-legend-bar" style={{ background: volumeColor }} />
              当月销量
            </span>
            <span>
              <i className="sales-trend-legend-line" style={{ borderColor: amountColor }} />
              月销售额
            </span>
          </div>
          <div className="sales-trend-popover-chart">
            <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="历史销量与销售额趋势">
              {[0, 1, 2, 3].map(index => {
                const y = padY + (index * (height - padY * 2)) / 3;
                return <line key={index} x1={padLeft} x2={width - padRight} y1={y} y2={y} stroke="#EEF2F6" />;
              })}
              {volTicks.slice(1).map(tick => (
                <text key={`vol-${tick}`} x={padLeft - 6} y={yVol(tick) + 3} textAnchor="end" className="sales-trend-axis-label sales-trend-axis-label-left">
                  {tick >= 1000 ? `${Math.round(tick / 1000)}k` : tick}
                </text>
              ))}
              {amtTicks.slice(1).map(tick => (
                <text key={`amt-${tick}`} x={width - padRight + 6} y={yAmt(tick) + 3} textAnchor="start" className="sales-trend-axis-label sales-trend-axis-label-right">
                  {tick >= 1000 ? `${Math.round(tick / 1000)}k` : tick}
                </text>
              ))}
              {merged.map((point, index) => {
                const x = xAt(index);
                const barHeight = height - padY - yVol(point.volume);
                return (
                  <rect
                    key={`bar-${point.month}`}
                    x={x - barWidth / 2}
                    y={yVol(point.volume)}
                    width={barWidth}
                    height={Math.max(1, barHeight)}
                    fill={volumeColor}
                    opacity={hoverIndex === index ? 0.95 : 0.72}
                    rx="1.5"
                  />
                );
              })}
              <polyline
                points={merged
                  .map((point, index) => {
                    const pointCoord = { x: xAt(index), y: yAmt(point.amount) };
                    return `${pointCoord.x},${pointCoord.y}`;
                  })
                  .join(" ")}
                fill="none"
                stroke={amountColor}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {merged.map((point, index) => (
                <circle
                  key={`line-${point.month}`}
                  cx={xAt(index)}
                  cy={yAmt(point.amount)}
                  r={hoverIndex === index ? 4 : 3}
                  fill="#fff"
                  stroke={amountColor}
                  strokeWidth="2"
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
              {merged.map((_, index) => {
                const x = xAt(index);
                const step = chartWidth / Math.max(count - 1, 1);
                const left = Math.max(0, index === 0 ? 0 : x - step / 2);
                const right = Math.min(width, index === count - 1 ? width : x + step / 2);
                return (
                  <rect
                    key={`hover-${index}`}
                    x={left}
                    y="0"
                    width={right - left}
                    height={height}
                    fill="transparent"
                    onMouseMove={() => setHoverIndex(index)}
                  />
                );
              })}
            </svg>
            {hoverIndex != null && (
              <div className="sales-trend-hover-tip" style={{ left: `${(xAt(hoverIndex) / width) * 100}%` }}>
                <b>{merged[hoverIndex].month}</b>
                <div className="sales-trend-hover-row">
                  <span>
                    <i style={{ background: volumeColor }} />
                    当月销量
                  </span>
                  <strong>{formatVolume(merged[hoverIndex].volume)}</strong>
                </div>
                <div className="sales-trend-hover-row">
                  <span>
                    <i style={{ background: amountColor }} />
                    月销售额
                  </span>
                  <strong>{formatAmount(merged[hoverIndex].amount)}</strong>
                </div>
              </div>
            )}
          </div>
          <div className="sales-trend-month-axis">
            {axisMonths.map(point => (
              <span key={point.month}>{point.month}</span>
            ))}
          </div>
          <p className="sales-trend-popover-foot">
            {sorftimeSalesTrendMeta.source} · {record?.fetchedAt}
          </p>
        </div>
      )}
    </div>
  );
}

function SnapshotSalesTrendSparkline({asin, sales30d, color, trendByAsin}: {asin: string; sales30d: number | null; color: string; trendByAsin: typeof sorftimeSalesTrendData}) {
  const record = trendByAsin[asin];
  const volumeSeries = record?.status === "ready" ? record.volume : [];
  const amountByMonth = new Map((record?.amount ?? []).map(point => [point.month, point.value]));
  const merged = volumeSeries.map(point => ({month: point.month, volume: point.value, amount: amountByMonth.get(point.month) ?? 0}));
  const latestVolume = [...volumeSeries].filter(point => Number(point.value) > 0).sort((a, b) => String(a.month).localeCompare(String(b.month))).at(-1)?.value;
  const displaySales = latestVolume ?? sales30d;
  if (!merged.length) return <strong>{displaySales === null || displaySales === undefined ? "—" : `${Number(displaySales).toLocaleString()}+`}</strong>;
  const sparkData = merged.slice(-18).map(point => point.volume);
  const sparkW = 56, sparkH = 22, sparkPad = 2;
  const sparkMin = Math.min(...sparkData), sparkMax = Math.max(...sparkData);
  const sparkPoints = sparkData.map((value, index) => {
    const x = sparkPad + (index * (sparkW - sparkPad * 2)) / Math.max(sparkData.length - 1, 1);
    const y = sparkPad + (1 - (value - sparkMin) / (sparkMax - sparkMin || 1)) * (sparkH - sparkPad * 2);
    return `${x},${y}`;
  }).join(" ");
  return <div className="sales-trend-cell"><div className="sales-trend-value"><strong>{displaySales === null || displaySales === undefined ? "—" : `${Number(displaySales).toLocaleString()}+`}</strong><svg className="sales-trend-spark" viewBox={`0 0 ${sparkW} ${sparkH}`} width={sparkW} height={sparkH} role="img"><polyline points={sparkPoints} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg></div><details><summary>历史销量趋势</summary><div className="sales-trend-month-axis">{merged.map(point => <span key={point.month}>{point.month} · {point.volume.toLocaleString()} 件 · ${point.amount.toLocaleString()}</span>)}</div></details></div>;
}

type ChartHover = {
  x: number;
  month: string;
  entries: Array<{ asin: string; brand: string; color: string; value: string }>;
};

function ComparisonChart({ products, metric, inverse = false, trendByAsin }: { products: Product[]; metric: ChartMetric; inverse?: boolean; trendByAsin: typeof sorftimeSalesTrendData }) {
  const [hover, setHover] = useState<ChartHover | null>(null);
  const width = 900;
  const plotHeight = 210;
  const axisHeight = 20;
  const height = plotHeight + axisHeight;
  const padX = 32;
  const padY = 22;
  const field = sorftimeMetricKey(metric);
  const monthKeys = collectChartMonthKeys(products, field, trendByAsin);
  const seriesByProduct = products.map((product, index) => {
    const map = new Map(
      (trendByAsin[product.asin]?.[field] ?? [])
        .filter(point => isValidTrendValue(point.value))
        .map(point => [point.month, point.value]),
    );
    return {
      product,
      color: colors[index],
      series: monthKeys.map(month => map.get(month) ?? null),
    };
  });
  const all = seriesByProduct.flatMap(({ series }) => series.filter((value): value is number => value != null));
  if (!monthKeys.length || !all.length) {
    return <div className="empty-chart">等待 Sorftime 同步 · {sorftimeSalesTrendMeta.syncCommand}</div>;
  }
  const maxCount = monthKeys.length;
  const showYearOnAxis = new Set(monthKeys.map(month => month.slice(0, 4))).size > 1;
  const min = Math.min(...all);
  const max = Math.max(...all);
  const chartWidth = width - padX * 2;
  const plotBottom = plotHeight - padY;
  const xAt = (index: number) => padX + index * chartWidth / Math.max(maxCount - 1, 1);
  const point = (value: number, i: number) => {
    const x = xAt(i);
    const normalized = (value - min) / (max - min || 1);
    const y = padY + (inverse ? normalized : 1 - normalized) * (plotBottom - padY);
    return { x, y };
  };
  const formatValue = (value: number) =>
    metric === "prices"
      ? `$${value.toFixed(2)}`
      : metric === "ranks"
        ? `#${Math.round(value).toLocaleString()}`
        : metric === "revenue"
          ? `$${Math.round(value).toLocaleString()}`
          : `${Math.round(value).toLocaleString()} 件`;
  return (
    <div className="comparison-chart">
      <div className="chart-stage">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="多竞品趋势对比图" onMouseLeave={() => setHover(null)}>
          {[0, 1, 2, 3].map(i => (
            <line key={i} x1={padX} x2={width - padX} y1={padY + i * 46} y2={padY + i * 46} stroke="#E7ECF2" strokeDasharray="4 5" />
          ))}
          {seriesByProduct.map(({ product: p, color, series }) => {
            const defined = series
              .map((value, index) => (value == null ? null : { value, index }))
              .filter((item): item is { value: number; index: number } => item != null);
            if (!defined.length) return null;
            return (
              <g key={p.asin}>
                <polyline
                  points={defined.map(({ value, index }) => {
                    const pt = point(value, index);
                    return `${pt.x},${pt.y}`;
                  }).join(" ")}
                  fill="none"
                  stroke={color}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                {defined.map(({ value, index }) => {
                  const pt = point(value, index);
                  return (
                    <circle
                      key={`${p.asin}-${index}`}
                      className="chart-point"
                      cx={pt.x}
                      cy={pt.y}
                      r="3.5"
                      fill={color}
                      stroke="#fff"
                      strokeWidth="2"
                      pointerEvents="none"
                    >
                      <title>{`${p.brand} · ${formatTrendMonthTitle(monthKeys[index])} · ${formatValue(value)}`}</title>
                    </circle>
                  );
                })}
              </g>
            );
          })}
          {hover && (
            <line className="chart-hover-line" x1={hover.x} x2={hover.x} y1={padY} y2={plotBottom} stroke="#8393A8" strokeWidth="1" strokeDasharray="4 4" />
          )}
          {Array.from({ length: maxCount }).map((_, index) => {
            const x = xAt(index);
            const step = chartWidth / Math.max(maxCount - 1, 1);
            const left = Math.max(0, index === 0 ? 0 : x - step / 2);
            const right = Math.min(width, index === maxCount - 1 ? width : x + step / 2);
            const entries = seriesByProduct.flatMap(({ product, color, series }) =>
              series[index] == null
                ? []
                : [{ asin: product.asin, brand: product.brand, color, value: formatValue(series[index] as number) }],
            );
            return (
              <rect
                key={index}
                className="chart-hover-zone"
                x={left}
                y="0"
                width={right - left}
                height={plotHeight}
                fill="transparent"
                onMouseMove={() => setHover({ x, month: formatTrendMonthTitle(monthKeys[index]), entries })}
              />
            );
          })}
          {monthKeys.map((month, index) => (
            <text
              key={`axis-${month}`}
              x={xAt(index)}
              y={height - 5}
              textAnchor="middle"
              className="comparison-chart-axis-label"
            >
              {formatTrendMonthLabel(month, showYearOnAxis)}
            </text>
          ))}
        </svg>
        {hover && (
          <div
            className="chart-tooltip chart-tooltip-group"
            style={{
              left: `${(hover.x / width) * 100}%`,
              top: "12px",
              transform: hover.x / width < 0.2 ? "translateX(0)" : hover.x / width > 0.8 ? "translateX(-100%)" : "translateX(-50%)",
            }}
          >
            <b className="chart-tooltip-title">{hover.month}</b>
            {hover.entries.map(entry => (
              <div className="chart-tooltip-row" key={entry.asin}>
                <span>
                  <i style={{ background: entry.color }} />
                  {entry.brand}
                </span>
                <strong>{entry.value}</strong>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function ProductHeader({ product, index, market }: { product: Product; index: number; market?: MarketSite }) {
  const marketInfo = marketSites.find(site => site.code === (market ?? "US"))!;
  const image = amazonMediaSrc(product.image);
  return <div className="compare-product-head">
    <span className="series-dot" style={{ background: colors[index] }}>{index + 1}</span>
    {image ? <img src={image} alt="" referrerPolicy="no-referrer" /> : <div className="image-placeholder">ASIN</div>}
    <div>
      <b>{product.brand}</b>
      <a
        className="asin-link"
        href={`https://www.${marketInfo.amazonDomain}/dp/${product.asin}`}
        target="_blank"
        rel="noreferrer"
        title={`打开 Amazon ${marketInfo.label}商品页`}
      >
        {product.asin}<span>↗</span>
      </a>
      <CatalogSourceStatus product={product} />
    </div>
  </div>;
}

function variationAxes(source: string) {
  const themes: string[] = [];
  if (/color|颜色/i.test(source)) themes.push("颜色");
  if (/size|尺寸/i.test(source)) themes.push("尺寸");
  if (/style|款式/i.test(source)) themes.push("款式");
  if (/configuration|配置/i.test(source)) themes.push("配置");
  return themes.join("、");
}

function VariationTheme({ product, childVariants }: { product: Product; childVariants?: string[] }) {
  const primary = product.synced && product.catalogSource !== "sorftime-fallback"
    ? variationAxes([product.format, ...product.variantDetails.map(item => item.name)].join(" ")) : "";
  const fallback = primary ? "" : variationAxes((childVariants ?? []).join(" "));
  return <>{primary || fallback || "暂无数据"}{fallback ? <small className="insight-source">Sorftime · 子体属性</small> : null}</>;
}


export type CompetitorOverviewData = Readonly<{
  products: Product[];
  market: MarketSite;
  slugParam: string | null;
  salesTrendByAsin: typeof sorftimeSalesTrendData;
  ratingByAsin: typeof sorftimeRatingData;
  fbaFeeByAsin: typeof sorftimeFbaFeeData;
  childSalesByAsin: typeof sorftimeChildSales30d;
  priceStrategyByAsin: typeof sorftimePriceStrategies;
  listingContentByAsin?: Record<string, Pick<SorftimeListingContentRecord, "asin" | "marketplace" | "status"> & Partial<SorftimeListingContentRecord>>;
}>;
type PageMatrixProps = CompetitorOverviewData & Readonly<{presentation: "page"; translationProjectId: string | null; translationVersionId?: string | null; translationKey: string}>;
export type CompetitorOverviewSnapshotProps = CompetitorOverviewData & Readonly<{
  sellingTranslationsByAsin: Record<string, SellingTranslationResult | null>;
  categoryTrendByNode: typeof sorftimeCategoryTrendData;
}>;
type MatrixProps = PageMatrixProps | (CompetitorOverviewSnapshotProps & Readonly<{presentation: "snapshot"}>);

function CachedSellingTranslation({result}: {result: SellingTranslationResult | null}) {
  return <div>{result?.state === "ready" ? <ul>{result.points.map((point, index) => <li key={index}>{point}</li>)}</ul> : <p className="muted">{result?.message || "暂无可翻译的卖点原文。"}</p>}
    {result?.state === "ready" && !result.sourceComplete && <small className="muted">历史原文仅保留部分卖点，已翻译现有完整内容。</small>}
    {result?.original.length ? <details><summary>查看原文</summary><ul>{result.original.map((point, index) => <li key={index}>{point}</li>)}</ul></details> : null}
  </div>;
}

function SellingPointsRow(props: MatrixProps) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const showFull = props.presentation === "snapshot" || expanded;
  return <tr className={`selling-points-row${showFull ? " expanded" : ""}`}><th>主要卖点<small className="insight-source">亚马逊商品卖点中文翻译</small>
    {props.presentation === "page" ? <button type="button" className="price-strategy-toggle selling-points-toggle" aria-expanded={expanded}
      aria-controls={props.products.map(product => `${id}-${product.asin}`).join(" ")} onClick={() => setExpanded(value => !value)}>
      {expanded ? "收起主要卖点 ▴" : "展开主要卖点 ▾"}
    </button> : null}
  </th>{props.products.map(product => <td key={product.asin} className="selling-points-cell">
    {!showFull ? <p className="selling-points-summary muted">展开查看中文卖点及原文</p> : null}
    <div id={`${id}-${product.asin}`} className="selling-points-details" hidden={!showFull}>
      {props.presentation === "snapshot" ? <CachedSellingTranslation result={props.sellingTranslationsByAsin[product.asin] ?? null} />
        : <SellingPointTranslation key={`${props.translationKey}:${product.asin}`} projectId={props.translationProjectId}
          versionId={props.translationVersionId} asin={product.asin} />}
    </div>
  </td>)}</tr>;
}

export function PriceStrategyRow({ products, priceStrategyByAsin, presentation, market = "US" }: Pick<CompetitorOverviewData, "products" | "priceStrategyByAsin"> & { presentation: "page" | "snapshot"; market?: MarketSite }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const showFull = presentation === "snapshot" || expanded;
  return <tr className={`price-strategy-row${showFull ? " expanded" : ""}`}><th>价格策略分析<small className="insight-source">Sorftime MCP</small>
    {presentation === "page" ? <button type="button" className="price-strategy-toggle" aria-expanded={expanded} aria-controls={products.map(p => `${id}-${p.asin}`).join(" ")} onClick={() => setExpanded(value => !value)}>{expanded ? "收起价格策略 ▴" : "展开价格策略 ▾"}</button> : null}
  </th>{products.map(p => {
    const strategy = priceStrategyByAsin[p.asin];
    const metric = resolvePriceMetric(strategy as unknown as { status?: string; currentPrice?: unknown } | undefined, p.price);
    return <td key={p.asin}>{strategy && metric.source === "sorftime" ? <div className="price-strategy-cell">
      <p className="price-strategy-summary"><b>当前价 {market === "US" ? "$" : `${marketSiteCurrency(market)} `}{metric.value?.toFixed(2)}</b><small>已取得定价与促销分析</small></p>
      <div id={`${id}-${p.asin}`} className="price-strategy-details" hidden={!showFull}><p><b>定价锚点</b>{strategy.anchor}</p><p><b>促销手法</b>{strategy.promotion}</p><p><b>折扣心理</b>{strategy.psychology}</p><small>{strategy.evidence}</small></div>
    </div> : <div id={`${id}-${p.asin}`}><span className="no-data-text">{metric.label ?? sorftimePriceStrategyMeta.emptyMessage}</span></div>}</td>;
  })}</tr>;
}

function ProductSpecifications({ product, listing, market }: { product: Product; listing?: NonNullable<CompetitorOverviewData["listingContentByAsin"]>[string]; market: MarketSite }) {
  const primary = product.synced && product.catalogSource !== "sorftime-fallback";
  const specifications = primary ? product.specifications.filter(value => value.trim() && !/^(—|等待同步|暂无数据)$/.test(value.trim())) : [];
  const provenanceValid = listing?.specificationsProvenance === undefined || hasValidListingSpecificationsProvenance(listing);
  const fallback = !specifications.length && listing?.asin === product.asin && listing.marketplace === market && listing.status === "ready" && listing.source === "Sorftime" && provenanceValid ? listing.specifications?.filter(value => typeof value === "string" && value.trim()) ?? [] : [];
  const values = specifications.length ? specifications : fallback;
  return <div className="spec-lines">{values.length ? values.map(spec => <div key={spec}>{spec}</div>) : <span className="no-data-text">暂无已核验规格</span>}{fallback.length ? <small className="insight-source">Sorftime · 商品内容参数</small> : null}</div>;
}

export function CompetitorOverviewMatrix(props: MatrixProps) {
  const {products, market, slugParam, salesTrendByAsin, ratingByAsin, fbaFeeByAsin, childSalesByAsin, priceStrategyByAsin, presentation} = props;
  return <ComparisonOverviewCard description={<>{slugParam ? `当前工作区 /p/${slugParam} · 仅展示本批对标 ASIN` : "同一工作区内的竞品对齐查看；不同品类请用各自的 /p/ 地址"}；点击 ASIN 可打开对应站点前台</>} badge={<span className="source-badge">MCP 综合</span>} presentation={presentation}><div className="matrix-wrap"><table className="compare-matrix"><thead><tr><th>指标</th>{products.map((p,i)=><th key={p.asin}><ProductHeader product={p} index={i} market={market}/></th>)}</tr></thead><tbody>
          <tr><th>当前售价</th>{products.map(p=>{const overview=resolveOverviewPrice(p.price, salesTrendByAsin[p.asin]);return <td key={p.asin}><strong>{overview.value===null?"—":`${market === "US" ? "$" : `${marketSiteCurrency(market)} `}${overview.value}`}</strong></td>})}</tr>
          <tr><th>30天销量<small className="insight-source">Sorftime · 悬停趋势图</small></th>{products.map((p,i)=><td key={p.asin}>{presentation === "snapshot" ? <SnapshotSalesTrendSparkline asin={p.asin} sales30d={p.sales} color={colors[i]} trendByAsin={salesTrendByAsin}/> : <SalesTrendSparkline asin={p.asin} sales30d={p.sales} color={colors[i]} trendByAsin={salesTrendByAsin}/>}</td>)}</tr>
          <tr><th>评分 / 评论<small className="insight-source">Sorftime MCP</small></th>{products.map(p=>{const metric=resolveRatingMetric(ratingByAsin[p.asin],p);return <td key={p.asin}>{metric.value?<>{metric.value.rating===null?<span>— / {metric.value.reviewCount?.toLocaleString() ?? "—"}</span>:<RatingCell rating={metric.value.rating} reviews={metric.value.reviewCount}/>} {metric.label?<small className="no-data-text">{metric.label}</small>:null}</>:<span className="no-data-text">{metric.label}</span>}</td>})}</tr>
          <tr><th>Best Seller Rank</th>{products.map(p=>{const overview=resolveOverviewRank(p.rank, p.subRank, salesTrendByAsin[p.asin]);return <td key={p.asin}>{overview.value===null?"—":overview.source==="sellerSprite"?<div className="rank-lines"><b>#{overview.value.toLocaleString()} in {p.rankCategory}</b>{p.subRank===null?null:<small>#{p.subRank} in {p.subRankCategory}</small>}</div>:<div className="rank-lines"><b>#{overview.value.toLocaleString()}</b><small>类目：卖家精灵未返回</small></div>}</td>})}</tr>
          <tr><th>购物车卖家</th>{products.map(p=><td key={p.asin}><CatalogProfileValue product={p} field="buyBoxSeller" /></td>)}</tr>
          <tr><th>配送方式</th>{products.map(p=><td key={p.asin}><CatalogProfileValue product={p} field="fulfillment" /></td>)}</tr>
          <tr><th>产品包装</th>{products.map(p=><td key={p.asin}><CatalogProfileValue product={p} field="packageSize" /><CatalogProfileValue product={p} field="packageWeight" /></td>)}</tr>
          <tr><th>FBA 费用</th>{products.map(p=>{const record=fbaFeeByAsin[p.asin];const metric=resolveFbaMetric(record);return <td key={p.asin}>{metric.value!=null?<div className="fba-fee-cell"><strong>{market === "US" ? "$" : `${marketSiteCurrency(market)} `}{metric.value.toFixed(2)}</strong>{record?.packageSize?<small title={record.note??undefined}>{record.packageSize}{record.packageWeight?` · ${record.packageWeight}`:""}</small>:null}<small className="insight-source">{record?.source === "keepa" ? "Keepa · 配送费" : "Sorftime · FBA 费用估算"}</small></div>:<span className="no-data-text">{metric.label ?? sorftimeFbaFeeMeta.emptyMessage}</span>}</td>})}</tr>
          <tr><th>产品规格<small className="insight-source">Features &amp; Specs</small></th>{products.map(p=><td key={p.asin}><ProductSpecifications product={p} listing={props.listingContentByAsin?.[p.asin]} market={market} /></td>)}</tr>
          <tr><th>上架时间</th>{products.map(p=><td key={p.asin}><CatalogProfileValue product={p} field="launch" /></td>)}</tr><tr><th>变体主题</th>{products.map(p=><td key={p.asin}><VariationTheme product={p} childVariants={childSalesByAsin[p.asin]?.map(item => item.variant)} /></td>)}</tr><tr><th>变体数量</th>{products.map(p=><td key={p.asin}><CatalogProfileValue product={p} field="variants" /></td>)}</tr>
          <tr><th>近期披露子体销量<small className="insight-source">Sorftime · 页面披露口径</small><small className="insight-source">统计周期未提供</small></th>{products.map(p=>{const items=[...((childSalesByAsin[p.asin] as typeof sorftimeChildSales30d[string] | undefined)??[])].sort((a,b)=>b.sales-a.sales||a.variant.localeCompare(b.variant));return <td key={p.asin}><ChildSalesBars items={items.slice(0,5)}/>{presentation === "snapshot" && items.length > 5 ? <details><summary>查看其余 {items.length - 5} 个子体</summary><ChildSalesBars items={items.slice(5)}/></details> : null}</td>})}</tr>
          <PriceStrategyRow market={market} products={products} priceStrategyByAsin={priceStrategyByAsin} presentation={presentation} />
          <SellingPointsRow {...props} />
        </tbody></table></div></ComparisonOverviewCard>;
}

export function CompetitorOverviewCategoryTrend({products, market, categoryTrendByNode, presentation = "page"}: Pick<CompetitorOverviewSnapshotProps, "products" | "market" | "categoryTrendByNode"> & {presentation?: "page" | "snapshot"}) {
  const refs = products.map(p => ({asin: p.asin, brand: p.brand, subRankCategory: p.subRankCategory}));
  if (presentation === "page") return <CategoryNodeTrendSection marketplace={market} products={refs} trendByNode={categoryTrendByNode}/>;
  const records = pickCategoryRecords(refs, market, categoryTrendByNode);
  if (!records.length) return <CategoryNodeTrendSection marketplace={market} products={refs} trendByNode={categoryTrendByNode}/>;
  return <div className="overview-category-snapshot">{records.map((record, index) => <details key={record.nodeId} open={index === 0}><summary>{record.categoryName} · Node {record.nodeId}</summary><CategoryNodeTrendSection marketplace={market} products={refs} trendByNode={categoryTrendByNode} snapshotNodeId={record.nodeId}/></details>)}</div>;
}

export function CompetitorOverviewHistory({products, market, salesTrendByAsin, metric, onMetricChange}: Readonly<{products: Product[]; market: MarketCode; salesTrendByAsin: typeof sorftimeSalesTrendData; metric: ChartMetric; onMetricChange: (metric: ChartMetric) => void}>) {
  return <section className="card compare-chart-card sales-combined-card">
          <div className="section-head">
            <div>
              <h3>竞品历史数据追踪</h3>
              <p>
                {metric === "history"
                  ? "月销量 · 同一坐标系查看增速、体量与拐点"
                  : metric === "revenue"
                    ? `月销售额 · Sorftime SalesAmount · ${marketSiteCurrency(market)}`
                    : metric === "prices"
                      ? `历史价格 · 月均价 · ${marketSiteCurrency(market)}`
                      : "大类 BSR · 越靠上表现越优"}
                {sorftimeSalesTrendMeta.updatedAt ? ` · 同步至 ${sorftimeSalesTrendMeta.updatedAt}` : ""}
              </p>
            </div>
            <div className="chart-head-actions">
              <div className="chart-view-switch" role="group" aria-label="切换历史数据指标">
                <button type="button" className={metric === "history" ? "selected" : ""} aria-pressed={metric === "history"} onClick={() => onMetricChange("history")}>
                  月销量
                </button>
                <button type="button" className={metric === "revenue" ? "selected" : ""} aria-pressed={metric === "revenue"} onClick={() => onMetricChange("revenue")}>
                  月销售额
                </button>
                <button type="button" className={metric === "prices" ? "selected" : ""} aria-pressed={metric === "prices"} onClick={() => onMetricChange("prices")}>
                  历史价格
                </button>
                <button type="button" className={metric === "ranks" ? "selected" : ""} aria-pressed={metric === "ranks"} onClick={() => onMetricChange("ranks")}>
                  大类 BSR
                </button>
              </div>
              <span className="source-badge">Sorftime MCP</span>
            </div>
          </div>
          <div className="chart-legend">
            {products.map((p, i) => (
              <span key={p.asin}>
                <i style={{ background: colors[i] }} />
                {p.brand}
              </span>
            ))}
          </div>
          <SourceDailyObservations products={products} salesTrendByAsin={salesTrendByAsin}/>
          <ComparisonChart key={metric} products={products} metric={metric} inverse={metric === "ranks"} trendByAsin={salesTrendByAsin} />
        </section>;
}

export function SourceDailyObservations({products, salesTrendByAsin}: Readonly<{products: Product[]; salesTrendByAsin: typeof sorftimeSalesTrendData}>) {
  const fields = ["volume", "amount", "price", "rank"] as const;
  const labels = {volume: "销量来源观测值", amount: "销售额来源观测值", price: "价格来源观测值", rank: "排名来源观测值"};
  const records = products.filter(product => fields.some(field => (salesTrendByAsin[product.asin]?.dailyObservations?.[field]?.length || salesTrendByAsin[product.asin]?.missingDailyObservations?.[field]?.length)));
  if (!records.length) return null;
  return <section className="overview-history-records"><h4>来源日观测序列</h4><p>来源日期为日粒度，指标口径未确认；这些观测值不参与自然月汇总或年度与增长计算。</p>{records.map(product => {
    const record = salesTrendByAsin[product.asin];
    const dates = [...new Set(fields.flatMap(field => [...(record.dailyObservations?.[field] ?? []), ...(record.missingDailyObservations?.[field] ?? [])].map(point => point.date)))].sort();
    const hasMonths = fields.some(field => record[field]?.length);
    return <details key={product.asin} open><summary>{product.brand} · {product.asin}</summary>{!hasMonths && <p>月度数据不可用，月度口径待确认。</p>}<div className="matrix-wrap"><table className="compare-matrix"><thead><tr><th>来源日期</th>{fields.map(field => <th key={field}>{labels[field]}<small>采集：{record.dailyObservations?.[field]?.length ? (record.dailyFieldFetchedAt?.[field] ?? record.fieldFetchedAt?.[field] ?? record.fetchedAt) : "未知"}</small></th>)}</tr></thead><tbody>{dates.map(date => <tr key={date}><th>{date}</th>{fields.map(field => { const value = record.dailyObservations?.[field]?.find(point => point.date === date)?.value; const missing = record.missingDailyObservations?.[field]?.find(point => point.date === date); const observedAt = record.dailyObservationFetchedAt?.[field]?.[date] ?? record.dailyFieldFetchedAt?.[field] ?? record.fieldFetchedAt?.[field] ?? record.fetchedAt; return <td key={field}>{missing ? <>—<small>来源缺失 · 采集：{missing.fetchedAt}</small>{isValidTrendValue(value) && <small>保留观测：{value} · 采集：{observedAt}</small>}</> : isValidTrendValue(value) ? <>{value}<small>采集：{observedAt}</small></> : "—"}</td>; })}</tr>)}</tbody></table></div></details>;
  })}</section>;
}

function SnapshotHistoryRecords({products, salesTrendByAsin, metric}: Readonly<{products: Product[]; salesTrendByAsin: typeof sorftimeSalesTrendData; metric: ChartMetric}>) {
  const field = sorftimeMetricKey(metric);
  const months = [...new Set(products.flatMap(product => (salesTrendByAsin[product.asin]?.[field] ?? []).filter(point => isValidTrendValue(point.value)).map(point => point.month)))].sort();
  if (!months.length) return null;
  return <details className="overview-history-records"><summary>全部月份明细</summary><div className="matrix-wrap"><table className="compare-matrix"><thead><tr><th>月份</th>{products.map(product => <th key={product.asin}>{product.brand} · {product.asin}</th>)}</tr></thead><tbody>{months.map(month => <tr key={month}><th>{month}</th>{products.map(product => {
    const value = salesTrendByAsin[product.asin]?.[field]?.find(point => point.month === month)?.value;
    return <td key={product.asin}>{isValidTrendValue(value) ? metric === "prices" || metric === "revenue" ? `$${value!.toLocaleString()}` : metric === "ranks" ? `#${value!.toLocaleString()}` : `${value!.toLocaleString()} 件` : "—"}</td>;
  })}</tr>)}</tbody></table></div></details>;
}

export function CompetitorOverviewSnapshotView(props: CompetitorOverviewSnapshotProps) {
  const {products, market, categoryTrendByNode, salesTrendByAsin} = props;
  return <>
    <CompetitorOverviewCategoryTrend products={products} market={market} categoryTrendByNode={categoryTrendByNode} presentation="snapshot"/>
    <CompetitorOverviewMatrix {...props} presentation="snapshot"/>
    <section className="card compare-chart-card sales-combined-card">
      <div className="section-head"><div><h3>竞品历史数据追踪</h3><p>月销量 · 历史价格 · 大类 BSR · 月销售额</p></div><span className="source-badge">Sorftime MCP</span></div>
      <div className="chart-legend">{products.map((p, i) => <span key={p.asin}><i style={{background: colors[i]}}/>{p.brand}</span>)}</div>
      <SourceDailyObservations products={products} salesTrendByAsin={salesTrendByAsin}/>
      {(["history", "revenue", "prices", "ranks"] as const).map(metric => <details key={metric} className="overview-history-detail" open={metric === "history"}><summary>{metric === "history" ? "月销量" : metric === "revenue" ? "月销售额" : metric === "prices" ? "历史价格" : "大类 BSR"}</summary><ComparisonChart products={products} metric={metric} inverse={metric === "ranks"} trendByAsin={salesTrendByAsin}/><SnapshotHistoryRecords products={products} metric={metric} salesTrendByAsin={salesTrendByAsin}/></details>)}
    </section>
  </>;
}
