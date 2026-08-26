import { pathToFileURL } from "node:url";

import {
  appendCatalogEntry,
  asinsNeedingCatalogSync,
  readCatalogAsins,
} from "./lib/catalog-sync.mjs";
import { buildCatalogEntryFromSorftime } from "./lib/sorftime-catalog-fallback.mjs";
import { callSorftimeTool, readSorftimeKey } from "./lib/sorftime-mcp-client.mjs";

export async function syncCatalogAsinsFromSorftime({
  asins,
  marketplace,
  key,
  callTool = callSorftimeTool,
  appendEntry = appendCatalogEntry,
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
      const detail = response?.data ?? response;
      const entry = buildCatalogEntryFromSorftime({ asin, marketplace, detail });
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

  const pending = asinsNeedingCatalogSync(asins);
  if (!pending.length) {
    console.log("[catalog:sorftime] all ASINs already in competitor-data.ts");
    return;
  }

  const result = await syncCatalogAsinsFromSorftime({
    asins: pending,
    marketplace,
    key: readSorftimeKey(),
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
