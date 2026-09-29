import {pickCrnKey,pickNewKey,type SellerSpriteMarketNiche,type SellerSpriteDistRow,type SellerSpriteDistProduct} from "./sellersprite-market-niche";
function toNumber(value: unknown) {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !value.trim())) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toPct(value: unknown) {
  const num = toNumber(value);
  if (num == null) return null;
  return num <= 1 && num >= 0 ? num * 100 : num;
}


function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}


function labelPath(raw: string) {
  return raw
    .split(":")
    .map(part => part.trim())
    .filter(Boolean)
    .join(" › ");
}

function mapNiche(
  item: Record<string, unknown>,
  stats: Record<string, unknown>,
  options: { marketplace: string; topN: number; newProductMonths: number; fetchedAt: string },
): SellerSpriteMarketNiche {
  const crn = pickCrnKey(options.topN);
  const neu = pickNewKey(options.newProductMonths);
  const headCount = options.topN;
  const headSales = toNumber(item[`${crn}ProductSales`]);
  const headRevenue = toNumber(item[`${crn}ProductRevenue`]);
  const images = Array.isArray(item.top10Images)
    ? item.top10Images
        .map(entry => asRecord(entry))
        .map(entry => ({ asin: String(entry.asin ?? ""), image: String(entry.image ?? "") }))
        .filter(entry => entry.asin)
    : [];

  return {
    marketplace: options.marketplace,
    nodeId: String(item.nodeId ?? ""),
    nodeIdPath: String(item.nodeIdPath ?? ""),
    categoryName: String(item.nodeLabelName ?? "").trim() || labelPath(String(item.nodeLabelPath ?? "")).split(" › ").at(-1) || "",
    categoryNameLocale: String(item.nodeLabelLocale ?? "").trim(),
    categoryPath: labelPath(String(item.nodeLabelPath ?? "")),
    categoryPathLocale: labelPath(String(item.nodeLabelPathLocale ?? "")),
    fetchedAt: options.fetchedAt,
    currency: String(item.currency ?? "USD"),
    sampleProducts: toNumber(item.topProducts) ?? toNumber(item.products) ?? toNumber(stats.products),
    brands: toNumber(item.brands) ?? toNumber(stats.brands),
    sellers: toNumber(item.sellers) ?? toNumber(stats.sellers),
    totalProducts: toNumber(item.totalProducts),
    totalUnits: toNumber(item.totalUnits),
    totalRevenue: toNumber(item.totalRevenue),
    avgUnits: toNumber(item.avgUnits) ?? toNumber(stats.avgUnits),
    avgRevenue: toNumber(item.avgRevenue) ?? toNumber(stats.avgRevenue),
    avgPrice: toNumber(item.avgPrice) ?? toNumber(stats.avgPrice),
    avgRatings: toNumber(item.avgRatings) ?? toNumber(stats.avgRatings),
    avgRating: toNumber(item.avgRating) ?? toNumber(stats.avgRating),
    avgBsr: toNumber(item.avgBsr) ?? toNumber(stats.avgBsr),
    avgSellers: toNumber(item.avgSellers) ?? toNumber(stats.avgSellers),
    avgProfit: toNumber(item.avgProfit) ?? toNumber(stats.avgProfit),
    avgWeightLb: toNumber(item.avgWeight) ?? toNumber(stats.avgWeight),
    avgWeightG: toNumber(item.baseAvgWeight) ?? toNumber(stats.baseAvgWeight),
    avgVolumeIn3: toNumber(item.avgVolume) ?? toNumber(stats.avgVolume),
    avgVolumeCm3: toNumber(item.baseAvgVolume) ?? toNumber(stats.baseAvgVolume),
    ebcProportion: toNumber(item.ebcProportion),
    amazonSelfProportion: toNumber(item.amazonSelfProportion),
    fbaProportion: toNumber(item.fbaProportion),
    fbmProportion: toNumber(item.fbmProportion),
    sellerNationLabel: String(item.sellerNationLabel ?? item.sellerNation ?? ""),
    sellerNationShare: toNumber(item.sellerProportion),
    returnRatio: toNumber(item.returnRatio),
    avgReturnRatio: toNumber(item.avgReturnRatio),
    searchToPurchaseRatio: toNumber(item.searchToPurchaseRatio),
    hlAvgUnits: headSales != null && headCount ? headSales / headCount : toNumber(stats.hlAvgUnits),
    hlAvgRevenue: headRevenue != null && headCount ? headRevenue / headCount : toNumber(stats.hlAvgRevenue),
    hlAvgBsr: toNumber(stats.hlAvgBsr),
    hlAvgPrice: toNumber(stats.hlAvgPrice),
    hlAvgRating: toNumber(stats.hlAvgRating),
    productCrn: toPct(item[`${crn}ProductCrn`]),
    brandCrn: toPct(item[`${crn}BrandCrn`]),
    sellerCrn: toPct(item[`${crn}SellerCrn`]),
    newCount: toNumber(item[`${neu}NewCount`]) ?? toNumber(stats.newProducts),
    newRatio: toPct(item[`${neu}NewRatio`]) ?? toNumber(stats.newProductProportion),
    newAvgPrice: toNumber(item[`${neu}NewAvgPrice`]) ?? toNumber(stats.newAvgPrice),
    newAvgRatings: toNumber(item[`${neu}NewAvgReviews`]) ?? toNumber(stats.newAvgRatings),
    newAvgRating: toNumber(item[`${neu}NewAvgRating`]) ?? toNumber(stats.newAvgRating),
    newAvgUnits: toNumber(item[`${neu}NewAvgSales`]) ?? toNumber(stats.newAvgUnits),
    newAvgRevenue: toNumber(item[`${neu}NewAvgRevenue`]) ?? toNumber(stats.newAvgRevenue),
    firstShelfDate: item.firstShelfDate ? String(item.firstShelfDate).slice(0, 10) : stats.firstShelfDate ? String(stats.firstShelfDate).slice(0, 10) : null,
    lastShelfDate: item.lastShelfDate ? String(item.lastShelfDate).slice(0, 10) : stats.lastShelfDate ? String(stats.lastShelfDate).slice(0, 10) : null,
    topImages: images,
  };
}


function asList(value: unknown) {
  if (Array.isArray(value)) return value.map(asRecord);
  const record = asRecord(value);
  if (Array.isArray(record.items)) return record.items.map(asRecord);
  return [];
}

function parseDistProducts(value: unknown): { asins: string[]; items: SellerSpriteDistProduct[] } {
  if (!Array.isArray(value)) return { asins: [], items: [] };
  const items = value
    .map(entry => {
      if (typeof entry === "string") {
        const asin = entry.trim();
        return asin ? { asin } : null;
      }
      const record = asRecord(entry);
      const asin = String(record.asin ?? record.ASIN ?? "").trim();
      if (!asin) return null;
      return {
        asin,
        title: record.title ? String(record.title) : undefined,
        units: toNumber(record.totalUnits ?? record.units),
        price: toNumber(record.price),
        rating: toNumber(record.rating),
        ratings: toNumber(record.ratings),
        imageUrl: record.imageUrl ? String(record.imageUrl) : undefined,
        profit: toNumber(record.profit),
        fba: toNumber(record.fba),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  return { asins: items.map(item => item.asin), items };
}

function distRows(
  value: unknown,
  pickLabel: (item: Record<string, unknown>) => string,
): SellerSpriteDistRow[] {
  return asList(value)
    .map(item => {
      const parsed = parseDistProducts(item.asins ?? item.items ?? item.productList);
      const products = toNumber(item.products) ?? toNumber(item.productNum) ?? toNumber(item.asinNum);
      const unitsShare = toPct(item.unitsRatio ?? item.totalUnitsRatio ?? item.productsRatio);
      const avgUnitsShare =
        toPct(item.avgUnitsRatio ?? item.avgUnitsShare ?? item.avgSaleRatio) ??
        (products && unitsShare != null && products > 0 ? unitsShare / products : null);
      return {
        label: pickLabel(item),
        products,
        units: toNumber(item.units) ?? toNumber(item.totalUnits),
        unitsShare,
        revenue: toNumber(item.revenue) ?? toNumber(item.totalRevenue),
        rating: toNumber(item.rating),
        ratings: toNumber(item.ratings),
        asinRatio: toPct(item.asinRatio ?? item.productsRatio),
        avgUnitsShare,
        asins: parsed.asins,
        items: parsed.items,
      };
    })
    .filter(row => row.label);
}


export {mapNiche,distRows};

import type {SellerSpriteProductDemand,SellerSpriteTrendPoint} from './sellersprite-market-niche';
type SellerSpriteDemandFallback={totalProducts?:number|null;returnRatio?:number|null;avgReturnRatio?:number|null;searchToPurchaseRatio?:number|null};
function parseProductDemand(
  value: unknown,
  fallback: SellerSpriteDemandFallback = {},
): SellerSpriteProductDemand {
  const record = asRecord(value);
  const items = Array.isArray(record.items) ? record.items.map(asRecord) : [];
  const pageViews = items
    .map(item => {
      const rawDate = String(item.date ?? item.month ?? "").trim();
      const month = rawDate.length >= 7 ? rawDate.slice(0, 10) : rawDate;
      const views = toNumber(item.glanceViews ?? item.pageViews ?? item.views ?? item.value);
      if (!month || views == null) return null;
      return { month, value: views };
    })
    .filter((point): point is SellerSpriteTrendPoint => Boolean(point));
  const updatedAt = pageViews.at(-1)?.month ?? null;
  const apiEmpty =
    !pageViews.length &&
    toNumber(record.asinCount) == null &&
    toNumber(record.returnRatio) == null &&
    toNumber(record.searchToPurchaseRatio) == null;
  const pick = <T,>(api: T | null | undefined, fb: T | null | undefined) =>
    apiEmpty ? (fb ?? null) : (api ?? fb ?? null);
  return {
    asinCount: pick(toNumber(record.asinCount), fallback.totalProducts ?? null),
    returnRatio: pick(toNumber(record.returnRatio), fallback.returnRatio ?? null),
    avgReturnRatio: pick(toNumber(record.avgReturnRatio), fallback.avgReturnRatio ?? null),
    searchToPurchaseRatio: pick(toNumber(record.searchToPurchaseRatio), fallback.searchToPurchaseRatio ?? null),
    avgSearchToPurchaseRatio: apiEmpty ? null : toNumber(record.avgSearchToPurchaseRatio),
    pageViews,
    updatedAt,
  };
}


export {parseProductDemand};

import type {SellerSpriteCrnRow} from './sellersprite-market-niche';
function crnRows(value: unknown, kind: "product" | "brand" | "seller"): SellerSpriteCrnRow[] {
  return asList(value)
    .map((item, index) => {
      const units = toNumber(item.totalUnits) ?? toNumber(item.units);
      const revenue = toNumber(item.totalRevenue) ?? toNumber(item.revenue);
      const isNew = Number(item.newFlag) === 1;
      const newUnits = toNumber(item.newUnits) ?? (isNew ? units : 0);
      const newRevenue = toNumber(item.newRevenue) ?? (isNew ? revenue : 0);
      const asins = Array.isArray(item.asins)
        ? item.asins.map(entry => String(entry).trim()).filter(Boolean)
        : item.asin
          ? [String(item.asin).trim()]
          : [];
      const parsed = parseDistProducts(
        asins.map(asin => ({
          asin,
          title: kind === "product" ? String(item.title ?? "") : undefined,
          imageUrl: kind === "product" && item.imageUrl ? String(item.imageUrl) : undefined,
          units: kind === "product" ? units : undefined,
          price: kind === "product" ? toNumber(item.price) : undefined,
          rating: kind === "product" ? toNumber(item.rating) : undefined,
          ratings: kind === "product" ? toNumber(item.ratings) : undefined,
        })),
      );
      const label =
        kind === "product"
          ? String(item.title || item.asin || index + 1)
          : kind === "brand"
            ? String(item.brand || "")
            : String(item.sellerName || "");
      return {
        rank: toNumber(item.ranking) ?? index + 1,
        label,
        asin: item.asin ? String(item.asin) : undefined,
        imageUrl: item.imageUrl ? String(item.imageUrl) : undefined,
        products: toNumber(item.products),
        newProducts: toNumber(item.newProducts),
        isNew,
        units,
        newUnits,
        unitsShare: toPct(item.totalUnitsRatio ?? item.unitsRatio),
        newUnitsShare: toPct(item.newUnitsRatio),
        revenue,
        newRevenue,
        revenueShare: toPct(item.totalRevenueRatio ?? item.revenueRatio),
        newRevenueShare: toPct(item.newRevenueRatio),
        asins: parsed.asins,
        items: parsed.items,
      };
    })
    .filter(row => row.label);
}


export {crnRows};
