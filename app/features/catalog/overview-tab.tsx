"use client";

import { AsinSyncProgressSection } from "../sync/asin-sync-funnel";
import { sorftimeSalesTrendMeta } from "../../sorftime-sales-trend-data";
import { sorftimeFbaFeeMeta } from "../../sorftime-fba-fee-data";
import { sorftimeChildSales30d } from "../../sorftime-child-sales-data";
import { sorftimePriceStrategies, sorftimePriceStrategyMeta } from "../../sorftime-price-strategy-data";
import { StageOutputGapNotice } from "../sync/stage-output-gap-notice";
import { projectWorkspacePath } from "../../lib/workspace-url";
import Link from "next/link";
import { BatchAsinInput } from "../sync/batch-asin-input";
import { WorkspaceHistoryStrip } from "../projects/workspace-history-strip";
import { AnalysisProjectFavoriteButton } from "../projects/analysis-project-favorite-button";
import { StageOutputGapCard } from "../sync/stage-output-gap-card";
import { CategoryNodeTrendSection } from "../../category-node-trend-section";
import { resolveOverviewPrice, resolveOverviewRank } from "../../lib/competitor-overview-fallback";
import { resolveRatingMetric, resolveFbaMetric, resolvePriceMetric } from "../../lib/competitor-metric-resolution";
import { RatingCell } from "../../components/amazon-star-rating";
import { XydcVariantSection } from "../../xydc-variant-section";
import { type MarketCode, markets, sellerSpriteOnlyFieldsUnavailable, variationTheme } from "./product-contracts";
import { SourceBadge } from "../../components/source-badge";
import { ProductHeader } from "../../components/product-header";
import { SalesTrendSparkline, ChildSalesBars, ComparisonChart } from "../charts/sales-charts";
import { colors } from "../charts/chart-format";
import type { WorkspaceController } from "../workspace/use-workspace-controller";

type OverviewTabProps = Pick<WorkspaceController, "market" | "setMarket" | "setMessage" | "workspaceLabel" | "setWorkspaceLabel" | "asinDraft" | "asinParse" | "setAsinDraft" | "workspaces" | "currentProjectId" | "mixedFamilies" | "projectFavorites" | "tabHref" | "currentProjectName" | "slugParam" | "showBuilderNotice" | "message" | "runAnalysis" | "activeAsins" | "syncAsins" | "syncResume" | "refreshRuntimeAfterSync" | "stageOutputSnapshot" | "products" | "categoryTrendByNode" | "reviewGapReasonCode" | "reviewAnalysisByAsin" | "fbaGapReasonCode" | "fbaFeeByAsin" | "salesTrendByAsin" | "ratingByAsin" | "childSalesByAsin" | "priceStrategyByAsin" | "salesView" | "setSalesView" | "runtimeAnalysisData" | "runtimeAnalysisDataScope" | "runtimeScopeKey" | "handleOverviewTabOnRequestSync" | "handleOverviewTabOnSyncDismiss">;

export function OverviewTab({ market, setMarket, setMessage, workspaceLabel, setWorkspaceLabel, asinDraft, asinParse, setAsinDraft, workspaces, currentProjectId, mixedFamilies, projectFavorites, tabHref, currentProjectName, slugParam, showBuilderNotice, message, runAnalysis, activeAsins, syncAsins, syncResume, refreshRuntimeAfterSync, stageOutputSnapshot, products, categoryTrendByNode, reviewGapReasonCode, reviewAnalysisByAsin, fbaGapReasonCode, fbaFeeByAsin, salesTrendByAsin, ratingByAsin, childSalesByAsin, priceStrategyByAsin, salesView, setSalesView, runtimeAnalysisData, runtimeAnalysisDataScope, runtimeScopeKey, handleOverviewTabOnRequestSync, handleOverviewTabOnSyncDismiss }: OverviewTabProps) {
  return <div className="page-content compare-page">
        <section className="card asin-builder">
          <div className="section-head"><div><h3>设置对标竞品</h3><p>工作区按「类目 + 站点」分开：美国落地灯是 /p/floor-lamps-us，英国站会是 /p/floor-lamps-uk。同一站点再开一批细分（如儿童三轮 vs 成人滑板车）会再生成新地址。输入 3–10 个 ASIN 后点「开始全自动分析」。</p></div><span className="required-note">3–10 个</span></div>
          <div className="asin-builder-body">
            <div className="builder-meta-row">
            <label className="market-inline">目标市场<select value={market} onChange={e=>{const next=e.target.value as MarketCode;setMarket(next);setMessage(`已切换至 ${markets[next].label}，ASIN 链接与数据口径将同步更新`);}}>{Object.entries(markets).map(([code,item])=><option key={code} value={code}>{item.option}</option>)}</select></label>
            <label className="workspace-alias-field">
              细分名称
              <input
                value={workspaceLabel}
                onChange={e => setWorkspaceLabel(e.target.value)}
                placeholder="可选：儿童三轮 / 置物架灯 / Kids 3-Wheel"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            </div>
            <BatchAsinInput raw={asinDraft} result={asinParse} onRawChange={setAsinDraft} />
            {workspaces.length > 0 ? (
              <WorkspaceHistoryStrip
                workspaces={workspaces}
                currentProjectId={currentProjectId}
                buildHref={workspace => projectWorkspacePath(workspace.slug)}
              />
            ) : null}
            {mixedFamilies ? (
              <p className="mixed-family-note">
                当前表里混了不同品类。请分别打开对应工作区，不要把滑板车和落地灯放在同一页对比。
              </p>
            ) : null}
          </div>
          <div className="builder-actions">
            <AnalysisProjectFavoriteButton projectId={currentProjectId} favorites={projectFavorites} />
            <Link className="ghost-btn" href={tabHref("projects")}>收藏与历史</Link>
            {currentProjectName ? (
              <span className="builder-project-chip">
                当前工作区：{currentProjectName}
                {slugParam ? ` · /p/${slugParam}` : ""}
              </span>
            ) : null}
            {showBuilderNotice ? (
              <span
                className={
                  message.includes("请") || message.includes("不正确") || message.includes("重复")
                    ? "builder-message error"
                    : "builder-message"
                }
              >
                {message}
              </span>
            ) : null}
            <button className="primary-btn" onClick={runAnalysis}>开始全自动分析</button>
          </div>
        </section>

        {activeAsins.length > 0 || syncAsins ? (
        <AsinSyncProgressSection
          asins={activeAsins}
          marketplace={market}
          syncRequest={syncAsins}
          syncResume={syncResume}
          onRequestSync={handleOverviewTabOnRequestSync}
          onSyncComplete={async () => {
            await refreshRuntimeAfterSync("MCP 同步完成，最新分析数据已刷新");
          }}
          onSyncDismiss={handleOverviewTabOnSyncDismiss}
        />
        ) : null}

        <StageOutputGapCard snapshot={stageOutputSnapshot} stage="category" />
        <CategoryNodeTrendSection
          marketplace={market}
          products={products.map(p => ({ asin: p.asin, brand: p.brand, subRankCategory: p.subRankCategory }))}
          trendByNode={categoryTrendByNode}
        />

        {reviewGapReasonCode ? (
          <StageOutputGapNotice
            label="评论数据"
            asins={activeAsins}
            records={reviewAnalysisByAsin}
            reasonCode={reviewGapReasonCode}
          />
        ) : null}
        <StageOutputGapCard snapshot={stageOutputSnapshot} stage="sales_trend" />
        <StageOutputGapCard snapshot={stageOutputSnapshot} stage="child_sales" />
        <StageOutputGapCard snapshot={stageOutputSnapshot} stage="price_strategy" />
        {fbaGapReasonCode ? (
          <StageOutputGapNotice
            label="FBA费用"
            asins={activeAsins}
            records={fbaFeeByAsin}
            reasonCode={fbaGapReasonCode}
          />
        ) : null}
        <section className="card compare-table-card"><div className="section-head"><div><h3>竞品参数总览</h3><p>{slugParam ? `当前工作区 /p/${slugParam} · 仅展示本批对标 ASIN` : "同一工作区内的竞品对齐查看；不同品类请用各自的 /p/ 地址"}；点击 ASIN 可打开对应站点前台</p></div><SourceBadge>MCP 综合</SourceBadge></div><div className="matrix-wrap"><table className="compare-matrix"><thead><tr><th>指标</th>{products.map((p,i)=><th key={p.asin}><ProductHeader product={p} index={i} market={market}/></th>)}</tr></thead><tbody>
          <tr><th>当前售价</th>{products.map(p=>{const overview=resolveOverviewPrice(p.price, salesTrendByAsin[p.asin]);return <td key={p.asin}><strong>{overview.value===null?"—":`$${overview.value}`}</strong></td>})}</tr>
          <tr><th>30天销量<small className="insight-source">Sorftime · 悬停趋势图</small></th>{products.map((p,i)=><td key={p.asin}><SalesTrendSparkline asin={p.asin} sales30d={p.sales} color={colors[i]} trendByAsin={salesTrendByAsin}/></td>)}</tr>
          <tr><th>评分 / 评论<small className="insight-source">Sorftime MCP</small></th>{products.map(p=>{const metric=resolveRatingMetric(ratingByAsin[p.asin],p);return <td key={p.asin}>{metric.value?<>{metric.value.rating===null?<span>— / {metric.value.reviewCount?.toLocaleString() ?? "—"}</span>:<RatingCell rating={metric.value.rating} reviews={metric.value.reviewCount}/>} {metric.label?<small className="no-data-text">{metric.label}</small>:null}</>:<span className="no-data-text">{metric.label}</span>}</td>})}</tr>
          <tr><th>Best Seller Rank</th>{products.map(p=>{const overview=resolveOverviewRank(p.rank, p.subRank, salesTrendByAsin[p.asin]);return <td key={p.asin}>{overview.value===null?"—":overview.source==="sellerSprite"?<div className="rank-lines"><b>#{overview.value.toLocaleString()} in {p.rankCategory}</b>{p.subRank===null?null:<small>#{p.subRank} in {p.subRankCategory}</small>}</div>:<div className="rank-lines"><b>#{overview.value.toLocaleString()}</b><small>类目：卖家精灵未返回</small></div>}</td>})}</tr>
          <tr><th>购物车卖家</th>{products.map(p=><td key={p.asin}>{sellerSpriteOnlyFieldsUnavailable(p)?"SellerSprite 暂不可用":p.buyBoxSeller}</td>)}</tr>
          <tr><th>配送方式</th>{products.map(p=><td key={p.asin}>{sellerSpriteOnlyFieldsUnavailable(p)?"SellerSprite 暂不可用":p.fulfillment}</td>)}</tr>
          <tr><th>产品包装</th>{products.map(p=><td key={p.asin}><b>{p.packageSize}</b><small>{p.packageWeight}</small></td>)}</tr>
          <tr><th>FBA 费用</th>{products.map(p=>{const record=fbaFeeByAsin[p.asin];const metric=resolveFbaMetric(record);return <td key={p.asin}>{metric.value!=null?<div className="fba-fee-cell"><strong>${metric.value.toFixed(2)}</strong>{record?.packageSize?<small title={record.note??undefined}>{record.packageSize}{record.packageWeight?` · ${record.packageWeight}`:""}</small>:null}<small className="insight-source">{record?.source === "keepa" ? "Keepa · 配送费" : "Sorftime · FBA 费用估算"}</small></div>:<span className="no-data-text">{metric.label ?? sorftimeFbaFeeMeta.emptyMessage}</span>}</td>})}</tr>
          <tr><th>产品规格<small className="insight-source">Features &amp; Specs</small></th>{products.map(p=><td key={p.asin}><div className="spec-lines">{p.specifications.map(spec=><div key={spec}>{spec}</div>)}</div></td>)}</tr>
          <tr><th>上架时间</th>{products.map(p=><td key={p.asin}>{p.launch}</td>)}</tr><tr><th>变体主题</th>{products.map(p=><td key={p.asin}>{variationTheme(p)}</td>)}</tr><tr><th>变体数量</th>{products.map(p=><td key={p.asin}>{p.variants}</td>)}</tr>
          <tr><th>近30天子体销量<small className="insight-source">Sorftime MCP</small></th>{products.map(p=>{const items=[...((childSalesByAsin[p.asin] as typeof sorftimeChildSales30d[string] | undefined)??[])].sort((a,b)=>b.sales-a.sales||a.variant.localeCompare(b.variant)).slice(0,5);return <td key={p.asin}><ChildSalesBars items={items}/></td>})}</tr>
          <tr><th>价格策略分析<small className="insight-source">Sorftime MCP</small></th>{products.map(p=>{const strategy=priceStrategyByAsin[p.asin] as typeof sorftimePriceStrategies[string] | undefined;const metric=resolvePriceMetric(strategy,p.price);return <td key={p.asin}>{strategy&&metric.source==="sorftime"?<div className="price-strategy-cell"><p><b>定价锚点</b>{strategy.anchor}</p><p><b>促销手法</b>{strategy.promotion}</p><p><b>折扣心理</b>{strategy.psychology}</p><small>{strategy.evidence}</small></div>:<span className="no-data-text">{metric.label ?? sorftimePriceStrategyMeta.emptyMessage}</span>}</td>})}</tr>
          <tr><th>主要卖点<small className="insight-source">Amazon Bullet Point 总结</small></th>{products.map(p=><td key={p.asin} className="selling-points-cell"><ul>{p.sellingPoints.map((point,index)=><li key={`${p.asin}-bp-${index}`}>{point}</li>)}</ul></td>)}</tr>
        </tbody></table></div></section>

        <section className="card compare-chart-card sales-combined-card">
          <div className="section-head">
            <div>
              <h3>竞品历史数据追踪</h3>
              <p>
                {salesView === "history"
                  ? "月销量 · 同一坐标系查看增速、体量与拐点"
                  : salesView === "revenue"
                    ? "月销售额 · Sorftime SalesAmount · USD"
                    : salesView === "prices"
                      ? "历史价格 · 月均价 · USD"
                      : "大类 BSR · 越靠上表现越优"}
                {sorftimeSalesTrendMeta.updatedAt ? ` · 同步至 ${sorftimeSalesTrendMeta.updatedAt}` : ""}
              </p>
            </div>
            <div className="chart-head-actions">
              <div className="chart-view-switch" role="group" aria-label="切换历史数据指标">
                <button className={salesView === "history" ? "selected" : ""} aria-pressed={salesView === "history"} onClick={() => setSalesView("history")}>
                  月销量
                </button>
                <button className={salesView === "revenue" ? "selected" : ""} aria-pressed={salesView === "revenue"} onClick={() => setSalesView("revenue")}>
                  月销售额
                </button>
                <button className={salesView === "prices" ? "selected" : ""} aria-pressed={salesView === "prices"} onClick={() => setSalesView("prices")}>
                  历史价格
                </button>
                <button className={salesView === "ranks" ? "selected" : ""} aria-pressed={salesView === "ranks"} onClick={() => setSalesView("ranks")}>
                  大类 BSR
                </button>
              </div>
              <SourceBadge>Sorftime MCP</SourceBadge>
            </div>
          </div>
          <div className="chart-legend">
            {products.map((p, i) => (
              <span key={p.asin}>
                <i style={{ background: colors[i] }} />
                {p.brand}
              </span>
            ))}
          </div>
          <ComparisonChart key={salesView} products={products} metric={salesView} inverse={salesView === "ranks"} trendByAsin={salesTrendByAsin} />
        </section>

        <XydcVariantSection
          products={products.map(product => ({
            asin: product.asin,
            brand: product.brand,
            title: product.title,
            image: product.image,
          }))}
          families={runtimeAnalysisData?.variants.families ?? []}
          orderFamilies={runtimeAnalysisData?.variantOrders.families ?? []}
          progress={runtimeAnalysisDataScope === runtimeScopeKey ? runtimeAnalysisData?.xydcOrderProgress ?? null : null}
          market={markets[market]}
        />
      </div>;
}
