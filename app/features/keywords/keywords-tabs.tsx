"use client";

import Link from "next/link";
import { StageOutputGapCard } from "../sync/stage-output-gap-card";
import { KeywordFetchStatusSection } from "./keyword-fetch-status";
import { KeywordDemandSection } from "./keyword-demand-section";
import { MAX_ASIN_SLOTS } from "../projects/workspace-navigation";
import { type MarketCode, markets } from "../catalog/product-contracts";
import type { WorkspaceController } from "../workspace/use-workspace-controller";

type KeywordsTabProps = Pick<WorkspaceController, "market" | "setMarket" | "setMessage" | "inputs" | "setInputs" | "tabHref" | "currentProjectName" | "slugParam" | "showBuilderNotice" | "message" | "savingKeywordCompare" | "activeAsins" | "saveKeywordCompareProject" | "runAnalysis" | "stageOutputSnapshot" | "products" | "syncAsins" | "syncResume" | "keywordAnalysisByAsin" | "keywordEnrichmentByKeyword" | "refreshRuntimeAfterSync" | "handleKeywordsTabOnRequestSync" | "handleKeywordsTabOnSyncDismiss">;

export function KeywordsTab({ market, setMarket, setMessage, inputs, setInputs, tabHref, currentProjectName, slugParam, showBuilderNotice, message, savingKeywordCompare, activeAsins, saveKeywordCompareProject, runAnalysis, stageOutputSnapshot, products, syncAsins, syncResume, keywordAnalysisByAsin, keywordEnrichmentByKeyword, refreshRuntimeAfterSync, handleKeywordsTabOnRequestSync, handleKeywordsTabOnSyncDismiss }: KeywordsTabProps) {
  return <div className="page-content compare-page">
        <section className="card asin-builder">
          <div className="section-head">
            <div>
              <h3>本页独立设置竞品 ASIN</h3>
              <p>无需先去竞品概览；在此录入 3–10 个 ASIN，抓取关键词后即可保存到收藏夹「流量词对比」</p>
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
                  setMessage(`已切换至 ${markets[next].label}，关键词数据口径将同步更新`);
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
            <Link className="ghost-btn" href={tabHref("keyword-compare")}>
              ★ 流量词对比
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
            <button type="button" className="ghost-btn" disabled={savingKeywordCompare || activeAsins.length < 3} onClick={() => void saveKeywordCompareProject()}>
              {savingKeywordCompare ? "保存中…" : "保存到流量词对比"}
            </button>
            <button type="button" className="primary-btn" onClick={() => void runAnalysis()}>
              抓取关键词数据
            </button>
          </div>
        </section>

        <StageOutputGapCard snapshot={stageOutputSnapshot} stage="keywords" />
        <KeywordFetchStatusSection
          products={products.map(p => ({ asin: p.asin, brand: p.brand, image: p.image }))}
          marketplace={market}
          syncRequest={syncAsins}
          syncResume={syncResume}
          keywordAnalysisByAsin={keywordAnalysisByAsin}
          keywordEnrichmentByKeyword={keywordEnrichmentByKeyword}
          onRequestSync={handleKeywordsTabOnRequestSync}
          onSyncComplete={async () => {
            await refreshRuntimeAfterSync("关键词相关数据已就绪，可继续分析或保存到流量词对比");
          }}
          onSyncDismiss={handleKeywordsTabOnSyncDismiss}
        />

        <KeywordDemandSection
          mode="analysis"
          products={products.map(p => ({ asin: p.asin, brand: p.brand, title: p.title, subRankCategory: p.subRankCategory, image: p.image, price: p.price }))}
          sources={{ analysisByAsin: keywordAnalysisByAsin, enrichmentByKeyword: keywordEnrichmentByKeyword }}
        />
      </div>;
}

type KeywordInsightTabProps = Pick<WorkspaceController, "stageOutputSnapshot" | "products" | "keywordAnalysisByAsin" | "keywordEnrichmentByKeyword">;

export function KeywordInsightTab({ stageOutputSnapshot, products, keywordAnalysisByAsin, keywordEnrichmentByKeyword }: KeywordInsightTabProps) {
  return <div className="page-content compare-page">
        <StageOutputGapCard snapshot={stageOutputSnapshot} stage="keywords" />
        <KeywordDemandSection
          mode="insight"
          products={products.map(p => ({ asin: p.asin, brand: p.brand, title: p.title, subRankCategory: p.subRankCategory, image: p.image, price: p.price }))}
          sources={{ analysisByAsin: keywordAnalysisByAsin, enrichmentByKeyword: keywordEnrichmentByKeyword }}
        />
      </div>;
}
