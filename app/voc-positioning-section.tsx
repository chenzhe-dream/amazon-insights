"use client";

import { useMemo } from "react";
import {
  buildProductLaunchAnalysis,
  hasProductLaunchAnalysis,
  type ProductLaunchRuntimeSources,
} from "./product-launch-analysis";
import { LaunchSection, LaunchTable } from "./launch-section";
import { AnalysisRuleExplanation, RuleDecisionExplanation } from "./analysis-rule-explanation";
import { ActionStepsCell } from "./action-steps-cell";

type PositioningProduct = {
  asin: string;
  brand: string;
  title?: string;
  price?: number | null;
  sales?: number | null;
  subRankCategory?: string;
};

function priorityChipClass(priority: string) {
  if (priority === "P0") return "launch-priority-chip p0";
  if (priority === "P1") return "launch-priority-chip p1";
  if (priority === "P2") return "launch-priority-chip p2";
  if (priority === "P3") return "launch-priority-chip p3";
  return "launch-priority-chip pending";
}

function PriorityChip({ priority }: { priority: string }) {
  return <span className={priorityChipClass(priority)}>{priority}</span>;
}

function roleChipClass(role: string) {
  if (role === "核心保留") return "launch-role-chip keep";
  if (role === "保留并重做") return "launch-role-chip rework";
  if (role === "差异化突破") return "launch-role-chip breakthrough";
  if (role === "新品避坑") return "launch-role-chip avoid";
  if (role === "选择性优化") return "launch-role-chip selective";
  if (role === "观察/伪需求") return "launch-role-chip observe";
  return "launch-role-chip pending";
}

function RoleChip({ role }: { role: string }) {
  return <span className={roleChipClass(role)}>{role}</span>;
}

function rowDecisionIds(row: unknown): string[] | undefined {
  if (!row || typeof row !== "object" || !("ruleDecisionIds" in row)) return undefined;
  const value = (row as { ruleDecisionIds?: unknown }).ruleDecisionIds;
  return Array.isArray(value) && value.every(item => typeof item === "string") ? value : undefined;
}

export function VocPositioningSection({ products, sources }: {
  products: PositioningProduct[];
  sources: ProductLaunchRuntimeSources;
}) {
  const analysis = useMemo(() => buildProductLaunchAnalysis(products, sources), [products, sources]);
  const ready = hasProductLaunchAnalysis(products, sources);
  const positioning = analysis.vocPositioning;

  return (
    <div className="launch-page">
      <section className="card launch-block launch-intro-block">
        <div className="launch-section-head">
          <div className="launch-section-head-main">
            <span className="status-chip">define-amazon-voc-positioning</span>
            <h2 className="launch-page-title">产品定义结论</h2>
            <p>
              将买家喜爱、差评问题与未满足需求三表合并，输出可执行的单款产品定位、优化优先级与验证清单。
            </p>
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
            数据源 <b>喜爱 · 差评 · 未满足</b>
          </span>
        </div>
      </section>

      <AnalysisRuleExplanation trace={analysis.ruleTrace} resultAvailable={ready} />

      {!ready ? (
        <section className="card launch-block">
          <div className="pending-box">
            待 VOC 核心主题或 Sorftime 智能评论分析就绪后，自动生成产品定义结论。请先在「竞品VOC 汇总」与「竞品 VOC 洞察」确认三表数据已同步。
          </div>
        </section>
      ) : (
        <LaunchSection
          title="产品定义结论"
          description="Skill define-amazon-voc-positioning · 喜爱×差评×未满足三表合并，输出可执行单款定位"
          badge={<span className="status-chip">VOC 定位</span>}
        >
          <div className="definition-synthesis">
            <p className="definition-synthesis-merged">{positioning.oneLiner}</p>
            <ul className="launch-reason-list">
              {positioning.rationale.map(item => (
                <li key={item}>{item}</li>
              ))}
            </ul>

            <h4 className="voc-pos-subtitle">产品定位方向表</h4>
            <LaunchTable>
              <thead>
                <tr>
                  <th>定位维度</th>
                  <th>定位结论</th>
                  <th>数据依据</th>
                  <th>优先级</th>
                  <th>产品动作</th>
                  <th>判定依据</th>
                </tr>
              </thead>
              <tbody>
                {positioning.dimensionRows.map(row => (
                  <tr key={row.dimension}>
                    <th>{row.dimension}</th>
                    <td>{row.conclusion}</td>
                    <td className="launch-muted">{row.evidence}</td>
                    <td>
                      <PriorityChip priority={row.priority} />
                    </td>
                    <td className="launch-muted">{row.action}</td>
                    <td><RuleDecisionExplanation trace={analysis.ruleTrace} decisionIds={rowDecisionIds(row)} /></td>
                  </tr>
                ))}
              </tbody>
            </LaunchTable>

            <h4 className="voc-pos-subtitle">三表合并判断</h4>
            <LaunchTable>
              <thead>
                <tr>
                  <th>需求主题</th>
                  <th>喜爱占比</th>
                  <th>差评占比</th>
                  <th>未满足占比</th>
                  <th>综合判断</th>
                  <th>产品角色</th>
                  <th>优先级</th>
                </tr>
              </thead>
              <tbody>
                {positioning.mergedThemes.map(row => (
                  <tr key={row.theme}>
                    <th>{row.theme}</th>
                    <td>{row.lovePct}</td>
                    <td>{row.negPct}</td>
                    <td>{row.unmetPct}</td>
                    <td className="launch-muted">{row.judgment}</td>
                    <td>
                      <RoleChip role={row.role} />
                    </td>
                    <td>
                      <PriorityChip priority={row.priority} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </LaunchTable>

            <h4 className="voc-pos-subtitle">待优化优先级表</h4>
            <LaunchTable>
              <thead>
                <tr>
                  <th>优先级</th>
                  <th>待优化方向</th>
                  <th>来源</th>
                  <th>提及量/占比</th>
                  <th>用户影响</th>
                  <th>产品动作</th>
                  <th>验收标准</th>
                  <th>风险/待验证</th>
                  <th>判定依据</th>
                </tr>
              </thead>
              <tbody>
                {positioning.optimizeRows.map(row => (
                  <tr key={`${row.priority}-${row.direction}`}>
                    <th>
                      <PriorityChip priority={row.priority} />
                    </th>
                    <td>{row.direction}</td>
                    <td>{row.source}</td>
                    <td>{row.mention}</td>
                    <td>{row.userImpact}</td>
                    <td>
                      <ActionStepsCell value={row.productAction} />
                    </td>
                    <td className="launch-muted">{row.acceptance}</td>
                    <td className="launch-muted">{row.risk}</td>
                    <td><RuleDecisionExplanation trace={analysis.ruleTrace} decisionIds={rowDecisionIds(row)} /></td>
                  </tr>
                ))}
              </tbody>
            </LaunchTable>

            <div className="definition-synthesis-grid voc-pos-lists">
              <article>
                <h4>必须保留的优势</h4>
                <ol>
                  {positioning.mustKeep.map(item => (
                    <li key={item}>{item}</li>
                  ))}
                </ol>
              </article>
              <article>
                <h4>必须避免的问题</h4>
                <ol>
                  {positioning.mustAvoid.map(item => (
                    <li key={item}>{item}</li>
                  ))}
                </ol>
              </article>
              <article>
                <h4>最值得验证的差异化</h4>
                <ol>
                  {positioning.mustValidate.map(item => (
                    <li key={item}>{item}</li>
                  ))}
                </ol>
              </article>
            </div>

            <div className="launch-checklist-hints">
              <strong>下一步验证</strong>
              <ul>
                {positioning.nextValidations.map(item => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <p className="definition-synthesis-gaps">{positioning.dataBoundary}</p>
          </div>
        </LaunchSection>
      )}

      <p className="voc-source-footnote launch-footnote">
        分析引擎：voc-positioning.ts · Skill define-amazon-voc-positioning · 更新 {analysis.meta.analyzedAt}
      </p>
    </div>
  );
}
