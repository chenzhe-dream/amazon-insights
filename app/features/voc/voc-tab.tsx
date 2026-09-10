"use client";

import { sorftimeReviewAnalysisMeta as sorftimeReviewDataMeta } from "../../sorftime-review-analysis-data";
import { reviewMissingMessage } from "../../lib/voc-review-display";
import { StageOutputGapNotice } from "../sync/stage-output-gap-notice";
import { manualVocDisplayMeta, manualVocDimensions, manualVocSourceBadge } from "./voc-display-schema";
import { VocDimensionLabel } from "./voc-dimension-label";
import { AlexaVocImportPanel } from "./alexa-voc-import-panel";
import { sorftimeReviewAnalysisMeta } from "../../seller-sprite-review-analysis";
import { savedReportStageLabels } from "../projects/workspace-navigation";
import { SourceBadge } from "../../components/source-badge";
import { ProductHeader } from "../../components/product-header";
import { renderVocMatrixItem, ReviewAnalysisMatrixSection } from "./review-analysis-matrix";
import { VocSevenDimensionInsightSection } from "./voc-seven-dimension-insight";
import { VocRunStatusSummary } from "./voc-run-status-summary";
import type { WorkspaceController } from "../workspace/use-workspace-controller";

type VocTabProps = Pick<WorkspaceController, "products" | "authSession" | "alexaVocPageScope" | "manualVoc" | "market" | "reviewGapReasonCode" | "activeAsins" | "reviewAnalysisByAsin" | "reviewRefreshFailed" | "stageOutputSnapshot" | "manualVocByAsin" | "vocRun" | "cancelCurrentVocRun" | "retryCurrentVocStage" | "savedReportView" | "selectSavedReportVersion">;

export function VocTab({ products, authSession, alexaVocPageScope, manualVoc, market, reviewGapReasonCode, activeAsins, reviewAnalysisByAsin, reviewRefreshFailed, stageOutputSnapshot, manualVocByAsin, vocRun, cancelCurrentVocRun, retryCurrentVocStage, savedReportView, selectSavedReportVersion }: VocTabProps) {
  return <div className="page-content compare-page">
        <section className="card page-intro"><div><span className="status-chip">多竞品 VOC 对比</span><h2>七个相同维度同屏对齐，直接比较顾客关注与购买决策差异</h2><p>入口：Alexa for Shopping 对话框 · 中文七问一次性提交 · 输出完整报告 · 数据源为 Customer Review（经 Alexa 整理）。</p></div><SourceBadge>{products.length} 个 ASIN 同屏</SourceBadge></section>
        <section className="card voc-dimension-format-card">
          <div className="section-head"><div><h3>VOC 核心主题 · 七维格式</h3><p>矩阵左列展示格式说明，各 ASIN 列按同一结构对齐</p></div><SourceBadge>{manualVocDisplayMeta.source}</SourceBadge></div>
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
        </section>
        <AlexaVocImportPanel
          key={`${authSession.sessionIdentity}:${authSession.user.organizationId}`}
          projectId={alexaVocPageScope.authoritativeImportScope?.projectId ?? null}
          runId={alexaVocPageScope.authoritativeImportScope?.runId ?? null}
          products={products.map(p => ({ asin: p.asin, brand: p.brand, title: p.title }))}
          effectiveVocByAsin={manualVoc.effectiveVocByAsin}
          statusByAsin={manualVoc.statusByAsin}
          onImported={manualVoc.onImported}
          pollingEnabled={alexaVocPageScope.canPoll}
          disabled={market !== "US" || !alexaVocPageScope.authoritativeImportScope}
        />
        <section className="card voc-matrix-card">
          <div className="section-head">
            <div><h3>VOC 核心主题</h3><p>{manualVocDisplayMeta.scope}</p></div>
            <SourceBadge>Authenticated API</SourceBadge>
            {Object.values(manualVoc.statusByAsin).some(status => status === "source-error" || status === "protocol-conflict")
              ? <button type="button" className="ghost-btn" onClick={() => void manualVoc.refresh()}>重试读取 VOC</button>
              : null}
          </div>
          <div className="matrix-wrap">
            <table className="compare-matrix voc-matrix">
              <thead>
                <tr>
                  <th>VOC 维度</th>
                  {products.map((product, index) => {
                    const badge = manualVocSourceBadge(manualVoc.effectiveVocByAsin[product.asin] ?? null);
                    const status = manualVoc.statusByAsin[product.asin];
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
                    const overlayRecord = manualVoc.effectiveVocByAsin[product.asin] ?? null;
                    const record = overlayRecord?.normalizedRecord;
                    const status = manualVoc.statusByAsin[product.asin];
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
        {reviewGapReasonCode ? (
          <StageOutputGapNotice
            label="评论数据"
            asins={activeAsins}
            records={reviewAnalysisByAsin}
            reasonCode={reviewGapReasonCode}
          />
        ) : null}
        {reviewRefreshFailed ? <p role="status">本次评论结果读取失败；如有本项目已验证结果，将继续保留显示。重新进入 VOC 页可重试读取。</p> : null}
        <ReviewAnalysisMatrixSection
          title="智能评论分析"
          description="Sorftime MCP · 按实际返回的 Customers Say 主题及评论样本展示 · 六维同屏对齐 · 格式：【分类】+ 提及占比；各 ASIN 的样本数和采集时间见表头。"
          badge="Sorftime MCP"
          data={reviewAnalysisByAsin}
          missingMessages={Object.fromEntries(activeAsins.map(asin => [asin, reviewMissingMessage(stageOutputSnapshot.reviews, asin)]))}
          dataMeta={{ ...sorftimeReviewDataMeta, updatedAt: stageOutputSnapshot.reviews && "updatedAt" in stageOutputSnapshot.reviews ? stageOutputSnapshot.reviews.updatedAt : "当前项目结果尚未读取" }}
          configMeta={sorftimeReviewAnalysisMeta}
          pendingSteps={
            <>
              服务端 Sorftime 连接器尚未配置或数据尚未同步。请联系管理员配置连接器后运行{" "}
              <code>{sorftimeReviewAnalysisMeta.syncCommand}</code>。
            </>
          }
          products={products}
          market={market}
        />
        <VocSevenDimensionInsightSection products={products} manualVocByAsin={manualVocByAsin} reviewAnalysisData={reviewAnalysisByAsin} />
        <section className="card launch-block" data-voc-run={vocRun?.runId ?? undefined}>
            <VocRunStatusSummary observation={vocRun} />
            {vocRun?.kind === "active" ? (
              <button type="button" className="ghost-btn" onClick={() => void cancelCurrentVocRun()}>取消运行</button>
            ) : null}
            {vocRun?.kind === "failed" ? (
              <button type="button" className="ghost-btn" onClick={() => void retryCurrentVocStage()}>重试 VOC 阶段</button>
            ) : null}
            {vocRun?.kind === "waiting-input" ? <p>需要补齐可信 VOC 数据后再重试；不会自动采集外部数据。</p> : null}
            {savedReportView ? (
              <div data-saved-analysis-reports={savedReportView.runId}>
                {savedReportView.stages.map((slot) => (
                  <article key={slot.stage} data-report-stage={slot.stage}>
                    <strong>{savedReportStageLabels[slot.stage]} · {slot.stage}</strong>
                    {slot.history.length ? (
                      <label>
                        已保存报告版本
                        <select
                          value={slot.selected?.id ?? ""}
                          onChange={(event) => void selectSavedReportVersion(slot.stage, event.target.value)}
                        >
                          {slot.history.map((report) => (
                            <option key={report.id} value={report.id}>
                              v{report.version} · {report.status}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : (
                      <p>暂无已保存报告</p>
                    )}
                    {slot.selected ? (
                      <>
                        <p>
                          Report {slot.selected.id} · v{slot.selected.version} · {slot.selected.status}
                        </p>
                        <p>
                          Skill {slot.selected.skill.id}@{slot.selected.skill.version}
                        </p>
                        <details>
                          <summary>查看已保存结果</summary>
                          <pre>{JSON.stringify(slot.selected.result, null, 2)}</pre>
                        </details>
                      </>
                    ) : null}
                  </article>
                ))}
              </div>
            ) : null}
          </section>
      </div>;
}
