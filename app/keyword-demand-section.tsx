"use client";

import { useMemo, useRef, useState, useEffect } from "react";
import { createPortal } from "react-dom";
import {
  buildKeywordDemandAnalysis,
  buildKeywordComparisonMatrix,
  type CategoryBucket,
  type KeywordDemandProduct,
} from "./keyword-demand-analysis";
import type { KeywordSearchTrendPoint } from "./sif-keyword-enrichment-data";
import {
  categoryColorMap,
  keywordMeaningTaxonomy,
  type KeywordCategory,
} from "./keyword-classifier";
import { LaunchSection, LaunchTable } from "./launch-section";
import { sifKeywordAnalysisMeta } from "./sif-keyword-analysis-data";
import { SegmentStackBar, segmentStackColors } from "./segment-stack-bar";
import { buildKeywordLaunchConclusions, type KeywordLaunchConclusions } from "./keyword-demand-conclusions";
import { sifKeywordFieldTitle } from "./sif-keyword-field-glossary";
import { amazonMediaSrc } from "./lib/amazon-image";

function SourceBadge({ children }: { children: React.ReactNode }) {
  return <span className="source-badge">{children}</span>;
}

function formatPct(value: number | null | undefined, digits = 1) {
  if (value == null || Number.isNaN(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

function formatNum(value: number | null | undefined) {
  if (value == null) return "—";
  return value.toLocaleString();
}

function formatMoney(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return "—";
  return `$${value.toFixed(2)}`;
}

function formatAbaRank(value: number | null | undefined) {
  if (value == null || value <= 0) return "—";
  return value.toLocaleString();
}

function formatSearchVolumeMonth(value: string | null | undefined) {
  if (!value) return null;
  const match = value.match(/^(\d{4})-(\d{2})$/);
  if (!match) return value;
  return `${match[1]}-${match[2]}`;
}

function SearchVolumeCell({ volume, month }: { volume: number | null; month: string | null }) {
  if (volume == null) return <span className="kw-share-empty">—</span>;
  return (
    <div className="kw-volume-cell">
      <span>{formatNum(volume)}</span>
      {month ? <small>{formatSearchVolumeMonth(month)}</small> : null}
    </div>
  );
}

function KeywordSearchTrendSparkline({ trend }: { trend: KeywordSearchTrendPoint[] }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [tooltipStyle, setTooltipStyle] = useState<React.CSSProperties>({});
  const [mounted, setMounted] = useState(false);
  const cellRef = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);

  if (!trend.length) return <span className="kw-trend-empty">—</span>;

  const width = 84;
  const height = 30;
  const pad = 2;
  const volumes = trend.map(point => point.volume);
  const ranks = trend.map(point => (point.abaRank > 0 ? point.abaRank : null)).filter((value): value is number => value != null);
  const volMin = Math.min(...volumes);
  const volMax = Math.max(...volumes);
  const rankMin = ranks.length ? Math.min(...ranks) : 1;
  const rankMax = ranks.length ? Math.max(...ranks) : 1;
  const step = trend.length > 1 ? (width - pad * 2) / (trend.length - 1) : 0;

  const points = trend.map((point, index) => {
    const x = pad + index * step;
    const volumeY = pad + (1 - (point.volume - volMin) / (volMax - volMin || 1)) * (height - pad * 2);
    const rankY =
      point.abaRank > 0
        ? pad + ((point.abaRank - rankMin) / (rankMax - rankMin || 1)) * (height - pad * 2)
        : null;
    return { x, volumeY, rankY, point };
  });

  const volumePoints = points.map(item => `${item.x},${item.volumeY}`).join(" ");
  const rankPoints = points
    .filter(item => item.rankY != null)
    .map(item => `${item.x},${item.rankY}`)
    .join(" ");

  const active = hoverIndex != null ? points[hoverIndex] : null;

  const resolveHoverIndex = (clientX: number) => {
    const cell = cellRef.current;
    if (!cell) return null;
    const rect = cell.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const relativeX = clientX - rect.left;
    const svgX = (relativeX / rect.width) * width;
    if (trend.length === 1) return 0;
    const raw = Math.round((svgX - pad) / step);
    return Math.min(trend.length - 1, Math.max(0, raw));
  };

  const showTooltip = (index: number, clientX?: number) => {
    setHoverIndex(index);
    const cell = cellRef.current;
    if (!cell) return;
    const rect = cell.getBoundingClientRect();
    const anchorX =
      clientX != null
        ? Math.min(window.innerWidth - 12, Math.max(12, clientX))
        : Math.min(window.innerWidth - 12, Math.max(12, rect.left + (points[index]?.x ?? rect.width / 2) * (rect.width / width)));
    const tooltipHeight = 76;
    const belowTop = rect.bottom + 8;
    const aboveTop = rect.top - 8;
    const placeBelow = belowTop + tooltipHeight <= window.innerHeight - 8;
    setTooltipStyle({
      position: "fixed",
      left: anchorX,
      top: placeBelow ? belowTop : aboveTop,
      transform: placeBelow ? "translate(-50%, 0)" : "translate(-50%, -100%)",
      zIndex: 10000,
    });
  };

  const hideTooltip = () => {
    setHoverIndex(null);
    setTooltipStyle({});
  };

  const handleMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    const index = resolveHoverIndex(event.clientX);
    if (index == null) return;
    showTooltip(index, event.clientX);
  };

  return (
    <>
      <div
        ref={cellRef}
        className="kw-trend-cell kw-trend-cell-interactive"
        onMouseMove={handleMouseMove}
        onMouseLeave={hideTooltip}
      >
        <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label="月搜索趋势">
          {rankPoints ? (
            <polyline points={rankPoints} fill="none" stroke="#f0923e" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          ) : null}
          <polyline points={volumePoints} fill="none" stroke="#19b66a" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          {active ? (
            <>
              <line x1={active.x} x2={active.x} y1={pad} y2={height - pad} stroke="#b8c4d4" strokeWidth="1" strokeDasharray="2 2" />
              <circle cx={active.x} cy={active.volumeY} r="2.4" fill="#19b66a" stroke="#fff" strokeWidth="1" />
              {active.rankY != null ? (
                <circle cx={active.x} cy={active.rankY} r="2.2" fill="#f0923e" stroke="#fff" strokeWidth="1" />
              ) : null}
            </>
          ) : null}
        </svg>
      </div>
      {mounted && active
        ? createPortal(
            <div className="kw-trend-tooltip kw-trend-tooltip-portal" style={tooltipStyle}>
              <b>{active.point.month}</b>
              <span>搜索量 {formatNum(active.point.volume)}</span>
              <span>ABA #{active.point.abaRank > 0 ? formatAbaRank(active.point.abaRank) : "—"}</span>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function SuggestedBidCell({ low, median, high }: { low: number | null; median: number | null; high: number | null }) {
  if (median == null && low == null && high == null) return <span className="kw-share-empty">—</span>;
  return (
    <div className="kw-bid-cell">
      <span>{formatMoney(low)}</span>
      <span className="kw-bid-median">{formatMoney(median)}</span>
      <span>{formatMoney(high)}</span>
    </div>
  );
}

function Top3ConcentrationCell({ clickShare, conversionShare }: { clickShare: number | null; conversionShare: number | null }) {
  if (clickShare == null && conversionShare == null) return <span className="kw-share-empty">—</span>;
  return (
    <div className="kw-top3-cell" title={sifKeywordFieldTitle("top3Concentration")}>
      <span title="ABA 点击共享前三名合计占比">点击 {formatPct(clickShare, 0)}</span>
      <span title="ABA 转化共享前三名合计占比">转化 {formatPct(conversionShare, 0)}</span>
    </div>
  );
}

function KeywordLaunchConclusionsBlock({ conclusions }: { conclusions: KeywordLaunchConclusions }) {
  if (!conclusions.hasData) {
    return (
      <LaunchSection title="开品结论" description="按关键词需求分析框架输出立项判断（需 SIF 数据就绪）">
        <div className="pending-box">{conclusions.dataGaps[0] ?? "等待关键词数据"}</div>
      </LaunchSection>
    );
  }

  const gradeClass =
    conclusions.verdict.grade === "A"
      ? "launch-verdict approve"
      : conclusions.verdict.grade === "B"
        ? "launch-verdict conditional"
        : conclusions.verdict.grade === "D"
          ? "launch-verdict hold"
          : "launch-verdict conditional";

  return (
    <>
      <section className={`card launch-block launch-verdict-block kw-launch-verdict ${gradeClass}`}>
        <div className="launch-section-head">
          <div className="launch-section-head-main">
            <span className="status-chip">开品结论 · 结论先行</span>
            <h3>{conclusions.headline}</h3>
            <p>{conclusions.verdict.matrixLabel}</p>
          </div>
          <span className={`kw-grade-badge grade-${conclusions.verdict.grade.toLowerCase()}`}>{conclusions.verdict.gradeLabel}</span>
        </div>
        <div className="launch-section-body">
          <p className="kw-product-proposal">{conclusions.verdict.productProposal}</p>
          {conclusions.dataGaps.length ? (
            <ul className="launch-reason-list kw-data-gaps">
              {conclusions.dataGaps.map(gap => (
                <li key={gap}>数据缺口：{gap}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </section>

      {conclusions.sections.map(section => (
        <LaunchSection key={section.id} title={section.title} description="">
          <LaunchTable className="launch-conclusion-table kw-launch-section-table">
            <tbody>
              {section.items.map(item => (
                <tr key={item.label}>
                  <th>{item.label}</th>
                  <td>{item.value}</td>
                </tr>
              ))}
            </tbody>
          </LaunchTable>
        </LaunchSection>
      ))}

      {conclusions.functionMatrix.length ? (
        <LaunchSection title="功能需求分层" description="基础必备 / 高关注 / 差异化 / 伪需求 · 指导 BOM 与 Listing 优先级">
          <LaunchTable className="kw-function-matrix-table">
            <thead>
              <tr>
                <th>关键词</th>
                <th>类型</th>
                <th>月搜索量</th>
                <th>竞品覆盖</th>
                <th>开发动作</th>
              </tr>
            </thead>
            <tbody>
              {conclusions.functionMatrix.map(row => (
                <tr key={row.keyword}>
                  <th>{row.keyword}</th>
                  <td>
                    <span className={`kw-fn-tier tier-${row.type === "基础必备" ? "p0" : row.type === "高关注" ? "p1" : row.type === "差异化" ? "diff" : "skip"}`}>
                      {row.type}
                    </span>
                  </td>
                  <td>{formatNum(row.volume)}</td>
                  <td>{row.coverage} 个</td>
                  <td className="launch-muted">{row.action}</td>
                </tr>
              ))}
            </tbody>
          </LaunchTable>
        </LaunchSection>
      ) : null}

      {conclusions.keywordCombos.length ? (
        <LaunchSection title="高频需求组合词" description="产品词 + 功能/人群/年龄/场景组合 · 仅展示月搜索量 > 10,000">
          <LaunchTable>
            <thead>
              <tr>
                <th>组合词</th>
                <th>需求元素</th>
                <th>月搜索量</th>
              </tr>
            </thead>
            <tbody>
              {conclusions.keywordCombos.map(row => (
                <tr key={row.keyword}>
                  <th>{row.keyword}</th>
                  <td>{row.elements}</td>
                  <td>{formatNum(row.volume)}</td>
                </tr>
              ))}
            </tbody>
          </LaunchTable>
        </LaunchSection>
      ) : null}
    </>
  );
}

function TaxonomyReferenceTable() {
  return (
    <LaunchTable className="kw-taxonomy-table">
      <thead>
        <tr>
          <th>关键词类型</th>
          <th>说明</th>
          <th>示例</th>
        </tr>
      </thead>
      <tbody>
        {keywordMeaningTaxonomy.map(item => (
          <tr key={item.id}>
            <th>
              <span className="kw-tag" style={{ background: item.color }}>
                {item.label}
              </span>
            </th>
            <td>{item.description}</td>
            <td className="launch-muted">{item.examples.join("、")}</td>
          </tr>
        ))}
      </tbody>
    </LaunchTable>
  );
}

function TopCategoryStrip({ categories }: { categories: CategoryBucket[] }) {
  const top = categories.filter(item => item.keywordCount > 0);
  return (
    <div className="kw-category-strip kw-top-strip">
      {top.map(item => (
        <article key={item.id} className="kw-category-card" style={{ borderTopColor: item.color }}>
          <span className="kw-category-label">{item.shortLabel}</span>
          <strong>{item.keywordCount}</strong>
          <small>{item.label}</small>
          <em>{formatPct(item.sharePct, 0)} 流量</em>
        </article>
      ))}
    </div>
  );
}

function GroupSummaryRow({ groups }: { groups: ReturnType<typeof buildKeywordDemandAnalysis>["categoryGroups"] }) {
  const ordered = [...groups].sort(
    (a, b) => b.sharePct - a.sharePct || b.keywordCount - a.keywordCount || a.label.localeCompare(b.label, "zh-CN"),
  );
  return (
    <div className="kw-group-summary">
      {ordered.map(group => (
        <article key={group.id} className="kw-group-card">
          <b>{group.label}</b>
          <span>{group.keywordCount} 词</span>
          <em>{formatPct(group.sharePct, 0)}</em>
        </article>
      ))}
    </div>
  );
}

function buildKeywordMixSegments(mix: Array<{ id: KeywordCategory; label: string; sharePct: number }>) {
  const sorted = [...mix].filter(item => item.sharePct > 0).sort((a, b) => b.sharePct - a.sharePct);
  const top = sorted.slice(0, 6);
  const restPct = sorted.slice(6).reduce((sum, item) => sum + item.sharePct, 0);
  const display =
    restPct > 0
      ? [...top, { id: "category" as KeywordCategory, label: "其他", sharePct: restPct }]
      : top;

  return display.map((item, index) => ({
    value: item.sharePct,
    label: item.label,
    color: item.label === "其他" ? "#c5ced8" : segmentStackColors[index % segmentStackColors.length],
  }));
}

function CompetitorMixRow({
  brand,
  asin,
  image,
  mix,
}: {
  brand: string;
  asin: string;
  image?: string;
  mix: Array<{ id: KeywordCategory; label: string; sharePct: number }>;
}) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({});
  const wrapRef = useRef<HTMLDivElement>(null);
  const segments = buildKeywordMixSegments(mix);
  if (!segments.length) return null;

  const openPanel = () => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const centerX = Math.min(window.innerWidth - 16, Math.max(16, rect.left + rect.width / 2));
    const estimatedHeight = 72;
    const placeAbove = rect.top - estimatedHeight >= 12;
    setPanelStyle({
      position: "fixed",
      left: centerX,
      top: placeAbove ? rect.top - 8 : rect.bottom + 8,
      transform: placeAbove ? "translate(-50%, -100%)" : "translate(-50%, 0)",
      zIndex: 1200,
    });
    setPanelOpen(true);
  };

  return (
    <article className="kw-structure-row">
      <div className="kw-structure-product">
        {image ? (
          <img className="kw-structure-thumb" src={amazonMediaSrc(image)} alt={brand} referrerPolicy="no-referrer" />
        ) : (
          <div className="kw-structure-thumb kw-structure-thumb-empty" aria-hidden="true">
            ASIN
          </div>
        )}
        <div className="kw-structure-head-inline">
          <b>{brand}</b>
          <small>{asin}</small>
        </div>
      </div>
      <div className="variant-bar-block kw-structure-compact">
        <div className="variant-bar-head kw-structure-bar-head">
          <span>TOP 6 类 + 其他 · 悬停进度条查看全部分类占比</span>
        </div>
        <div
          ref={wrapRef}
          className="kw-structure-stack-wrap"
          onMouseEnter={openPanel}
          onMouseLeave={() => setPanelOpen(false)}
        >
          <SegmentStackBar segments={segments} absolute hideSegmentTitle />
        </div>
      </div>
      {panelOpen ? (
        <div className="kw-structure-float-panel" style={panelStyle}>
          <header className="kw-structure-float-head">
            {image ? <img className="kw-structure-float-thumb" src={amazonMediaSrc(image)} alt="" referrerPolicy="no-referrer" /> : null}
            <b>{brand}</b>
            <small>{asin}</small>
          </header>
          <div className="kw-structure-float-grid">
            {segments.map(segment => (
              <div key={segment.label}>
                <i style={{ background: segment.color }} />
                <span>{segment.label}</span>
                <strong>{segment.value.toFixed(1)}%</strong>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </article>
  );
}

type MatrixSort = "coverageDesc" | "coverageAsc" | "volumeDesc" | "volumeAsc" | "abaAsc";

function matrixSortOptions(sort: MatrixSort): { sortBy: "coverage" | "volume" | "aba"; sortDir: "asc" | "desc" } {
  if (sort === "volumeDesc") return { sortBy: "volume", sortDir: "desc" };
  if (sort === "volumeAsc") return { sortBy: "volume", sortDir: "asc" };
  if (sort === "abaAsc") return { sortBy: "aba", sortDir: "asc" };
  if (sort === "coverageAsc") return { sortBy: "coverage", sortDir: "asc" };
  return { sortBy: "coverage", sortDir: "desc" };
}

function KeywordComparisonMatrixTable({
  products,
  categories,
}: {
  products: KeywordDemandProduct[];
  categories: CategoryBucket[];
}) {
  const [filter, setFilter] = useState<KeywordCategory | "all">("all");
  const [sort, setSort] = useState<MatrixSort>("coverageDesc");
  const matrix = useMemo(
    () => buildKeywordComparisonMatrix(products, { category: filter, limit: 150, ...matrixSortOptions(sort) }),
    [products, filter, sort],
  );
  const rows = matrix.rows;
  const palette = ["#2F80ED", "#7A67D8", "#29A7C7", "#F0A020", "#E65B6A", "#26A269"];
  const activeCategories = categories.filter(item => item.keywordCount > 0);

  if (!rows.length) {
    return <div className="pending-box">暂无流量词数据</div>;
  }

  return (
    <>
      <div className="kw-matrix-toolbar">
        <label>
          含义筛选
          <select value={filter} onChange={event => setFilter(event.target.value as KeywordCategory | "all")}>
            <option value="all">全部含义</option>
            {activeCategories.map(item => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <span className="launch-muted">
          展示 {rows.length} / {matrix.totalRows} 个去重词 · 默认按共享率降序 · 点击「月搜索量」按搜索量从高到低 · 悬停列头可看释义
        </span>
      </div>
      <div className="kw-matrix-period-legend launch-muted">
        <span><b>近30天</b>：竞品列流量占比、建议竞价、点击转化率、ABA Top3（SIF listingSearch lately·30）</span>
        <span><b>月粒度</b>：月搜索量、ABA 排名、月搜索趋势（SIF keyword_history · 近12期）</span>
      </div>
      <div className="kw-matrix-wrap matrix-wrap">
        <table className="compare-matrix kw-matrix-table">
          <colgroup>
            <col className="kw-col-index" />
            <col className="kw-col-keyword" />
            <col className="kw-col-category" />
            <col className="kw-col-volume" />
            <col className="kw-col-trend" />
            <col className="kw-col-bid" />
            <col className="kw-col-cvr" />
            <col className="kw-col-aba" />
            <col className="kw-col-top3" />
            <col className="kw-col-coverage" />
            {matrix.competitors.map(competitor => (
              <col key={competitor.asin} className="kw-col-competitor" />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className="kw-matrix-sticky kw-matrix-index">#</th>
              <th className="kw-matrix-sticky kw-matrix-keyword kw-matrix-help" title={sifKeywordFieldTitle("keyword")}>
                关键词
              </th>
              <th className="kw-matrix-sticky kw-matrix-category kw-matrix-help" title={sifKeywordFieldTitle("category")}>
                含义分类
              </th>
              <th
                className={`kw-matrix-sticky kw-matrix-volume kw-matrix-sortable kw-matrix-help${sort.startsWith("volume") ? " active" : ""}`}
                onClick={() =>
                  setSort(current => {
                    if (current === "volumeDesc") return "volumeAsc";
                    return "volumeDesc";
                  })
                }
                title={sifKeywordFieldTitle("searchVolume", "点击按月搜索量降序（再点切换升序）")}
              >
                月搜索量
                <span className="kw-sort-mark" aria-hidden="true">
                  {sort === "volumeDesc" ? "↓" : sort === "volumeAsc" ? "↑" : "↓"}
                </span>
              </th>
              <th className="kw-matrix-sticky kw-matrix-trend kw-matrix-help" title={sifKeywordFieldTitle("searchTrend")}>
                月搜索趋势
              </th>
              <th className="kw-matrix-sticky kw-matrix-bid kw-matrix-help" title={sifKeywordFieldTitle("suggestedBid")}>
                建议竞价
              </th>
              <th className="kw-matrix-sticky kw-matrix-cvr kw-matrix-help" title={sifKeywordFieldTitle("clickConversionRate")}>
                点击<br />转化率
              </th>
              <th
                className={`kw-matrix-sticky kw-matrix-aba kw-matrix-sortable kw-matrix-help${sort === "abaAsc" ? " active" : ""}`}
                onClick={() => setSort("abaAsc")}
                title={sifKeywordFieldTitle("abaRank", "点击可按 ABA 排名升序")}
              >
                ABA<br />排名{sort === "abaAsc" ? " ↑" : ""}
              </th>
              <th className="kw-matrix-sticky kw-matrix-top3 kw-matrix-help" title={sifKeywordFieldTitle("top3Concentration")}>
                ABA Top3<br />集中度
              </th>
              <th
                className={`kw-matrix-sticky kw-matrix-coverage kw-matrix-sortable kw-matrix-help${sort.startsWith("coverage") ? " active" : ""}`}
                onClick={() =>
                  setSort(current => {
                    if (current === "coverageDesc") return "coverageAsc";
                    return "coverageDesc";
                  })
                }
                title={sifKeywordFieldTitle("coverage", "点击可按共享率排序（分子=有流量占比的竞品数，越大相关度越高）")}
              >
                共享率{sort === "coverageDesc" ? " ↓" : sort === "coverageAsc" ? " ↑" : ""}
              </th>
              {matrix.competitors.map((competitor, index) => (
                <th
                  key={competitor.asin}
                  className="kw-matrix-competitor-col kw-matrix-help"
                  title={sifKeywordFieldTitle("trafficShare", `${competitor.brand} · ${competitor.asin} · 近30天 listingSearch`)}
                >
                  <div className="kw-matrix-product-head">
                    <span className="series-dot" style={{ background: palette[index % palette.length] }}>
                      {index + 1}
                    </span>
                    {competitor.image ? (
                      <img src={amazonMediaSrc(competitor.image)} alt="" referrerPolicy="no-referrer" />
                    ) : (
                      <div className="image-placeholder">ASIN</div>
                    )}
                    <div>
                      <b>{competitor.brand}</b>
                      <small>{competitor.asin}</small>
                    </div>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.keyword}>
                <th className="kw-matrix-sticky kw-matrix-index">{index + 1}</th>
                <td className="kw-matrix-sticky kw-matrix-keyword">
                  <b>{row.keyword}</b>
                </td>
                <td className="kw-matrix-sticky kw-matrix-category">
                  <span className="kw-tag" style={{ background: row.categoryColor }}>
                    {row.categoryLabel}
                  </span>
                </td>
                <td className="kw-matrix-sticky kw-matrix-volume">
                  <SearchVolumeCell volume={row.searchVolume} month={row.searchVolumeMonth} />
                </td>
                <td className="kw-matrix-sticky kw-matrix-trend">
                  <KeywordSearchTrendSparkline trend={row.searchTrend} />
                </td>
                <td className="kw-matrix-sticky kw-matrix-bid">
                  <SuggestedBidCell low={row.bidLow} median={row.bidMedian} high={row.bidHigh} />
                </td>
                <td className="kw-matrix-sticky kw-matrix-cvr">{row.clickConversionRate != null ? formatPct(row.clickConversionRate, 1) : "—"}</td>
                <td className="kw-matrix-sticky kw-matrix-aba">{formatAbaRank(row.abaRank)}</td>
                <td className="kw-matrix-sticky kw-matrix-top3">
                  <Top3ConcentrationCell clickShare={row.top3ClickShare} conversionShare={row.top3ConversionShare} />
                </td>
                <td className="kw-matrix-sticky kw-matrix-coverage">
                  {row.coverageCount}/{row.coverageTotal}
                </td>
                {row.cells.map(cell => (
                  <td key={cell.asin} className={cell.isTop ? "kw-matrix-share kw-matrix-share-top" : "kw-matrix-share"}>
                    {cell.trafficShare != null && cell.trafficShare > 0 ? (
                      <>
                        {cell.isTop ? <span className="kw-share-crown" title="该词最高流量占比">👑</span> : null}
                        <span className="kw-share-value">{formatPct(cell.trafficShare, 1)}</span>
                      </>
                    ) : (
                      <span className="kw-share-empty">—</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export type KeywordDemandSectionMode = "analysis" | "insight";

export function KeywordDemandSection({
  products,
  mode = "analysis",
}: {
  products: KeywordDemandProduct[];
  mode?: KeywordDemandSectionMode;
}) {
  const analysis = useMemo(() => buildKeywordDemandAnalysis(products), [products]);
  const conclusions = useMemo(() => buildKeywordLaunchConclusions(analysis, products), [analysis, products]);
  const [showTaxonomy, setShowTaxonomy] = useState(false);
  const eyebrow = mode === "insight" ? "关键词调研 · 关键词洞察" : "关键词调研 · 竞品关键词分析";
  const title =
    mode === "insight"
      ? conclusions.hasData
        ? conclusions.headline
        : "关键词洞察待数据就绪"
      : analysis.headline;
  const summary =
    mode === "insight"
      ? conclusions.hasData
        ? conclusions.verdict.matrixLabel
        : "先完成竞品流量词同步，再输出开品结论与需求分层。"
      : analysis.summaryInsight;

  return (
    <div className="launch-page kw-demand-page">
      <section className="card launch-block launch-intro-block">
        <div className="launch-section-head">
          <div className="launch-section-head-main">
            <p className="launch-eyebrow">{eyebrow}</p>
            <h2 className="launch-page-title">{title}</h2>
            <p>{summary}</p>
          </div>
          <SourceBadge>SIF MCP</SourceBadge>
        </div>
        <div className="launch-meta-row">
          <span>
            分类体系 <b>12 类标签</b>
          </span>
          <span>
            统计周期 <b>{analysis.meta.period}</b>
          </span>
          <span>
            竞品 <b>
              {analysis.meta.readyCount}/{analysis.meta.asinCount}
            </b>
          </span>
          <span>
            去重词 <b>{analysis.meta.uniqueKeywords}</b>
          </span>
          <span>
            更新 <b>{analysis.meta.updatedAt}</b>
          </span>
        </div>
      </section>

      {!analysis.hasData ? (
        <LaunchSection title="等待 SIF 关键词数据" description="反查流量词尚未同步到本地">
          <div className="pending-box">
            1) Cursor Settings → MCP → 启用 sif-mcp · 2) 运行 <code>{sifKeywordAnalysisMeta.syncCommand}</code> · 3){" "}
            <code>npm run build</code> 并重启团队服务
          </div>
        </LaunchSection>
      ) : mode === "insight" ? (
        <KeywordLaunchConclusionsBlock conclusions={conclusions} />
      ) : (
        <>
          <LaunchSection title="标签分布概览" description="5 大分组汇总 · 下方展示全部 12 类标签">
            <GroupSummaryRow groups={analysis.categoryGroups} />
            <TopCategoryStrip categories={analysis.topCategories} />
          </LaunchSection>

          <LaunchSection
            title="竞品关键词结构对比"
            description="各 ASIN 流量词按含义分类 · 展示 TOP 6 类 + 其他"
            className="kw-structure-section"
          >
            <div className="kw-structure-list">
            {analysis.competitorBreakdown.map(item => {
              if (item.status !== "ready") {
                return (
                  <article key={item.asin} className="kw-structure-row pending">
                    <div className="kw-structure-product">
                      {item.image ? (
                        <img className="kw-structure-thumb" src={amazonMediaSrc(item.image)} alt={item.brand} referrerPolicy="no-referrer" />
                      ) : (
                        <div className="kw-structure-thumb kw-structure-thumb-empty" aria-hidden="true">
                          ASIN
                        </div>
                      )}
                      <div className="kw-structure-head-inline">
                        <b>{item.brand}</b>
                        <small>{item.asin}</small>
                      </div>
                    </div>
                    <div className="pending-box">等待数据</div>
                  </article>
                );
              }
              return (
                <CompetitorMixRow
                  key={item.asin}
                  brand={item.brand}
                  asin={item.asin}
                  image={item.image}
                  mix={item.mix}
                />
              );
            })}
            </div>
          </LaunchSection>

          <LaunchSection
            title="流量词对比"
            description="行=去重关键词 · 列=竞品近30天流量占比（listingSearch）"
          >
            <KeywordComparisonMatrixTable products={products} categories={analysis.categories} />
          </LaunchSection>

          <LaunchSection
            title="关键词含义分类标准"
            description="12 类标签 · import from keyword-classifier / keyword-meaning-taxonomy"
            badge={
              <button className="ghost-btn kw-toggle-taxonomy" onClick={() => setShowTaxonomy(value => !value)}>
                {showTaxonomy ? "收起" : "展开词表"}
              </button>
            }
          >
            {showTaxonomy ? <TaxonomyReferenceTable /> : <p className="launch-muted">点击「展开词表」查看 12 类标签定义与示例。</p>}
          </LaunchSection>
        </>
      )}
    </div>
  );
}
