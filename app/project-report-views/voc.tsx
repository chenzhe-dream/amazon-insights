"use client";
import {useMemo, type ReactNode} from "react";
import {useSnapshotPresentation} from "./snapshot-presentation";
import type {ManualAlexaVocRecord, ManualAlexaVocNormalizedRecord} from "../../shared/agent-contracts";
import type {ManualVocStatus} from "../manual-alexa-voc-store";
import {ProductHeader, type Product} from "./competitor-overview";
import type {MarketSite} from "../../shared/market-sites";
import {manualVocDimensions, manualVocDisplayMeta, manualVocSourceBadge, formatManualVocMatrixText} from "../voc-display-schema";
import {VocDimensionLabel} from "../voc-dimension-label";
import {buildVocDevelopmentSummary, hasVocDevelopmentData, vocDevBarPalette, vocDevelopmentSummaryMeta, vocInsightRingDimensions} from "../voc-development-summary";
import {formatReviewAnalysisItem, reviewMetricExplanation, formatReviewSharePct, reviewAnalysisBarPalette, reviewAnalysisDimensions, sorftimeReviewAnalysisMeta, type SellerSpriteReviewAnalysisRecord} from "../seller-sprite-review-analysis";
import type {sorftimeReviewAnalysisData} from "../sorftime-review-analysis-data";
import {reviewEmptyMessage, reviewEvidenceText} from "../lib/voc-review-display";
function SourceBadge({children}: {children: ReactNode}) {return <span className="source-badge">{children}</span>;}

export function ReviewAnalysisMatrixSection({
  title,
  description,
  badge,
  data,
  dataMeta,
  configMeta,
  pendingSteps,
  products,
  market,
  missingMessages,
}: {
  title: string;
  description: string;
  badge: string;
  data: Record<string, SellerSpriteReviewAnalysisRecord & { mentionTopics?: number }>;
  dataMeta: { source: string; updatedAt: string; syncCommand?: string; mcpNote?: string };
  configMeta: typeof sorftimeReviewAnalysisMeta;
  pendingSteps: React.ReactNode;
  products: Product[];
  market: MarketSite;
  missingMessages?: Record<string, string>;
}) {
  const hasProducts = products.length > 0;
  const hasSellerSprite = products.some(product => data[product.asin]?.sourceProvider === "sellerSprite");

  return (
    <section className="card ss-review-matrix-card">
      <div className="section-head">
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        <SourceBadge>{badge}</SourceBadge>
      </div>
      {!hasProducts ? (
        <div className="pending-box ss-review-pending">
          <strong>待同步评论分析数据</strong>
          <span>{dataMeta.mcpNote ?? configMeta.emptyMessage}</span>
          <span>{pendingSteps}</span>
        </div>
      ) : (
        <div className="matrix-wrap">
          <p className="ss-review-metric-note">口径提示：评论样本发生率与 Customers Say 主题提及份额不可互换；同一条评论可命中多个主题，因此各行可能重叠，合计不要求等于 100%。</p>
          <table className="compare-matrix voc-matrix ss-review-matrix">
            <thead>
              <tr>
                <th>分析维度</th>
                {products.map((product, index) => (
                  <th key={product.asin}>
                    <ProductHeader product={product} index={index} market={market} />
                    <small>{reviewEvidenceText(data[product.asin])}</small>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {reviewAnalysisDimensions.map(dimension => (
                <tr key={dimension.key}>
                  <th>
                    <span>{dimension.label}</span>
                    <small className="voc-status verified">{dimension.formatHint}</small>
                  </th>
                  {products.map(product => {
                    const analysis = data[product.asin];
                    const block = analysis?.blocks.find(item => item.key === dimension.key);
                    const rows = block?.rows ?? [];
                    if (analysis?.status !== "ready") {
                      return (
                        <td key={product.asin} className="bullet-cell ss-review-cell ss-review-cell-pending">
                          {analysis ? reviewEmptyMessage(analysis) : missingMessages?.[product.asin] ?? reviewEmptyMessage(undefined)}
                        </td>
                      );
                    }

                    return (
                      <td key={product.asin} className="bullet-cell ss-review-cell">
                        {rows.length ? (
                          <ul className="ss-review-theme-list">
                            {rows.map((row, rowIndex) => (
                              <li key={`${product.asin}-${dimension.key}-${rowIndex}-${row.label}`}>
                                <div className="ss-review-theme-row" title={reviewMetricExplanation(row, analysis.sampledReviews)}>
                                  <b>{formatReviewAnalysisItem(row, analysis.sampledReviews)}</b>
                                  <div className="ss-review-theme-bar">
                                    <i>
                                      <b
                                        style={{
                                          width: `${Math.min(100, Math.max(0, row.sharePct))}%`,
                                          background: reviewAnalysisBarPalette[dimension.key],
                                        }}
                                      />
                                    </i>
                                    <strong>{formatReviewSharePct(row.sharePct)}%</strong>
                                  </div>
                                </div>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <span className="ss-review-empty">
                            {reviewEmptyMessage(analysis)}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="voc-source-footnote">
        数据源：{hasSellerSprite ? "Sorftime MCP / 卖家精灵 MCP（逐 ASIN 见表头）" : dataMeta.source} · {hasSellerSprite ? "评论样本关键词聚类；Sorftime 记录另含 Customers Say 主题" : configMeta.method} · {dataMeta.updatedAt}
      </p>
    </section>
  );
}

export function VocSevenDimensionInsightSection({ products, manualVocByAsin, reviewAnalysisData }: {
  products: Product[];
  manualVocByAsin: Readonly<Record<string, ManualAlexaVocNormalizedRecord | undefined>>;
  reviewAnalysisData: typeof sorftimeReviewAnalysisData;
}) {
  const snapshot = useSnapshotPresentation();
  const summaries = useMemo(
    () => buildVocDevelopmentSummary(
      products.map(product => ({ asin: product.asin, brand: product.brand, productFamily: product.productFamily })),
      manualVocByAsin,
      reviewAnalysisData,
    ),
    [manualVocByAsin, products, reviewAnalysisData]
  );
  const summaryMap = useMemo(() => new Map(summaries.map(item => [item.key, item])), [summaries]);

  return (
    <section className="card voc-seven-dim-card">
      <div className="section-head">
        <div>
          <h3>VOC 七维综合分析</h3>
          <p>
            融合 VOC 核心主题 + 智能评论分析 · 各维度内主题占比归一化至 100%
          </p>
        </div>
        <SourceBadge>{products.length} 竞品 · 按已有来源汇总</SourceBadge>
      </div>
      {!hasVocDevelopmentData(products, manualVocByAsin, reviewAnalysisData) ? (
        <div className="pending-box">{snapshot ? "暂无可用于七维综合分析的已保存数据。" : "待 VOC 核心主题或智能评论分析就绪后，自动生成七维综合分析。"}</div>
      ) : (
        <>
          <div className="voc-seven-dim-grid">
            {vocInsightRingDimensions.map(dimension => {
              const summary = summaryMap.get(dimension.key);
              const themes = summary?.themes ?? [];
              const maxPct = Math.max(...themes.map(theme => theme.mentionPct), 1);

              return (
                <article
                  key={dimension.key}
                  className="voc-seven-dim-cell"
                  style={{ ["--segment-accent" as string]: vocDevBarPalette[dimension.key] }}
                >
                  <header>
                    <span className="voc-seven-dim-num">{dimension.num}</span>
                    <div>
                      <b>{summary?.label ?? dimension.key}</b>
                      <em>{dimension.en}</em>
                    </div>
                  </header>
                  {themes.length ? (
                    <ul className="voc-seven-dim-theme-list">
                      {themes.map(theme => (
                        <li key={`${dimension.key}-${theme.label}`}>
                          <div className="voc-seven-dim-theme-head">
                            <span>【{theme.label}】</span>
                            <strong>{theme.mentionPct >= 1 ? theme.mentionPct.toFixed(1) : theme.mentionPct.toFixed(2)}%</strong>
                          </div>
                          <div className="voc-seven-dim-theme-bar">
                            <i>
                              <b style={{ width: `${Math.min(100, (theme.mentionPct / maxPct) * 100)}%` }} />
                            </i>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="voc-seven-dim-empty">暂无归纳主题</p>
                  )}
                </article>
              );
            })}
          </div>
        </>
      )}
      <p className="voc-source-footnote">
        汇总来源：{vocDevelopmentSummaryMeta.sources.join(" · ")} · 格式：{vocDevelopmentSummaryMeta.format}
      </p>
    </section>
  );
}

function parseMotiveStarRating(segment: string) {
  if (!/[⭐★☆]/.test(segment)) return null;
  const filled = (segment.match(/⭐/g) ?? []).length || (segment.match(/★/g) ?? []).length;
  return filled > 0 ? Math.min(5, filled) : null;
}

function renderVocMatrixItem(item: string, dimensionKey: string) {
  if (dimensionKey !== "motives" || !item.includes("｜")) return formatManualVocMatrixText(item, dimensionKey);
  const parts = item.split("｜");
  if (parts.length < 3) return item;
  const starRating = parseMotiveStarRating(parts[1]);
  if (starRating == null) return item;
  return (
    <>
      {parts[0]}｜<AmazonStarRating rating={starRating} compact />｜{parts.slice(2).join("｜")}
    </>
  );
}

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

export function VocOverviewIntroduction({products}: {products: Product[]}) {
  return <>
        <section className="card page-intro"><div><span className="status-chip">多竞品 VOC 对比</span><h2>七个相同维度同屏对齐，直接比较顾客关注与购买决策差异</h2><p>入口：Alexa for Shopping 对话框 · 中文七问一次性提交 · 输出完整报告 · 数据源为 Customer Review（经 Alexa 整理）。</p></div><SourceBadge>{products.length} 个 ASIN 同屏</SourceBadge></section>
        <details className="card voc-dimension-format-card" open>
          <summary className="section-head voc-dimension-format-toggle">
            <div><h3>VOC 核心主题 · 七维格式</h3><p>矩阵左列展示格式说明，各 ASIN 列按同一结构对齐</p></div>
            <span className="voc-dimension-format-actions"><SourceBadge>{manualVocDisplayMeta.source}</SourceBadge><span className="voc-dimension-format-toggle-label"><span className="voc-dimension-format-collapse">收起 ▴</span><span className="voc-dimension-format-expand">展开 ▾</span></span></span>
          </summary>
          <table className="voc-dimension-format-table">
            <thead><tr><th>维度</th><th>格式说明</th></tr></thead>
            <tbody>
              {manualVocDimensions.map(d => (
                <tr key={d.key}>
                  <th>
                    <VocDimensionLabel label={d.label} description={d.description} />
                  </th>
                  <td>{d.formatHint}</td>
                </tr>
              ))}
              <tr className="voc-dimension-format-note-row">
                <th>备注</th>
                <td>Alexa for Shopping 聊天框提问，提问格式为：这个产品的顾客关注点是什么、好评点是什么、差评点是什么、未被满足的需求是什么、使用人群是谁、使用场景是什么、核心购买动机是什么。</td>
              </tr>
            </tbody>
          </table>
        </details>
  </>;
}

export type ManualVocMatrixProps = {
  products: Product[];
  market: MarketSite;
  effectiveVocByAsin: Readonly<Record<string, ManualAlexaVocRecord | null | undefined>>;
  statusByAsin: Readonly<Record<string, ManualVocStatus | undefined>>;
  onRetry?: () => void;
};
export function ManualVocMatrixSection({products, market, effectiveVocByAsin, statusByAsin, onRetry}: ManualVocMatrixProps) {
  return (
        <section className="card voc-matrix-card">
          <div className="section-head">
            <div><h3>VOC 核心主题</h3><p>{manualVocDisplayMeta.scope}</p></div>
            <SourceBadge>Authenticated API</SourceBadge>
            {onRetry && Object.values(statusByAsin).some(status => status === "source-error" || status === "protocol-conflict")
              ? <button type="button" className="ghost-btn" onClick={onRetry}>重试读取 VOC</button>
              : null}
          </div>
          <div className="matrix-wrap">
            <table className="compare-matrix voc-matrix">
              <thead>
                <tr>
                  <th>VOC 维度</th>
                  {products.map((product, index) => {
                    const badge = manualVocSourceBadge(effectiveVocByAsin[product.asin] ?? null);
                    const status = statusByAsin[product.asin];
                    return <th key={product.asin}>
                      <ProductHeader product={product} index={index} market={market} />
                      {badge ? <small className="voc-status verified">{badge}</small> : null}
                      {status === "source-error" ? <small className="voc-status limited">读取失败 · 已保留页面版本</small> : null}
                      {status === "protocol-conflict" ? <small className="voc-status limited">revision 冲突 · 已保留页面版本</small> : null}
                    </th>;
                  })}
                </tr>
              </thead>
              <tbody>
                {manualVocDimensions.map(dimension => <tr key={dimension.key}>
                  <th>
                    <VocDimensionLabel label={dimension.label} description={dimension.description} />
                    <small className={dimension.verified ? "voc-status verified" : "voc-status limited"}>{dimension.formatHint}</small>
                  </th>
                  {products.map(product => {
                    const overlayRecord = effectiveVocByAsin[product.asin] ?? null;
                    const record = overlayRecord?.normalizedRecord;
                    const status = statusByAsin[product.asin];
                    const fallback = status === "loading"
                      ? "正在读取当前组织的 Manual Alexa VOC…"
                      : status === "source-error"
                        ? "运行时 VOC 暂不可用，请重试。"
                        : status === "protocol-conflict"
                          ? "服务器返回冲突 revision；已保留较新页面版本。"
                          : market === "US"
                            ? "该 ASIN 尚未录入 Manual Alexa VOC。"
                            : "Manual Alexa VOC 当前仅支持美国站。";
                    const items = record?.[dimension.key] ?? [fallback];
                    const isTableRow = Boolean(record) && (dimension.key === "audiences" || dimension.key === "scenarios" || dimension.key === "motives");
                    const cellClass = record ? "bullet-cell voc-alexa-cell" : "bullet-cell voc-limited-cell";
                    return <td key={product.asin} className={cellClass}>
                      <ul className={isTableRow ? "voc-table-list" : undefined}>
                        {items.map((item, index) => <li key={`${product.asin}-${dimension.key}-${index}`} className={item.includes("｜") && index === 0 ? "voc-table-head" : undefined}>{renderVocMatrixItem(item, dimension.key)}</li>)}
                      </ul>
                    </td>;
                  })}
                </tr>)}
              </tbody>
            </table>
          </div>
          <p className="voc-source-footnote">入口：{manualVocDisplayMeta.source} · 提问：中文七问 · 输出：完整报告 · 权威源：PostgreSQL（认证 API 即时读取）</p>
        </section>
  );
}
