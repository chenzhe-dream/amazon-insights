import fs from "node:fs";
import path from "node:path";
import { callSorftimeTool, readSorftimeKey } from "./lib/sorftime-mcp-client.mjs";
import { callSellerSpriteMcpTool, readSellerSpriteSecretKey } from "./lib/sellersprite-mcp-client.mjs";
import { isForceRefresh, logCacheHit, readCachedDataExport } from "./lib/sync-cache.mjs";

const root = path.resolve(import.meta.dirname, "..");
const catalogPath = path.join(root, "app", "competitor-data.ts");
const outPath = path.join(root, "app", "sorftime-fba-fee-data.ts");

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

function parseKeepaFba(payload) {
  const data = payload?.data ?? payload;
  const pickAndPack =
    toNumber(data?.fbaFees) ??
    toNumber(data?.fbaItems?.pickAndPackFee) ??
    (() => {
      try {
        const items = typeof data?.fbaItems === "string" ? JSON.parse(data.fbaItems) : data?.fbaItems;
        return toNumber(items?.pickAndPackFee);
      } catch {
        return null;
      }
    })();
  return {
    fbaFee: pickAndPack,
    packageSize: data?.pkgDimensions ?? null,
    packageWeight: data?.pkgWeight ?? null,
    productSize: data?.dimensions ?? null,
  };
}

async function main() {
  const sorftimeKey = readSorftimeKey();
  const sellerSpriteKey = readSellerSpriteSecretKey();
  const marketplace = process.env.SORFTIME_MARKETPLACE ?? process.env.MARKETPLACE ?? "US";
  const asins =
    process.env.SORFTIME_ASINS?.split(",").map(item => item.trim()).filter(Boolean) ?? readCatalogAsins();
  const fetchedAt = new Date().toISOString().slice(0, 10);
  const existing = readCachedDataExport(outPath, "sorftimeFbaFeeData");
  const records = { ...existing };

  if (!sellerSpriteKey && !Object.values(existing).some(record => record?.status === "ready")) {
    console.error("[error] 未找到卖家精灵 MCP key，且无可用缓存");
    process.exitCode = 1;
    return;
  }

  if (isForceRefresh()) console.log("[sync] FORCE_REFRESH=1 · 忽略缓存，重新调用 MCP");

  for (const asin of asins) {
    if (!isForceRefresh() && existing[asin]?.status === "ready" && existing[asin]?.source === "keepa") {
      logCacheHit(asin, existing[asin]);
      records[asin] = existing[asin];
      continue;
    }
    if (!sellerSpriteKey) {
      console.log(`[skip] ${asin} · 无卖家精灵 MCP key`);
      continue;
    }

    process.stdout.write(`[fba] ${asin} ... `);
    try {
      let sorftimeFbaFee = null;
      let sorftimePackageCm = null;
      if (sorftimeKey) {
        try {
          const detailRaw = await callSorftimeTool(sorftimeKey, "product_detail", { asin, amz_site: marketplace });
          const detail = detailRaw?.data ?? detailRaw;
          sorftimeFbaFee = toNumber(detail?.fba_fee);
          sorftimePackageCm = detail?.package_size_cm ?? null;
        } catch {
          // Keepa 为主，Sorftime 仅作对照
        }
      }

      const keepaRaw = await callSellerSpriteMcpTool(sellerSpriteKey, "keepa_info", {
        marketplace,
        asin,
        returnFields: "asin,fbaFees,fbaItems,pkgDimensions,pkgWeight,dimensions,weight",
      });
      if (keepaRaw?.code && keepaRaw.code !== "OK") {
        throw new Error(`${keepaRaw.code}: ${keepaRaw.message ?? "keepa_info 失败"}`);
      }
      const keepa = parseKeepaFba(keepaRaw);
      if (keepa.fbaFee == null || keepa.fbaFee < 0) {
        records[asin] = {
          asin,
          marketplace,
          fetchedAt,
          status: "empty",
          source: "keepa",
          fbaFee: null,
          sorftimeFbaFee,
          packageSize: keepa.packageSize,
          packageWeight: keepa.packageWeight,
          note: sorftimeFbaFee != null ? `Sorftime MCP 返回 $${sorftimeFbaFee.toFixed(2)}（疑似按产品尺寸估费）` : undefined,
        };
        console.log("empty");
      } else {
        const inflated =
          sorftimeFbaFee != null && sorftimeFbaFee > keepa.fbaFee * 1.35
            ? `已校正：Sorftime MCP $${sorftimeFbaFee.toFixed(2)} 偏高（其 package ${sorftimePackageCm ?? "n/a"} 更接近产品尺寸）`
            : undefined;
        records[asin] = {
          asin,
          marketplace,
          fetchedAt,
          status: "ready",
          source: "keepa",
          fbaFee: keepa.fbaFee,
          sorftimeFbaFee,
          packageSize: keepa.packageSize,
          packageWeight: keepa.packageWeight,
          note: inflated,
        };
        const contra = sorftimeFbaFee != null ? ` · Sorftime $${sorftimeFbaFee.toFixed(2)}` : "";
        console.log(`Keepa $${keepa.fbaFee.toFixed(2)}${contra}`);
      }
    } catch (error) {
      if (existing[asin]?.status === "ready") {
        console.log(`error · keep cache (${error instanceof Error ? error.message : String(error)})`);
        records[asin] = existing[asin];
      } else {
        records[asin] = {
          asin,
          marketplace,
          fetchedAt,
          status: "error",
          source: "keepa",
          statusMessage: error instanceof Error ? error.message : String(error),
          fbaFee: null,
        };
        console.log(`error: ${records[asin].statusMessage}`);
      }
    }
    await sleep(300);
  }

  const body = `// Generated by scripts/build-sorftime-fba-fee.mjs — do not edit manually
export type SorftimeFbaFeeRecord = {
  asin: string;
  marketplace: string;
  fetchedAt: string;
  status: "ready" | "empty" | "error";
  statusMessage?: string;
  source?: "keepa" | "sorftime";
  fbaFee: number | null;
  sorftimeFbaFee?: number | null;
  packageSize?: string | null;
  packageWeight?: string | null;
  note?: string;
};

export const sorftimeFbaFeeMeta = ${JSON.stringify(
    {
      source: "Keepa · FBA 配送费（pick & pack）；Sorftime MCP fba_fee 作对照",
      updatedAt: fetchedAt,
      marketplace,
      syncCommand: "npm run fba:sync",
      emptyMessage: "暂未返回 FBA 配送费",
      note: "Sorftime product_detail.fba_fee 常按产品展开尺寸估费偏高；展示值改用 Keepa 包装尺寸对应的 FBA 配送费",
    },
    null,
    2,
  )} as const;

export const sorftimeFbaFeeData: Record<string, SorftimeFbaFeeRecord> = ${JSON.stringify(records, null, 2)};
`;
  fs.writeFileSync(outPath, body, "utf8");
  const ready = Object.values(records).filter(record => record.status === "ready").length;
  console.log(`[done] ${ready}/${asins.length} ASINs → app/sorftime-fba-fee-data.ts`);
}

main();
