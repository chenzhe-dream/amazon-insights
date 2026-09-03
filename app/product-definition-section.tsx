"use client";

import { useMemo } from "react";
import {
  buildProductLaunchAnalysis,
  hasProductLaunchAnalysis,
  type ProductLaunchRuntimeSources,
} from "./product-launch-analysis";
import { buildFinalProductDefinition } from "./final-product-definition";
import { ActionStepsCell } from "./action-steps-cell";
import { LaunchSection, LaunchTable } from "./launch-section";

type DefinitionProduct = {
  asin: string;
  brand: string;
  title?: string;
  price?: number | null;
  sales?: number | null;
  subRankCategory?: string;
  rankCategory?: string;
  productFamily?: "scooter" | "lighting" | "generic";
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
  if (role === "核心基础" || role === "核心强化") return "launch-role-chip keep";
  if (role === "保留并重做") return "launch-role-chip rework";
  if (role === "差异化突破") return "launch-role-chip breakthrough";
  if (role === "新品避坑") return "launch-role-chip avoid";
  if (role === "体验优化" || role === "可选配置") return "launch-role-chip selective";
  if (role === "暂不开发") return "launch-role-chip observe";
  return "launch-role-chip pending";
}

function RoleChip({ role }: { role: string }) {
  return <span className={roleChipClass(role)}>{role}</span>;
}

function gradeChipClass(grade: string) {
  if (grade === "A") return "launch-priority-chip p1";
  if (grade === "B") return "launch-priority-chip p2";
  if (grade === "C") return "launch-priority-chip pending";
  return "launch-priority-chip p0";
}

function demandChipClass(demand: string) {
  const text = demand.trim();
  if (text.startsWith("高") && !text.includes("中高")) return "final-demand-chip high";
  if (text.includes("中高")) return "final-demand-chip mid-high";
  if (text.startsWith("中")) return "final-demand-chip mid";
  if (text.includes("隐性") || text.includes("体验")) return "final-demand-chip implicit";
  if (text.includes("无法判断") || text === "—" || text === "待验证") return "final-demand-chip unknown";
  if (text.startsWith("低")) return "final-demand-chip low";
  return "final-demand-chip unknown";
}

function DemandChip({ demand, priority }: { demand: string; priority?: string }) {
  const tone = demandChipClass(demand);
  const focus = priority === "P0" && (tone.includes("implicit") || tone.includes("low")) ? " focus" : "";
  return <span className={`${tone}${focus}`}>{demand}</span>;
}

function FeatureLayerCard({
  title,
  items,
  tone = "default",
}: {
  title: string;
  items: Array<{ item: string; evidence: string }>;
  tone?: "default" | "avoid";
}) {
  return (
    <article className={tone === "avoid" ? "avoid" : undefined}>
      <h4>{title}</h4>
      <ul>
        {items.length ? (
          items.map(row => (
            <li key={row.item}>
              {row.item}
              <small className="final-def-evidence">{row.evidence}</small>
            </li>
          ))
        ) : (
          <li>暂无足够证据</li>
        )}
      </ul>
    </article>
  );
}

export function ProductDefinitionSection({ products, sources }: {
  products: DefinitionProduct[];
  sources: ProductLaunchRuntimeSources;
}) {
  const analysis = useMemo(() => buildProductLaunchAnalysis(products, sources), [products, sources]);
  const ready = hasProductLaunchAnalysis(products, sources);
  const priceBand =
    analysis.marketRows.find(row => row.metric.includes("价格"))?.data ??
    analysis.productDefinition.targetPrice;

  const report = useMemo(
    () =>
      buildFinalProductDefinition({
        categoryLabel: analysis.meta.categoryLabel,
        productCount: analysis.meta.productCount,
        dataMonth: analysis.meta.dataMonth,
        vocPositioning: analysis.vocPositioning,
        keyword: analysis.keywordConclusions,
        priceBand,
        hasVocData: ready,
      }),
    [analysis, priceBand, ready]
  );

  return (
    <div className="launch-page definition-page">
      <section className="card launch-block launch-intro-block">
        <div className="launch-section-head">
          <div className="launch-section-head-main">
            <span className="status-chip">define-amazon-product-from-voc-keywords</span>
            <h2 className="launch-page-title">新品定义</h2>
            <p>
              将「产品定义结论（VOC）」与「关键词需求分析」交叉验证，输出可进入 PRD 的最终产品定义：人群、场景、形态、功能分层、词群承接与机会等级。
            </p>
          </div>
          <span className="source-badge">
            {report.meta.productCount} 竞品 · {report.meta.dataMonth}
          </span>
        </div>
        <div className="launch-meta-row">
          <span>
            类目 <b>{report.meta.categoryLabel}</b>
          </span>
          <span>
            机会等级 <b>{ready ? report.opportunity.gradeLabel : "—"}</b>
          </span>
          <span>
            数据源 <b>VOC 定位 · 关键词需求 · 交叉矩阵</b>
          </span>
          <span>
            关键词 <b>{analysis.keywordConclusions?.hasData ? analysis.keywordConclusions.verdict.gradeLabel : "未就绪"}</b>
          </span>
        </div>
      </section>

      {!ready ? (
        <section className="card launch-block">
          <div className="pending-box">
            待 VOC 核心主题就绪后生成最终产品定义。请先完成「竞品 VOC 洞察」与「产品定义结论」页同步。
          </div>
        </section>
      ) : (
        <>
          <LaunchSection
            title="1. 最终产品定义结论"
            description="8 格要点与「产品定义结论 · 定位方向表」同源，完整展示不截断"
            badge={<span className={gradeChipClass(report.opportunity.grade)}>{report.opportunity.gradeLabel}</span>}
          >
            <div className="definition-synthesis">
              <div className="final-oneliner-grid">
                {report.oneLinerCards.map(card => (
                  <article key={card.key} className={`final-oneliner-card tone-${card.tone}`}>
                    <span className="final-oneliner-label">{card.label}</span>
                    <strong>{card.value}</strong>
                  </article>
                ))}
              </div>
              <div className="final-oneliner-full">
                <h4 className="voc-pos-subtitle">完整一句话定义</h4>
                <p className="definition-synthesis-merged">{report.oneLiner}</p>
              </div>
              <h4 className="voc-pos-subtitle">为什么选这个方向</h4>
              <div className="final-rationale-grid">
                {report.rationale.map(item => (
                  <article key={item.key} className={`final-rationale-card tone-${item.tone}`}>
                    <span className="final-rationale-label">{item.label}</span>
                    {item.highlight ? <strong className="final-rationale-highlight">{item.highlight}</strong> : null}
                    <p>{item.value}</p>
                  </article>
                ))}
              </div>
            </div>
          </LaunchSection>

          <LaunchSection title="2. 机会等级与决策" description="A建议立项 · B优化后立项 · C观察/小范围验证 · D不建议">
            <LaunchTable className="launch-conclusion-table">
              <thead>
                <tr>
                  <th>机会等级</th>
                  <th>最终判断</th>
                  <th>需求依据</th>
                  <th>进入方式</th>
                  <th>主要风险</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th>
                    <span className={gradeChipClass(report.opportunity.grade)}>{report.opportunity.gradeLabel}</span>
                  </th>
                  <td>{report.opportunity.judgment}</td>
                  <td className="launch-muted">{report.opportunity.demandBasis}</td>
                  <td>{report.opportunity.entryPath}</td>
                  <td className="launch-muted">{report.opportunity.mainRisks}</td>
                </tr>
              </tbody>
            </LaunchTable>
            <p className="definition-synthesis-gaps">{report.opportunity.note}</p>
          </LaunchSection>

          <LaunchSection
            title="3. VOC 与关键词交叉验证表"
            description="搜索需求 ≠ 产品需求；体验痛点不因搜索弱而删除 · 市场需求色标：红=高 · 橙=中高 · 蓝=中 · 紫=低/隐性 · P0 另加红框"
          >
            <LaunchTable stickyHeader>
              <thead>
                <tr>
                  <th>需求主题</th>
                  <th>VOC证据</th>
                  <th>关键词证据</th>
                  <th>市场需求</th>
                  <th>用户价值</th>
                  <th>竞争供给</th>
                  <th>综合判断</th>
                  <th>产品角色</th>
                  <th>优先级</th>
                </tr>
              </thead>
              <tbody>
                {report.crossRows.map(row => (
                  <tr key={row.theme}>
                    <th>{row.theme}</th>
                    <td className="launch-muted">{row.vocEvidence}</td>
                    <td className="launch-muted">{row.keywordEvidence}</td>
                    <td>
                      <DemandChip demand={row.marketDemand} priority={row.priority} />
                    </td>
                    <td className="launch-muted">{row.userValue}</td>
                    <td className="launch-muted">{row.competition}</td>
                    <td>{row.judgment}</td>
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
          </LaunchSection>

          <LaunchSection title="4. 最终产品定义表" description="覆盖市场、人群、场景、形态、功能、规格、价格与避坑 · 表头吸顶可下滑对照">
            <LaunchTable stickyHeader>
              <thead>
                <tr>
                  <th>产品定义维度</th>
                  <th>最终结论</th>
                  <th>VOC依据</th>
                  <th>关键词依据</th>
                  <th>产品动作</th>
                  <th>优先级</th>
                  <th>待验证</th>
                </tr>
              </thead>
              <tbody>
                {report.definitionRows.map(row => (
                  <tr key={row.dimension}>
                    <th>{row.dimension}</th>
                    <td>{row.conclusion}</td>
                    <td className="launch-muted">{row.vocBasis}</td>
                    <td className="launch-muted">{row.keywordBasis}</td>
                    <td>
                      <ActionStepsCell value={row.action} maxItems={3} />
                    </td>
                    <td>
                      <PriorityChip priority={row.priority} />
                    </td>
                    <td className="launch-muted">{row.pending}</td>
                  </tr>
                ))}
              </tbody>
            </LaunchTable>
          </LaunchSection>

          <LaunchSection title="5. 功能与配置分层" description="基础必备 / 差异化 / 可选 / 首版不做 / P0避坑">
            <div className="launch-product-def-grid final-def-layers">
              <FeatureLayerCard title="基础版必须具备" items={report.featureLayers.mustHave} />
              <FeatureLayerCard title="核心差异化" items={report.featureLayers.differentiation} />
              <FeatureLayerCard title="可选配置 / 变体" items={report.featureLayers.optional} />
              <FeatureLayerCard title="首版暂不开发" items={report.featureLayers.notInV1} tone="avoid" />
              <FeatureLayerCard title="P0 避坑与验收方向" items={report.featureLayers.p0Avoid} tone="avoid" />
            </div>
          </LaunchSection>

          <LaunchSection title="6. 关键词承接方案" description="用于验证产品与需求匹配，不替代完整 Listing / 广告词库">
            <LaunchTable stickyHeader>
              <thead>
                <tr>
                  <th>词群类型</th>
                  <th>关键词</th>
                  <th>对应产品功能</th>
                  <th>页面卖点角度</th>
                  <th>适用 SKU</th>
                </tr>
              </thead>
              <tbody>
                {report.keywordGroups.map(row => (
                  <tr key={row.type}>
                    <th>{row.type}</th>
                    <td>{row.keywords}</td>
                    <td className="launch-muted">{row.productLink}</td>
                    <td className="launch-muted">{row.listingAngle}</td>
                    <td>{row.skuHint}</td>
                  </tr>
                ))}
              </tbody>
            </LaunchTable>
          </LaunchSection>

          <LaunchSection title="7. 产品方案优先级" description="保留 P0–P3 口径，优先展示影响定义的关键项">
            <LaunchTable stickyHeader>
              <thead>
                <tr>
                  <th>优先级</th>
                  <th>产品方向</th>
                  <th>数据证据</th>
                  <th>商业影响</th>
                  <th>产品动作</th>
                  <th>验收方向</th>
                </tr>
              </thead>
              <tbody>
                {report.priorityRows.map(row => (
                  <tr key={`${row.priority}-${row.direction}`}>
                    <th>
                      <PriorityChip priority={row.priority} />
                    </th>
                    <td>{row.direction}</td>
                    <td className="launch-muted">{row.evidence}</td>
                    <td>{row.businessImpact}</td>
                    <td>
                      <ActionStepsCell value={row.action} />
                    </td>
                    <td className="launch-muted">{row.acceptance}</td>
                  </tr>
                ))}
              </tbody>
            </LaunchTable>
          </LaunchSection>

          <LaunchSection title="8. 风险与下一步验证" description="只列影响当前产品定义的关键项">
            <div className="definition-synthesis-grid">
              <article>
                <h4>主要风险</h4>
                <ul className="final-def-plain-list">
                  {report.risks.map(item => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </article>
              <article>
                <h4>下一步验证</h4>
                <ul className="final-def-plain-list">
                  {report.nextValidations.map(item => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </article>
            </div>
          </LaunchSection>

          <LaunchSection title="9. 数据边界" description="VOC 与关键词的角色边界">
            <p className="definition-synthesis-merged">{report.dataBoundary}</p>
          </LaunchSection>
        </>
      )}

      <p className="voc-source-footnote launch-footnote">
        分析引擎：final-product-definition.ts（Skill define-amazon-product-from-voc-keywords） · 更新 {report.meta.analyzedAt}
      </p>
    </div>
  );
}
