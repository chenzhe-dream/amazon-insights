"use client";

import { useMemo } from "react";
import { UrlResumableAsinSyncFunnel, type SyncResumeBundle } from "../sync/asin-sync-funnel";
import {
  sifListingTrafficOverview,
  sifListingTrafficMeta,
  type TrafficDisplayData,
} from "../../sif-listing-traffic-data";
import { sifMonthlyTrafficTrend, sifMonthlyTrafficMeta } from "../../sif-monthly-traffic-trend-data";
import { amazonMediaSrc } from "../../lib/amazon-image";

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
  trafficData?: TrafficDisplayData;
  trafficOrigin?: "dynamic" | "legacy" | "pending";
};

function buildAsinTrafficStatus(asin: string, trafficData?: TrafficDisplayData) {
  const overview = trafficData ? trafficData.overview[asin] : sifListingTrafficOverview[asin];
  const monthly = trafficData ? trafficData.monthlyTrend[asin] : sifMonthlyTrafficTrend[asin];
  const totalScore = overview?.totalScore ?? 0;
  const childCount = overview?.children.length ?? 0;
  const monthCount = monthly?.points?.length ?? 0;
  const naturalShare = overview?.naturalAd.find(item => item.label === "自然流量")?.ratio ?? null;
  const adShare = overview?.naturalAd.find(item => item.label === "广告流量")?.ratio ?? null;
  const ready = Boolean(overview && totalScore > 0);
  return {
    asin,
    ready,
    totalScore,
    childCount,
    monthCount,
    naturalShare,
    adShare,
    updatedThrough: overview?.updatedThrough ?? null,
  };
}

export function TrafficFetchStatusSection({
  products,
  marketplace,
  syncRequest,
  syncResume,
  onRequestSync,
  onSyncComplete,
  onSyncDismiss,
  trafficData,
  trafficOrigin = "legacy",
}: Props) {
  const rows = useMemo(
    () =>
      products.map(product => ({
        ...product,
        ...buildAsinTrafficStatus(product.asin, trafficData),
      })),
    [products, trafficData]
  );

  const readyCount = rows.filter(row => row.ready).length;
  const missingAsins = rows.filter(row => !row.ready).map(row => row.asin);
  const readyPct = Math.round((readyCount / Math.max(rows.length, 1)) * 100);
  const totalScoreSum = rows.reduce((sum, row) => sum + row.totalScore, 0);

  if (syncRequest || syncResume.syncJobId || syncResume.terminalJob) {
    return (
      <UrlResumableAsinSyncFunnel
        asins={products.map(product => product.asin)}
        marketplace={marketplace}
        syncRequest={syncRequest}
        resume={syncResume}
        focusStageIds={["catalog", "traffic"]}
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
      <section className="card keyword-fetch-status traffic-fetch-status">
        <div className="keyword-fetch-head">
          <div>
            <span className="status-chip">流量数据</span>
            <h3>等待录入 ASIN</h3>
            <p>先在上方填写至少 3 个竞品，再抓取 SIF Listing 流量结构与月趋势。</p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="card keyword-fetch-status traffic-fetch-status">
      <div className="keyword-fetch-head">
        <div>
          <span className="status-chip">流量数据就绪度</span>
          <h3>
            {missingAsins.length === 0
              ? "流量结构数据已就绪"
              : `${missingAsins.length} 个 ASIN 待拉取流量结构`}
          </h3>
          <p>
            本页只看 SIF Listing 流量结构 + 近6月趋势 · {trafficData?.meta.period ?? sifListingTrafficMeta.period} · 更新至{" "}
            {trafficData ? trafficData.meta.updatedThrough ?? '未提供' : sifListingTrafficMeta.updatedThrough ?? sifMonthlyTrafficMeta.updatedThrough}
          </p>
          {trafficOrigin === "dynamic" && <p>当前显示本次 run 的 PostgreSQL 动态流量快照。</p>}
          {trafficOrigin === "legacy" && <p>当前显示 <b>legacy</b> 流量缓存，动态快照仍在等待。</p>}
        </div>
        <div className="keyword-fetch-summary">
          <span>
            就绪 <b>
              {readyCount}/{rows.length}
            </b>
          </span>
          <span>
            总分合计 <b>{totalScoreSum.toLocaleString()}</b>
          </span>
          <span>
            月趋势点 <b>{rows.reduce((sum, row) => sum + row.monthCount, 0)}</b>
          </span>
          <button type="button" className="ghost-btn" onClick={onRequestSync}>
            {missingAsins.length > 0 ? "拉取缺失流量" : "强制刷新"}
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
              <span>Listing 总分</span>
              <strong>{row.ready ? row.totalScore.toLocaleString() : "—"}</strong>
              <em>{row.ready ? `${row.childCount} 个子体` : "SIF listing traffic"}</em>
            </div>
            <div className="keyword-fetch-metric">
              <span>自然 / 广告</span>
              <strong>
                {row.ready && row.naturalShare != null && row.adShare != null
                  ? `${row.naturalShare}% / ${row.adShare}%`
                  : "—"}
              </strong>
              <em>{row.ready ? `月点 ${row.monthCount}` : "待流量结构就绪"}</em>
            </div>
            <div className="keyword-fetch-state">
              <span className={`keyword-fetch-pill ${row.ready ? "ok" : "wait"}`}>
                {row.ready ? "已就绪" : "待拉取"}
              </span>
              <small>
                {row.updatedThrough ? `更新至 ${row.updatedThrough}` : "尚无本地缓存"}
              </small>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
