import fs from "node:fs";
import path from "node:path";
import { callSorftimeTool, readSorftimeKey } from "./lib/sorftime-mcp-client.mjs";
import { parseSorftimeCategoryTrend } from "./lib/sorftime-trend-parse.mjs";
import { selectSorftimeCategoryInputs } from "./lib/sorftime-category-input.mjs";
import {
  isForceRefresh,
  logCacheHit,
  readCachedDataExport,
  shouldUseCachedRecord,
} from "./lib/sync-cache.mjs";

const root = path.resolve(import.meta.dirname, "..");
const catalogPath = path.join(root, "app", "competitor-data.ts");
const outPath = path.join(root, "app", "sorftime-category-trend-data.ts");

function readCatalogProducts() {
  const source = fs.readFileSync(catalogPath, "utf8");
  const asins = [...source.matchAll(/"asin":\s*"([A-Z0-9]{10})"/g)].map(match => match[1]);
  const categories = [...source.matchAll(/"subRankCategory":\s*"([^"]*)"/g)].map(match => match[1]);
  return asins.map((asin, index) => ({
    asin,
    subRankCategory: categories[index] ?? "",
  }));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function mergeByMonth(volume, avgPrice) {
  const priceMap = new Map(avgPrice.map(point => [point.month, point.value]));
  return volume.map(point => ({
    month: point.month,
    value: Math.round(point.value * (priceMap.get(point.month) ?? 0)),
  }));
}

async function resolveNodeFromAsin(key, asin, marketplace) {
  const detail = await callSorftimeTool(key, "product_detail", { asin, amz_site: marketplace });
  const data = detail?.data ?? detail;
  const nodeId = data?.node_id != null ? String(data.node_id) : null;
  if (!nodeId) throw new Error("product_detail 未返回 node_id");
  const subcategory = String(data.subcategory ?? "");
  const categoryName = subcategory.replace(/\s*\(Rank:\s*\d+\)\s*$/i, "").trim() || data.category || "未知类目";
  const topCategory = String(data.top_category ?? "").replace(/\s*\(Rank:\s*\d+\)\s*$/i, "").trim();
  return { nodeId, categoryName, topCategory, sourceAsin: asin };
}

async function resolveNodeFromName(key, categoryName, marketplace) {
  const search = await callSorftimeTool(key, "category_name_search", {
    category_name: categoryName,
    amz_site: marketplace,
  });
  const rows = search?.data ?? [];
  const exact = rows.find(row => String(row.category_name).toLowerCase() === categoryName.toLowerCase());
  const hit = exact ?? rows[0];
  if (!hit?.node_id) throw new Error(`category_name_search 未找到「${categoryName}」`);
  return {
    nodeId: String(hit.node_id),
    categoryName: String(hit.category_name ?? categoryName),
    topCategory: "",
    sourceAsin: "",
  };
}

async function main() {
  const key = readSorftimeKey();
  const marketplace = process.env.SORFTIME_MARKETPLACE ?? "US";
  const asinFilter = process.env.SORFTIME_ASINS?.split(",").map(item => item.trim()).filter(Boolean) ?? null;
  const catalog = selectSorftimeCategoryInputs(readCatalogProducts(), asinFilter);
  const fetchedAt = new Date().toISOString().slice(0, 10);
  const existing = readCachedDataExport(outPath, "sorftimeCategoryTrendData");
  const records = { ...existing };

  if (!key && !Object.values(existing).some(record => record.status === "ready")) {
    console.error("[error] 未找到 Sorftime MCP key，且无可用缓存");
    process.exitCode = 1;
    return;
  }

  if (isForceRefresh()) console.log("[sync] FORCE_REFRESH=1 · 忽略缓存，重新调用 MCP");

  /** @type {Map<string, { nodeId: string; categoryName: string; topCategory: string; sourceAsin: string; asins: string[] }>} */
  const nodePlan = new Map();

  for (const product of catalog) {
    if (!key) break;
    process.stdout.write(`[node] ${product.asin} ... `);
    try {
      const resolved = await resolveNodeFromAsin(key, product.asin, marketplace);
      const current = nodePlan.get(resolved.nodeId) ?? { ...resolved, asins: [] };
      current.asins.push(product.asin);
      if (!current.categoryName && resolved.categoryName) current.categoryName = resolved.categoryName;
      if (!current.topCategory && resolved.topCategory) current.topCategory = resolved.topCategory;
      nodePlan.set(resolved.nodeId, current);
      console.log(`${resolved.categoryName} · node ${resolved.nodeId}`);
    } catch (error) {
      console.log(`asin detail fail · fallback name (${error instanceof Error ? error.message : String(error)})`);
      if (!product.subRankCategory || product.subRankCategory === "等待同步") continue;
      try {
        const resolved = await resolveNodeFromName(key, product.subRankCategory, marketplace);
        const current = nodePlan.get(resolved.nodeId) ?? { ...resolved, asins: [] };
        current.asins.push(product.asin);
        nodePlan.set(resolved.nodeId, current);
        console.log(`  → ${resolved.categoryName} · node ${resolved.nodeId}`);
      } catch (nameError) {
        console.log(`  → skip: ${nameError instanceof Error ? nameError.message : String(nameError)}`);
      }
    }
    await sleep(250);
  }

  if (!nodePlan.size && catalog.length) {
    const names = [...new Set(catalog.map(item => item.subRankCategory).filter(name => name && name !== "等待同步"))];
    for (const categoryName of names) {
      if (!key) break;
      try {
        const resolved = await resolveNodeFromName(key, categoryName, marketplace);
        nodePlan.set(resolved.nodeId, {
          ...resolved,
          asins: catalog.filter(item => item.subRankCategory === categoryName).map(item => item.asin),
        });
      } catch (error) {
        console.log(`[skip] ${categoryName}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  for (const plan of nodePlan.values()) {
    const cached = existing[plan.nodeId];
    const cacheHasMonopoly = Boolean(
      cached?.listingMonopoly?.length && cached?.brandMonopoly?.length && cached?.sellerMonopoly?.length,
    );
    if (shouldUseCachedRecord(cached) && cacheHasMonopoly) {
      logCacheHit(plan.nodeId, cached);
      records[plan.nodeId] = {
        ...cached,
        asins: plan.asins,
        categoryName: plan.categoryName || cached.categoryName,
        topCategory: plan.topCategory || cached.topCategory,
        sourceAsin: plan.sourceAsin || cached.sourceAsin,
      };
      continue;
    }

    if (!key) {
      console.log(`[skip] node ${plan.nodeId} · 无 MCP key，保留已有缓存或跳过`);
      continue;
    }

    process.stdout.write(`[category] ${plan.categoryName} (${plan.nodeId}) ... `);
    try {
      const [volumeRaw, avgPriceRaw, listingRaw, brandRaw, sellerRaw] = await Promise.all([
        callSorftimeTool(key, "category_trend", {
          node_id: plan.nodeId,
          amz_site: marketplace,
          trend_index: "SalesCount",
        }),
        callSorftimeTool(key, "category_trend", {
          node_id: plan.nodeId,
          amz_site: marketplace,
          trend_index: "AvgPrice",
        }),
        callSorftimeTool(key, "category_trend", {
          node_id: plan.nodeId,
          amz_site: marketplace,
          trend_index: "Top3ProductSalesAmountShare",
        }),
        callSorftimeTool(key, "category_trend", {
          node_id: plan.nodeId,
          amz_site: marketplace,
          trend_index: "Top3BrandSalesAmountShare",
        }),
        callSorftimeTool(key, "category_trend", {
          node_id: plan.nodeId,
          amz_site: marketplace,
          trend_index: "Top3SellerSalesAmountShare",
        }),
      ]);
      const volume = parseSorftimeCategoryTrend(volumeRaw);
      const avgPrice = parseSorftimeCategoryTrend(avgPriceRaw);
      const amount = mergeByMonth(volume, avgPrice);
      const listingMonopoly = parseSorftimeCategoryTrend(listingRaw);
      const brandMonopoly = parseSorftimeCategoryTrend(brandRaw);
      const sellerMonopoly = parseSorftimeCategoryTrend(sellerRaw);
      records[plan.nodeId] = {
        nodeId: plan.nodeId,
        categoryName: plan.categoryName,
        topCategory: plan.topCategory,
        sourceAsin: plan.sourceAsin,
        asins: plan.asins,
        marketplace,
        fetchedAt,
        status: volume.length ? "ready" : "empty",
        volume,
        avgPrice,
        amount,
        listingMonopoly,
        brandMonopoly,
        sellerMonopoly,
        note: "销售额 = 小类 Top100 月销量 × 当月均价；垄断系数 = Top3 销售额占比（Sorftime category_trend）",
      };
      console.log(`${volume.length} months · volume+amount+monopoly`);
    } catch (error) {
      if (cached?.status === "ready") {
        console.log(`error · keep cache (${error instanceof Error ? error.message : String(error)})`);
        records[plan.nodeId] = {
          ...cached,
          asins: plan.asins,
          categoryName: plan.categoryName || cached.categoryName,
        };
        continue;
      }
      records[plan.nodeId] = {
        nodeId: plan.nodeId,
        categoryName: plan.categoryName,
        topCategory: plan.topCategory,
        sourceAsin: plan.sourceAsin,
        asins: plan.asins,
        marketplace,
        fetchedAt,
        status: "error",
        statusMessage: error instanceof Error ? error.message : String(error),
        volume: [],
        avgPrice: [],
        amount: [],
        listingMonopoly: [],
        brandMonopoly: [],
        sellerMonopoly: [],
        note: "销售额 = 小类 Top100 月销量 × 当月均价；垄断系数 = Top3 销售额占比（Sorftime category_trend）",
      };
      console.log(`error: ${records[plan.nodeId].statusMessage}`);
    }
    await sleep(300);
  }

  // Drop stale nodes not referenced by current catalog when syncing full catalog
  const keepIds = new Set(nodePlan.keys());
  if (!asinFilter && keepIds.size) {
    for (const nodeId of Object.keys(records)) {
      if (!keepIds.has(nodeId)) delete records[nodeId];
    }
  }

  const body = `// Generated by scripts/build-sorftime-category-trend.mjs — do not edit manually
export type SorftimeCategoryTrendPoint = { month: string; value: number };

export type SorftimeCategoryTrendRecord = {
  nodeId: string;
  categoryName: string;
  topCategory: string;
  sourceAsin: string;
  asins: string[];
  marketplace: string;
  fetchedAt: string;
  status: "ready" | "empty" | "error";
  statusMessage?: string;
  volume: SorftimeCategoryTrendPoint[];
  avgPrice: SorftimeCategoryTrendPoint[];
  amount: SorftimeCategoryTrendPoint[];
  listingMonopoly: SorftimeCategoryTrendPoint[];
  brandMonopoly: SorftimeCategoryTrendPoint[];
  sellerMonopoly: SorftimeCategoryTrendPoint[];
  note?: string;
};

export const sorftimeCategoryTrendMeta = ${JSON.stringify(
    {
      source: "Sorftime MCP · product_detail + category_trend",
      updatedAt: fetchedAt,
      marketplace,
      syncCommand: "npm run category:sync",
      cachePolicy: "默认使用本地缓存；FORCE_REFRESH=1 或 --force 强制刷新",
      amountFormula: "销售额 = SalesCount × AvgPrice（小类 Top100 统计口径）",
      monopolyFormula: "Listing/品牌/卖家垄断系数 = Top3 销售额占比（category_trend）",
    },
    null,
    2,
  )} as const;

export const sorftimeCategoryTrendData: Record<string, SorftimeCategoryTrendRecord> = ${JSON.stringify(records, null, 2)};
`;
  fs.writeFileSync(outPath, body, "utf8");
  const ready = Object.values(records).filter(record => record.status === "ready").length;
  console.log(`[done] ${ready}/${Object.keys(records).length || 0} nodes → app/sorftime-category-trend-data.ts`);
}

main();
