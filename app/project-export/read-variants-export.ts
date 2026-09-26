import { RuntimeAnalysisDataSnapshotSchema, type RuntimeAnalysisDataSnapshot } from "../lib/runtime-analysis-data";
import type { ExportModuleContext, ExportModuleRead } from "./export-module-context";
import { marketSites } from "../../shared/market-sites";
import type { VariantsSnapshotSources } from "./page-snapshot-variants";

function scopedRecord(value: unknown, asin: string, marketplace: string, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  if ((record.asin !== undefined && record.asin !== asin)
    || (record.marketplace !== undefined && record.marketplace !== marketplace)) throw new Error(`${label}来源范围不匹配`);
  return record;
}

function sameSet(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && new Set(left).size === left.length
    && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function validatedSnapshot(value: unknown, context: ExportModuleContext): RuntimeAnalysisDataSnapshot {
  const snapshot = RuntimeAnalysisDataSnapshotSchema.parse(value);
  const scope = snapshot.exportScope;
  if (!scope || scope.projectId !== context.projectId || scope.organizationId !== context.organizationId
    || scope.marketplace !== context.marketplace || !sameSet(scope.asins, context.sourceAsins)) {
    throw new Error("变体导出来源范围无法核验");
  }
  if (Date.parse(scope.readAt) > Date.parse(context.capturedAt) + 60_000) throw new Error("变体导出读取时间异常");
  return snapshot;
}

/** A second strict read catches mutable cache and translated-label changes during preparation. */
async function readValidatedVariants(context: ExportModuleContext, read: ExportModuleRead): Promise<RuntimeAnalysisDataSnapshot> {
  if (!context.asins.length || context.asins.some(asin => !context.sourceAsins.includes(asin))) throw new Error("变体导出 ASIN 范围无效");
  const query = new URLSearchParams({ projectId: context.projectId, asins: context.sourceAsins.join(","), exportStrict: "1" });
  const url = `/api/runtime-analysis-data?${query}`;
  async function load() {
    const response = await read(url, { method: "GET", cache: "no-store" });
    if (!response.ok) throw new Error(`变体与订单缓存读取失败（${response.status}）`);
    return validatedSnapshot(await response.json(), context);
  }
  const first = await load();
  const second = await load();
  if (first.exportScope?.contentHash !== second.exportScope?.contentHash
    || JSON.stringify({ variants: first.variants, orders: first.variantOrders })
      !== JSON.stringify({ variants: second.variants, orders: second.variantOrders })) {
    throw new Error("变体或订单缓存正在变化，请重试导出");
  }
  const sourceSet = new Set(context.sourceAsins);
  if (first.variants.families.some(family => !sourceSet.has(family.inputAsin) || family.country !== context.marketplace)
    || first.variantOrders.families.some(family => family.country !== context.marketplace)) throw new Error("变体导出来源范围不匹配");
  return first;
}

/** Frozen, scoped source values for the original variant and order cards. */
export async function readVariantsSnapshot(context: ExportModuleContext, read: ExportModuleRead): Promise<VariantsSnapshotSources> {
  const snapshot = await readValidatedVariants(context, read);
  const site = marketSites.find(entry => entry.code === context.marketplace);
  if (!site) throw new Error("此站点尚无对应的变体原页面视图");
  if (context.version && context.version.marketplace !== context.marketplace) throw new Error("父体目录来源范围不匹配");
  const selectedSet = new Set(context.asins);
  const families = snapshot.variants.families.filter(family => selectedSet.has(family.inputAsin));
  const parentKeys = new Set(families.map(family => `${family.country}:${family.parentAsin}`));
  const orderFamilies = snapshot.variantOrders.families.filter(family => parentKeys.has(`${family.country}:${family.parentAsin}`));
  const catalog = context.version?.catalog ?? [];
  const listing = context.version?.stageOutputs.listing;
  const listingByAsin = listing && "data" in listing ? (listing.data as {contentByAsin?: Record<string, unknown>}).contentByAsin : undefined;
  const products = context.asins.map(asin => {
    const matches = catalog.filter(item => item && typeof item === "object" && "asin" in item && item.asin === asin);
    if (matches.length > 1) throw new Error("父体商品目录来源重复");
    const product = scopedRecord(matches[0], asin, context.marketplace, "父体商品目录");
    const content = scopedRecord(listingByAsin?.[asin], asin, context.marketplace, "Listing");
    const mainImage = content.mainImage;
    return {asin, brand: typeof product.brand === "string" ? product.brand : "",
      title: typeof product.title === "string" ? product.title : "",
      image: typeof mainImage === "string" ? mainImage : typeof product.image === "string" ? product.image : ""};
  });
  return {products, families, orderFamilies, market: {label: site.label, domain: `www.${site.amazonDomain}`},
    capturedAt: context.capturedAt, progress: snapshot.xydcOrderProgress};
}
