"use client";

import { useMemo } from "react";
import { UrlResumableAsinSyncFunnel, type SyncResumeBundle } from "./asin-sync-funnel";
import { sifKeywordAnalysisData, sifKeywordAnalysisMeta } from "./sif-keyword-analysis-data";
import { sifKeywordEnrichmentData } from "./sif-keyword-enrichment-data";
import { amazonMediaSrc } from "./lib/amazon-image";

type ProductLite = {
  asin: string;
  brand: string;
  image?: string;
};

type Props = {
  products: ProductLite[];
  marketplace: string;
  syncRequest: string[] | null;
  syncResume: SyncResumeBundle;
  onRequestSync: () => void;
  onSyncComplete?: () => void;
  onSyncDismiss?: () => void;
};

function normalizeKeyword(keyword: string) {
  return keyword.trim().toLowerCase();
}

function buildAsinKeywordStatus(asin: string) {
  const record = sifKeywordAnalysisData[asin];
  const keywords = record?.status === "ready" ? record.keywords : [];
  const keywordCount = keywords.length;
  let enrichedCount = 0;
  for (const row of keywords) {
    const enrich = sifKeywordEnrichmentData[normalizeKeyword(row.keyword)];
    if (enrich?.status === "ready" && enrich.searchTrend?.length) enrichedCount += 1;
  }
  const ready = record?.status === "ready" && keywordCount > 0;
  return {
    asin,
    ready,
    status: record?.status ?? "empty",
    statusMessage: record?.statusMessage ?? null,
    fetchedAt: record?.fetchedAt ?? null,
    totalKeywordsInPeriod: record?.totalKeywordsInPeriod ?? null,
    keywordCount,
    enrichedCount,
    enrichPct: keywordCount > 0 ? Math.round((enrichedCount / keywordCount) * 100) : 0,
  };
}

export function KeywordFetchStatusSection({
  products,
  marketplace,
  syncRequest,
  syncResume,
  onRequestSync,
  onSyncComplete,
  onSyncDismiss,
}: Props) {
  const rows = useMemo(
    () =>
      products.map(product => ({
        ...product,
        ...buildAsinKeywordStatus(product.asin),
      })),
    [products]
  );

  const readyCount = rows.filter(row => row.ready).length;
  const totalKeywords = rows.reduce((sum, row) => sum + row.keywordCount, 0);
  const totalEnriched = rows.reduce((sum, row) => sum + row.enrichedCount, 0);
  const missingAsins = rows.filter(row => !row.ready).map(row => row.asin);
  const readyPct = Math.round((readyCount / Math.max(rows.length, 1)) * 100);

  if (syncRequest || syncResume.syncJobId) {
    return (
      <UrlResumableAsinSyncFunnel
        asins={products.map(product => product.asin)}
        marketplace={marketplace}
        syncRequest={syncRequest}
        resume={syncResume}
        focusStageIds={["catalog", "keywords"]}
        onComplete={() => {
          onSyncComplete?.();
          onSyncDismiss?.();
        }}
        onDismiss={() => {
          onSyncDismiss?.();
        }}
      />
    );
  }

  if (!rows.length) {
    return (
      <section className="card keyword-fetch-status">
        <div className="keyword-fetch-head">
          <div>
            <span className="status-chip">关键词数据</span>
            <h3>等待录入 ASIN</h3>
            <p>先在上方填写至少 3 个竞品，再抓取 SIF 反查流量词与月搜索量。</p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="card keyword-fetch-status">
      <div className="keyword-fetch-head">
        <div>
          <span className="status-chip">关键词数据就绪度</span>
          <h3>
            {missingAsins.length === 0
              ? "流量词数据已就绪"
              : `${missingAsins.length} 个 ASIN 待拉取流量词`}
          </h3>
          <p>
            本页只看 SIF 反查流量词 + 月搜索 enrichment · {sifKeywordAnalysisMeta.period} · 更新{" "}
            {sifKeywordAnalysisMeta.updatedAt}
          </p>
        </div>
        <div className="keyword-fetch-summary">
          <span>
            就绪 <b>
              {readyCount}/{rows.length}
            </b>
          </span>
          <span>
            流量词 <b>{totalKeywords}</b>
          </span>
          <span>
            月搜补全 <b>{totalEnriched}</b>
          </span>
          <button type="button" className="ghost-btn" onClick={onRequestSync}>
            {missingAsins.length > 0 ? "拉取缺失关键词" : "强制刷新"}
          </button>
        </div>
      </div>

      <div className="keyword-fetch-overall">
        <i style={{ width: `${readyPct}%` }} />
      </div>

      <div className="keyword-fetch-rows">
        {rows.map(row => (
          <article key={row.asin} className={`keyword-fetch-row${row.ready ? " ready" : " pending"}`}>
            <div className="keyword-fetch-product">
              {row.image ? (
                <img src={amazonMediaSrc(row.image)} alt="" className="keyword-fetch-thumb" referrerPolicy="no-referrer" />
              ) : (
                <div className="keyword-fetch-thumb empty">ASIN</div>
              )}
              <div>
                <b>{row.brand}</b>
                <small>{row.asin}</small>
              </div>
            </div>
            <div className="keyword-fetch-metric">
              <span>流量词</span>
              <strong>{row.ready ? row.keywordCount : "—"}</strong>
              <em>
                {row.totalKeywordsInPeriod != null
                  ? `周期内 ${row.totalKeywordsInPeriod.toLocaleString()}`
                  : "SIF listingSearch"}
              </em>
            </div>
            <div className="keyword-fetch-metric">
              <span>月搜 enrichment</span>
              <strong>{row.ready ? `${row.enrichPct}%` : "—"}</strong>
              <em>{row.ready ? `${row.enrichedCount}/${row.keywordCount} 词有趋势` : "待流量词就绪"}</em>
            </div>
            <div className="keyword-fetch-state">
              <span className={`keyword-fetch-pill ${row.ready ? "ok" : "wait"}`}>
                {row.ready ? "已就绪" : "待拉取"}
              </span>
              <small>{row.fetchedAt ? `同步 ${row.fetchedAt}` : row.statusMessage ?? "尚无本地缓存"}</small>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
