"use client";

import { sifMonthlyTrafficTrend, type SifMonthlyTrafficSeries, sifMonthlyTrafficMeta } from "../../sif-monthly-traffic-trend-data";
import { useState } from "react";
import { type Product } from "../catalog/product-contracts";
import { colors } from "../charts/chart-format";

export type MonthlyTrafficHover = {
  x: number;
  month: string;
  brand: string;
  asin: string;
  natural: number;
  ad: number;
  total: number;
  brandColor: string;
};

export function MonthlyTrafficStackChart({
  products,
  monthlyTrendByAsin = sifMonthlyTrafficTrend,
}: {
  products: Product[];
  monthlyTrendByAsin?: Record<string, SifMonthlyTrafficSeries>;
}) {
  const [hover, setHover] = useState<MonthlyTrafficHover | null>(null);
  const width = 980;
  const height = 300;
  const padL = 52;
  const padR = 18;
  const padT = 18;
  const padB = 44;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const monthLabels = sifMonthlyTrafficMeta.months;
  const brandCounts = products.reduce<Record<string, number>>((acc, product) => {
    acc[product.brand] = (acc[product.brand] ?? 0) + 1;
    return acc;
  }, {});
  const series = products
    .map((product, index) => ({
      product,
      color: colors[index],
      label: brandCounts[product.brand] > 1 ? `${product.brand} · ${product.asin.slice(-4)}` : product.brand,
      points: monthlyTrendByAsin[product.asin]?.points ?? [],
    }))
    .filter(item => item.points.length);

  if (!series.length) return <div className="empty-chart">等待 SIF 月流量结构数据</div>;

  const monthCount = monthLabels.length;
  const brandCount = series.length;
  const maxTotal = Math.max(...series.flatMap(item => item.points.map(point => point.total)), 1);
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(ratio => Math.round(maxTotal * ratio));
  const groupGap = plotW / brandCount;
  const barGap = 2;
  const barWidth = Math.min(16, Math.max(8, (groupGap * 0.78 - barGap * (monthCount - 1)) / monthCount));
  const clusterWidth = monthCount * barWidth + (monthCount - 1) * barGap;
  const yFor = (value: number) => padT + plotH * (1 - value / maxTotal);

  return (
    <div className="comparison-chart monthly-traffic-stack-chart">
      <div className="chart-stage">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="按品牌近6个月自然广告堆叠柱图" onMouseLeave={() => setHover(null)}>
          {yTicks.map((tick, index) => {
            const y = yFor(tick);
            return (
              <g key={tick}>
                <line x1={padL} x2={width - padR} y1={y} y2={y} stroke="#E7ECF2" strokeDasharray="4 5" />
                <text x={padL - 8} y={y + 3} textAnchor="end" className="monthly-traffic-axis-label">{index === 0 ? "0" : tick.toLocaleString()}</text>
              </g>
            );
          })}
          {series.map((item, brandIndex) => {
            const groupCenter = padL + groupGap * brandIndex + groupGap / 2;
            const clusterLeft = groupCenter - clusterWidth / 2;
            return (
              <g key={item.product.asin}>
                {item.points.map((point, monthIndex) => {
                  const monthLabel = monthLabels[monthIndex] ?? point.label;
                  const x = clusterLeft + monthIndex * (barWidth + barGap);
                  const naturalH = (point.natural / maxTotal) * plotH;
                  const adH = (point.ad / maxTotal) * plotH;
                  const naturalY = padT + plotH - naturalH;
                  const adY = naturalY - adH;
                  const stackH = Math.max(naturalH + adH, 0);
                  const gap = naturalH > 1.5 && adH > 1.5 ? 1.2 : 0;
                  return (
                    <g
                      key={`${item.product.asin}-${point.month}`}
                      className="monthly-traffic-bar"
                      onMouseMove={() => setHover({
                        x: x + barWidth / 2,
                        month: monthLabel,
                        brand: item.label,
                        asin: item.product.asin,
                        natural: point.natural,
                        ad: point.ad,
                        total: point.total,
                        brandColor: item.color,
                      })}
                    >
                      <rect
                        x={x}
                        y={naturalY}
                        width={barWidth}
                        height={Math.max(naturalH - gap / 2, 0)}
                        fill={sifMonthlyTrafficMeta.naturalColor}
                        rx="2"
                      />
                      <rect
                        x={x}
                        y={adY}
                        width={barWidth}
                        height={Math.max(adH - gap / 2, 0)}
                        fill={sifMonthlyTrafficMeta.adColor}
                        rx="2"
                      />
                      <rect x={x} y={adY} width={barWidth} height={stackH} fill="transparent" />
                      <text
                        x={x + barWidth / 2}
                        y={height - 26}
                        textAnchor="middle"
                        className="monthly-traffic-month-tick"
                      >
                        {monthLabel.replace("月", "")}
                      </text>
                    </g>
                  );
                })}
                <line
                  x1={clusterLeft}
                  x2={clusterLeft + clusterWidth}
                  y1={padT + plotH + 1}
                  y2={padT + plotH + 1}
                  stroke={item.color}
                  strokeWidth="2"
                  strokeLinecap="round"
                  opacity="0.85"
                />
                <text x={groupCenter} y={height - 8} textAnchor="middle" className="monthly-traffic-brand-label">
                  {item.label}
                </text>
              </g>
            );
          })}
        </svg>
        {hover && (
          <div
            className="chart-tooltip chart-tooltip-group monthly-traffic-tooltip"
            style={{
              left: `${(hover.x / width) * 100}%`,
              top: "12px",
              transform: hover.x / width < 0.2 ? "translateX(0)" : hover.x / width > 0.8 ? "translateX(-100%)" : "translateX(-50%)",
            }}
          >
            <b className="chart-tooltip-title">{hover.brand} · {hover.month}</b>
            <div className="chart-tooltip-row"><span><i style={{ background: sifMonthlyTrafficMeta.naturalColor }} />自然流量</span><strong>{hover.natural.toLocaleString()}</strong></div>
            <div className="chart-tooltip-row"><span><i style={{ background: sifMonthlyTrafficMeta.adColor }} />广告流量</span><strong>{hover.ad.toLocaleString()}</strong></div>
            <div className="chart-tooltip-row"><span><i style={{ background: hover.brandColor }} />合计</span><strong>{hover.total.toLocaleString()}</strong></div>
          </div>
        )}
      </div>
    </div>
  );
}
