import type { StageOutputSnapshot } from "./lib/stage-output-browser";

const stageOutputLabels: Record<string, string> = {
  keywords: "关键词", reviews: "评论", sales_trend: "历史趋势", fba: "FBA 费用",
  listing: "Listing", category: "类目趋势", traffic: "流量",
};

const stageOutputGapCopy: Record<string, string> = {
  CONNECT_TIMEOUT: "数据源连接超时，本模块存在既定数据缺口。",
  UPSTREAM_EMPTY: "数据源未返回可用记录，本模块存在既定数据缺口。",
  CONNECTOR_FAILED: "数据源连接失败，本模块存在既定数据缺口。",
};

export function StageOutputGapCard({ snapshot, stage }: { snapshot: StageOutputSnapshot; stage: keyof StageOutputSnapshot }) {
  const projection = snapshot[stage];
  if (!projection || projection.stageStatus === "done") return null;
  return (
    <section className="card" data-stage-output-gap={projection.stage}>
      <div className="pending-box">
        <strong>{stageOutputLabels[projection.stage]}数据缺口</strong>
        <span>{stageOutputGapCopy[projection.gap.reasonCode]}</span>
        <span>当前页面保留已验证数据；此状态不代表模块成功。</span>
      </div>
    </section>
  );
}
