type StageOutputGapReasonCode =
  | "CONNECT_TIMEOUT"
  | "UPSTREAM_EMPTY"
  | "CONNECTOR_FAILED"
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
  records: Readonly<Record<string, Readonly<{ status?: unknown }> | undefined>>;
  reasonCode: StageOutputGapReasonCode;
}>;

const reasonCopy: Readonly<Record<StageOutputGapReasonCode, string>> = {
  CONNECT_TIMEOUT: "连接超时",
  UPSTREAM_EMPTY: "上游暂无记录",
  CONNECTOR_FAILED: "连接失败",
  OUTPUT_UNAVAILABLE: "结果暂不可用",
};

export function stageOutputGapReasonCode(entry: StageOutputGapEntry | undefined): StageOutputGapReasonCode | null {
  if (!entry || entry.stageStatus === "done") return null;
  return entry.stageStatus === "missing-output" ? entry.reasonCode : entry.gap.reasonCode;
}

export function StageOutputGapNotice({ label, asins, records, reasonCode }: Props) {
  const ready = asins.filter(asin => records[asin]?.status === "ready");
  const missing = asins.filter(asin => records[asin]?.status !== "ready");
  if (!missing.length) return null;
  return (
    <p className="stage-output-gap-notice" role="status">
      <strong>{`${label} ${ready.length}/${asins.length}`}</strong>
      <span>{`；${missing.join("、")} ${reasonCopy[reasonCode]}`}</span>
    </p>
  );
}
