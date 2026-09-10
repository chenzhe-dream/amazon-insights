import { createRepairSafeRecordMap, isRepairIncomplete } from "./lib/sync-cache.mjs";
import fs from "node:fs";
import path from "node:path";
import { callSorftimeTool, readSorftimeKey } from "./lib/sorftime-mcp-client.mjs";
import { parseSorftimeTrend } from "./lib/sorftime-trend-parse.mjs";
import { isForceRefresh, logCacheHit, readCachedDataExport } from "./lib/sync-cache.mjs";
import { readScopedSorftimeEvidenceByOperation } from "./lib/scoped-sorftime-evidence.mjs";
import { buildScopedSorftimeModuleResult } from "./lib/scoped-sorftime-fallbacks.mjs";
import { positiveMoneyOrNull } from "./lib/commerce-data-validity.mjs";

const root = path.resolve(import.meta.dirname, "..");
const catalogPath = path.join(root, "app", "competitor-data.ts");
const outPath = path.join(root, "app", "sorftime-price-strategy-data.ts");

function readCatalogAsins() {
  const source = fs.readFileSync(catalogPath, "utf8");
  return [...source.matchAll(/"asin":\s*"([A-Z0-9]{10})"/g)].map(match => match[1]);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function money(value) {
  return `$${Number(value).toFixed(2)}`;
}

function modePrice(values) {
  const counts = new Map();
  for (const value of values) {
    const key = Number(value).toFixed(2);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || Number(b[0]) - Number(a[0]))[0]?.[0] ?? null;
}

export function buildStrategy({ price, coupon, prices }) {
  if (price != null && positiveMoneyOrNull(price) == null) return null;
  if (!prices.length && price == null) return null;

  const series = prices.map(point => positiveMoneyOrNull(point.value)).filter(value => value != null);
  const latest = series.at(-1) ?? positiveMoneyOrNull(price);
  const min = series.length ? Math.min(...series) : price;
  const max = series.length ? Math.max(...series) : price;
  const common = modePrice(series) ?? (latest != null ? Number(latest).toFixed(2) : null);
  const current = positiveMoneyOrNull(price) ?? latest;
  if (current == null) return null;
  const couponValue = Number(coupon);
  const hasCoupon = Number.isFinite(couponValue) && couponValue > 0;
  const couponLooksPercent = hasCoupon && couponValue > 0 && couponValue <= 80 && Number.isInteger(couponValue);
  const volatility = series.length >= 2 ? max - min : 0;
  const endsWith99 = current != null && /^\d+\.99$/.test(Number(current).toFixed(2));

  const anchorParts = [];
  if (common != null && current != null) {
    const commonNum = Number(common);
    if (Math.abs(commonNum - current) < 0.05) {
      anchorParts.push(`常用成交价集中在 ${money(current)}`);
    } else {
      anchorParts.push(`当前售价 ${money(current)}，历史高频价约 ${money(commonNum)}`);
    }
  } else if (current != null) {
    anchorParts.push(`当前售价 ${money(current)}`);
  }
  if (min != null && max != null && series.length) {
    anchorParts.push(`近 ${series.length} 个月价格区间 ${money(min)}–${money(max)}`);
  }
  if (volatility >= 8) anchorParts.push("采用多档动态改价");
  else if (volatility > 0 && volatility < 3) anchorParts.push("价格相对稳定");

  let promotion;
  if (hasCoupon) {
    promotion = couponLooksPercent
      ? `Sorftime 返回当前 Coupon 约 ${couponValue}% 比例折扣，叠加在售价之上形成即时优惠。`
      : `Sorftime 返回当前 Coupon 约 ${money(couponValue)} 固定金额券，用于拉低感知到手价。`;
  } else if (volatility >= 5) {
    promotion = "Sorftime 暂未返回有效 Coupon；近月价格波动明显，促销更偏向直接改价而非领券。";
  } else {
    promotion = "Sorftime 暂未返回有效 Coupon；近月价格变动有限，促销动作偏弱或未公开券信息。";
  }

  let psychology;
  if (hasCoupon && endsWith99) {
    psychology = `用 ${money(current)} 尾数价降低整数价格感知，再叠加 Coupon 制造“现在更划算”的即时优惠感。`;
  } else if (hasCoupon) {
    psychology = "以公开售价建立锚点，再通过 Coupon 制造可领取的额外优惠，降低下单犹豫。";
  } else if (max != null && current != null && max - current >= 8) {
    psychology = `相对历史高位 ${money(max)}，当前价已下探约 ${money(max - current)}，用可见降幅强化入手时机。`;
  } else if (endsWith99) {
    psychology = `维持 ${money(current)} 尾数定价，强调价格记忆点与稳定成交带。`;
  } else {
    psychology = "以直接标价为主，减少领券步骤，突出到手价确定性。";
  }

  return {
    anchor: `${anchorParts.join("，")}。`,
    promotion,
    psychology,
    evidence: "Sorftime MCP · product_detail（price/coupon）+ product_trend（Price）",
    currentPrice: current ?? null,
    coupon: hasCoupon ? couponValue : 0,
    priceMin: min ?? null,
    priceMax: max ?? null,
    months: series.length,
  };
}

function buildPriceStrategyUiRecords(records, marketplace, fetchedAt) {
  const uiRecords = {};
  for (const [asin, record] of Object.entries(records)) {
    if (!record?.anchor || record.status !== "ready" || positiveMoneyOrNull(record.currentPrice) == null) continue;
    uiRecords[asin] = {
      asin: record.asin ?? asin,
      marketplace: record.marketplace ?? marketplace,
      fetchedAt: record.fetchedAt ?? fetchedAt,
      source: record.source ?? "Sorftime",
      status: record.status,
      currentPrice: record.currentPrice,
      anchor: record.anchor,
      promotion: record.promotion,
      psychology: record.psychology,
      evidence: record.evidence,
      ...(record.provenance ? { provenance: record.provenance } : {}),
    };
  }
  return uiRecords;
}

export function buildPriceStrategyUiExport({ records, marketplace, fetchedAt }) {
  const uiRecords = buildPriceStrategyUiRecords(records, marketplace, fetchedAt);
  return `// Generated by scripts/build-sorftime-price-strategy.mjs — do not edit manually
export type PriceStrategy = {
  asin: string;
  marketplace: string;
  fetchedAt: string;
  source: "Sorftime";
  status: "ready";
  currentPrice: number;
  anchor: string;
  promotion: string;
  psychology: string;
  evidence: string;
  provenance?: Record<string, string>;
};

export const sorftimePriceStrategyMeta = ${JSON.stringify(
    {
      source: "Sorftime MCP · product_detail + product_trend(Price)",
      updatedAt: fetchedAt,
      marketplace,
      syncCommand: "npm run price-strategy:sync",
      emptyMessage: "Sorftime 暂未返回可核验的价格策略数据",
    },
    null,
    2,
  )} as const;

export const sorftimePriceStrategies: Record<string, PriceStrategy> = ${JSON.stringify(uiRecords, null, 2)};
`;
}

async function main() {
  const jobId = process.env.AGENT_SYNC_JOB_ID?.trim();
  const scopedEvidenceOnly = Boolean(jobId) && process.env.SORFTIME_SCOPED_EVIDENCE_ONLY === "1";
  const key = scopedEvidenceOnly ? null : readSorftimeKey();
  const marketplace = process.env.SORFTIME_MARKETPLACE ?? "US";
  const asins =
    process.env.SORFTIME_ASINS?.split(",").map(item => item.trim()).filter(Boolean) ?? readCatalogAsins();
  const fetchedAt = new Date().toISOString().slice(0, 10);
  const existing = readCachedDataExport(outPath, "sorftimePriceStrategies");
  const records = createRepairSafeRecordMap(existing);

  if (!key && !jobId && !Object.values(existing).some(Boolean)) {
    console.error("[error] 未找到 Sorftime MCP key，且无可用缓存");
    process.exitCode = 1;
    return;
  }

  if (isForceRefresh()) console.log("[sync] FORCE_REFRESH=1 · 忽略缓存，重新调用 MCP");

  let missingFallback = false;
  for (const asin of asins) {
    const evidenceByOperation = jobId
      ? readScopedSorftimeEvidenceByOperation({ jobId, marketplace, asin })
      : {};
    const fallback = () => buildScopedSorftimeModuleResult({
      module: "price_strategy",
      evidenceByOperation,
      expectedScope: { jobId, marketplace, asin },
    });
    if ((!jobId || isRepairIncomplete()) && !isForceRefresh() && existing[asin]?.status === "ready" && Number(existing[asin]?.currentPrice) > 0) {
      logCacheHit(asin, { status: "ready", fetchedAt: existing[asin].fetchedAt });
      records[asin] = existing[asin];
      continue;
    }
    if (!key) {
      const result = fallback();
      if (result) records[asin] = result;
      else {
        delete records[asin];
        missingFallback = true;
      }
      console.log(`[price-strategy] ${asin} · ${result ? "same-job Sorftime evidence" : "无可用同任务证据"}`);
      continue;
    }

    process.stdout.write(`[price-strategy] ${asin} ... `);
    try {
      const [detailRaw, priceRaw] = await Promise.all([
        callSorftimeTool(key, "product_detail", { asin, amz_site: marketplace }),
        callSorftimeTool(key, "product_trend", {
          asin,
          amz_site: marketplace,
          product_trend_type: "Price",
        }),
      ]);
      const detail = detailRaw?.data ?? detailRaw;
      const prices = parseSorftimeTrend(priceRaw);
      const strategy = buildStrategy({
        price: detail?.price ?? null,
        coupon: detail?.coupon ?? 0,
        prices,
      });
      if (!strategy) {
        const result = fallback();
        if (result) records[asin] = result;
        else delete records[asin];
        console.log("empty");
      } else {
        records[asin] = { ...strategy, asin, marketplace, fetchedAt, status: "ready", source: "Sorftime" };
        console.log(`${prices.length} months · price ${strategy.currentPrice}`);
      }
    } catch (error) {
      const result = fallback();
      if (result) {
        records[asin] = result;
        console.log("connection error · same-job Sorftime evidence");
      } else if (!jobId && existing[asin]?.status === "ready" && Number(existing[asin]?.currentPrice) > 0) {
        console.log(`error · keep cache (${error instanceof Error ? error.message : String(error)})`);
        records[asin] = existing[asin];
      } else {
        delete records[asin];
        missingFallback = true;
        console.log(`error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await sleep(300);
  }

  const uiRecords = buildPriceStrategyUiRecords(records, marketplace, fetchedAt);
  const body = buildPriceStrategyUiExport({ records, marketplace, fetchedAt });
  fs.writeFileSync(outPath, body, "utf8");
  console.log(`[done] ${Object.keys(uiRecords).length}/${asins.length} ASINs → app/sorftime-price-strategy-data.ts`);
  if (missingFallback) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) main();
