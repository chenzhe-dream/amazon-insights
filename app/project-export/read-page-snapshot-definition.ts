import {MarketSiteSchema} from "../../shared/market-sites";
import type {ExportModuleContext, ExportModuleRead} from "./export-module-context";
import {buildCurrentPageAnalysisInputs, catalogGapNote, readManualVocRecords,
  type CurrentPageAnalysisInputs} from "./read-voc-definition-export";

export type DefinitionSnapshotSources = Readonly<{
  analysisInputs: CurrentPageAnalysisInputs | null;
  gapNotes: string[];
}>;

/** The original page's current inputs, detached from later reads and without report-history selection. */
export async function readPageSnapshotDefinition(context: ExportModuleContext, read: ExportModuleRead): Promise<DefinitionSnapshotSources> {
  const site = MarketSiteSchema.parse(context.marketplace);
  if (context.version && context.version.marketplace !== site) throw new Error("已发布新品定义站点来源范围不匹配");
  if (new Set(context.asins).size !== context.asins.length) throw new Error("新品定义商品来源重复");
  for (const asin of context.asins) {
    const matches = context.version?.catalog.filter(item => item && typeof item === "object" && "asin" in item && item.asin === asin) ?? [];
    if (matches.length > 1) throw new Error("新品定义商品来源重复");
    if (matches.some(item => item && typeof item === "object" && "marketplace" in item && item.marketplace !== site)) throw new Error("新品定义商品站点来源不匹配");
  }
  const manual = await readManualVocRecords(context, read);
  return structuredClone({analysisInputs: buildCurrentPageAnalysisInputs(context, manual), gapNotes: catalogGapNote(context)});
}
