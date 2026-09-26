import { MarketSiteSchema } from "../../shared/market-sites";
import { readCurrentProjectDisplayVersion } from "../lib/project-display-version-browser";
import type { CompetitorOverviewSnapshotProps, Product } from "../project-report-views/competitor-overview";
import { exportFetcher, scopedFetcher, readExportEligibility, readExportSellingTranslations, verifyExportSession,
  type ExportFetcher, type ExportRequest, type PreparedProjectExport } from "./read-export-content";
import type { ExportModuleContext } from "./export-module-context";
import type { ExportSectionId } from "./module-catalog";
import {readVariantsSnapshot} from "./read-variants-export";
import type {VariantsSnapshotSources} from "./page-snapshot-variants";
import {readPageSnapshotImages, type ImagesSnapshotSources} from "./read-page-snapshot-images";

// Extend only after each original view has passed its snapshot acceptance.
export const pageSnapshotModules: readonly ExportSectionId[] = ["competitor-overview", "variants-orders", "listing-images"];
export type PageSnapshotSources = Pick<PreparedProjectExport, "project" | "sourceProjectId" | "capturedAt" | "sourceLabel"> & {
  moduleIds: ExportSectionId[];
  overview: CompetitorOverviewSnapshotProps | null;
  variants?: VariantsSnapshotSources;
  images?: ImagesSnapshotSources;
};

export function stageData(context: ExportModuleContext, stage: keyof NonNullable<ExportModuleContext["version"]>["stageOutputs"]): Record<string, unknown> {
  const output = context.version?.stageOutputs[stage];
  return output && "data" in output && output.data && typeof output.data === "object" ? output.data as Record<string, unknown> : {};
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Defaults describe missing data; no generated catalogue or other-project fallback is imported. */
export function snapshotProducts(context: ExportModuleContext): Product[] {
  const listing = object(stageData(context, "listing").contentByAsin);
  return context.asins.map(asin => {
    const matches = context.version?.catalog.filter(item => object(item).asin === asin) ?? [];
    if (matches.length > 1) throw new Error("商品来源重复，请重新准备");
    const product = object(matches[0]);
    const content = object(listing[asin]);
    for (const item of [product, content]) {
      if ((item.asin !== undefined && item.asin !== asin) || (item.marketplace !== undefined && item.marketplace !== context.marketplace))
        throw new Error("商品或图片来源范围不匹配");
    }
    const result = {
      asin, brand: "品牌未记录", image: "", title: "", productFamily: "generic",
      price: null, sales: null, rating: null, reviews: null, rank: null, subRank: null,
      rankCategory: "", subRankCategory: "", buyBoxSeller: "—", fulfillment: "—",
      packageSize: "—", packageWeight: "—", specifications: [], launch: "—", format: "—", variants: "—",
      history: [], prices: [], ranks: [], variantShare: [], variantDetails: [], sellingPoints: [],
      strengths: [], weaknesses: [], unmet: [], scenarios: [], audiences: [], keywords: [], synced: false,
      ...product,
      ...(typeof content.mainImage === "string" ? {image: content.mainImage} : {}),
    };
    return result as unknown as Product;
  });
}

export async function readPageSnapshotSources(request: ExportRequest, fetcher: ExportFetcher = exportFetcher): Promise<PageSnapshotSources> {
  if (request.moduleIds.some(id => !pageSnapshotModules.includes(id))) throw new Error("所选模块尚未接入原页面快照");
  const read = scopedFetcher(request, fetcher);
  const {project, source, sourceProjectId} = await readExportEligibility(request, read);
  const version = await readCurrentProjectDisplayVersion({
    organizationId: request.organizationId, projectId: sourceProjectId, marketplace: source.marketplace, asins: source.asins,
  }, read);
  const context: ExportModuleContext = {
    projectId: sourceProjectId, organizationId: request.organizationId, marketplace: source.marketplace,
    asins: project.asins, sourceAsins: source.asins, currentRunId: source.currentRunId,
    version, capturedAt: new Date().toISOString(), sharedReads: new Map(),
  };
  const selected = <T,>(raw: unknown): T => Object.fromEntries(Object.entries(object(raw)).filter(([key]) => project.asins.includes(key)).map(([key, value]) => {
    const item = object(value);
    if ((item.asin !== undefined && item.asin !== key) || (item.marketplace !== undefined && item.marketplace !== project.marketplace))
      throw new Error("模块数据来源范围不匹配");
    return [key, value];
  })) as T;
  let overview: CompetitorOverviewSnapshotProps | null = null;
  if (version && request.moduleIds.includes("competitor-overview")) {
    if (!MarketSiteSchema.safeParse(project.marketplace).success) throw new Error("此站点尚无对应的竞品原页面视图");
    const selling = await readExportSellingTranslations(version, project.asins, read);
    const categories = object(stageData(context, "category").trendByNode);
    for (const item of Object.values(categories).map(object)) {
      if (item.marketplace !== undefined && item.marketplace !== project.marketplace) throw new Error("类目趋势来源站点不匹配");
    }
    overview = {
      products: snapshotProducts(context), market: project.marketplace as CompetitorOverviewSnapshotProps["market"], slugParam: null,
      salesTrendByAsin: selected(stageData(context, "sales_trend").trendByAsin),
      ratingByAsin: selected(stageData(context, "reviews").ratingByAsin),
      fbaFeeByAsin: selected(stageData(context, "fba").feeByAsin),
      childSalesByAsin: selected(stageData(context, "child_sales").rowsByAsin),
      priceStrategyByAsin: selected(stageData(context, "price_strategy").strategyByAsin),
      categoryTrendByNode: categories as CompetitorOverviewSnapshotProps["categoryTrendByNode"],
      sellingTranslationsByAsin: Object.fromEntries(selling.map(item => [item.asin, item])),
    };
  }
  const variants = request.moduleIds.includes("variants-orders") ? await readVariantsSnapshot(context,read) : undefined;
  const images = request.moduleIds.includes("listing-images") ? readPageSnapshotImages(context,snapshotProducts(context)) : undefined;
  await verifyExportSession(request, read); request.signal.throwIfAborted();
  return structuredClone({
    project: {id:project.id, name:project.name, marketplace:project.marketplace, asins:project.asins},
    sourceProjectId, capturedAt: context.capturedAt, moduleIds:[...request.moduleIds],
    sourceLabel: version ? `已有报告 · 数据完成 ${version.sourceCompletedAt}` : "暂无已发布基础报告",
    overview, ...(variants ? {variants} : {}), ...(images ? {images} : {}),
  });
}
