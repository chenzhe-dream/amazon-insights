import { reportIncompleteRepair, createRepairSafeRecordMap, isRepairIncomplete, hasUsableTrendRecord } from "./lib/sync-cache.mjs";
import fs from "node:fs";
import path from "node:path";
import { callSorftimeTool, readSorftimeKey } from "./lib/sorftime-mcp-client.mjs";
import { parseSorftimeTrend } from "./lib/sorftime-trend-parse.mjs";
import {
  isForceRefresh,
  logCacheHit,
  readCachedDataExport,
  shouldUseCachedRecord,
} from "./lib/sync-cache.mjs";

const root = path.resolve(import.meta.dirname, "..");
const catalogPath = path.join(root, "app", "competitor-data.ts");
const outPath = path.join(root, "app", "sorftime-sales-trend-data.ts");

function readCatalogAsins() {
  const source = fs.readFileSync(catalogPath, "utf8");
  return [...source.matchAll(/"asin":\s*"([A-Z0-9]{10})"/g)].map(match => match[1]);
}

function hasFullTrend(record) { return hasUsableTrendRecord(record); }

async function main() {
  const key = readSorftimeKey();
  const marketplace = process.env.SORFTIME_MARKETPLACE ?? "US";
  const asins = process.env.SORFTIME_ASINS?.split(",").map(item => item.trim()).filter(Boolean) ?? readCatalogAsins();
  const fetchedAt = new Date().toISOString().slice(0, 10);
  const existing = readCachedDataExport(outPath, "sorftimeSalesTrendData");
  const records = createRepairSafeRecordMap(existing);

  if (!key && !Object.values(existing).some(record => record.status === "ready")) {
    console.error("[error] 未找到 Sorftime MCP key，且无可用缓存");
    process.exitCode = 1;
    return;
  }

  if (isForceRefresh()) console.log("[sync] FORCE_REFRESH=1 · 忽略缓存，重新调用 MCP");

  for (const asin of asins) {
    if (shouldUseCachedRecord(existing[asin]) && hasFullTrend(existing[asin])) {
      logCacheHit(asin, existing[asin]);
      continue;
    }

    if (!key) {
      console.log(`[skip] ${asin} · 无 MCP key，保留已有缓存或跳过`);
      continue;
    }

    if (isRepairIncomplete()) {
      const next = {...existing[asin], asin, marketplace, fetchedAt: existing[asin]?.fetchedAt ?? fetchedAt};
      let failed = false;
      for (const [field, trendType] of Object.entries({volume:"SalesVolume",amount:"SalesAmount",price:"Price",rank:"Rank"})) {
        if (hasUsableTrendRecord({status:"ready", [field]: next[field]})) continue;
        try {
          const raw = await callSorftimeTool(key, "product_trend", {asin, amz_site:marketplace, product_trend_type:trendType});
          const points = parseSorftimeTrend(raw);
          if (!hasUsableTrendRecord({status:"ready", [field]:points})) throw new Error(`${field}: empty provider response`);
          next[field] = points;
        } catch (error) {
          failed = true;
          next[field] ??= [];
          console.error(`[repair-incomplete] ${asin} ${field}: ${error instanceof Error ? error.message : String(error)}`);
          reportIncompleteRepair(asin);
        }
      }
      records[asin] = {...next, status:failed ? "error" : "ready", ...(failed ? {statusMessage:"Trend repair incomplete; retained available cached portions"} : {})};
      continue;
    }

    process.stdout.write(`[sorftime] ${asin} trend ... `);
    try {
      // The formal Sorftime policy permits one request at a time. Avoid spending
      // the other metrics' admission deadlines while the first request runs.
      const [volumeRaw, amountRaw, priceRaw, rankRaw] = [
        await callSorftimeTool(key, "product_trend", { asin, amz_site: marketplace, product_trend_type: "SalesVolume" }),
        await callSorftimeTool(key, "product_trend", { asin, amz_site: marketplace, product_trend_type: "SalesAmount" }),
        await callSorftimeTool(key, "product_trend", { asin, amz_site: marketplace, product_trend_type: "Price" }),
        await callSorftimeTool(key, "product_trend", { asin, amz_site: marketplace, product_trend_type: "Rank" }),
      ];
      const volume = parseSorftimeTrend(volumeRaw);
      const amount = parseSorftimeTrend(amountRaw);
      const price = parseSorftimeTrend(priceRaw);
      const rank = parseSorftimeTrend(rankRaw);
      records[asin] = {
        asin,
        marketplace,
        fetchedAt,
        status: volume.length || amount.length || price.length || rank.length ? "ready" : "empty",
        volume,
        amount,
        price,
        rank,
      };
      console.log(
        `${volume.length}m vol · ${amount.length}m amt · ${price.length}m price · ${rank.length}m rank`,
      );
    } catch (error) {
      if (hasFullTrend(existing[asin])) {
        console.log(`error · keep cache (${error instanceof Error ? error.message : String(error)})`);
        continue;
      }
      records[asin] = {
        asin,
        marketplace,
        fetchedAt,
        status: "error",
        statusMessage: error instanceof Error ? error.message : String(error),
        volume: [],
        amount: [],
        price: [],
        rank: [],
      };
      console.log(`error: ${records[asin].statusMessage}`);
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  const body = `// Generated by scripts/build-sorftime-sales-trend.mjs — do not edit manually
export type SorftimeTrendPoint = { month: string; value: number };

export type SorftimeSalesTrendRecord = {
  asin: string;
  marketplace: string;
  fetchedAt: string;
  status: "ready" | "empty" | "error";
  statusMessage?: string;
  volume: SorftimeTrendPoint[];
  amount: SorftimeTrendPoint[];
  price: SorftimeTrendPoint[];
  rank: SorftimeTrendPoint[];
};

export const sorftimeSalesTrendMeta = ${JSON.stringify(
    {
      source: "Sorftime MCP · product_trend（SalesVolume / SalesAmount / Price / Rank）",
      updatedAt: fetchedAt,
      marketplace,
      syncCommand: "npm run sales:sync",
      cachePolicy: "默认使用本地缓存；FORCE_REFRESH=1 或 --force 强制刷新",
    },
    null,
    2,
  )} as const;

export const sorftimeSalesTrendData: Record<string, SorftimeSalesTrendRecord> = ${JSON.stringify(records, null, 2)};
`;
  fs.writeFileSync(outPath, body, "utf8");
  const ready = Object.values(records).filter(record => record.status === "ready").length;
  console.log(`[done] ${ready}/${asins.length} ASIN → app/sorftime-sales-trend-data.ts`);
}

main();
