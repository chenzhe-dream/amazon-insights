"use client";
import React,{useId} from 'react';
import {MARKET_SYNTHESIS_DIMENSIONS,type MarketOverviewSynthesis} from '../server/domain/market-research/original-overview/sellersprite-market-overview-synthesis';
import type {MarketOverviewOriginalSynthesis} from '../shared/market-overview-original-synthesis';
// Original archive panel and radar. Business text and dimensions are passed through unchanged.
const SYNTHESIS_SCORE_LABELS = MARKET_SYNTHESIS_DIMENSIONS;

function MarketSynthesisRadarChart({
  scores,
}: {
  scores: MarketOverviewSynthesis["scores"];
}) {
  const items = SYNTHESIS_SCORE_LABELS.map(item => ({
    label: item.label,
    value: scores[item.key],
    max: item.max,
    ratio: item.max > 0 ? scores[item.key] / item.max : 0,
  }));
  const size = 340;
  const cx = size / 2;
  const cy = size / 2;
  const radius = 92;
  const labelRadius = radius + 42;
  const levels = 4;
  const startAngle = -Math.PI / 2;
  const identity = useId(); const gradientId = `${identity}-fill`;
  const glowId = `${identity}-glow`;

  function pointAt(index: number, ratio: number) {
    const angle = startAngle + (index * Math.PI * 2) / items.length;
    return {
      x: cx + Math.cos(angle) * radius * ratio,
      y: cy + Math.sin(angle) * radius * ratio,
      lx: cx + Math.cos(angle) * labelRadius,
      ly: cy + Math.sin(angle) * labelRadius,
      angle,
    };
  }

  function labelPlacement(angle: number) {
    const normalized = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    if (normalized < Math.PI * 0.22 || normalized > Math.PI * 1.78) {
      return { anchor: "middle" as const, dx: 0, dy: -10 };
    }
    if (normalized < Math.PI * 0.78) {
      return { anchor: "start" as const, dx: 8, dy: 2 };
    }
    if (normalized < Math.PI * 1.22) {
      return { anchor: "middle" as const, dx: 0, dy: 16 };
    }
    return { anchor: "end" as const, dx: -8, dy: 2 };
  }

  const gridLevels = Array.from({ length: levels }, (_, level) => {
    const ratio = (level + 1) / levels;
    return {
      ratio,
      points: items
        .map((_, index) => {
          const point = pointAt(index, ratio);
          return `${point.x},${point.y}`;
        })
        .join(" "),
    };
  });

  const dataPoints = items.map((item, index) => {
    const point = pointAt(index, item.ratio);
    return { ...point, ...item };
  });
  const dataPolygon = dataPoints.map(point => `${point.x},${point.y}`).join(" ");

  const axisLines = items.map((_, index) => {
    const outer = pointAt(index, 1);
    return { x1: cx, y1: cy, x2: outer.x, y2: outer.y };
  });

  const avgRatio = items.reduce((sum, item) => sum + item.ratio, 0) / Math.max(items.length, 1);

  return (
    <div className="ss-market-synthesis-radar-card">
      <div className="ss-market-synthesis-radar-head">
        <h5>六维机会雷达</h5>
        <span>分数越高越有利</span>
      </div>
      <div className="ss-market-synthesis-radar">
        <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label="市场机会六维雷达图">
          <defs>
            <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#a78bfa" stopOpacity="0.42" />
              <stop offset="100%" stopColor="#c4b5fd" stopOpacity="0.08" />
            </linearGradient>
            <filter id={glowId} x="-20%" y="-20%" width="140%" height="140%">
              <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="#7c3aed" floodOpacity="0.18" />
            </filter>
          </defs>
          <circle cx={cx} cy={cy} r={radius + 6} fill="#fafbfc" stroke="#eef2f6" strokeWidth="1" />
          {gridLevels.map(level => (
            <polygon
              key={level.ratio}
              points={level.points}
              fill={level.ratio === 1 ? "#fff" : "none"}
              stroke="#e8edf2"
              strokeWidth={level.ratio === 1 ? 1.4 : 1}
              strokeDasharray={level.ratio === 1 ? undefined : "4 4"}
            />
          ))}
          {axisLines.map(line => (
            <line key={`${line.x2}-${line.y2}`} {...line} stroke="#e8edf2" strokeWidth={1} />
          ))}
          {[0.25, 0.5, 0.75, 1].map(level => {
            const tick = pointAt(0, level);
            return (
              <text
                key={level}
                x={tick.x - 10}
                y={tick.y + 4}
                className="ss-market-synthesis-radar-tick"
              >
                {Math.round(level * 100)}
              </text>
            );
          })}
          <polygon
            points={dataPolygon}
            fill={`url(#${gradientId})`}
            stroke="#7c3aed"
            strokeWidth={2.2}
            strokeLinejoin="round"
            filter={`url(#${glowId})`}
          />
          {dataPoints.map(point => {
            const placement = labelPlacement(point.angle);
            const labelX = point.lx + placement.dx;
            const labelY = point.ly + placement.dy;
            const labelWidth = point.label.length * 12 + 16;
            const valueText = `${point.value}/${point.max}`;
            const valueWidth = valueText.length * 6.5 + 12;
            const boxWidth = Math.max(labelWidth, valueWidth);
            const boxHeight = 34;
            const boxX =
              placement.anchor === "start"
                ? labelX - 4
                : placement.anchor === "end"
                  ? labelX - boxWidth + 4
                  : labelX - boxWidth / 2;
            const boxY = labelY - 12;
            return (
              <g key={point.label}>
                <circle cx={point.x} cy={point.y} r={5} fill="#fff" stroke="#7c3aed" strokeWidth={2.2} />
                <circle cx={point.x} cy={point.y} r={2.2} fill="#7c3aed" />
                <rect
                  x={boxX}
                  y={boxY}
                  width={boxWidth}
                  height={boxHeight}
                  rx={6}
                  className="ss-market-synthesis-radar-label-box"
                />
                <text
                  x={labelX}
                  y={labelY}
                  textAnchor={placement.anchor}
                  className="ss-market-synthesis-radar-label"
                >
                  {point.label}
                </text>
                <text
                  x={labelX}
                  y={labelY + 14}
                  textAnchor={placement.anchor}
                  className="ss-market-synthesis-radar-value"
                >
                  {valueText}
                </text>
              </g>
            );
          })}
          <g className="ss-market-synthesis-radar-center">
            <circle cx={cx} cy={cy} r={28} fill="#fff" stroke="#ddd6fe" strokeWidth="1.2" />
            <text x={cx} y={cy - 2} textAnchor="middle" className="ss-market-synthesis-radar-center-label">
              综合
            </text>
            <text x={cx} y={cy + 14} textAnchor="middle" className="ss-market-synthesis-radar-center-value">
              {Math.round(avgRatio * 100)}%
            </text>
          </g>
        </svg>
      </div>
      <ul className="ss-market-synthesis-radar-legend">
        {items.map(item => (
          <li key={item.label}>
            <span>{item.label}</span>
            <div className="ss-market-synthesis-radar-legend-track">
              <i style={{ width: `${Math.round(item.ratio * 100)}%` }} />
            </div>
            <em>
              {item.value}/{item.max}
            </em>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MarketOverviewSynthesisPanel({ synthesis }: { synthesis: MarketOverviewSynthesis }) {
  return (
    <div className="ss-market-synthesis">
      <div className="ss-market-synthesis-head">
        <div className="ss-market-synthesis-score">
          <span>市场机会指数</span>
          <strong>
            {synthesis.score}
            <em>/100</em>
          </strong>
          <b>{synthesis.gradeLabel}</b>
          <small>{synthesis.grade}</small>
          <p className="ss-market-synthesis-grade-def">{synthesis.gradeDefinition}</p>
        </div>
        <MarketSynthesisRadarChart scores={synthesis.scores} />
      </div>
      {synthesis.crossSignals.length ? (
        <p className="ss-market-synthesis-cross">{synthesis.crossSignals.join(" · ")}</p>
      ) : null}
      <p className="ss-market-synthesis-radar-hint">
        雷达六维与下方分析段落一一对应；分数越高表示该维度对进入者越有利（「新品进入难度」分数高 = 壁垒更低）。
      </p>
      <ol className="ss-market-synthesis-sections">
        {MARKET_SYNTHESIS_DIMENSIONS.map((dim, index) => (
          <li key={dim.key}>
            <b>
              {index + 1}. {dim.label}
              <em>
                {" "}
                {synthesis.scores[dim.key]}/{dim.max}
              </em>
            </b>
            <p>{synthesis.sections[dim.sectionKey]}</p>
          </li>
        ))}
      </ol>
      <div className="ss-market-synthesis-lists">
        <div>
          <h5>最大机会</h5>
          <ul>
            {synthesis.topOpportunities.map(item => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        <div>
          <h5>最大风险</h5>
          <ul>
            {synthesis.topRisks.map(item => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </div>
      <p className="ss-market-synthesis-verdict">{synthesis.finalVerdict}</p>
    </div>
  );
}

export function MarketOverviewOriginalSummary({result}:{result:MarketOverviewOriginalSynthesis}){
 return <section aria-label="原版市场概览总结">
  <p className="market-research-note">原版规则总结 · 六维评分。根据本报告已保存的来源计算；缺失输入沿用原版默认规则，分数不表示数据完整或成功概率。</p>
  {result.inputGaps.length>0&&<details className="market-research-boundaries"><summary>本次总结有 {result.inputGaps.length} 项输入缺口</summary><ul>{result.inputGaps.map(gap=><li key={gap}>{gap}</li>)}</ul></details>}
  <MarketOverviewSynthesisPanel synthesis={result.summary}/>
  <details className="market-research-boundaries"><summary>原版规则与来源说明</summary><ul>{result.originalAssumptions.map(item=><li key={item}>{item}</li>)}</ul><p>原版规则版本 {result.version}；绑定来源 {result.sourceRefs.length} 份。</p></details>
 </section>;
}
