"use client";

import { useState } from "react";
import type { SorftimeTrendPoint } from "./types";

type Series = { label: string; color: string; values: SorftimeTrendPoint[] };
const finite = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value) ? value : null;
const fmt = (value: number | null | undefined) => finite(value) === null ? "未知" : value!.toLocaleString("zh-CN", { maximumFractionDigits: 2 });

/** Reference chart layout: first series is a blue volume line; second is a purple amount column. */
export function CategoryComboChart({ volume, amount, amountEstimated = false }: { volume: SorftimeTrendPoint[]; amount: SorftimeTrendPoint[]; amountEstimated?: boolean }) {
  const [hover, setHover] = useState<string | null>(null);
  const months = [...new Set([...volume, ...amount].map(point => point.month))].sort();
  const v = new Map(volume.map(point => [point.month, finite(point.value)]));
  const a = new Map(amount.map(point => [point.month, finite(point.value)]));
  const maxVolume = Math.max(1, ...volume.map(point => finite(point.value) ?? 0));
  const maxAmount = Math.max(1, ...amount.map(point => finite(point.value) ?? 0));
  const width = 960, height = 168, left = 46, right = 50, top = 16, bottom = 152;
  const x = (index: number) => left + index * (width - left - right) / Math.max(1, months.length - 1);
  const yv = (value: number) => bottom - value / maxVolume * (bottom - top);
  const ya = (value: number) => bottom - value / maxAmount * (bottom - top);
  return <div className="comparison-chart category-combo-chart">
    <div className="sales-trend-popover-legend category-combo-legend"><span><i className="sales-trend-legend-line" style={{ borderColor: "#2f80ed" }} />月销量（折线）</span><span><i className="sales-trend-legend-bar" style={{ background: "#7a67d8" }} />月销售额{amountEstimated ? "估算" : ""}（柱状）</span></div>
    {months.length ? <div className="chart-stage"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="类目历史销量与销售额" onMouseLeave={() => setHover(null)}>
      {[0, 1, 2, 3].map(i => <line key={i} x1={left} x2={width - right} y1={top + i * (bottom - top) / 3} y2={top + i * (bottom - top) / 3} stroke="#eef2f6" />)}
      {months.map((month, i) => { const amountValue = a.get(month); return amountValue === null || amountValue === undefined ? null : <rect key={month} x={x(i) - 9} y={ya(amountValue)} width={18} height={Math.max(1, bottom - ya(amountValue))} fill="#7a67d8" opacity={hover === month ? .92 : .55} rx="2" />; })}
      {months.map((month, i) => i === 0 || v.get(month) === null || v.get(month) === undefined || v.get(months[i - 1]) === null || v.get(months[i - 1]) === undefined ? null : <line key={`line-${month}`} x1={x(i - 1)} y1={yv(v.get(months[i - 1])!)} x2={x(i)} y2={yv(v.get(month)!)} stroke="#2f80ed" strokeWidth="2.5" />)}
      {months.map((month, i) => v.get(month) === null || v.get(month) === undefined ? null : <circle key={month} cx={x(i)} cy={yv(v.get(month)!)} r={hover === month ? 4.5 : 3} fill="#fff" stroke="#2f80ed" strokeWidth="2" />)}
      {months.map((month, i) => <rect key={`hit-${month}`} x={x(i) - 14} y={top} width={28} height={bottom - top} fill="transparent" onMouseEnter={() => setHover(month)}><title>{month}：销量 {fmt(v.get(month))}；销售额{amountEstimated ? "估算" : ""} {fmt(a.get(month))}</title></rect>)}
      {months.filter((_, i) => months.length <= 12 || i % Math.max(1, Math.ceil(months.length / 8)) === 0).map(month => <text key={`label-${month}`} x={x(months.indexOf(month))} y={height - 2} textAnchor="middle" className="sales-trend-axis-label">{month.slice(2)}</text>)}
    </svg></div> : <div className="empty-chart">暂无历史趋势</div>}
    {hover ? <p className="market-research-note">{hover} · 月销量 {fmt(v.get(hover))} · 月销售额{amountEstimated ? "估算" : ""} {fmt(a.get(hover))}</p> : null}
  </div>;
}

export function MonopolyTrendChart({ listing, brand, seller }: { listing: SorftimeTrendPoint[]; brand: SorftimeTrendPoint[]; seller: SorftimeTrendPoint[] }) {
  const series: Series[] = [
    { label: "TOP3 商品占比", color: "#2f80ed", values: listing },
    { label: "TOP3 品牌占比", color: "#29a7c7", values: brand },
    { label: "TOP3 卖家占比", color: "#e65b6a", values: seller },
  ];
  const months = [...new Set(series.flatMap(row => row.values.map(p => p.month)))].sort();
  const [hover, setHover] = useState<string | null>(null);
  const width = 960, height = 168, left = 46, right = 46, top = 16, bottom = 152;
  const x = (index: number) => left + index * (width - left - right) / Math.max(1, months.length - 1);
  const y = (value: number) => bottom - Math.min(100, Math.max(0, value)) / 100 * (bottom - top);
  return <div className="comparison-chart monopoly-trend-chart"><div className="sales-trend-popover-legend">{series.map(row => <span key={row.label}><i className="sales-trend-legend-line" style={{ borderColor: row.color }} />{row.label}</span>)}</div>
    {months.length ? <div className="chart-stage"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="TOP3 商品、品牌和卖家占比趋势" onMouseLeave={() => setHover(null)}>
      {series.map(row => { const points = new Map(row.values.map(p => [p.month, finite(p.value)])); return months.map((month, index) => points.get(month) === null || points.get(month) === undefined || index === 0 || points.get(months[index - 1]) === null || points.get(months[index - 1]) === undefined ? null : <line key={`${row.label}-${month}`} x1={x(index - 1)} y1={y(points.get(months[index - 1])!)} x2={x(index)} y2={y(points.get(month)!)} stroke={row.color} strokeWidth="2.5" />); })}
      {months.map((month, i) => <rect key={month} x={x(i) - 14} y={top} width={28} height={bottom - top} fill="transparent" onMouseEnter={() => setHover(month)}><title>{month}：{series.map(row => `${row.label} ${fmt(row.values.find(p => p.month === month)?.value)}%`).join("；")}</title></rect>)}
    </svg></div> : <div className="empty-chart">暂无占比趋势</div>}
    {hover ? <p className="market-research-note">{hover} · {series.map(row => `${row.label} ${fmt(row.values.find(p => p.month === hover)?.value)}%`).join(" · ")}</p> : null}
  </div>;
}
