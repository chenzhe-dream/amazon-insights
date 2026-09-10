"use client";

import { type ManualAlexaVocNormalizedRecord } from "../../../shared/agent-contracts";
import { sorftimeReviewAnalysisData } from "../../sorftime-review-analysis-data";
import { useMemo } from "react";
import { buildVocDevelopmentSummary, hasVocDevelopmentData, vocInsightRingDimensions, vocDevBarPalette, vocDevelopmentSummaryMeta } from "./voc-development-summary";
import { type Product } from "../catalog/product-contracts";
import { SourceBadge } from "../../components/source-badge";

export function VocSevenDimensionInsightSection({ products, manualVocByAsin, reviewAnalysisData }: {
  products: Product[];
  manualVocByAsin: Readonly<Record<string, ManualAlexaVocNormalizedRecord | undefined>>;
  reviewAnalysisData: typeof sorftimeReviewAnalysisData;
}) {
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
        <div className="pending-box">待 VOC 核心主题或智能评论分析就绪后，自动生成七维综合分析。</div>
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
