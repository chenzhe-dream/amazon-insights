"use client";

import { formatTrafficScore, trafficChildCountLabel } from "../../lib/traffic-detail-view";
import { sifAdChannelGlossary, sifAdChannelGlossaryList } from "../../sif-listing-traffic-data";
import Link from "next/link";
import { StageOutputGapCard } from "../sync/stage-output-gap-card";
import { TrafficDetailRecoveryControl } from "./traffic-detail-recovery";
import { TrafficFetchStatusSection } from "./traffic-fetch-status";
import { sifMonthlyTrafficMeta } from "../../sif-monthly-traffic-trend-data";
import { MAX_ASIN_SLOTS } from "../projects/workspace-navigation";
import { type MarketCode, markets } from "../catalog/product-contracts";
import { SourceBadge } from "../../components/source-badge";
import { ProductHeader } from "../../components/product-header";
import { colors } from "../charts/chart-format";
import { TrafficDistributionBars, ChildTrafficStructurePanel } from "./traffic-distribution";
import { MonthlyTrafficStackChart } from "./monthly-traffic-stack-chart";
import { TrafficAnalysisConclusionSection } from "./traffic-analysis-conclusion-section";
import type { WorkspaceController } from "../workspace/use-workspace-controller";

type TrafficTabProps = Pick<WorkspaceController, "market" | "setMarket" | "setMessage" | "inputs" | "setInputs" | "tabHref" | "currentProjectName" | "slugParam" | "showBuilderNotice" | "message" | "savingTrafficPromo" | "saveTrafficPromoProject" | "runAnalysis" | "stageOutputSnapshot" | "authSession" | "baseSyncRunId" | "trafficSnapshotState" | "trafficBindingKey" | "trafficData" | "trafficSnapshotOwner" | "products" | "stageOutputView" | "trafficOrigin" | "syncAsins" | "syncResume" | "refreshRuntimeAfterSync" | "trafficMeta" | "trafficOverviewByAsin" | "trafficMonthlyTrendByAsin" | "handleTrafficTabOnRequestSync" | "handleTrafficTabOnSyncDismiss">;

export function TrafficTab({ market, setMarket, setMessage, inputs, setInputs, tabHref, currentProjectName, slugParam, showBuilderNotice, message, savingTrafficPromo, saveTrafficPromoProject, runAnalysis, stageOutputSnapshot, authSession, baseSyncRunId, trafficSnapshotState, trafficBindingKey, trafficData, trafficSnapshotOwner, products, stageOutputView, trafficOrigin, syncAsins, syncResume, refreshRuntimeAfterSync, trafficMeta, trafficOverviewByAsin, trafficMonthlyTrendByAsin, handleTrafficTabOnRequestSync, handleTrafficTabOnSyncDismiss }: TrafficTabProps) {
  return <div className="page-content compare-page">
        <section className="card asin-builder">
          <div className="section-head">
            <div>
              <h3>本页独立设置竞品 ASIN</h3>
              <p>无需先去竞品概览；在此录入 3–10 个 ASIN，抓取流量后即可保存到收藏夹「竞品推广能力分析」</p>
            </div>
            <span className="required-note">3–10 个</span>
          </div>
          <div className="asin-builder-body">
            <label className="market-inline">
              目标市场
              <select
                value={market}
                onChange={e => {
                  const next = e.target.value as MarketCode;
                  setMarket(next);
                  setMessage(`已切换至 ${markets[next].label}，流量数据口径将同步更新`);
                }}
              >
                {Object.entries(markets).map(([code, item]) => (
                  <option key={code} value={code}>
                    {item.option}
                  </option>
                ))}
              </select>
            </label>
            <div className="asin-inputs">
              {Array.from({ length: MAX_ASIN_SLOTS }).map((_, i) => (
                <label key={i} className="asin-slot">
                  <span>
                    {i + 1}
                    {i < 3 && <b>*</b>}
                  </span>
                  <input
                    value={inputs[i]}
                    name={`asin-slot-${i}`}
                    placeholder="10位ASIN"
                    maxLength={10}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    data-lpignore="true"
                    data-1p-ignore="true"
                    onChange={e => setInputs(prev => prev.map((v, j) => (j === i ? e.target.value.toUpperCase() : v)))}
                  />
                  {i >= 3 && inputs[i] ? (
                    <button
                      type="button"
                      onClick={() => setInputs(prev => prev.map((v, j) => (j === i ? "" : v)))}
                      aria-label={`清空竞品${i + 1}`}
                    >
                      ×
                    </button>
                  ) : null}
                </label>
              ))}
            </div>
          </div>
          <div className="builder-actions">
            <Link className="ghost-btn" href={tabHref("traffic-promo")}>
              ★ 推广能力分析
            </Link>
            {currentProjectName ? (
              <span className="builder-project-chip">
                当前工作区：{currentProjectName}
                {slugParam ? ` · /p/${slugParam}` : ""}
              </span>
            ) : null}
            {showBuilderNotice ? (
              <span
                className={
                  message.includes("请") || message.includes("不正确") || message.includes("重复") || message.includes("失败")
                    ? "builder-message error"
                    : "builder-message"
                }
              >
                {message}
              </span>
            ) : null}
            <button type="button" className="ghost-btn" disabled={savingTrafficPromo || inputs.filter(Boolean).length < 3} onClick={() => void saveTrafficPromoProject()}>
              {savingTrafficPromo ? "保存中…" : "保存到推广能力分析"}
            </button>
            <button type="button" className="primary-btn" onClick={() => void runAnalysis()}>
              抓取流量数据
            </button>
          </div>
        </section>

        <StageOutputGapCard snapshot={stageOutputSnapshot} stage="traffic" />
        {authSession.user.role === 'admin' && !authSession.logoutPending && baseSyncRunId && trafficSnapshotState.kind === 'dynamic' && <TrafficDetailRecoveryControl key={trafficBindingKey} runId={baseSyncRunId} recovered={Boolean(trafficData?.authoritativeListingAsins?.length)} onRecovered={async () => trafficSnapshotOwner.current?.refresh()} />}
        <TrafficFetchStatusSection
          products={products.map(p => ({ asin: p.asin, brand: p.brand, image: p.image }))}
          marketplace={market}
          trafficData={stageOutputView.trafficData}
          trafficOrigin={stageOutputSnapshot.traffic?.stageStatus === "done" ? "dynamic" : trafficOrigin}
          syncRequest={syncAsins}
          syncResume={syncResume}
          onRequestSync={handleTrafficTabOnRequestSync}
          onSyncComplete={async () => {
            await refreshRuntimeAfterSync("流量相关数据已就绪，可继续分析或保存到推广能力分析");
          }}
          onSyncDismiss={handleTrafficTabOnSyncDismiss}
        />

        <section className="card page-intro"><div><span className="status-chip">竞品流量分析</span><h2>同屏比较流量结构、月趋势，并输出推广能力结论</h2><p>数据来自 SIF「查流量结构」· {trafficMeta.period} · 更新至 {trafficMeta.updatedThrough}，统一 Listing 口径。</p></div>
          <SourceBadge>SIF MCP</SourceBadge>
        </section>

        <section className="card listing-traffic-distribution">
          <div className="section-head">
            <div>
              <h3>父 ASIN 流量结构</h3>
              <p>Listing 聚合 · 自然 / 广告占比 · 广告渠道 · 推荐专栏来源</p>
            </div>
            <SourceBadge>SIF MCP</SourceBadge>
          </div>
          <div className="traffic-distribution-scroll">
            <div className="traffic-distribution-grid">
              <div className="traffic-distribution-head">
                <span>竞品</span>
                <span>Listing自然 / 广告流量分布</span>
                <span title="悬停各渠道标签可查看 SIF 字段释义">广告流量分布</span>
                <span>推荐专栏流量分布</span>
              </div>
              {products.map((p, i) => {
                const data = trafficOverviewByAsin[p.asin];
                return (
                  <div className="traffic-distribution-row" key={p.asin}>
                    <div className="traffic-product-cell">
                      <ProductHeader product={p} index={i} market={market} />
                      {data && <small>总分 {formatTrafficScore(data.totalScore)} · 更新至 {data.updatedThrough ?? "未提供"}</small>}
                    </div>
                    <div className="traffic-metric-cell"><TrafficDistributionBars items={data?.naturalAd ?? []} palette={["#55BB6A", "#FFB03B"]} /></div>
                    <div className="traffic-metric-cell"><TrafficDistributionBars state={stageOutputView.trafficData.detailAvailability?.[p.asin]?.adChannels} items={data?.adChannels ?? []} glossary={sifAdChannelGlossary} palette={["#538CEE", "#FFB03B", "#F15C5C", "#55BB6A"]} /></div>
                    <div className="traffic-metric-cell"><TrafficDistributionBars state={stageOutputView.trafficData.detailAvailability?.[p.asin]?.recommendationSources} items={data?.recommendationSources ?? []} maxItems={6} palette={["#538CEE", "#55BB6A", "#FFB03B", "#F15C5C"]} /></div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="traffic-channel-glossary">
            {sifAdChannelGlossaryList.map(item => (
              <span key={item.label} title={`${item.en} · ${item.meaning}`}>
                <b>{item.label}</b>
                <em>{item.en}</em>
                <small>{item.meaning}</small>
              </span>
            ))}
          </div>
          <p className="traffic-data-note">口径对齐 SIF 查流量结构 · Listing 聚合视图 · 近30天流量分 · 广告渠道释义来自 SIF MCP wholeName 与查流量结构文档。</p>
        </section>

        <section className="card child-traffic-distribution">
          <div className="section-head">
            <div>
              <h3>子体流量结构</h3>
              <p>默认展示流量 TOP3 子体 · 其余折叠 · 条长按总分缩放</p>
            </div>
            <SourceBadge>SIF MCP</SourceBadge>
          </div>
          <div className="child-traffic-compare-grid">
            {products.map((p, i) => {
              const data = trafficOverviewByAsin[p.asin];
              return (
                <div className="child-traffic-card" key={p.asin}>
                  <div className="child-traffic-card-head">
                    <ProductHeader product={p} index={i} market={market} />
                    <small>{trafficChildCountLabel(data, stageOutputView.trafficData.detailAvailability?.[p.asin]?.children)} · 总分 {formatTrafficScore(data?.totalScore)}</small>
                  </div>
                  <ChildTrafficStructurePanel variants={data?.children ?? []} state={stageOutputView.trafficData.detailAvailability?.[p.asin]?.children} />
                </div>
              );
            })}
          </div>
        </section>

        <section className="card compare-chart-card monthly-traffic-card">
          <div className="section-head">
            <div>
              <h3>月流量趋势对比</h3>
              <p>按品牌分组 · 近6个月自然 / 广告堆叠柱 · 更新至 {trafficMeta.updatedThrough}</p>
            </div>
            <SourceBadge>SIF MCP</SourceBadge>
          </div>
          <div className="monthly-traffic-legends">
            <div className="chart-legend">
              <span><i style={{ background: sifMonthlyTrafficMeta.naturalColor }} />自然流量</span>
              <span><i style={{ background: sifMonthlyTrafficMeta.adColor }} />广告流量</span>
            </div>
            <div className="chart-legend">
              {products.map((p, i) => <span key={p.asin}><i style={{ background: colors[i] }} />{p.brand}</span>)}
            </div>
          </div>
          <MonthlyTrafficStackChart products={products} monthlyTrendByAsin={trafficMonthlyTrendByAsin} />
          <p className="traffic-data-note">{sifMonthlyTrafficMeta.note}</p>
        </section>

        <TrafficAnalysisConclusionSection products={products} market={market} trafficData={stageOutputView.trafficData} />
      </div>;
}
