import { isModuleVisible, type ModuleKey } from "../../shared/module-visibility-contracts";

// Planned export sections, not a claim that this project's data is ready.
// Phase two supplies authorized availability and full snapshot content.
const EXPORT_SECTIONS = [
  { id: "competitor-overview", module: "overview", label: "竞品参数总览", description: "完整竞品参数、价格、销量、评分与规格。" },
  { id: "variants-orders", module: "overview", label: "变体 / 订单", description: "全部子体、属性、订单占比与销售趋势。" },
  { id: "listing-images", module: "overview", label: "主副图分析", description: "产品主副图、图片分析与备注。" },
  { id: "voc", module: "voc", label: "VOC 分析", description: "VOC 七维分析、用户反馈与对应依据。" },
  { id: "keywords", module: "keywords", label: "关键词调研", description: "关键词、搜索需求与分析结果。" },
  { id: "definition", module: "definition", label: "新品定义", description: "最终产品定义、开发优先级与依据。" },
  { id: "checklist", module: "checklist", label: "立项前确认清单", description: "立项检查项、验证结论与待确认事项。" },
  { id: "traffic", module: "traffic", label: "竞品流量分析", description: "自然与广告流量、推广能力及对应分析。" },
] as const satisfies readonly { id: string; module: ModuleKey; label: string; description: string }[];

export type ExportSectionId = (typeof EXPORT_SECTIONS)[number]["id"];

export function visibleExportSections(visibleModules: readonly ModuleKey[] | undefined) {
  return EXPORT_SECTIONS.filter(section => isModuleVisible(visibleModules, section.module));
}
