import { ImageRemarkOutcomeSchema } from "../../shared/agent-contracts";
import { z } from "zod";
import { MarketSiteSchema, marketSites } from "../../shared/market-sites";
import { ImageRemarkOverlayEntrySchema } from "../../shared/image-remark-overlay";
import type { ExportModuleContext } from "./export-module-context";
import { safeOnlineUrl } from "./safe-export-url";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const listingSchema = z.object({
  asin: z.string(), marketplace: z.string(), fetchedAt: z.string().optional(),
  mainImage: z.string().nullable().optional(), galleryImages: z.array(z.string()).optional(),
  previousGalleryImages: z.array(z.string()).optional(),
});
const remarkSchema = z.object({
  remark: z.string(), image_types: z.array(z.string()), confidence: z.enum(["high", "medium", "low"]),
  imageUrl: z.string().optional(),
});
const outcomeSchema = ImageRemarkOutcomeSchema;

export type ImagesSnapshotSources = Readonly<{
  products: {asin: string; brand: string; image: string}[];
  market: {label: string; domain: string};
  listingByAsin: Record<string, z.infer<typeof listingSchema>>;
  remarksByAsin: Record<string, (z.infer<typeof remarkSchema> | null)[]>;
  outcomesByAsin: Record<string, (z.infer<typeof outcomeSchema> | null)[]>;
  overlays: z.infer<typeof ImageRemarkOverlayEntrySchema>[];
}>;

/** Pure projection of the selected ASINs from the frozen published report. */
export function readPageSnapshotImages(context: ExportModuleContext, snapshotProducts?: readonly {asin: string; brand: string; image: string}[]): ImagesSnapshotSources {
  const site = MarketSiteSchema.parse(context.marketplace);
  if (context.version && context.version.marketplace !== site) throw new Error("已发布主副图站点来源范围不匹配");
  const market = marketSites.find(item => item.code === site)!;
  const catalog = context.version?.catalog ?? [];
  const listingOutput = context.version?.stageOutputs.listing;
  const remarksOutput = context.version?.stageOutputs.image_remarks;
  const listings = object(listingOutput && "data" in listingOutput ? object(listingOutput.data).contentByAsin : null);
  const remarks = object(remarksOutput && "data" in remarksOutput ? object(remarksOutput.data).remarksByAsin : null);
  const outcomes = object(remarksOutput && "data" in remarksOutput ? object(remarksOutput.data).outcomesByAsin : null);
  const products: ImagesSnapshotSources["products"] = [];
  const listingByAsin: ImagesSnapshotSources["listingByAsin"] = {};
  const remarksByAsin: ImagesSnapshotSources["remarksByAsin"] = {};
  const outcomesByAsin: ImagesSnapshotSources["outcomesByAsin"] = {};
  for (const asin of context.asins) {
    if (!/^[A-Z0-9]{10}$/.test(asin)) throw new Error("主副图 ASIN 无效");
    const candidates = catalog.filter(item => object(item).asin === asin);
    if (candidates.length > 1) throw new Error("商品来源重复，请重新准备");
    const product = object(candidates[0]);
    if ((product.marketplace !== undefined && product.marketplace !== site) ||
        (product.asin !== undefined && product.asin !== asin)) throw new Error("商品来源范围不匹配");
    const provided = snapshotProducts?.find(item => item.asin === asin);
    if (snapshotProducts && (!provided || snapshotProducts.filter(item => item.asin === asin).length !== 1))
      throw new Error("主副图商品来源范围不匹配");
    const rawListing = listings[asin];
    if (rawListing !== undefined) {
      const listing = listingSchema.parse(rawListing);
      if (listing.asin !== asin || listing.marketplace !== site) throw new Error("主副图来源范围不匹配");
      listingByAsin[asin] = {
        asin: listing.asin, marketplace: listing.marketplace, fetchedAt: listing.fetchedAt,
        mainImage: safeOnlineUrl(listing.mainImage ?? undefined, true) ?? "",
        galleryImages: listing.galleryImages?.map(url => safeOnlineUrl(url, true) ?? "") ?? [],
        previousGalleryImages: listing.previousGalleryImages?.map(url => safeOnlineUrl(url, true) ?? ""),
      };
    }
    const rawRemarks = remarks[asin] === undefined ? [] : z.array(z.unknown()).parse(remarks[asin]);
    remarksByAsin[asin] = rawRemarks.map(value => {
      if (value == null) return null;
      const note = remarkSchema.parse(value);
      return {...note, ...(note.imageUrl !== undefined ? {imageUrl: safeOnlineUrl(note.imageUrl, true) ?? ""} : {})};
    });
    const rawOutcomes = outcomes[asin] === undefined ? [] : z.array(z.unknown()).parse(outcomes[asin]);
    outcomesByAsin[asin] = rawOutcomes.map(value => value == null ? null : outcomeSchema.parse(value));
    const rawImage = provided?.image ?? product.image;
    products.push({asin, brand: provided?.brand ?? (typeof product.brand === "string" ? product.brand : "品牌未记录"),
      image: typeof rawImage === "string" ? safeOnlineUrl(rawImage, true) ?? "" : ""});
  }
  const overlays = (context.version?.imageRemarkOverlay ?? []).map(item => ImageRemarkOverlayEntrySchema.parse(item))
    .filter(item => context.asins.includes(item.asin)).map(item => ({...item, imageUrl: safeOnlineUrl(item.imageUrl, true) ?? ""}));
  return {products, market: {label: market.label, domain: market.amazonDomain},
    listingByAsin, remarksByAsin, outcomesByAsin, overlays};
}
