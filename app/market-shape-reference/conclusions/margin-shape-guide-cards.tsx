"use client";

import {
  SORFTIME_MARGIN_ENTRY_RULES,
  type MarginEntryLabel,
  type ShapeMarginEntryBandGuide,
  type ShapeMarginEntryGuide,
} from "./sorftime-category-dashboard";

export type MarginShapeGuideTierMode = "full" | "merged";

const MERGED_MARGIN_ENTRY_TIER_GROUPS: Array<{
  label: string;
  tone: string;
  sourceLabels: MarginEntryLabel[];
}> = [
  { label: "优先/建议进入", tone: "green", sourceLabels: ["优先进入", "建议进入"] },
  { label: "谨慎/不建议进入", tone: "yellow", sourceLabels: ["谨慎进入", "不建议进入"] },
];

function sortBandsByShapeShare(bands: ShapeMarginEntryBandGuide[]) {
  return [...bands].sort(
    (left, right) => (right.last6MonthsSalesSharePct ?? 0) - (left.last6MonthsSalesSharePct ?? 0),
  );
}

function MarginBandChip({ band }: { band: ShapeMarginEntryBandGuide }) {
  return (
    <span className="market-structure-margin-band-chip">
      <strong>{band.priceBand}</strong>
      <span>
        {band.linkCount} 链接
        {band.last6MonthsSalesSharePct != null ? ` · 形态内销量占比 ${band.last6MonthsSalesSharePct.toFixed(1)}%` : ""}
        {band.avgMarginPct != null ? ` · 均毛利 ${band.avgMarginPct.toFixed(1)}%` : ""}
      </span>
    </span>
  );
}

function MarginBandTierRow({
  label,
  tone,
  bands,
}: {
  label: string;
  tone: string;
  bands: ShapeMarginEntryBandGuide[];
}) {
  const sorted = sortBandsByShapeShare(bands);

  return (
    <div className="market-structure-margin-tier-row">
      <span
        className={`top-sales-margin-entry-note-tag top-sales-margin-entry-note-tag-${tone} market-structure-margin-tier-label`}
      >
        {label}
      </span>
      <div className="market-structure-margin-band-list">
        {sorted.length ? (
          sorted.map(band => <MarginBandChip key={`${label}-${band.priceBand}`} band={band} />)
        ) : (
          <span className="market-structure-margin-band-empty">暂无价格带</span>
        )}
      </div>
    </div>
  );
}

function mergeTierBands(shape: ShapeMarginEntryGuide, sourceLabels: MarginEntryLabel[]) {
  const bands: ShapeMarginEntryBandGuide[] = [];
  for (const label of sourceLabels) {
    bands.push(...shape.tiers[label]);
  }
  return bands;
}

function MarginShapeGuideCard({
  shape,
  tierMode = "full",
}: {
  shape: ShapeMarginEntryGuide;
  tierMode?: MarginShapeGuideTierMode;
}) {
  const tierRows =
    tierMode === "merged"
      ? MERGED_MARGIN_ENTRY_TIER_GROUPS.map(group => ({
          key: group.label,
          label: group.label,
          tone: group.tone,
          bands: mergeTierBands(shape, group.sourceLabels),
        }))
      : SORFTIME_MARGIN_ENTRY_RULES.map(rule => ({
          key: rule.label,
          label: rule.label,
          tone: rule.tone,
          bands: shape.tiers[rule.label],
        }));

  return (
    <article className="market-structure-margin-shape-card">
      <header className="market-structure-margin-shape-head">
        <strong>{shape.productShape}</strong>
        <span>
          {shape.linkCount} 链接 · 近6个月销量占 TOP {shape.last6MonthsSalesSharePct?.toFixed(2) ?? "—"}%
        </span>
      </header>
      <div
        className={`market-structure-margin-shape-tiers${tierMode === "merged" ? " market-structure-margin-shape-tiers-merged" : ""}`}
      >
        {tierRows.map(row => (
          <MarginBandTierRow key={row.key} label={row.label} tone={row.tone} bands={row.bands} />
        ))}
      </div>
    </article>
  );
}

export function MarginShapeGuideCardList({
  shapeGuides,
  tierMode = "full",
}: {
  shapeGuides: ShapeMarginEntryGuide[];
  tierMode?: MarginShapeGuideTierMode;
}) {
  if (!shapeGuides.length) return null;

  return (
    <div className="market-structure-margin-shape-list">
      {shapeGuides.map(shape => (
        <MarginShapeGuideCard key={shape.productShape} shape={shape} tierMode={tierMode} />
      ))}
    </div>
  );
}

export const MARGIN_SHAPE_GUIDE_FOOTNOTE =
  "占比口径：近6个月销量（件数），非销售额；形态内销量占比 = 该形态某价格带销量 ÷ 该形态总销量。价格带按「形态 × 价格带」内链接的市场准入标签多数归类；进入立项阶段后，应结合实际采购、头程、广告与退货成本重新核算全成本毛利率，不可仅依据 Sorftime 初筛标签定案。";
