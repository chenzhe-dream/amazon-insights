import type { AsinModuleStatus, SyncJob } from "../../app/lib/sync-server";

const fields = {
  keywords: "keywords", reviews: "reviews", sales: "sales_trend", childSales: "child_sales",
  priceStrategy: "price_strategy", fba: "fba", listing: "listing", imageRemarks: "image_remarks",
  category: "category", traffic: "traffic", voc: "alexa_voc",
} as const;

export function sameAsinSet(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && new Set(left).size === left.length &&
    [...left].sort().every((asin, index) => asin === [...right].sort()[index]);
}

export function projectSyncReadiness(asins: string[], job: SyncJob | null): AsinModuleStatus[] {
  return asins.map(asin => ({
    asin,
    inCatalog: job?.asinProgress[asin]?.catalog?.status === "ready",
    ...Object.fromEntries(Object.entries(fields).map(([field, stage]) =>
      [field, job?.asinProgress[asin]?.[stage]?.status === "ready" ? "ready" : "missing"])),
  }) as AsinModuleStatus);
}
