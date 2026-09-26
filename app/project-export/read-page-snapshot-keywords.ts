import {z} from "zod";
import {MarketSiteSchema} from "../../shared/market-sites";
import type {KeywordDemandProduct, KeywordDemandSources} from "../keyword-demand-analysis";
import type {AnalysisInputScope} from "../../shared/product-structure-rules";
import type {ExportModuleContext} from "./export-module-context";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const presentObject = (value: unknown): Record<string, unknown> => z.record(z.string(),z.unknown()).parse(value);
const sourceDate = (value: string) => /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) ? value : null;
const sourcePeriod = (window: {time_type:string;time_value:string;listingSearch:boolean} | null | undefined) => {
  if (!window) return null;
  if (window.time_type === "lately" && /^\d+$/.test(window.time_value)) return `近${window.time_value}天 · ${window.listingSearch ? "站内搜索" : "全部搜索"}`;
  return `${window.time_type} ${window.time_value} · ${window.listingSearch ? "站内搜索" : "全部搜索"}`;
};
const finiteOrNull = z.number().finite().nullable();
const keywordRow = z.object({
  keyword:z.string(), trafficShare:finiteOrNull, searchVolume:finiteOrNull, abaRank:finiteOrNull,
  cpcMedian:finiteOrNull, cpcLow:finiteOrNull, cpcHigh:finiteOrNull, naturalRatio:finiteOrNull,
  trafficDependency:z.string().nullable(), organicRank:z.string().nullable(), rankEvolution:z.string().nullable(),
  keywordHealth:z.string().nullable(), top3ClickShare:finiteOrNull, top3ConversionShare:finiteOrNull,
  clickConversionRate:finiteOrNull,
});
const analysisRecord = z.object({
  asin:z.string(), marketplace:z.string(), fetchedAt:z.string(), status:z.enum(["ready","empty","error"]),
  statusMessage:z.string().optional(), dataNotice:z.string().nullable().optional(),
  totalKeywordsInPeriod:finiteOrNull, topKeywordsAnalyzed:z.number().finite(), keywords:z.array(keywordRow),
  queryWindow:z.object({time_type:z.string(),time_value:z.string(),listingSearch:z.boolean()}).nullable().optional(),
});
const enrichmentRecord = z.object({
  keyword:z.string(), fetchedAt:z.string(), status:z.enum(["ready","partial","error"]), statusMessage:z.string().optional(),
  searchTrend:z.array(z.object({month:z.string(),volume:z.number().finite(),abaRank:z.number().finite()})),
  bidLow:finiteOrNull, bidMedian:finiteOrNull, bidHigh:finiteOrNull, clickConversionRate:finiteOrNull,
  top3ClickShare:finiteOrNull, top3ConversionShare:finiteOrNull,
});

export type KeywordsSnapshotSources = Readonly<{
  products: KeywordDemandProduct[];
  sources: KeywordDemandSources;
  analysisScope: Partial<AnalysisInputScope>;
  sourceMeta: {period: string | null; updatedAt: string | null};
  sourceRows: {asin: string; fetchedAt: string | null; status: string | null; notice: string | null; period: string | null}[];
}>;

/** Selects only published keyword rows and their explicitly matching enrichment. No network or generated fallback. */
export function readPageSnapshotKeywords(context: ExportModuleContext, products: readonly KeywordDemandProduct[]): KeywordsSnapshotSources {
  const site = MarketSiteSchema.parse(context.marketplace);
  if (context.version && context.version.marketplace !== site) throw new Error("已发布关键词站点来源范围不匹配");
  if (products.length !== context.asins.length || context.asins.some(asin =>
    !/^[A-Z0-9]{10}$/.test(asin) || products.filter(product => product.asin === asin).length !== 1))
    throw new Error("关键词商品来源范围不匹配");
  const stage = context.version?.stageOutputs.keywords;
  const data = stage && "data" in stage ? presentObject(stage.data) : {};
  const rawAnalysis = data.analysisByAsin === undefined ? {} : presentObject(data.analysisByAsin);
  const rawEnrichment = data.enrichmentByKeyword === undefined ? {} : presentObject(data.enrichmentByKeyword);
  const analysisByAsin: NonNullable<KeywordDemandSources["analysisByAsin"]> = {};
  const enrichmentByKeyword: NonNullable<KeywordDemandSources["enrichmentByKeyword"]> = {};
  const sourceRows: KeywordsSnapshotSources["sourceRows"] = [];
  const periods = new Set<string>();
  const dates: string[] = [];
  for (const asin of context.asins) {
    const raw = rawAnalysis[asin];
    if (raw === undefined) {
      sourceRows.push({asin,fetchedAt:null,status:null,notice:null,period:null});
      continue;
    }
    const record = analysisRecord.parse(raw);
    if (record.asin !== asin || record.marketplace !== site) throw new Error("关键词来源范围不匹配");
    analysisByAsin[asin] = record;
    const period = sourcePeriod(record.queryWindow);
    if (period) periods.add(period);
    const fetchedAt = sourceDate(record.fetchedAt);
    if (fetchedAt) dates.push(fetchedAt);
    sourceRows.push({asin,fetchedAt,status:record.status,
      notice:record.dataNotice || record.statusMessage || null,period});
    for (const row of record.keywords) {
      const key = row.keyword.trim().toLowerCase();
      if (!key || rawEnrichment[key] === undefined) continue;
      const rawEnriched = object(rawEnrichment[key]);
      if (rawEnriched.marketplace !== undefined && rawEnriched.marketplace !== site) throw new Error("关键词补充站点来源范围不匹配");
      const enrichment = enrichmentRecord.parse(rawEnrichment[key]);
      if (enrichment.keyword.trim().toLowerCase() !== key) throw new Error("关键词补充来源不匹配");
      enrichmentByKeyword[key] = enrichment;
      const enrichedAt = sourceDate(enrichment.fetchedAt);
      if (enrichedAt) dates.push(enrichedAt);
    }
  }
  return structuredClone({products:[...products],sources:{analysisByAsin,enrichmentByKeyword},
    analysisScope:{projectId:context.projectId,organizationId:context.organizationId,marketplace:site},
    sourceMeta:{period:periods.size === 1 ? [...periods][0] : null, updatedAt:dates.length ? dates.sort().at(-1)! : null},
    sourceRows});
}
