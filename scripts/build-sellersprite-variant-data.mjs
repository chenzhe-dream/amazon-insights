import fs from "node:fs";
import path from "node:path";
import { callSellerSpriteMcpTool, readSellerSpriteSecretKey } from "./lib/sellersprite-mcp-client.mjs";
import {
  isForceRefresh,
  logCacheHit,
  readCachedDataExport,
} from "./lib/sync-cache.mjs";

const root = path.resolve(import.meta.dirname, "..");
const catalogPath = path.join(root, "app", "competitor-data.ts");
const childSalesPath = path.join(root, "app", "seller-sprite-child-sales-data.ts");
const outPath = path.join(root, "app", "variant-data.ts");

function readCatalogAsins() {
  const source = fs.readFileSync(catalogPath, "utf8");
  return [...source.matchAll(/"asin":\s*"([A-Z0-9]{10})"/g)].map(match => match[1]);
}

function readChildSalesLookup() {
  if (!fs.existsSync(childSalesPath)) return new Map();
  const source = fs.readFileSync(childSalesPath, "utf8");
  const lookup = new Map();
  const rowRe =
    /\{\s*asin:\s*"([A-Z0-9]{10})"[\s\S]*?variant:\s*"([^"]+)"[\s\S]*?sales:\s*(\d+)[\s\S]*?observedAt:\s*"([^"]+)"/g;
  for (const match of source.matchAll(rowRe)) {
    lookup.set(match[1], {
      childSales: Number(match[3]),
      salesMonth: match[4].slice(0, 7),
      variant: match[2],
    });
  }
  return lookup;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function formatAttribute(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "未命名变体";
  const colorMatch = text.match(/^(?:Color|颜色)\s*[:：=]\s*(.+)$/i);
  if (colorMatch) return `颜色：${colorMatch[1].trim()}`;
  return text.replace(/^([^:：=]+)[:：=]\s*/, (_, key) => `${key.trim()}：`);
}

function formatLaunch(ms) {
  if (!ms) return null;
  const date = new Date(Number(ms));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function pickVariantReviews(detail) {
  const variantReviews = toNumber(detail?.variantReviews);
  if (variantReviews != null && variantReviews > 0) return variantReviews;
  const reviews = toNumber(detail?.reviews);
  const ratings = toNumber(detail?.ratings);
  if (reviews != null && reviews > 0 && (ratings == null || reviews < ratings)) return reviews;
  return null;
}

function withReviewShares(variants) {
  const totalReviews = variants.reduce((sum, item) => sum + (item.reviews ?? 0), 0);
  return variants.map(item => ({
    ...item,
    reviewShare:
      item.reviews != null && totalReviews > 0
        ? Math.round((item.reviews / totalReviews) * 1000) / 10
        : null,
  }));
}

async function fetchChildDetail(secretKey, asin, marketplace, attempt = 0) {
  const raw = await callSellerSpriteMcpTool(secretKey, "asin_detail", { marketplace, asin });
  if (raw?.code === "ERROR_MAXIMUM_ACCESS_PER_MINUTE" && attempt < 4) {
    await sleep(15000 * (attempt + 1));
    return fetchChildDetail(secretKey, asin, marketplace, attempt + 1);
  }
  if (raw?.code && raw.code !== "OK") {
    throw new Error(`${raw.code}: ${raw.message ?? "asin_detail 请求失败"}`);
  }
  return raw?.data ?? raw;
}

async function syncParentVariants(secretKey, catalogAsin, marketplace, childSalesLookup, fetchedAt) {
  const salesMonth = fetchedAt.slice(0, 7);
  const listing = await fetchChildDetail(secretKey, catalogAsin, marketplace);
  const parentAsin = String(listing?.parent ?? catalogAsin).toUpperCase();
  let variationList = Array.isArray(listing?.variationList) ? listing.variationList : [];

  if (!variationList.length) {
    variationList = [{ asin: catalogAsin, attribute: listing?.skuList?.[0] ?? "默认变体" }];
  }

  const enriched = [];
  for (const variation of variationList) {
    process.stdout.write(".");
    const childAsin = String(variation.asin ?? "").toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(childAsin)) continue;

    let detail = listing;
    if (childAsin !== catalogAsin) {
      try {
        detail = await fetchChildDetail(secretKey, childAsin, marketplace);
        await sleep(450);
      } catch {
        detail = listing;
      }
    }

    const salesInfo = childSalesLookup.get(childAsin);
    enriched.push({
      asin: childAsin,
      attribute: formatAttribute(variation.attribute ?? detail?.skuList?.[0]),
      reviews: pickVariantReviews(detail),
      reviewShare: null,
      childSales: salesInfo?.childSales ?? null,
      salesMonth: salesInfo?.childSales != null ? salesInfo.salesMonth ?? salesMonth : null,
      launch: formatLaunch(detail?.availableDate ?? detail?.createdTime),
      image: detail?.imageUrl ?? detail?.zoomImageUrl ?? null,
    });
  }

  return withReviewShares(enriched).sort(
    (a, b) => (b.reviewShare ?? -1) - (a.reviewShare ?? -1) || (b.reviews ?? -1) - (a.reviews ?? -1)
  );
}

async function main() {
  const secretKey = readSellerSpriteSecretKey();
  const marketplace = process.env.SELLERSPRITE_MARKETPLACE ?? "US";
  const asins =
    process.env.SELLERSPRITE_ASINS?.split(",").map(item => item.trim()).filter(Boolean) ??
    readCatalogAsins();
  const fetchedAt = new Date().toISOString().slice(0, 10);
  const existing = readCachedDataExport(outPath, "sellerSpriteVariantData");
  const records = { ...existing };
  const childSalesLookup = readChildSalesLookup();

  if (!secretKey && !Object.values(existing).some(list => Array.isArray(list) && list.length)) {
    console.error("[error] 未找到 SellerSprite secret-key，且无可用缓存");
    process.exitCode = 1;
    return;
  }

  if (isForceRefresh()) console.log("[sync] FORCE_REFRESH=1 · 忽略缓存，重新调用 MCP");

  for (const parentAsin of asins) {
    const cached = existing[parentAsin];
    const cacheIsUsable =
      Array.isArray(cached) &&
      cached.length &&
      cached.some(item => item.reviewShare != null || item.reviews != null);
    if (!isForceRefresh() && cacheIsUsable) {
      logCacheHit(parentAsin, { status: "ready", fetchedAt: cached[0]?.salesMonth, volume: cached });
      records[parentAsin] = cached;
      continue;
    }
    if (!secretKey) {
      console.log(`[skip] ${parentAsin} · 无 MCP key`);
      continue;
    }

    process.stdout.write(`[variant] ${parentAsin}`);
    try {
      records[parentAsin] = await syncParentVariants(
        secretKey,
        parentAsin,
        marketplace,
        childSalesLookup,
        fetchedAt
      );
      console.log(` ${records[parentAsin].length} children`);
    } catch (error) {
      if (cacheIsUsable) {
        console.log(` error · keep cache (${error instanceof Error ? error.message : String(error)})`);
        records[parentAsin] = cached;
      } else {
        records[parentAsin] = [];
        console.log(` error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await sleep(500);
  }

  const body = `// Generated by scripts/build-sellersprite-variant-data.mjs — do not edit manually
export type SellerSpriteVariant = {
  asin: string;
  attribute: string;
  reviews: number | null;
  reviewShare: number | null;
  childSales: number | null;
  salesMonth: string | null;
  launch: string | null;
  image: string | null;
};

export const sellerSpriteVariantMeta = ${JSON.stringify(
    {
      source: "卖家精灵 MCP · asin_detail · variantReviews + variationList",
      updatedAt: fetchedAt,
      marketplace,
      syncCommand: "npm run variant:sync",
      note: "评论占比按卖家精灵返回的子体 variantReviews 计算；子销量取商品调研近30天购买量（如有）",
    },
    null,
    2
  )} as const;

export const sellerSpriteVariantData: Record<string, SellerSpriteVariant[]> = ${JSON.stringify(records, null, 2)};
`;

  fs.writeFileSync(outPath, body, "utf8");
  const ready = Object.values(records).filter(list => Array.isArray(list) && list.length).length;
  console.log(`[done] ${ready}/${asins.length} parents → app/variant-data.ts`);
}

main().catch(error => {
  console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
