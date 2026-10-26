type StageOutputGapReasonCode =
  | "CONNECT_TIMEOUT"
  | "UPSTREAM_EMPTY"
  | "CONNECTOR_FAILED"
  | "SIF_KEYWORD_SCHEMA_INVALID"
  | "MCP_SCHEMA"
  | "OUTPUT_UNAVAILABLE";

type StageOutputGapEntry =
  | Readonly<{ stageStatus: "done" }>
  | Readonly<{ stageStatus: "missing-output"; reasonCode: "OUTPUT_UNAVAILABLE" }>
  | Readonly<{
      stageStatus: "partial" | "failed";
      gap: Readonly<{ reasonCode: Exclude<StageOutputGapReasonCode, "OUTPUT_UNAVAILABLE"> }>;
    }>;

type Props = Readonly<{
  label: "评论数据" | "FBA费用";
  asins: readonly string[];
  records: Readonly<Record<string, Readonly<{ status?: unknown; sampledReviews?: unknown }> | undefined>>;
  reasonCode: StageOutputGapReasonCode;
  gapItems?: readonly { asin: string; causeCode: StageOutputGapReasonCode }[];
}>;

const reasonCopy: Readonly<Record<StageOutputGapReasonCode, string>> = {
  CONNECT_TIMEOUT: "连接超时",
  UPSTREAM_EMPTY: "上游暂无记录",
  CONNECTOR_FAILED: "连接失败",
  SIF_KEYWORD_SCHEMA_INVALID: "关键词数据结构无效",
  MCP_SCHEMA: "数据源返回结构无效",
  OUTPUT_UNAVAILABLE: "结果暂不可用",
};

export function stageOutputGapReasonCode(entry: StageOutputGapEntry | undefined): StageOutputGapReasonCode | null {
  if (!entry || entry.stageStatus === "done") return null;
  return entry.stageStatus === "missing-output" ? entry.reasonCode : entry.gap.reasonCode;
}

export function StageOutputGapNotice({ label, asins, records, reasonCode, gapItems = [] }: Props) {
  const causes = new Map(gapItems.map(item => [item.asin, item.causeCode]));
  const missing = asins.filter(asin => causes.has(asin) || records[asin]?.status !== "ready");
  const readyCount = asins.length - missing.length;
  if (!missing.length) return null;
  const describe = (asin: string) => {
    const cause = causes.get(asin) ?? reasonCode;
    const samples = records[asin]?.sampledReviews;
    if (label === "评论数据" && cause === "UPSTREAM_EMPTY" &&
        typeof samples === "number" && Number.isInteger(samples) && samples > 0) {
      return "已有评论样本，暂无可用分析主题";
    }
    return reasonCopy[cause];
  };
  return (
    <p className="stage-output-gap-notice" role="status">
      <strong>{`${label} ${readyCount}/${asins.length}`}</strong>
      <span>{gapItems.length
        ? `；${missing.map(asin => `${asin}：${describe(asin)}`).join("；")}`
        : `；${missing.join("、")} ${reasonCopy[reasonCode]}`}</span>
    </p>
  );
}
