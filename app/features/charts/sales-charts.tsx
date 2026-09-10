"use client";

import { sorftimeChildSalesMeta } from "../../sorftime-child-sales-data";
import { sorftimeSalesTrendData, sorftimeSalesTrendMeta } from "../../sorftime-sales-trend-data";
import { useState } from "react";
import { type Product } from "../catalog/product-contracts";
import { type ChartMetric, sorftimeMetricKey, collectChartMonthKeys, isValidTrendValue, colors, formatTrendMonthTitle, formatTrendMonthLabel } from "./chart-format";

export const childSalesBarPalette = ["#2F80ED", "#1AA8A1", "#7A67D8", "#E8912D", "#E65B6A", "#26A269"];

export function ChildSalesBars({ items }: { items: Array<{ asin: string; variant: string; sales: number; observedAt: string }> }) {
  if (!items.length) {
    return <span className="no-data-text child-sales-empty" title={`${sorftimeChildSalesMeta.source}；核查时间 ${sorftimeChildSalesMeta.checkedAt}`}>{sorftimeChildSalesMeta.emptyMessage}</span>;
  }
  const max = Math.max(...items.map(item => item.sales));
  return <div className="child-sales-bars">{items.map((item, index) => <div key={item.asin} title={`${item.asin} · 数据核查 ${item.observedAt}`}><span>{item.variant}</span><i><b style={{ width: `${Math.max(10, (item.sales / max) * 100)}%`, background: childSalesBarPalette[index % childSalesBarPalette.length] }} /></i><strong>{item.sales.toLocaleString()}+</strong></div>)}</div>;
}

export function SalesTrendSparkline({ asin, sales30d, color, trendByAsin }: { asin: string; sales30d: number | null; color: string; trendByAsin: typeof sorftimeSalesTrendData }) {
  const record = trendByAsin[asin];
  const [open, setOpen] = useState(false);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

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
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        setOpen(false);
        setHoverIndex(null);
      }}
    >
      <div className="sales-trend-value">
        <strong>{displaySales === null || displaySales === undefined ? "—" : `${Number(displaySales).toLocaleString()}+`}</strong>
        <span className="sales-trend-spark" aria-label="悬停查看历史销量趋势">
          <svg viewBox={`0 0 ${sparkW} ${sparkH}`} width={sparkW} height={sparkH} role="img">
            <polyline points={sparkPoints} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </div>
      {open && merged.length > 0 && (
        <div className="sales-trend-popover">
          <div className="sales-trend-popover-head">
            <span className="sales-trend-popover-title">
              <i />销量趋势
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

export type ChartHover = {
  x: number;
  month: string;
  entries: Array<{ asin: string; brand: string; color: string; value: string }>;
};

export function ComparisonChart({ products, metric, inverse = false, trendByAsin }: { products: Product[]; metric: ChartMetric; inverse?: boolean; trendByAsin: typeof sorftimeSalesTrendData }) {
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
                      <title>{p.brand} · {formatTrendMonthTitle(monthKeys[index])} · {formatValue(value)}</title>
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
