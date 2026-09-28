"use client";

import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties} from 'react';
import {createPortal} from 'react-dom';
import type {SorftimeCategoryDashboardProduct, SorftimeProductMonthlyTrend} from './types';

type Point = {month: string; volume: number | null; amount: number | null; aov: number | null};
const volumeColor = '#2f80ed', amountColor = '#7a67d8', aovColor = '#16a085';
const valid = (value: number | null | undefined) => value != null && Number.isFinite(value) ? value : null;
const number = (value: number | null, digits = 0) => value == null ? '未知' : value.toLocaleString('zh-CN', {minimumFractionDigits: digits, maximumFractionDigits: digits});

export function productTrendPoints(trend: SorftimeProductMonthlyTrend): Point[] {
  const volumes = new Map(trend.volume.map(point => [point.month, valid(point.value)]));
  const amounts = new Map(trend.amount.map(point => [point.month, valid(point.value)]));
  return [...new Set([...volumes.keys(), ...amounts.keys()])].sort().map(month => {
    const volume = volumes.get(month) ?? null, amount = amounts.get(month) ?? null;
    return {month, volume, amount, aov: volume != null && volume > 0 && amount != null ? amount / volume : null};
  });
}

function lineSegments(points: Point[], key: 'amount' | 'aov', x: (index: number) => number, y: (value: number) => number) {
  const segments: string[] = []; let segment: string[] = [];
  points.forEach((point, index) => {
    const value = point[key];
    const previous = points[index-1];
    const consecutive = !previous || monthNumber(point.month) - monthNumber(previous.month) === 1;
    if (value == null || !consecutive) {if (segment.length) segments.push(segment.join(' ')); segment = [];}
    if (value != null) segment.push(`${x(index)},${y(value)}`);
  });
  if (segment.length) segments.push(segment.join(' '));
  return segments;
}

function monthNumber(month: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  return match ? Number(match[1]) * 12 + Number(match[2]) : NaN;
}

/** Compact original-style preview; the dialog retains the complete history. */
function MiniChart({points}: {points: Point[]}) {
  const recent = points.slice(-14);
  const max = (key: 'volume' | 'amount' | 'aov') => Math.max(1, ...recent.map(point => point[key] ?? 0));
  const x = (index: number) => recent.length === 1 ? 54 : 5 + index * 98 / (recent.length - 1);
  const y = (value: number, key: 'volume' | 'amount' | 'aov') => 31 - Math.max(0, value) / max(key) * 27;
  return <svg className="shape-ref-trend-mini" viewBox="0 0 108 34" role="img" aria-label={recent.length === 1 ? '单月数据，暂无法判断趋势' : '最近月度销量、销售额与客单价'}>
    {recent.map((point, index) => <g key={point.month} data-mini-month={point.month}>
      <title>{`${point.month}：销量 ${number(point.volume)}；销售额 ${number(point.amount,2)}；客单价 ${number(point.aov,2)}`}</title>
      {point.volume != null && <rect x={x(index)-2} y={Math.min(30,y(point.volume,'volume'))} width="4" height={Math.max(1,31-y(point.volume,'volume'))} fill={volumeColor}/>}
    </g>)}
    {(['amount','aov'] as const).map(key => <g key={key}>
      {lineSegments(recent,key,x,value=>y(value,key)).map((segment,index)=><polyline key={index} points={segment} fill="none" stroke={key==='amount'?amountColor:aovColor} strokeWidth="1.3" strokeDasharray={key==='aov'?'3 2':undefined}/>)}
      {recent.map((point,index)=>point[key]==null?null:<circle key={point.month} cx={x(index)} cy={y(point[key],key)} r="1.3" fill={key==='amount'?amountColor:aovColor}/>)}
    </g>)}
  </svg>;
}

function DetailChart({points, currency}: {points: Point[]; currency: string}) {
  const [active, setActive] = useState<number | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const width = 520, height = 230, left = 48, right = 90, top = 20, bottom = 40;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const maxVolume = Math.max(1, ...points.map(point => point.volume ?? 0));
  const maxAmount = Math.max(1, ...points.map(point => point.amount ?? 0));
  const aovValues = points.flatMap(point => point.aov == null ? [] : [point.aov]);
  const minAov = Math.min(0, ...aovValues), maxAov = Math.max(1, ...aovValues);
  const x = (index: number) => left + index * plotWidth / Math.max(points.length - 1, 1);
  const yVolume = (value: number) => top + plotHeight * (1 - Math.max(0, value) / maxVolume);
  const yAmount = (value: number) => top + plotHeight * (1 - Math.max(0, value) / maxAmount);
  const yAov = (value: number) => top + plotHeight * (1 - (value - minAov) / Math.max(0.01, maxAov - minAov));
  const barWidth = Math.min(12, plotWidth / points.length * .5);
  const selected = active == null ? null : points[active];
  const monthStep = Math.max(1, Math.ceil(points.length / 8));
  const shownMonths = points.filter((_, index) => index % monthStep === 0 || index === points.length-1);
  return <>
    <div className="shape-ref-trend-legend"><span><i style={{background: volumeColor}}/>月销量</span><span><i style={{background: amountColor}}/>月销售额</span><span><i style={{background: aovColor}}/>客单价</span></div>
    <div className="shape-ref-trend-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="月度销量、销售额与客单价趋势" onMouseLeave={() => {if (!inspecting) setActive(null);}}>
        {[0, .25, .5, .75, 1].map(ratio => <g key={ratio}><line x1={left} x2={width-right} y1={top+plotHeight*(1-ratio)} y2={top+plotHeight*(1-ratio)} stroke="#e7edf5"/><text x={left-6} y={top+plotHeight*(1-ratio)+3} textAnchor="end" className="shape-ref-trend-axis">{Math.round(maxVolume*ratio).toLocaleString()}</text><text x={width-right+6} y={top+plotHeight*(1-ratio)+3} className="shape-ref-trend-axis">{Math.round(maxAmount*ratio).toLocaleString()}</text></g>)}
        {aovValues.length > 0 && [0,.5,1].map(ratio => <text key={`aov-tick-${ratio}`} x={width-3} y={top+plotHeight*(1-ratio)+3} textAnchor="end" className="shape-ref-trend-axis shape-ref-trend-aov-axis">{currency}{number(minAov+(maxAov-minAov)*ratio,0)}</text>)}
        {points.map((point, index) => point.volume == null ? null : <rect key={`volume-${point.month}`} data-trend-month={point.month} data-trend-series="volume" x={x(index)-barWidth/2} y={yVolume(point.volume)} width={barWidth} height={Math.max(1, height-bottom-yVolume(point.volume))} fill={volumeColor} opacity=".72" rx="1"/>)}
        {lineSegments(points, 'amount', x, yAmount).map((segment, index) => <polyline key={`amount-line-${index}`} points={segment} fill="none" stroke={amountColor} strokeWidth="2"/>)}
        {points.map((point, index) => point.amount == null ? null : <circle key={`amount-${point.month}`} data-trend-month={point.month} data-trend-series="amount" cx={x(index)} cy={yAmount(point.amount)} r="3" fill="#fff" stroke={amountColor} strokeWidth="2"/>)}
        {lineSegments(points, 'aov', x, yAov).map((segment, index) => <polyline key={`aov-line-${index}`} points={segment} fill="none" stroke={aovColor} strokeWidth="2" strokeDasharray="5 4"/>)}
        {points.map((point, index) => point.aov == null ? null : <circle key={`aov-${point.month}`} data-trend-month={point.month} data-trend-series="aov" cx={x(index)} cy={yAov(point.aov)} r="3" fill="#fff" stroke={aovColor} strokeWidth="2"/>)}
        {active != null && <line x1={x(active)} x2={x(active)} y1={top} y2={height-bottom} stroke="#aab8c8" strokeDasharray="4 4"/>}
        {points.map((point, index) => <g key={`hit-${point.month}`} data-trend-month={point.month} role="button" tabIndex={0} aria-label={`${point.month} 月度数据`} onMouseEnter={() => {setInspecting(false); setActive(index);}} onMouseMove={() => {setInspecting(false); setActive(index);}} onPointerDown={() => {setActive(index); setInspecting(true);}} onClick={() => {setActive(index); setInspecting(true);}} onFocus={() => {setActive(index); setInspecting(true);}} onKeyDown={event => {if (event.key === 'Enter' || event.key === ' ') {event.preventDefault(); setActive(index); setInspecting(true);}}}><rect x={x(index) - plotWidth/Math.max(points.length-1,1)/2} y={0} width={plotWidth/Math.max(points.length-1,1)} height={height-bottom} fill="transparent"/>{(index % monthStep === 0 || index === points.length-1) && <text x={x(index)} y={height-10} textAnchor="middle" className="shape-ref-trend-axis">{point.month.slice(5)}</text>}</g>)}
      </svg>
      {selected && <div className="shape-ref-trend-tooltip" style={{left: `${Math.min(76, Math.max(24, x(active!)/width*100))}%`}}><b>{selected.month}</b><div>月销量 <strong>{number(selected.volume)}</strong></div><div>月销售额 <strong>{selected.amount == null ? '未知' : `${currency}${number(selected.amount,2)}`}</strong></div><div>客单价 <strong>{selected.aov == null ? '未知' : `${currency}${number(selected.aov,2)}`}</strong></div></div>}
    </div>
    <div className="shape-ref-trend-month-axis" style={{gridTemplateColumns: `repeat(${shownMonths.length}, minmax(0, 1fr))`}}>{shownMonths.map(point => <span key={point.month}>{points.length > 12 ? point.month.slice(2) : point.month}</span>)}</div>
  </>;
}

export function ProductTrend({product, currency = '$'}: {product: SorftimeCategoryDashboardProduct; currency?: string}) {
  const points = useMemo(() => productTrendPoints(product.monthlyTrend), [product.monthlyTrend]);
  const anchor = useRef<HTMLButtonElement>(null), closeTimer = useRef<number | null>(null);
  const dialogClose = useRef<HTMLButtonElement>(null), focusDialog = useRef(false), suppressFocusOpen = useRef(false);
  const [open, setOpen] = useState(false), [pinned, setPinned] = useState(false), [style, setStyle] = useState<CSSProperties>({});
  const cancelClose = useCallback(() => {if (closeTimer.current != null) {window.clearTimeout(closeTimer.current); closeTimer.current = null;}}, []);
  const close = useCallback((restoreFocus = false) => {cancelClose(); setOpen(false); setPinned(false); if (restoreFocus) {suppressFocusOpen.current = true; anchor.current?.focus(); window.setTimeout(() => {suppressFocusOpen.current = false;}, 0);}}, [cancelClose]);
  const show = useCallback(() => {cancelClose(); setOpen(true);}, [cancelClose]);
  const scheduleClose = useCallback(() => {cancelClose(); if (!pinned) closeTimer.current = window.setTimeout(() => setOpen(false), 180);}, [cancelClose, pinned]);
  const position = useCallback(() => {
    if (!anchor.current) return;
    const rect = anchor.current.getBoundingClientRect(), panelWidth = Math.min(520, window.innerWidth-24), panelHeight = Math.min(370, window.innerHeight-24);
    const left = Math.min(Math.max(12, rect.left+rect.width/2-panelWidth/2), Math.max(12, window.innerWidth-panelWidth-12));
    const top = rect.bottom+8+panelHeight <= window.innerHeight-12 ? rect.bottom+8 : Math.max(12, rect.top-panelHeight-8);
    setStyle({position: 'fixed', left, top, width: panelWidth, maxHeight: `calc(100vh - 24px)`, zIndex: 1200});
  }, []);
  useLayoutEffect(() => {if (!open) return; position(); window.addEventListener('resize', position); window.addEventListener('scroll', position, true); return () => {window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true);};}, [open, position]);
  useEffect(() => {if (open && focusDialog.current) {focusDialog.current = false; dialogClose.current?.focus();}}, [open, pinned]);
  useEffect(() => {if (!open) return; const onKey = (event: KeyboardEvent) => {if (event.key === 'Escape') close(true);}; const onPointer = (event: PointerEvent) => {if (!anchor.current?.contains(event.target as Node) && !(event.target as Element).closest?.('.shape-ref-trend-popover')) close();}; document.addEventListener('keydown', onKey); document.addEventListener('pointerdown', onPointer); return () => {document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onPointer);};}, [open, close]);
  useEffect(() => () => cancelClose(), [cancelClose]);
  if (!points.length) return <span className="shape-ref-trend" title="暂无月度数据">未知</span>;
  if (points.every(point=>point.volume==null&&point.amount==null)) return <span className="shape-ref-trend" title="月度销量与销售额均缺失">未知</span>;
  return <>
    <button ref={anchor} type="button" className="shape-ref-trend shape-ref-trend-trigger" aria-label={`${product.asin} 月度销量与销售额趋势`} aria-haspopup="dialog" aria-expanded={open} onMouseEnter={show} onMouseLeave={scheduleClose} onFocus={() => {if (!suppressFocusOpen.current) show();}} onBlur={scheduleClose} onKeyDown={event => {if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {event.preventDefault(); cancelClose(); focusDialog.current = true; setOpen(true); setPinned(true); if (open && pinned) {focusDialog.current = false; dialogClose.current?.focus();}}}} onClick={event => {cancelClose(); if (event.detail === 0) {focusDialog.current = true; setOpen(true); setPinned(true); if (open && pinned) {focusDialog.current = false; dialogClose.current?.focus();}} else if (open && pinned) close(); else {setOpen(true); setPinned(true);}}}>
      <MiniChart points={points}/>
    </button>
    {open && typeof document !== 'undefined' && createPortal(<div role="dialog" aria-label="月度趋势" className="shape-ref-trend-popover" style={style} onMouseEnter={show} onMouseLeave={scheduleClose} onFocusCapture={show} onBlurCapture={scheduleClose}><div className="shape-ref-trend-popover-head"><b>月度趋势</b><button ref={dialogClose} type="button" aria-label="关闭月度趋势" onClick={() => close(true)}>×</button></div><DetailChart points={points} currency={currency}/>{points.length===1&&<p>仅1个月数据，暂无法判断趋势</p>}<p>报表月度数据 · 客单价 = 月销售额 / 月销量</p></div>, document.body)}
  </>;
}
