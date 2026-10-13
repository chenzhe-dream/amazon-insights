import { pathToFileURL } from "node:url";

import {
  appendCatalogEntry,
  asinsNeedingSorftimeCatalogSync,
  readCatalogAsins,
} from "./lib/catalog-sync.mjs";
import { buildCatalogEntryFromSorftime } from "./lib/sorftime-catalog-fallback.mjs";
import { callSorftimeTool, readSorftimeKey } from "./lib/sorftime-mcp-client.mjs";
import {
  createProductDetailEvidence,
  createCategorySalesTrendEvidence,
  createProductVariationsEvidence,
  writeScopedSorftimeEvidence,
} from "./lib/scoped-sorftime-evidence.mjs";

export async function syncCatalogAsinsFromSorftime({
  asins,
  marketplace,
  key,
  callTool = callSorftimeTool,
  appendEntry = appendCatalogEntry,
  jobId = process.env.AGENT_SYNC_JOB_ID,
  writeEvidence = writeScopedSorftimeEvidence,
  retainFallbackModules = false,
}) {
  if (typeof key !== "string" || !key.trim()) {
    throw new Error("未找到 Sorftime MCP key，无法执行 catalog 基础商品兜底");
  }

  const uniqueAsins = [...new Set(asins)];
  const added = [];
  const failed = [];
  for (const asin of uniqueAsins) {
    try {
      const response = await callTool(key, "product_detail", { asin, amz_site: marketplace });
      const entry = buildCatalogEntryFromSorftime({ asin, marketplace, detail: response });
      if (jobId) {
        const productEvidence = createProductDetailEvidence({ jobId, marketplace, asin, detail: response });
        writeEvidence(productEvidence);
        if (retainFallbackModules) {
          const nodeId = productEvidence.data.nodeId;
          if (nodeId) {
            try {
              const categoryResponse = await callTool(key, "category_trend", {
                node_id: nodeId,
                amz_site: marketplace,
                trend_index: "SalesCount",
              });
              writeEvidence(createCategorySalesTrendEvidence({
                jobId,
                marketplace,
                asin,
                nodeId,
                categoryName: productEvidence.data.categoryName,
                topCategory: productEvidence.data.topCategory,
                response: categoryResponse,
              }));
            } catch {
              // Product detail remains a valid catalog result; category fallback is optional evidence.
            }
          }
          try {
            const variationsResponse = await callTool(key, "product_variations", {
              asin,
              amz_site: marketplace,
              page: 1,
            });
            writeEvidence(createProductVariationsEvidence({
              jobId,
              marketplace,
              asin,
              response: variationsResponse,
            }));
          } catch {
            // Product detail remains a valid catalog result; variation fallback is optional evidence.
          }
        }
      }
      if (appendEntry(entry) !== false) {
        added.push(asin);
      }
    } catch (error) {
      failed.push({ asin, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { added, failed };
}

async function main() {
  const marketplace = (process.env.SORFTIME_MARKETPLACE ?? process.env.MARKETPLACE ?? "US").trim().toUpperCase();
  const fromEnv = process.env.SORFTIME_ASINS?.split(",").map(item => item.trim().toUpperCase()).filter(Boolean) ?? [];
  const fromArgv = process.argv.slice(2).map(item => item.trim().toUpperCase()).filter(item => /^[A-Z0-9]{10}$/.test(item));
  const asins = [...new Set([...fromEnv, ...fromArgv])];
  if (!asins.length || asins.some(asin => !/^[A-Z0-9]{10}$/.test(asin))) {
    throw new TypeError("请指定合法 ASIN：SORFTIME_ASINS=B0XXXXXXXX npm run catalog:sorftime:sync");
  }

  const pending = asinsNeedingSorftimeCatalogSync(asins, marketplace);
  if (!pending.length) {
    console.log("[catalog:sorftime] all ASINs already in competitor-data.ts");
    return;
  }

  const result = await syncCatalogAsinsFromSorftime({
    asins: pending,
    marketplace,
    key: readSorftimeKey(),
    retainFallbackModules: Boolean(process.env.AGENT_SYNC_JOB_ID),
  });
  for (const failure of result.failed) {
    console.error(`[catalog:sorftime] ${failure.asin} failed (${failure.reason})`);
  }
  console.log(`[done] Sorftime catalog +${result.added.length} · total ${readCatalogAsins().length} ASINs`);
  if (result.failed.length) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => {
    console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
