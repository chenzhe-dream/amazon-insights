"use client";

import { type TrafficDisplayItem, type ChildTrafficVariant, childTrafficSegmentMeta, sifAdChannelGlossary, childTrafficSegments } from "../../sif-listing-traffic-data";
import { type TrafficFieldState, trafficDetailMessage, formatTrafficScore, formatTrafficPercent } from "../../lib/traffic-detail-view";
import { useState } from "react";
import { amazonMediaSrc } from "../../lib/amazon-image";
import { SegmentStackBar } from "../../components/segment-stack-bar";

export function TrafficDistributionBars({ items, palette, maxItems, glossary, state }: {
  items: TrafficDisplayItem[];
  palette: string[];
  maxItems?: number;
  glossary?: Record<string, { en: string; meaning: string }>;
  state?: TrafficFieldState;
}) {
  const visible = maxItems ? items.slice(0, maxItems) : items;
  if (!visible.length) return <div className="traffic-dist-empty"><strong>—</strong><span>{trafficDetailMessage(state)}</span></div>;
  return (
    <div className="traffic-dist-bars">
      {visible.map((item, index) => {
        const tip = glossary?.[item.label];
        const title = tip
          ? `${item.label} · ${tip.en}\n${tip.meaning}\n${formatTrafficScore(item.score)} · ${formatTrafficPercent(item.ratio)}`
          : `${item.label} · ${formatTrafficScore(item.score)} · ${formatTrafficPercent(item.ratio)}`;
        return (
          <div key={item.label} title={title}>
            <span title={title}>{item.label}</span>
            <i><b style={{ width: `${Math.max(0, Math.min(100, item.ratio ?? 0))}%`, background: palette[index % palette.length] }} /></i>
            <strong>{formatTrafficScore(item.score)}</strong>
            <em>{formatTrafficPercent(item.ratio)}</em>
          </div>
        );
      })}
    </div>
  );
}

export function ChildTrafficStructurePanel({ variants, state }: { variants: ChildTrafficVariant[]; state?: TrafficFieldState }) {
  const previewCount = 3;
  const [expanded, setExpanded] = useState(false);
  const ranked = [...variants].sort((a, b) => b.totalScore - a.totalScore || b.sharePct - a.sharePct);
  if (!ranked.length) {
    return <div className="traffic-dist-empty"><strong>—</strong><span>{trafficDetailMessage(state)}</span></div>;
  }
  const visible = expanded ? ranked : ranked.slice(0, previewCount);
  const hiddenCount = Math.max(0, ranked.length - previewCount);
  const maxScore = Math.max(...ranked.map(child => child.totalScore), 1);
  return (
    <div className="child-traffic-structure">
      <div className="child-traffic-legend">
        {childTrafficSegmentMeta.map(item => {
          const tip = sifAdChannelGlossary[item.label];
          return (
            <span key={item.key} title={tip ? `${item.label} · ${tip.en}\n${tip.meaning}` : item.label}>
              <i style={{ background: item.color }} />{item.label}
            </span>
          );
        })}
      </div>
      <div className="child-traffic-rows">
        {visible.map((child, index) => {
          const segments = childTrafficSegments(child);
          return (
            <div className="child-traffic-row" key={child.asin}>
              <div className="child-traffic-meta">
                {child.image && <img src={amazonMediaSrc(child.image)} alt="" referrerPolicy="no-referrer" />}
                <div>
                  <b>#{index + 1} · {child.label}</b>
                  <small>{child.asin}</small>
                </div>
                <em title={formatTrafficPercent(child.sharePct)}>{formatTrafficPercent(child.sharePct)}</em>
              </div>
              <div className="child-traffic-bar-wrap" style={{ width: `${Math.max(18, (child.totalScore / maxScore) * 100)}%` }}>
                <SegmentStackBar segments={segments} hideSegmentTitle={false} />
                <strong title={formatTrafficScore(child.totalScore)}>{formatTrafficScore(child.totalScore)}</strong>
              </div>
            </div>
          );
        })}
      </div>
      {hiddenCount > 0 ? (
        <button type="button" className="variant-detail-toggle" onClick={() => setExpanded(value => !value)}>
          {expanded ? "收起子体" : `展开其余 ${hiddenCount} 个子体`}
        </button>
      ) : null}
    </div>
  );
}
