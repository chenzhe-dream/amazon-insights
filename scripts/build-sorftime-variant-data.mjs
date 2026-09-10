import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createSorftimeBudget } from "./lib/sorftime-request-budget.mjs";
import { callSorftimeTool, readSorftimeKey } from "./lib/sorftime-mcp-client.mjs";
import {
  isForceRefresh,
  logCacheHit,
  readCachedDataExport,
} from "./lib/sync-cache.mjs";

const root = path.resolve(import.meta.dirname, "..");
const catalogPath = path.join(root, "app", "competitor-data.ts");
const outPath = path.join(root, "app", "sorftime-variant-data.ts");

function readCatalogAsins() {
  const source = fs.readFileSync(catalogPath, "utf8");
  return [...source.matchAll(/"asin":\s*"([A-Z0-9]{10})"/g)].map(match => match[1]);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function parseImageList(raw) {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {
    if (raw.startsWith("http")) return [raw];
  }
  return [];
}

function formatAttribute(property) {
  const text = String(property ?? "").trim();
  if (!text) return "未命名变体";
  const parts = text.split(/[,，]/).map(part => part.trim()).filter(Boolean);
  const mapped = parts.map(part => {
    const colorMatch = part.match(/^(?:Color|颜色)\s*[:：=]\s*(.+)$/i);
    if (colorMatch) return `颜色：${colorMatch[1].trim()}`;
    const styleMatch = part.match(/^(?:Style|款式)\s*[:：=]\s*(.+)$/i);
    if (styleMatch) return `款式：${styleMatch[1].trim()}`;
    const sizeMatch = part.match(/^(?:Size|尺寸)\s*[:：=]\s*(.+)$/i);
    if (sizeMatch) return `尺寸：${sizeMatch[1].trim()}`;
    return part.replace(/^([^:：=]+)[:：=]\s*/, (_, key) => `${key.trim()}：`);
  });
  return mapped.join(" · ") || text;
}

function variantMatchKey(attribute) {
  const text = String(attribute ?? "").trim();
  if (!text) return "";
  const colorMatch = text.match(/(?:Color|颜色)\s*[:：=]\s*([^,，]+)/i);
  if (colorMatch) return colorMatch[1].trim().toLowerCase();
  return text.toLowerCase();
}

function parseVariationRows(raw) {
  const rows = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : [];
  return rows
    .map(row => {
      const asin = String(row.Asin ?? row.asin ?? "").toUpperCase();
      const salesRaw = Number(row.SalesAmount ?? row.sales_amount);
      const childSales = Number.isFinite(salesRaw) && salesRaw >= 0 ? salesRaw : null;
      if (!/^[A-Z0-9]{10}$/.test(asin)) return null;
      return {
        asin,
        attribute: formatAttribute(row.Property ?? row.property),
        matchKey: variantMatchKey(row.Property ?? row.property),
        childSales,
      };
    })
    .filter(Boolean);
}

async function fetchAllVariations(key, asin, marketplace, call = callSorftimeTool, onPartial = () => {}) {
  const first = await call(key, "product_variations", {
    asin,
    amz_site: marketplace,
    page: 1,
  });
  const items = parseVariationRows(first);
  const total = Number(first?.data?.[0]?.ItemTotal ?? first?.data?.[0]?.item_total ?? items.length);
  const pageSize = 20;
  const pages = Math.max(1, Math.ceil((total || items.length) / pageSize));
  for (let page = 2; page <= pages; page += 1) {
    try {
    const next = await call(key, "product_variations", {
      asin,
      amz_site: marketplace,
      page,
    });
    items.push(...parseVariationRows(next));
    await sleep(200);
    } catch { onPartial(); break; }
  }
  const map = new Map();
  for (const item of items) map.set(item.asin, item);
  return [...map.values()];
}

async function fetchListingDetail(key, asin, marketplace, call = callSorftimeTool) {
  const raw = await call(key, "product_detail", { asin, amz_site: marketplace });
  const detail = raw?.data ?? raw;
  const images = parseImageList(detail?.main_image);
  return {
    parentAsin: detail?.parent_asin ? String(detail.parent_asin).toUpperCase() : asin,
    reviewTotal: toNumber(detail?.review_count),
    launch: detail?.online_date ? String(detail.online_date).slice(0, 10) : null,
    image: images[0] ?? null,
  };
}

function countReviewSamplesByVariant(reviews) {
  const counts = new Map();
  for (const review of reviews ?? []) {
    const key = variantMatchKey(review?.variant_attribute);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function withReviewShares(variants, { sampledTotal, reviewTotal }) {
  if (!sampledTotal) {
    return variants.map(item => ({ ...item, reviewShare: null }));
  }

  const weights = variants.map(item => item.reviewSamples ?? 0);
  const estimatedTotals =
    reviewTotal != null ? largestRemainderAllocate(weights, reviewTotal) : weights;

  return variants.map((item, index) => {
    const sampleCount = item.reviewSamples ?? 0;
    return {
      ...item,
      reviews: reviewTotal != null ? estimatedTotals[index] : sampleCount > 0 ? sampleCount : null,
      reviewShare:
        sampleCount > 0 ? Math.round((sampleCount / sampledTotal) * 1000) / 10 : null,
    };
  });
}

function largestRemainderAllocate(weights, total) {
  if (!weights.length || total <= 0) return weights.map(() => 0);
  const weightSum = weights.reduce((sum, value) => sum + value, 0) || 1;
  const raw = weights.map(weight => (total * weight) / weightSum);
  const floors = raw.map(value => Math.floor(value));
  let remainder = total - floors.reduce((sum, value) => sum + value, 0);
  const order = raw
    .map((value, index) => ({ index, fraction: value - floors[index] }))
    .sort((a, b) => b.fraction - a.fraction || b.index - a.index);
  const result = [...floors];
  for (let i = 0; remainder > 0; i += 1) {
    result[order[i % order.length].index] += 1;
    remainder -= 1;
  }
  return result;
}

export async function syncParentVariants(key, catalogAsin, marketplace, fetchedAt, options = {}) {
  const budget = createSorftimeBudget(options);
  const call = budget(false);
  const optionalCall = budget(true);
  const progress = options.onProgress ?? (() => {});
  let partial = false;
  const salesMonth = fetchedAt.slice(0, 7);
  const listing = await fetchListingDetail(key, catalogAsin, marketplace, call);
  const parentAsin = listing.parentAsin || catalogAsin;
  const variations = await fetchAllVariations(key, parentAsin, marketplace, call, () => { partial = true; });

  let reviewSamples = [];
  try {
    const reviewsRaw = await optionalCall(key, "product_reviews", {
      asin: catalogAsin,
      amz_site: marketplace,
      review_type: "Both",
    });
    reviewSamples = reviewsRaw?.data ?? reviewsRaw ?? [];
  } catch {
    reviewSamples = [];
    partial = true;
  }
  const sampleCounts = countReviewSamplesByVariant(reviewSamples);
  const sampledTotal = [...sampleCounts.values()].reduce((sum, value) => sum + value, 0);
  const reviewTotal = listing.reviewTotal;

  const enriched = [];
  for (const variation of variations) {
    progress({ asin: catalogAsin, completed: enriched.length, total: variations.length, state: "collecting" });
    let launch = null;
    let image = null;
    try {
      const childDetail = variation.asin === catalogAsin ? listing : await fetchListingDetail(key, variation.asin, marketplace, optionalCall);
      launch = childDetail.launch;
      image = childDetail.image;
    } catch {
      // launch/image optional
      partial = true;
    }

    const sampleCount = sampleCounts.get(variation.matchKey) ?? 0;

    enriched.push({
      asin: variation.asin,
      attribute: variation.attribute,
      reviewSamples: sampleCount,
      reviews: null,
      reviewShare: null,
      childSales: variation.childSales,
      salesMonth: variation.childSales != null ? salesMonth : null,
      launch,
      image,
    });
  }

  progress({ asin: catalogAsin, completed: enriched.length, total: variations.length, state: partial ? "partial" : "completed" });

  return withReviewShares(enriched, { sampledTotal, reviewTotal }).sort(
    (a, b) => (b.reviewShare ?? -1) - (a.reviewShare ?? -1) || (b.reviews ?? -1) - (a.reviews ?? -1)
  );
}

export async function syncSorftimeVariants({ outputPath = outPath, asins: selectedAsins, key: suppliedKey, callTool } = {}) {
  const key = suppliedKey ?? readSorftimeKey();
  const marketplace = process.env.SORFTIME_MARKETPLACE ?? "US";
  const asins = selectedAsins ??
    process.env.SORFTIME_ASINS?.split(",").map(item => item.trim()).filter(Boolean) ?? readCatalogAsins();
  const fetchedAt = new Date().toISOString().slice(0, 10);
  const existing = readCachedDataExport(outputPath, "sorftimeVariantData");
  const records = { ...existing };
  const outcomes = { ...readCachedDataExport(outputPath, "sorftimeVariantMeta").outcomes };
  const deadline = Math.min(Number(process.env.SORFTIME_COLLECTION_DEADLINE) || Infinity, Date.now() + 90_000);

  function writeRecords() {
  const body = `// Generated by scripts/build-sorftime-variant-data.mjs — do not edit manually
export type SorftimeVariant = {
  asin: string;
  attribute: string;
  reviewSamples: number | null;
  reviews: number | null;
  reviewShare: number | null;
  childSales: number | null;
  salesMonth: string | null;
  launch: string | null;
  image: string | null;
};

export const sorftimeVariantMeta = ${JSON.stringify(
    {
      source:
        "Sorftime MCP · product_variations + product_reviews(variant_attribute) + product_detail",
      updatedAt: fetchedAt,
      outcomes,
      marketplace,
      syncCommand: "npm run variant:sync",
      note:
        "评论占比=近一年评论样本中该颜色出现次数/样本总数；评论数为按样本占比估算的父体 review_count。Sorftime 样本上限约100条，样本少时同色可能占比相同。",
    },
    null,
    2
  )} as const;

export const sorftimeVariantData: Record<string, SorftimeVariant[]> = ${JSON.stringify(records, null, 2)};
`;

  fs.writeFileSync(outputPath, body, "utf8");
  }

  if (!key && !Object.values(existing).some(list => Array.isArray(list) && list.length)) {
    console.error("[error] 未找到 Sorftime MCP key，且无可用缓存");
    process.exitCode = 1;
    return;
  }

  if (isForceRefresh()) console.log("[sync] FORCE_REFRESH=1 · 忽略缓存，重新调用 MCP");

  for (const parentAsin of asins) {
    const cached = existing[parentAsin];
    if (
      !isForceRefresh() &&
      Array.isArray(cached) &&
      cached.length &&
      cached.some(item => item.reviewShare != null) &&
      cached.every(item => "reviewSamples" in item)
    ) {
      logCacheHit(parentAsin, { status: "ready", fetchedAt: cached[0]?.salesMonth, volume: cached });
      records[parentAsin] = cached;
      continue;
    }
    if (!key) {
      console.log(`[skip] ${parentAsin} · 无 MCP key`);
      continue;
    }

    console.log(`[variant] ${parentAsin}`);
    try {
      records[parentAsin] = await syncParentVariants(key, parentAsin, marketplace, fetchedAt, { deadline, callTool,
        onProgress: progress => {
          outcomes[parentAsin] = { state: progress.state, fetchedAt };
          console.log(`@@sorftime-progress@@${JSON.stringify(progress)}`);
        },
      });
      console.log(` ${records[parentAsin].length} children`);
    } catch (error) {
      outcomes[parentAsin] = { state: "partial", reasonCode: error?.name === "TimeoutError" || error?.diagnostic?.failureKind === "timeout" ? "REQUEST_TIMEOUT" : "CONNECTOR_FAILED", fetchedAt };
      if (Array.isArray(cached) && cached.length) {
        console.log(` error · keep cache (${error instanceof Error ? error.message : String(error)})`);
        records[parentAsin] = cached;
      } else {
        records[parentAsin] = [];
        console.log(` error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    writeRecords();
  }

  writeRecords();
  const ready = asins.filter(asin => Array.isArray(records[asin]) && records[asin].length).length;
  console.log(`[done] ${ready}/${asins.length} parents → app/sorftime-variant-data.ts`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) syncSorftimeVariants().catch(error => {
  console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
