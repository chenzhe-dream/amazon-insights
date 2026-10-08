import type { AmazonKeywordDemandReport } from "./keyword-original-demand";

export type KeywordBusinessOutput = {
  id:
    | "demand-conclusion"
    | "target-audience"
    | "use-scenario"
    | "purchase-motivation"
    | "basic-features"
    | "differentiated-features"
    | "specifications"
    | "unmet-needs"
    | "price-band"
    | "competition-difficulty"
    | "development-plan"
    | "opportunity-level"
    | "risks"
    | "next-steps";
  label: string;
  status: "ready" | "pending";
  conclusion: string;
  sourceRefs: string[];
  missing: string[];
};

const output = (
  id: KeywordBusinessOutput["id"],
  label: string,
  conclusion: string,
  sourceRefs: string[],
  missing: string[] = [],
): KeywordBusinessOutput => ({ id, label, status: missing.length ? "pending" : "ready", conclusion, sourceRefs, missing });

function dimensionEvidence(report: AmazonKeywordDemandReport, id: "w1" | "w2" | "w3" | "w4" | "w5", fallback: string) {
  const dimension = report.dimensions[id];
  return dimension.rows.length ? dimension.conclusion : fallback;
}

/**
 * Projects the ZIP business document's 14 requested outputs without changing
 * the original W1–W5/PVS algorithm. Every output either cites the saved facts
 * projection or names the evidence that is still missing.
 */
export function buildKeywordBusinessOutputs(report: AmazonKeywordDemandReport, factsId: string): KeywordBusinessOutput[] {
  const source = (path: string) => `${factsId}#${path}`;
  const keywordSource = source("members.pageMetrics.monthlySearchVolume");
  const trendSource = source("members.trend");
  const w2 = report.dimensions.w2;
  const w3 = report.dimensions.w3;
  const w4 = report.dimensions.w4;
  const specificationRows = w4.rows.filter(row => /规格|尺寸|材质|大小|size|material/i.test(row.label));
  const competitionMissing = ["缺少供需比或 ABA Top3 竞争证据", "缺少真实利润/成本证据"];

  return [
    output("demand-conclusion", "需求结论", report.synthesis.headline, [keywordSource, trendSource]),
    output("target-audience", "目标人群", dimensionEvidence(report, "w2", "关键词样本未形成明确人群结论。"), w2.rows.length ? [keywordSource] : [], w2.rows.length ? [] : ["缺少明确人群关键词"]),
    output("use-scenario", "使用场景", dimensionEvidence(report, "w3", "关键词样本未形成明确场景结论。"), w3.rows.length ? [keywordSource] : [], w3.rows.length ? [] : ["缺少明确场景关键词"]),
    output("purchase-motivation", "购买动机", "暂不从关键词推断购买动机。", [], ["缺少评论/VOC购买动机证据"]),
    output("basic-features", "基础功能", dimensionEvidence(report, "w4", "关键词样本未形成明确功能/属性结论。"), w4.rows.length ? [keywordSource] : [], w4.rows.length ? [] : ["缺少功能或属性关键词"]),
    output("differentiated-features", "差异化功能", w4.rows.length ? `关键词显示的功能/属性切口：${w4.rows.slice(0, 4).map(row => row.label).join("、")}；仍需结合竞品和VOC确认差异化。` : "暂不能从当前词池确认差异化功能。", w4.rows.length ? [keywordSource] : [], w4.rows.length ? [] : ["缺少功能属性词及竞品/VOC对照"]),
    output("specifications", "规格要求", specificationRows.length ? `关键词中出现的规格方向：${specificationRows.slice(0, 4).map(row => row.label).join("、")}。` : "暂不能从当前词池确定规格要求。", specificationRows.length ? [keywordSource] : [], specificationRows.length ? [] : ["缺少可验证的规格属性词"]),
    output("unmet-needs", "未满足需求", "暂不从搜索词直接推断未满足需求。", [], ["缺少差评、未满足需求或评论主题证据"]),
    output("price-band", "价格带", "暂不能确定价格带。", [], ["缺少价格分布或商品价格证据"]),
    output("competition-difficulty", "竞争难度", "当前仅有原版PVS相对估算，不能替代正式竞争难度判断。", [], competitionMissing),
    output("development-plan", "开发方案", report.developmentDirections.length ? report.developmentDirections.map(row => row.direction).join("；") : "暂未筛出可执行的P1/P2开发方向。", report.developmentDirections.length ? [keywordSource] : [], report.developmentDirections.length ? [] : ["缺少达到P1/P2的需求簇"]),
    output("opportunity-level", "机会等级", report.validationPriorities.length ? `原版参考验证等级：${report.validationPriorities.map(row => row.tier).join("、")}；该等级仅用于验证排序。` : "暂不能形成机会等级。", report.validationPriorities.length ? [keywordSource, trendSource] : [], report.validationPriorities.length ? ["正式机会等级仍缺竞争、利润和供给证据"] : ["缺少可排序的需求簇", "缺少正式竞争与利润证据"]),
    output("risks", "风险", report.dataNotes.join("；") || "当前报告未发现可引用的风险说明。", [keywordSource], report.dataNotes.length ? [] : ["缺少风险来源说明"]),
    output("next-steps", "下一步", report.validationPriorities.length ? report.validationPriorities.map(row => `${row.hypothesis}：${row.method}（${row.effort}）`).join("；") : "先补齐竞争、价格、利润和VOC证据后再定下一步。", report.validationPriorities.length ? [keywordSource, trendSource] : [], report.validationPriorities.length ? [] : ["缺少可执行验证项"]),
  ];
}
