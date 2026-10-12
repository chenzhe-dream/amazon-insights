import { isRepairIncomplete, hasUsableTrendRecord } from "./lib/sync-cache.mjs";
import fs from "node:fs";
import path from "node:path";
import { generatedAppDataPath } from "./lib/generated-app-data-path.mjs";
import { callSorftimeTool, readSorftimeKey } from "./lib/sorftime-mcp-client.mjs";
import { parseSorftimeProductTrend } from "./lib/sorftime-trend-parse.mjs";
import {ProviderDiagnosticError, formatProviderDiagnosticLine} from './lib/provider-diagnostics.mjs';
import {
  isForceRefresh,
  logCacheHit,
  readCachedDataExport,
  shouldUseCachedRecord,
} from "./lib/sync-cache.mjs";

const root = path.resolve(import.meta.dirname, "..");
const catalogPath = generatedAppDataPath(root, "competitor-data.ts");
const outPath = generatedAppDataPath(root, "sorftime-sales-trend-data.ts");

function readCatalogAsins() {
  const source = fs.readFileSync(catalogPath, "utf8");
  return [...source.matchAll(/"asin":\s*"([A-Z0-9]{10})"/g)].map(match => match[1]);
}

function hasFullTrend(record) { return hasUsableTrendRecord(record); }

const trendTypes = {volume:'SalesVolume', amount:'SalesAmount', price:'Price', rank:'Rank'};
export async function collectSalesTrendResponses({key, asin, marketplace, callTool = callSorftimeTool, fields = Object.keys(trendTypes)}) {
  const responses = {}, requestErrors = {};
  for (const [field, type] of Object.entries(trendTypes)) {
    if (!fields.includes(field)) continue;
    try { responses[field] = await callTool(key, 'product_trend', {asin, amz_site:marketplace, type}); }
    catch { requestErrors[field] = 'Provider request failed'; }
  }
  return {responses, requestErrors};
}
export function buildSalesTrendRecord({asin, marketplace, fetchedAt, responses, requestErrors = {}, previous = {}}) {
  const next = {...previous, asin, marketplace, fetchedAt,
    dailyObservations:{...previous.dailyObservations}, observationPeriods:{...previous.observationPeriods}, observationErrors:{...requestErrors},
    fieldFetchedAt:{...previous.fieldFetchedAt}};
  for (const [field, type] of Object.entries(trendTypes)) {
    next[field] ??= [];
    if (next[field].length || next.dailyObservations[field]?.length) next.fieldFetchedAt[field] ??= previous.fetchedAt;
    if (!Object.hasOwn(responses, field)) continue;
    try {
      const result = parseSorftimeProductTrend(responses[field], {asin, type});
      // A verified empty response cannot erase previously collected observations.
      if (!result.monthly.length && !result.daily.length &&
          (next[field].length || next.dailyObservations[field]?.length)) continue;
      next[field] = result.monthly;
      next.dailyObservations[field] = result.daily;
      next.observationPeriods[field] = result.period;
      next.fieldFetchedAt[field] = fetchedAt;
    } catch (error) {
      next.observationErrors[field] = error.message;
    }
  }
  const hasDaily = Object.values(next.dailyObservations).some(points => points.length);
  const hasMonths = Object.keys(trendTypes).some(field => next[field].length);
  const invalid = Object.keys(next.observationErrors).length > 0;
  next.status = invalid ? 'error' : hasMonths ? 'ready' : 'empty';
  delete next.statusMessage;
  if (invalid) next.statusMessage = '部分趋势响应格式不符，已保留可验证数据';
  else if (hasDaily) next.statusMessage = '来源包含日观测序列，月度销量口径待确认；未将日观测累加为月销量';
  return next;
}

export async function runSalesTrendSync(options = {}) {
  const key = options.key ?? readSorftimeKey();
  const marketplace = options.marketplace ?? process.env.SORFTIME_MARKETPLACE ?? "US";
  const asins = options.asins ?? process.env.SORFTIME_ASINS?.split(",").map(item => item.trim()).filter(Boolean) ?? readCatalogAsins();
  const fetchedAt = options.fetchedAt ?? new Date().toISOString().slice(0, 10);
  const targetPath = options.outPath ?? outPath;
  const existing = options.existing ?? readCachedDataExport(targetPath, "sorftimeSalesTrendData");
  const repair = options.repair ?? isRepairIncomplete();
  const callTool = options.callTool ?? callSorftimeTool;
  // The per-field reducer retains prior data. A whole-record repair proxy would
  // discard usable daily/partial results whenever monthly readiness is absent.
  const records = { ...existing };

  if (!key && !Object.values(existing).some(record => record.status === "ready")) {
    console.error("[error] 未找到 Sorftime MCP key，且无可用缓存");
    process.exitCode = 1;
    return;
  }

  if (isForceRefresh()) console.log("[sync] FORCE_REFRESH=1 · 忽略缓存，重新调用 MCP");

  for (const asin of asins) {
    if (!repair && shouldUseCachedRecord(existing[asin]) && hasFullTrend(existing[asin])) {
      logCacheHit(asin, existing[asin]);
      continue;
    }

    if (!key) {
      console.log(`[skip] ${asin} · 无 MCP key，保留已有缓存或跳过`);
      continue;
    }

    process.stdout.write(`[sorftime] ${asin} trend ... `);
    try {
      // The formal Sorftime policy permits one request at a time. Avoid spending
      // the other metrics' admission deadlines while the first request runs.
      const previous = existing[asin]?.asin === asin && existing[asin]?.marketplace === marketplace ? existing[asin] : {};
      const fields = Object.keys(trendTypes).filter(field => !repair || !(
        hasUsableTrendRecord({status:'ready', [field]:previous[field]}) ||
        previous.observationPeriods?.[field] === 'day' && Array.isArray(previous.dailyObservations?.[field]) &&
        previous.dailyObservations[field].length > 0 && previous.dailyObservations[field].every(point =>
          /^\d{4}-\d{2}-\d{2}$/.test(point?.date) && Number.isFinite(point.value) && point.value >= 0)));
      const collected = await collectSalesTrendResponses({key, asin, marketplace, callTool, fields});
      records[asin] = buildSalesTrendRecord({asin, marketplace, fetchedAt,
        ...collected, previous});
      for (const field of Object.keys(records[asin].observationErrors)) {
        if (collected.requestErrors[field]) continue; // Transport emits its original cause at the request boundary.
        const error = new ProviderDiagnosticError({connector:'sorftime',stage:'sales_trend',asin,
          operation:'product_trend',failureKind:'schema',causeCode:'MCP_SCHEMA',boundary:'consumer-shape'});
        process.stderr.write(`${formatProviderDiagnosticLine(error.diagnostic)}\n`);
        process.exitCode = 1;
      }
      if (Object.keys(records[asin].observationErrors).length) process.exitCode = 1;
      const {amount, price, rank} = records[asin];
      console.log(
        `${records[asin].volume.length}m vol · ${amount.length}m amt · ${price.length}m price · ${rank.length}m rank`,
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
    await new Promise(resolve => setTimeout(resolve, options.delayMs ?? 300));
  }

  const body = `// Generated by scripts/build-sorftime-sales-trend.mjs — do not edit manually
export type SorftimeTrendPoint = { month: string; value: number };

export type SorftimeSalesTrendRecord = {
  asin: string;
  marketplace: string;
  fetchedAt: string;
  status: "ready" | "empty" | "error";
  statusMessage?: string;
  dailyObservations?: Partial<Record<"volume" | "amount" | "price" | "rank", {date:string;value:number}[]>>;
  observationPeriods?: Partial<Record<"volume" | "amount" | "price" | "rank", "month" | "day" | null>>;
  observationErrors?: Partial<Record<"volume" | "amount" | "price" | "rank", string>>;
  fieldFetchedAt?: Partial<Record<"volume" | "amount" | "price" | "rank", string>>;
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
  fs.writeFileSync(targetPath, body, "utf8");
  const ready = Object.values(records).filter(record => record.status === "ready").length;
  console.log(`[done] ${ready}/${asins.length} ASIN → app/sorftime-sales-trend-data.ts`);
  return records;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) runSalesTrendSync();
