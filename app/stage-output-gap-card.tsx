import type { StageOutputSnapshot } from "./lib/stage-output-browser";

const stageOutputLabels: Record<string, string> = {
  keywords: "关键词", reviews: "评论", sales_trend: "历史趋势", fba: "FBA 费用",
  listing: "Listing", category: "类目趋势", traffic: "流量", child_sales: "子体销量",
  price_strategy: "价格策略", image_remarks: "主副图备注",
};

const stageOutputGapCopy = {
  CONNECT_TIMEOUT: "数据源连接超时，本模块存在既定数据缺口。",
  UPSTREAM_EMPTY: "数据源未返回可用记录，本模块存在既定数据缺口。",
  CONNECTOR_FAILED: "数据源连接失败，本模块存在既定数据缺口。",
  SIF_KEYWORD_SCHEMA_INVALID: "关键词数据结构无效，本模块存在既定数据缺口。",
  MCP_SCHEMA: "数据源返回结构无效，本模块存在既定数据缺口。",
  OUTPUT_UNAVAILABLE: "阶段结果暂不可用，已停止自动重试。",
} as const;

export function StageOutputGapCard({ snapshot, stage }: { snapshot: StageOutputSnapshot; stage: keyof StageOutputSnapshot }) {
  const projection = snapshot[stage];
  if (!projection || projection.stageStatus === "done") return null;
  const reasonCode = projection.stageStatus === "missing-output"
    ? projection.reasonCode
    : projection.gap.reasonCode;
  return (
    <section className="card" data-stage-output-gap={projection.stage}>
      <div className="pending-box">
        <strong>{stageOutputLabels[projection.stage]}数据缺口</strong>
        <span>{stageOutputGapCopy[reasonCode]}</span>
        <span>当前页面保留已验证数据；此状态不代表模块成功。</span>
      </div>
    </section>
  );
}
