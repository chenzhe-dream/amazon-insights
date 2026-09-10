"use client";

import { type SellerSpriteReviewAnalysisRecord, sorftimeReviewAnalysisMeta, reviewAnalysisDimensions, reviewMetricExplanation, formatReviewAnalysisItem, reviewAnalysisBarPalette, formatReviewSharePct } from "../../seller-sprite-review-analysis";
import { reviewEvidenceText, reviewEmptyMessage } from "../../lib/voc-review-display";
import { AmazonStarRating } from "../../components/amazon-star-rating";
import { type Product, type MarketCode } from "../catalog/product-contracts";
import { SourceBadge } from "../../components/source-badge";
import { ProductHeader } from "../../components/product-header";

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
  market: MarketCode;
  missingMessages?: Record<string, string>;
}) {
  const hasProducts = products.length > 0;

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
                            {rows.map(row => (
                              <li key={`${product.asin}-${dimension.key}-${row.label}`}>
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
        数据源：{dataMeta.source} · {configMeta.method} · {dataMeta.updatedAt}
      </p>
    </section>
  );
}

export function parseMotiveStarRating(segment: string) {
  if (!/[⭐★☆]/.test(segment)) return null;
  const filled = (segment.match(/⭐/g) ?? []).length || (segment.match(/★/g) ?? []).length;
  return filled > 0 ? Math.min(5, filled) : null;
}

export function renderVocMatrixItem(item: string, dimensionKey: string) {
  if (dimensionKey !== "motives" || !item.includes("｜")) return item;
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
