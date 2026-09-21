"use client";

import { useMemo } from "react";
import {
  buildProductLaunchAnalysis,
  hasProductLaunchAnalysis,
  type FinalDecision,
  type LaunchVerdict,
  type ProductLaunchRuntimeSources,
} from "./product-launch-analysis";
import { LaunchSection, LaunchTable } from "./launch-section";
import { AnalysisRuleExplanation, RuleDecisionExplanation } from "./analysis-rule-explanation";

type LaunchProduct = {
  asin: string;
  brand: string;
  title?: string;
  price?: number | null;
  sales?: number | null;
  subRankCategory?: string;
};

function verdictClass(status: LaunchVerdict) {
  if (status === "approve") return "launch-verdict approve";
  if (status === "conditional") return "launch-verdict conditional";
  return "launch-verdict hold";
}

function decisionClass(decision: FinalDecision) {
  if (decision === "优先立项") return "approve";
  if (decision === "建议小批量测试") return "conditional";
  return "hold";
}

function rowDecisionIds(row: unknown): string[] | undefined {
  if (!row || typeof row !== "object" || !("ruleDecisionIds" in row)) return undefined;
  const value = (row as { ruleDecisionIds?: unknown }).ruleDecisionIds;
  return Array.isArray(value) && value.every(item => typeof item === "string") ? value : undefined;
}

export function ProductLaunchRecommendationSection({ products, sources }: {
  products: LaunchProduct[];
  sources: ProductLaunchRuntimeSources;
}) {
  const analysis = useMemo(() => buildProductLaunchAnalysis(products, sources), [products, sources]);
  const ready = hasProductLaunchAnalysis(products, sources);

  return (
    <div className="launch-page">
      <section className="card launch-block launch-intro-block">
        <div className="launch-section-head">
          <div className="launch-section-head-main">
            <span className="status-chip">amazon-voc-insight</span>
            <h2 className="launch-page-title">竞品 VOC 洞察</h2>
            <p>执行摘要 → 明确结论 → 买家喜爱 → 差评优先级 → 未满足需求。产品定义结论见同组三级页。</p>
          </div>
          <span className="source-badge">
            {analysis.meta.productCount} 竞品 · {analysis.meta.dataMonth}
          </span>
        </div>
        <div className="launch-meta-row">
          <span>
            类目 <b>{analysis.meta.categoryLabel}</b>
          </span>
          <span>
            品牌 <b>{analysis.meta.brands.join(" / ")}</b>
          </span>
          <span>
            数据源 <b>{analysis.meta.sources.slice(0, 3).join(" · ")}</b>
          </span>
        </div>
      </section>

      <AnalysisRuleExplanation trace={analysis.ruleTrace} resultAvailable={ready} />

      {!ready ? (
        <section className="card launch-block">
          <div className="pending-box">
            待 VOC 核心主题或 Sorftime 智能评论分析就绪后，自动生成 VOC 立项分析报告。请先在「竞品VOC 汇总」页确认七维数据已同步。
          </div>
        </section>
      ) : (
        <>
          <section
            className={`card launch-block launch-verdict-block ${verdictClass(analysis.verdict.status)} ${decisionClass(analysis.finalDecision)}`}
          >
            <div className="launch-section-head">
              <div className="launch-section-head-main">
                <p className="launch-eyebrow">1. 执行摘要 · 四选一</p>
                <h3>{analysis.finalDecision}</h3>
                <p className="launch-exec-summary">{analysis.executiveSummary}</p>
              </div>
              <span className="status-chip">{analysis.verdict.title}</span>
            </div>
            <div className="launch-section-body">
              <ul className="launch-reason-list">
                {analysis.verdict.reasons.map(reason => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
          </section>

          <LaunchSection title="明确结论（先读这里）" description="五个核心问题的直接回答，对应摘要中的判断锚点">
            <LaunchTable className="launch-conclusion-table">
              <thead>
                <tr>
                  <th>问题</th>
                  <th>结论</th>
                </tr>
              </thead>
              <tbody>
                {analysis.conclusions.map(row => (
                  <tr key={row.question}>
                    <th>{row.question}</th>
                    <td>{row.answer}</td>
                  </tr>
                ))}
              </tbody>
            </LaunchTable>
          </LaunchSection>

          <LaunchSection
            title="买家喜爱优先级表"
            description="对齐亚马逊「买家喜爱什么」：高频好评=必须保留的卖点；强化方向含产品冻结项 + Listing/包装兑现动作"
          >
            <LaunchTable>
              <thead>
                <tr>
                  <th>喜爱主题</th>
                  <th>详情</th>
                  <th>提及频次</th>
                  <th>价值程度</th>
                  <th>是否行业共性</th>
                  <th>影响环节</th>
                  <th>是否建议保留</th>
                  <th>强化方向</th>
                  <th>判定依据</th>
                </tr>
              </thead>
              <tbody>
                {analysis.positivePriorityRows.map(row => (
                  <tr key={row.theme}>
                    <th>{row.theme}</th>
                    <td className="launch-muted">{row.detail}</td>
                    <td>{row.frequency}</td>
                    <td>
                      <span className={`launch-impact-chip impact-love-${row.valueLevel}`}>{row.valueLevel}</span>
                    </td>
                    <td>{row.industryWide}</td>
                    <td>{row.impactStages}</td>
                    <td>{row.shouldKeep}</td>
                    <td className="launch-muted">{row.leverageDirection}</td>
                    <td><RuleDecisionExplanation trace={analysis.ruleTrace} decisionIds={rowDecisionIds(row)} /></td>
                  </tr>
                ))}
              </tbody>
            </LaunchTable>
          </LaunchSection>

          <LaunchSection
            title="差评问题优先级表"
            description="解决方向对齐亚马逊「主要投诉→如何解决」：产品改动 + 包装/Listing 动作；无法映射时标「需人工介入」"
          >
            <LaunchTable>
              <thead>
                <tr>
                  <th>差评问题</th>
                  <th>提及频次</th>
                  <th>严重程度</th>
                  <th>是否行业共性</th>
                  <th>影响环节</th>
                  <th>是否建议解决</th>
                  <th>解决方向</th>
                  <th>判定依据</th>
                </tr>
              </thead>
              <tbody>
                {analysis.negativePriorityRows.map(row => (
                  <tr key={row.issue}>
                    <th>{row.issue}</th>
                    <td>{row.frequency}</td>
                    <td>
                      <span className={`launch-impact-chip impact-${row.severity}`}>{row.severity}</span>
                    </td>
                    <td>{row.industryWide}</td>
                    <td>{row.impactStages}</td>
                    <td>{row.shouldFix}</td>
                    <td className="launch-muted">{row.fixDirection}</td>
                    <td><RuleDecisionExplanation trace={analysis.ruleTrace} decisionIds={rowDecisionIds(row)} /></td>
                  </tr>
                ))}
              </tbody>
            </LaunchTable>
          </LaunchSection>

          <LaunchSection
            title="未满足需求机会表"
            description="优先：消费者反复提出 × 竞品解决较差 × 供应链可实现"
          >
            <LaunchTable>
              <thead>
                <tr>
                  <th>未满足需求</th>
                  <th>目标人群</th>
                  <th>使用场景</th>
                  <th>竞品解决情况</th>
                  <th>市场价值</th>
                  <th>实现难度</th>
                  <th>建议方案</th>
                  <th>判定依据</th>
                </tr>
              </thead>
              <tbody>
                {analysis.unmetOpportunityRows.map(row => (
                  <tr key={row.need}>
                    <th>{row.need}</th>
                    <td>{row.audience}</td>
                    <td>{row.scenario}</td>
                    <td>{row.competitorStatus}</td>
                    <td>{row.marketValue}</td>
                    <td>{row.difficulty}</td>
                    <td className="launch-muted">{row.proposal}</td>
                    <td><RuleDecisionExplanation trace={analysis.ruleTrace} decisionIds={rowDecisionIds(row)} /></td>
                  </tr>
                ))}
              </tbody>
            </LaunchTable>
          </LaunchSection>
        </>
      )}

      <p className="voc-source-footnote launch-footnote">
        分析引擎：product-launch-analysis.ts · 对齐 Skill amazon-voc-insight · 更新 {analysis.meta.analyzedAt}
      </p>
    </div>
  );
}
