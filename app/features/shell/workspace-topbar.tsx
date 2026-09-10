"use client";

import { AuthIdentityControl } from "../../auth-session-gate";
import Link from "next/link";
import { markets } from "../catalog/product-contracts";
import type { WorkspaceController } from "../workspace/use-workspace-controller";

type WorkspaceTopbarProps = Pick<WorkspaceController, "products" | "market" | "pageTitle" | "authSession" | "activeTab" | "savingKeywordCompare" | "activeAsins" | "saveKeywordCompareProject" | "runAnalysis" | "savingTrafficPromo" | "inputs" | "saveTrafficPromoProject" | "savingChecklist" | "saveChecklistProject" | "tabHref" | "savedReportView" | "downloadSavedAnalysisReports">;

export function WorkspaceTopbar({ products, market, pageTitle, authSession, activeTab, savingKeywordCompare, activeAsins, saveKeywordCompareProject, runAnalysis, savingTrafficPromo, inputs, saveTrafficPromoProject, savingChecklist, saveChecklistProject, tabHref, savedReportView, downloadSavedAnalysisReports }: WorkspaceTopbarProps) {
  return <header className="topbar">
        <div>
          <p className="eyebrow">{products[0]?.subRankCategory && products[0].subRankCategory !== "等待同步" ? products[0].subRankCategory : "竞品分析"} · Amazon {markets[market].short}</p>
          <h1>{pageTitle}</h1>
        </div>
        <div className="top-actions">
          <AuthIdentityControl session={authSession} />
          {activeTab === "keywords" ? (
            <>
              <button
                type="button"
                className="ghost-btn"
                disabled={savingKeywordCompare || activeAsins.length < 3}
                onClick={() => void saveKeywordCompareProject()}
              >
                {savingKeywordCompare ? "保存中…" : "保存到流量词对比"}
              </button>
              <button type="button" className="primary-btn" onClick={() => void runAnalysis()}>
                抓取关键词数据
              </button>
            </>
          ) : activeTab === "traffic" ? (
            <>
              <button
                type="button"
                className="ghost-btn"
                disabled={savingTrafficPromo || inputs.filter(Boolean).length < 3}
                onClick={() => void saveTrafficPromoProject()}
              >
                {savingTrafficPromo ? "保存中…" : "保存到推广能力分析"}
              </button>
              <button type="button" className="primary-btn" onClick={() => void runAnalysis()}>
                抓取流量数据
              </button>
            </>
          ) : activeTab === "checklist" ? (
            <>
              <button
                type="button"
                className="ghost-btn"
                disabled={savingChecklist || activeAsins.length < 3}
                onClick={() => void saveChecklistProject()}
              >
                {savingChecklist ? "保存中…" : "保存到项目确认清单"}
              </button>
              <Link className="primary-btn" href={tabHref("overview")}>管理竞品 ASIN</Link>
            </>
          ) : (
            <>
              <button
                type="button"
                className="ghost-btn"
                disabled={!savedReportView}
                onClick={downloadSavedAnalysisReports}
              >
                导出对比报告
              </button>
              <Link className="primary-btn" href={tabHref("overview")}>管理竞品 ASIN</Link>
            </>
          )}
        </div>
      </header>;
}
