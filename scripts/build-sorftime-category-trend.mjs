import { createRepairSafeRecordMap, isRepairIncomplete } from "./lib/sync-cache.mjs";
import fs from "node:fs";
import path from "node:path";
import { generatedAppDataPath } from "./lib/generated-app-data-path.mjs";
import { pathToFileURL } from "node:url";
import { callSorftimeTool, readSorftimeKey } from "./lib/sorftime-mcp-client.mjs";
import {
  formatProviderDiagnosticLine,
  ProviderDiagnosticError,
} from "./lib/provider-diagnostics.mjs";
import { parseSorftimeCategoryTrend } from "./lib/sorftime-trend-parse.mjs";
import { selectSorftimeCategoryInputs } from "./lib/sorftime-category-input.mjs";
import { readScopedSorftimeEvidenceByOperation } from "./lib/scoped-sorftime-evidence.mjs";
import { buildScopedSorftimeModuleResult } from "./lib/scoped-sorftime-fallbacks.mjs";
import {
  isForceRefresh,
  logCacheHit,
  readCachedDataExport,
  shouldUseCachedRecord,
} from "./lib/sync-cache.mjs";

const root = path.resolve(import.meta.dirname, "..");
const catalogPath = generatedAppDataPath(root, "competitor-data.ts");
const outPath = generatedAppDataPath(root, "sorftime-category-trend-data.ts");

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

async function resolveNodeFromAsin(callTool, key, asin, marketplace) {
  const detail = await callTool(key, "product_detail", { asin, amz_site: marketplace });
  const data = detail?.data ?? detail;
  // A matching product with the observed empty node field has no category
  // trend to request. Missing/malformed envelopes still fail schema checks.
  if (data?.asin === asin && data.node_id === "") return null;
  const nodeId = data?.node_id != null ? String(data.node_id) : null;
  if (!nodeId) {
    throw Object.assign(new Error("category node unavailable"), {
      kind: "schema",
      providerDiagnostic: { operation: "product_detail", boundary: "consumer-shape" },
    });
  }
  const subcategory = String(data.subcategory ?? "");
  const categoryName = subcategory.replace(/\s*\(Rank:\s*\d+\)\s*$/i, "").trim() || data.category || "未知类目";
  const topCategory = String(data.top_category ?? "").replace(/\s*\(Rank:\s*\d+\)\s*$/i, "").trim();
  return { nodeId, categoryName, topCategory, sourceAsin: asin };
}

export async function runSorftimeCategoryCli(options = {}) {
  const env = options.env ?? process.env;
  const jobId = Object.hasOwn(options, "jobId") ? options.jobId : env.AGENT_SYNC_JOB_ID?.trim();
  const scopedEvidenceOnly = Boolean(jobId) && env.SORFTIME_SCOPED_EVIDENCE_ONLY === "1";
  const key = Object.hasOwn(options, "key")
    ? options.key
    : (scopedEvidenceOnly ? null : readSorftimeKey(env));
  const marketplace = options.marketplace ?? env.SORFTIME_MARKETPLACE ?? "US";
  const asinFilter = Object.hasOwn(options, "asinFilter")
    ? options.asinFilter
    : (env.SORFTIME_ASINS?.split(",").map(item => item.trim()).filter(Boolean) ?? null);
  const catalog = options.catalog ?? selectSorftimeCategoryInputs(readCatalogProducts(), asinFilter);
  const fetchedAt = options.fetchedAt ?? new Date().toISOString().slice(0, 10);
  const outputPath = options.outPath ?? outPath;
  const existing = options.existing ?? readCachedDataExport(outputPath, "sorftimeCategoryTrendData");
  const providerCall = options.providerCall ?? callSorftimeTool;
  const wait = options.wait ?? sleep;
  const writeFileSync = options.writeFileSync ?? fs.writeFileSync;
  const stderrWrite = options.stderrWrite ?? (line => process.stderr.write(line));

  if (!key && !jobId && !Object.values(existing).some(record => record.status === "ready")) {
    console.error("[error] 未找到 Sorftime MCP key，且无可用缓存");
    process.exitCode = 1;
    return;
  }

  if (isForceRefresh()) console.log("[sync] FORCE_REFRESH=1 · 忽略缓存，重新调用 MCP");

  const { records, nodePlan, diagnostics } = await collectSorftimeCategoryRecords({
    key,
    marketplace,
    catalog,
    existing,
    fetchedAt,
    jobId,
    callTool: options.callTool,
    providerCall,
    wait,
  });

  // Drop stale nodes not referenced by current catalog when syncing full catalog
  const plannedAsins = new Set([...nodePlan.values()].flatMap(plan => plan.asins));
  const currentFailureKeys = catalog
    .filter(product => !plannedAsins.has(product.asin))
    .map(product => `asin-error:${product.asin}`)
    .filter(key => ["error", "empty"].includes(records[key]?.status));
  const keepIds = new Set([...nodePlan.keys(), ...currentFailureKeys]);
  if (!isRepairIncomplete() && !asinFilter && keepIds.size) {
    for (const nodeId of Object.keys(records)) {
      if (!keepIds.has(nodeId)) delete records[nodeId];
    }
  }

  const body = `// Generated by scripts/build-sorftime-category-trend.mjs — do not edit manually
export type SorftimeCategoryTrendPoint = { month: string; value: number };

export type SorftimeCategoryTrendRecord = {
  asin?: string;
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
  source?: "Sorftime";
  provenance?: Record<string, string>;
  provenanceByAsin?: Record<string, Record<string, string>>;
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
  writeFileSync(outputPath, body, "utf8");
  for (const diagnostic of diagnostics) {
    stderrWrite(`${formatProviderDiagnosticLine(diagnostic)}\n`);
  }
  if (diagnostics.length) process.exitCode = 1;
  const ready = Object.values(records).filter(record => record.status === "ready").length;
  console.log(`[done] ${ready}/${Object.keys(records).length || 0} nodes → app/sorftime-category-trend-data.ts`);
  return { records, nodePlan, diagnostics };
}

export async function collectSorftimeCategoryRecords({
  key,
  marketplace,
  catalog,
  existing,
  fetchedAt,
  jobId,
  callTool = /** @type {typeof callSorftimeTool | undefined} */ (undefined),
  providerCall = callSorftimeTool,
  wait = sleep,
}) {
  const invokeTool = callTool ?? ((providerKey, tool, args) =>
    providerCall(providerKey, tool, args, {
      emitDiagnostics: false,
      allowCategorySiblingDispatch: true,
    }));
  const records = createRepairSafeRecordMap(jobId && !isRepairIncomplete() ? {} : existing);
  /** @type {Map<string, { nodeId: string; categoryName: string; topCategory: string; sourceAsin: string; asins: string[] }>} */
  const nodePlan = new Map();
  const fallbackRecords = new Map();
  const diagnostics = [];

  const fallbackForAsin = asin => {
    if (!jobId) return null;
    return buildScopedSorftimeModuleResult({
      module: "category",
      evidenceByOperation: readScopedSorftimeEvidenceByOperation({ jobId, marketplace, asin }),
      expectedScope: { jobId, marketplace, asin },
    });
  };
  const combineFallbacks = (asins, nodeId) => {
    const matches = asins
      .map(asin => fallbackForAsin(asin))
      .filter(fallback => fallback?.nodeId === nodeId);
    if (!matches.length) return null;
    return {
      ...matches[0],
      sourceAsin: matches[0].asin,
      asins: matches.map(fallback => fallback.asin),
      provenanceByAsin: Object.fromEntries(matches.map(fallback => [
        fallback.asin,
        fallback.provenance,
      ])),
    };
  };

  for (const product of catalog) {
    if (isRepairIncomplete()) {
      const cachedEntry = Object.entries(existing).find(([, record]) => record?.status === "ready" && record.asins?.includes(product.asin) && record.volume?.some(point => Number.isFinite(point?.value) && point.value >= 0));
      if (cachedEntry) {
        logCacheHit(product.asin, cachedEntry[1]);
        continue;
      }
    }
    process.stdout.write(`[node] ${product.asin} ... `);
    try {
      if (!key) throw new Error("Sorftime key unavailable");
      const resolved = await resolveNodeFromAsin(invokeTool, key, product.asin, marketplace);
      if (resolved === null) {
        records[`asin-error:${product.asin}`] = {
          ...categoryFailureRecord({ asin: product.asin, marketplace, fetchedAt, reason: "UPSTREAM_EMPTY" }),
          status: "empty",
        };
        console.log("empty · UPSTREAM_EMPTY");
        continue;
      }
      const current = nodePlan.get(resolved.nodeId) ?? { ...resolved, asins: [] };
      current.asins.push(product.asin);
      if (!current.categoryName && resolved.categoryName) current.categoryName = resolved.categoryName;
      if (!current.topCategory && resolved.topCategory) current.topCategory = resolved.topCategory;
      nodePlan.set(resolved.nodeId, current);
      console.log(`${resolved.categoryName} · node ${resolved.nodeId}`);
    } catch (error) {
      const fallback = fallbackForAsin(product.asin);
      if (!fallback) {
        const diagnostic = diagnosticForAsin(error, product.asin, "product_detail");
        diagnostics.push(diagnostic);
        records[`asin-error:${product.asin}`] = categoryFailureRecord({
          asin: product.asin,
          marketplace,
          fetchedAt,
          reason: diagnostic.causeCode,
        });
        console.log(`error · ${diagnostic.causeCode}`);
        continue;
      }
      const current = nodePlan.get(fallback.nodeId) ?? {
        nodeId: fallback.nodeId,
        categoryName: fallback.categoryName,
        topCategory: fallback.topCategory,
        sourceAsin: product.asin,
        asins: [],
      };
      current.asins.push(product.asin);
      nodePlan.set(fallback.nodeId, current);
      fallbackRecords.set(fallback.nodeId, combineFallbacks(current.asins, fallback.nodeId));
      console.log(`${fallback.categoryName} · same-job evidence`);
    }
    await wait(250);
  }

  for (const plan of nodePlan.values()) {
    const cached = existing[plan.nodeId];
    const cacheHasMonopoly = Boolean(
      cached?.listingMonopoly?.length && cached?.brandMonopoly?.length && cached?.sellerMonopoly?.length,
    );
    if ((!jobId || isRepairIncomplete()) && shouldUseCachedRecord(cached) && cacheHasMonopoly) {
      logCacheHit(plan.nodeId, cached);
      records[plan.nodeId] = {
        ...cached,
        asins: [...new Set([...(isRepairIncomplete() ? cached?.asins ?? [] : []), ...plan.asins])],
        categoryName: plan.categoryName || cached.categoryName,
        topCategory: plan.topCategory || cached.topCategory,
        sourceAsin: plan.sourceAsin || cached.sourceAsin,
      };
      continue;
    }

    if (!key) {
      const fallback = fallbackRecords.get(plan.nodeId) ?? combineFallbacks(plan.asins, plan.nodeId);
      if (fallback) records[plan.nodeId] = fallback;
      else delete records[plan.nodeId];
      console.log(`[category] node ${plan.nodeId} · ${fallback ? "same-job Sorftime evidence" : "无可用同任务证据"}`);
      continue;
    }

    process.stdout.write(`[category] ${plan.categoryName} (${plan.nodeId}) ... `);
    try {
      const volumeRaw = await invokeTool(key, "category_trend", {
        node_id: plan.nodeId, amz_site: marketplace, trend_index: "SalesCount",
      });
      const avgPriceRaw = await invokeTool(key, "category_trend", {
        node_id: plan.nodeId, amz_site: marketplace, trend_index: "AvgPrice",
      });
      const listingRaw = await invokeTool(key, "category_trend", {
        node_id: plan.nodeId, amz_site: marketplace, trend_index: "Top3ProductSalesAmountShare",
      });
      const brandRaw = await invokeTool(key, "category_trend", {
        node_id: plan.nodeId, amz_site: marketplace, trend_index: "Top3BrandSalesAmountShare",
      });
      const sellerRaw = await invokeTool(key, "category_trend", {
        node_id: plan.nodeId, amz_site: marketplace, trend_index: "Top3SellerSalesAmountShare",
      });
      const volume = parseSorftimeCategoryTrend(volumeRaw);
      const avgPrice = parseSorftimeCategoryTrend(avgPriceRaw);
      const amount = mergeByMonth(volume, avgPrice);
      const listingMonopoly = parseSorftimeCategoryTrend(listingRaw);
      const brandMonopoly = parseSorftimeCategoryTrend(brandRaw);
      const sellerMonopoly = parseSorftimeCategoryTrend(sellerRaw);
      const normalRecord = {
        nodeId: plan.nodeId,
        categoryName: plan.categoryName,
        topCategory: plan.topCategory,
        sourceAsin: plan.sourceAsin,
        asins: [...new Set([...(isRepairIncomplete() ? cached?.asins ?? [] : []), ...plan.asins])],
        marketplace,
        fetchedAt,
        status: volume.length ? "ready" : "empty",
        ...(volume.length ? {} : { statusMessage: "UPSTREAM_EMPTY" }),
        volume,
        avgPrice,
        amount,
        listingMonopoly,
        brandMonopoly,
        sellerMonopoly,
        note: "销售额 = 小类 Top100 月销量 × 当月均价；垄断系数 = Top3 销售额占比（Sorftime category_trend）",
      };
      records[plan.nodeId] = normalRecord.status === "ready"
        ? normalRecord
        : (combineFallbacks(plan.asins, plan.nodeId) ?? normalRecord);
      console.log(`${volume.length} months · volume+amount+monopoly`);
    } catch (error) {
      const fallback = fallbackRecords.get(plan.nodeId) ?? combineFallbacks(plan.asins, plan.nodeId);
      if (!fallback) {
        const nodeDiagnostics = plan.asins.map(asin => diagnosticForAsin(error, asin, "category_trend"));
        diagnostics.push(...nodeDiagnostics);
        records[plan.nodeId] = categoryFailureRecord({
          asin: plan.sourceAsin,
          nodeId: plan.nodeId,
          categoryName: plan.categoryName,
          topCategory: plan.topCategory,
          asins: [...new Set([...(isRepairIncomplete() ? cached?.asins ?? [] : []), ...plan.asins])],
          marketplace,
          fetchedAt,
          reason: nodeDiagnostics[0].causeCode,
        });
        console.log(`error · ${nodeDiagnostics[0].causeCode}`);
        continue;
      }
      records[plan.nodeId] = fallback;
      console.log("connection error · same-job Sorftime evidence");
    }
    await wait(300);
  }

  return { records, nodePlan, diagnostics };
}

function categoryFailureRecord({
  asin,
  nodeId = "",
  categoryName = "",
  topCategory = "",
  asins = [asin],
  marketplace,
  fetchedAt,
  reason,
}) {
  return {
    nodeId,
    categoryName,
    topCategory,
    sourceAsin: asin,
    asins,
    marketplace,
    fetchedAt,
    status: "error",
    statusMessage: reason,
    volume: [],
    avgPrice: [],
    amount: [],
    listingMonopoly: [],
    brandMonopoly: [],
    sellerMonopoly: [],
  };
}

function boundedCategoryFailure(error, asin, operation) {
  const normalized = finalCategoryConnectTimeout(error, asin);
  if (normalized instanceof ProviderDiagnosticError) return normalized;
  const schemaFailure = normalized?.kind === "schema";
  return new ProviderDiagnosticError({
    connector: "sorftime",
    stage: "category",
    asin,
    failureKind: schemaFailure ? "schema" : "connection",
    causeCode: schemaFailure ? "MCP_SCHEMA" : "UNKNOWN_TRANSPORT",
    operation,
    boundary: normalized?.providerDiagnostic?.boundary,
  }, { cause: normalized });
}

function diagnosticForAsin(error, asin, operation) {
  const bounded = boundedCategoryFailure(error, asin, operation).diagnostic;
  return { ...bounded, asin };
}

function finalCategoryConnectTimeout(error, asin) {
  const diagnostic = error instanceof ProviderDiagnosticError ? error.diagnostic : null;
  if (diagnostic?.failureKind !== "timeout" || diagnostic.causeCode !== "CONNECT_TIMEOUT") {
    return error;
  }
  return new ProviderDiagnosticError({
    connector: "sorftime",
    stage: "category",
    asin: diagnostic?.asin === "UNKNOWNASIN" ? asin : (diagnostic?.asin ?? asin),
    failureKind: "timeout",
    causeCode: "CONNECT_TIMEOUT",
  }, { cause: error });
}

const invokedAsScript = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;
if (invokedAsScript) {
  runSorftimeCategoryCli().catch((error) => {
    console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
