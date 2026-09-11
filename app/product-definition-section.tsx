"use client";

import type { ProductDefinitionOutput } from "../shared/product-definition-output";
import { ProductDefinitionOutputSchema } from "../shared/product-definition-output";
import type { ProductLaunchRuntimeSources } from "./product-launch-analysis";
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

export type SavedProductDefinitionReport = {
  id: string;
  status: string;
  result: unknown;
};

export type ProductDefinitionExecutionState =
  | string
  | { kind?: string; status?: string; message?: string };

type Feature = ProductDefinitionOutput["configurationLayers"]["mustHave"][number];

const labels: Record<string, string> = {
  "dual-validation": "VOC 与关键词双重验证",
  "voc-only": "VOC 单侧验证",
  "keyword-candidate": "关键词候选",
  conflict: "证据冲突",
  avoid: "避坑",
  "core-foundation": "核心基础",
  "core-strengthening": "核心强化",
  "retain-and-redesign": "保留并重做",
  differentiation: "差异化突破",
  "experience-optimization": "体验优化",
  "new-product-avoidance": "新品避坑",
  optional: "可选配置",
  "do-not-build": "暂不开发",
  validate: "待验证",
  include: "纳入",
  redesign: "重做",
  exclude: "排除",
  supported: "已有证据",
  "requires-validation": "待验证",
  "target-market": "目标市场",
  demand: "需求",
  seasonality: "季节性",
  audience: "目标人群",
  scenario: "使用场景",
  motivation: "购买动机",
  "pain-point": "核心痛点",
  "product-form": "产品形态",
  "base-feature": "基础功能",
  specification: "规格",
  "material-structure": "材质与结构",
  "color-sku": "颜色与 SKU",
  "price-tier": "价格档位",
  "selling-point": "核心卖点",
  avoidance: "避坑要求",
  cost: "成本",
  profitability: "盈利能力",
  patent: "专利",
  compliance: "合规",
  "supply-chain": "供应链",
  "core-term": "核心词",
  feature: "功能词",
  "long-tail": "长尾词",
  risk: "风险词",
};

function chineseLabel(value: string) {
  return labels[value] ?? value;
}

function evidenceLabel(ids: readonly string[]) {
  return ids.length ? ids.join("、") : "—";
}

function executionStatus(state: ProductDefinitionExecutionState | undefined) {
  if (typeof state === "string") return state;
  return state?.status ?? state?.kind ?? "unknown";
}

function executionLabel(status: string) {
  if (["running", "active", "queued"].includes(status)) return "当前执行中";
  if (status === "failed") return "当前执行失败";
  if (status === "waiting-voc-report") return "等待 VOC 分析完成";
  if (status === "waiting-input") return "当前等待输入";
  if (status === "input-ready") return "输入已就绪，等待分析结果";
  return "等待已保存的新品定义报告";
}

function FeatureLayer({ title, items }: { title: string; items: readonly Feature[] }) {
  return (
    <article>
      <h4>{title}</h4>
      <ul>
        {items.length ? items.map((item) => (
          <li key={item.item}>
            {item.item}
            <small className="final-def-evidence">证据：{evidenceLabel(item.evidenceIds)}</small>
          </li>
        )) : <li>暂无已保存内容</li>}
      </ul>
    </article>
  );
}

export function ProductDefinitionSection({
  savedReport,
  current = false,
  sourceLabel,
  executionState,
}: {
  products: DefinitionProduct[];
  sources: ProductLaunchRuntimeSources;
  savedReport?: SavedProductDefinitionReport | null;
  current?: boolean;
  sourceLabel?: string;
  executionState?: ProductDefinitionExecutionState;
}) {
  const state = executionStatus(executionState);
  const savedStatusAllowed = savedReport?.status === "complete" || savedReport?.status === "partial";
  const parsed = savedStatusAllowed
    ? ProductDefinitionOutputSchema.safeParse(savedReport?.result)
    : null;
  const output = parsed?.success ? parsed.data : null;
  const outputAvailable = output?.status === "complete" || output?.status === "partial";
  const currentReady = current && state === "succeeded" && outputAvailable;
  const historicalReady = !current && outputAvailable;
  const visible = currentReady || historicalReady ? output : null;
  const invalid = Boolean(savedReport && savedStatusAllowed && parsed && !parsed.success);

  return (
    <div className="launch-page definition-page">
      <section className="card launch-block launch-intro-block">
        <div className="launch-section-head">
          <div className="launch-section-head-main">
            <span className="status-chip">define-amazon-product-from-voc-keywords</span>
            <h2 className="launch-page-title">新品定义</h2>
            <p>展示已保存的 VOC 与关键词交叉验证结果。</p>
          </div>
          <span className="source-badge">
            {historicalReady ? "历史报告" : currentReady ? "当前结果已保存" : executionLabel(state)}
          </span>
        </div>
        <div className="launch-meta-row">
          <span>报告 <b>{sourceLabel ?? savedReport?.id ?? "—"}</b></span>
          <span>机会等级 <b>{visible?.opportunity.grade ?? "待验证"}</b></span>
          {visible?.opportunity.grade === null && visible.opportunity.pendingReason ? (
            <span>待验证原因 <b>{visible.opportunity.pendingReason}</b></span>
          ) : null}
        </div>
      </section>

      {!visible ? (
        <section className="card launch-block">
          <div className="pending-box">
            {invalid ? "报告格式无法识别，无法作为最终结果展示。" : executionLabel(state)}
          </div>
        </section>
      ) : (
        <>
          {historicalReady && state !== "unknown" && state !== "succeeded" ? (
            <section className="card launch-block">
              <div className="pending-box">
                {executionLabel(state)}；以下为历史报告，不代表当前执行结果。
              </div>
            </section>
          ) : null}

          <LaunchSection title="1. 机会等级与证据交叉验证" description="内容直接来自已保存报告">
            <LaunchTable stickyHeader>
              <thead><tr><th>VOC 主题</th><th>关键词组</th><th>VOC 证据</th><th>关键词证据</th><th>判断</th><th>产品角色</th><th>优先级</th></tr></thead>
              <tbody>{visible.evidenceMatrix.map((row, index) => (
                <tr key={`${row.themeKey ?? "none"}-${row.keywordGroupId ?? "none"}-${index}`}>
                  <th>{row.themeKey ?? "—"}</th>
                  <td>{row.keywordGroupId ?? "—"}</td>
                  <td>{evidenceLabel(row.vocEvidenceIds)}</td>
                  <td>{evidenceLabel(row.keywordEvidenceIds)}</td>
                  <td>{chineseLabel(row.judgment)}</td>
                  <td>{chineseLabel(row.productRole)}</td>
                  <td>{row.priority}</td>
                </tr>
              ))}</tbody>
            </LaunchTable>
          </LaunchSection>

          <LaunchSection title="2. 最终产品定义">
            <LaunchTable stickyHeader>
              <thead><tr><th>维度</th><th>结论</th><th>VOC 证据</th><th>关键词证据</th><th>产品动作</th><th>优先级</th><th>验证状态</th></tr></thead>
              <tbody>{visible.finalDefinition.map((row) => (
                <tr key={row.dimension}>
                  <th>{chineseLabel(row.dimension)}</th><td>{row.conclusion}</td>
                  <td>{evidenceLabel(row.vocEvidenceIds)}</td><td>{evidenceLabel(row.keywordEvidenceIds)}</td>
                  <td>{chineseLabel(row.action)}</td><td>{row.priority}</td><td>{chineseLabel(row.validationStatus)}</td>
                </tr>
              ))}</tbody>
            </LaunchTable>
          </LaunchSection>

          <LaunchSection title="3. 功能与配置分层">
            <div className="launch-product-def-grid final-def-layers">
              <FeatureLayer title="基础版必须具备" items={visible.configurationLayers.mustHave} />
              <FeatureLayer title="核心差异化" items={visible.configurationLayers.differentiation} />
              <FeatureLayer title="可选配置 / 变体" items={visible.configurationLayers.optional} />
              <FeatureLayer title="首版暂不开发" items={visible.configurationLayers.notInV1} />
              <FeatureLayer title="P0 避坑" items={visible.configurationLayers.p0Avoid} />
            </div>
          </LaunchSection>

          <LaunchSection title="4. 关键词承接方案">
            <LaunchTable><thead><tr><th>关键词组</th><th>角色</th><th>产品承接</th><th>页面角度</th><th>适用 SKU</th><th>证据</th></tr></thead>
              <tbody>{visible.keywordLanding.map((row) => <tr key={`${row.groupId}-${row.role}`}><th>{row.groupId}</th><td>{chineseLabel(row.role)}</td><td>{row.productLink}</td><td>{row.listingAngle}</td><td>{row.skuHint}</td><td>{evidenceLabel(row.evidenceIds)}</td></tr>)}</tbody>
            </LaunchTable>
          </LaunchSection>

          <LaunchSection title="5. 产品方案优先级">
            <LaunchTable><thead><tr><th>优先级</th><th>方向</th><th>证据</th><th>动作</th><th>验收方向</th></tr></thead>
              <tbody>{visible.priorities.map((row) => <tr key={`${row.priority}-${row.direction}`}><th>{row.priority}</th><td>{row.direction}</td><td>{evidenceLabel(row.evidenceIds)}</td><td>{chineseLabel(row.action)}</td><td>{row.acceptance}</td></tr>)}</tbody>
            </LaunchTable>
          </LaunchSection>

          <LaunchSection title="6. 风险与商业验证">
            <LaunchTable><thead><tr><th>领域</th><th>状态</th><th>下一步</th></tr></thead>
              <tbody>{visible.risks.map((row) => <tr key={row.area}><th>{chineseLabel(row.area)}</th><td>{chineseLabel(row.status)}</td><td>{row.nextStep}</td></tr>)}</tbody>
            </LaunchTable>
          </LaunchSection>

          <LaunchSection title="7. 数据边界">
            <p className="definition-synthesis-merged">{visible.dataBoundary}</p>
          </LaunchSection>
        </>
      )}
    </div>
  );
}
