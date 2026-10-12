import { createRepairSafeRecordMap, isRepairIncomplete, reportIncompleteRepair } from "./lib/sync-cache.mjs";
import fs from "node:fs";
import path from "node:path";
import { generatedAppDataPath } from "./lib/generated-app-data-path.mjs";
import { callSorftimeTool, readSorftimeKey } from "./lib/sorftime-mcp-client.mjs";
import { callSellerSpriteMcpTool, readSellerSpriteSecretKey } from "./lib/sellersprite-mcp-client.mjs";
import { isForceRefresh, logCacheHit, readCachedDataExport } from "./lib/sync-cache.mjs";
import {
  createDirectListingProvenance,
  collectListingProductData,
  buildListingRecordFromProductDetailEvidence,
  buildListingFailureRecord,
  discardUnscopedListingRecord,
  selectScopedListingRecord,
} from "./lib/sorftime-listing-parse.mjs";
import { readScopedSorftimeEvidence } from "./lib/scoped-sorftime-evidence.mjs";

const root = path.resolve(import.meta.dirname, "..");
const catalogPath = generatedAppDataPath(root, "competitor-data.ts");
const outPath = generatedAppDataPath(root, "sorftime-listing-content-data.ts");

function readCatalogAsins() {
  const source = fs.readFileSync(catalogPath, "utf8");
  return [...source.matchAll(/"asin":\s*"([A-Z0-9]{10})"/g)].map(match => match[1]);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseSellerSpriteBadge(detail) {
  const badge = detail?.badge ?? {};
  return {
    hasEbc: badge.ebc === "Y" ? true : badge.ebc === "N" ? false : null,
    hasVideo: badge.video === "Y" ? true : badge.video === "N" ? false : null,
    lqs: Number.isFinite(Number(detail?.lqs)) ? Number(detail.lqs) : null,
  };
}

async function main() {
  const jobId = process.env.AGENT_SYNC_JOB_ID?.trim();
  const scopedEvidenceOnly = Boolean(jobId) && process.env.SORFTIME_SCOPED_EVIDENCE_ONLY === "1";
  const sorftimeKey = scopedEvidenceOnly ? null : readSorftimeKey();
  const sellerSpriteKey = scopedEvidenceOnly ? null : readSellerSpriteSecretKey();
  const marketplace = process.env.SORFTIME_MARKETPLACE ?? process.env.MARKETPLACE ?? "US";
  const asins =
    process.env.SORFTIME_ASINS?.split(",").map(item => item.trim()).filter(Boolean) ?? readCatalogAsins();
  const fetchedAt = new Date().toISOString().slice(0, 10);
  const refreshImages = process.env.AGENT_SYNC_IMAGE_ACTION === "refresh";
  const existing = readCachedDataExport(outPath, "sorftimeListingContentData");
  const records = refreshImages ? { ...existing } : createRepairSafeRecordMap(existing);

  if (!sorftimeKey && !jobId && !Object.values(existing).some(record => record?.status === "ready")) {
    console.error("[error] 未找到 Sorftime MCP key，且无可用缓存");
    process.exitCode = 1;
    return;
  }

  if (isForceRefresh()) console.log("[sync] FORCE_REFRESH=1 · 忽略缓存，重新调用 MCP");

  let missingCredential = false;
  for (const asin of asins) {
    const evidence = jobId
      ? readScopedSorftimeEvidence({
        jobId,
        marketplace,
        asin,
        operation: "product_detail",
      })
      : null;
    const selected = refreshImages ? null : selectScopedListingRecord({
      evidence,
      existingRecord: existing[asin],
      forceRefresh: isForceRefresh(),
      requireScopedEvidence: Boolean(jobId) && !isRepairIncomplete(),
    });
    if (selected) {
      records[asin] = selected;
      if (evidence) {
        console.log(`[listing] ${asin} · same-job Sorftime evidence · ${selected.galleryImages.length} imgs`);
      } else {
        logCacheHit(asin, selected);
      }
      continue;
    }
    if (!sorftimeKey) {
      console.log(`[skip] ${asin} · 无 Sorftime MCP key`);
      if (refreshImages) reportIncompleteRepair(asin);
      else if (evidence) records[asin] = buildListingRecordFromProductDetailEvidence(evidence);
      else if (jobId) discardUnscopedListingRecord(records, asin);
      missingCredential = true;
      continue;
    }

    process.stdout.write(`[listing] ${asin} ... `);
    try {
      const product = await collectListingProductData({ asin, marketplace, key: sorftimeKey, callTool: callSorftimeTool, detailEvidence: evidence, refreshImages });
      const { galleryImages, operation } = product;
      if (refreshImages && !galleryImages.length) throw new Error("本次未返回图片，保留原图册");
      const mainImage = galleryImages[0] ?? null;
      const secondaryImages = galleryImages.slice(1);
      const hasAplus =
        product.hasAplus ?? (refreshImages ? existing[asin]?.hasAplus ?? null : null);

      let hasEbc = refreshImages ? existing[asin]?.hasEbc ?? null : null;
      let hasVideo = refreshImages ? existing[asin]?.hasVideo ?? null : null;
      let lqs = refreshImages ? existing[asin]?.lqs ?? null : null;
      if (sellerSpriteKey && !refreshImages) {
        try {
          const ssRaw = await callSellerSpriteMcpTool(sellerSpriteKey, "asin_detail", {
            marketplace,
            asin,
            returnFields: "asin,badge,lqs",
          });
          if (!ssRaw?.code || ssRaw.code === "OK") {
            const badgeInfo = parseSellerSpriteBadge(ssRaw?.data ?? ssRaw);
            hasEbc = badgeInfo.hasEbc;
            hasVideo = badgeInfo.hasVideo;
            lqs = badgeInfo.lqs;
          }
        } catch {
          // SellerSprite 可选
        }
      }

      if (!galleryImages.length && hasAplus == null) {
        records[asin] = {
          asin,
          marketplace,
          fetchedAt,
          status: "empty",
          mainImage: null,
          galleryImages: [],
          secondaryImages: [],
          imageCount: 0,
          hasAplus,
          hasEbc,
          hasVideo,
          lqs,
          source: "Sorftime",
          provenance: createDirectListingProvenance({ jobId, marketplace, asin, fetchedAt, operation }),
        };
        console.log("empty");
      } else {
        records[asin] = {
          asin,
          marketplace,
          fetchedAt,
          status: "ready",
          mainImage,
          galleryImages,
          ...(refreshImages ? { previousGalleryImages: existing[asin]?.previousGalleryImages ?? existing[asin]?.galleryImages ?? [] } : {}),
          secondaryImages,
          imageCount: galleryImages.length,
          hasAplus,
          hasEbc,
          hasVideo,
          lqs,
          source: "Sorftime",
          provenance: createDirectListingProvenance({ jobId, marketplace, asin, fetchedAt, operation }),
        };
        console.log(`${galleryImages.length} imgs · A+ ${hasAplus ? "Y" : hasAplus === false ? "N" : "?"}`);
      }
    } catch (error) {
      if (refreshImages) {
        console.error(`error · 保留原图册 (${error instanceof Error ? error.message : String(error)})`);
        reportIncompleteRepair(asin);
      } else if (!jobId && existing[asin]?.status === "ready") {
        console.log(`error · keep cache (${error instanceof Error ? error.message : String(error)})`);
        records[asin] = existing[asin];
      } else {
        records[asin] = buildListingFailureRecord({ asin, marketplace, fetchedAt, jobId, error });
        console.log(`error: ${records[asin].statusMessage}`);
      }
    }
    await sleep(300);
  }

  const body = `// Generated by scripts/build-sorftime-listing-content.mjs — do not edit manually
export type SorftimeListingContentRecord = {
  asin: string;
  marketplace: string;
  fetchedAt: string;
  status: "ready" | "empty" | "error";
  statusMessage?: string;
  mainImage: string | null;
  galleryImages: string[];
  previousGalleryImages?: string[];
  secondaryImages: string[];
  imageCount: number;
  hasAplus: boolean | null;
  hasEbc: boolean | null;
  hasVideo: boolean | null;
  lqs: number | null;
  source?: "Sorftime";
  provenance?: {
    jobId: string;
    marketplace: string;
    asin: string;
    operation: string;
    fetchedAt: string;
    connector: string;
    tool: string;
    stageId?: string;
  } | null;
};

export const sorftimeListingContentMeta = ${JSON.stringify(
    {
      source: "Sorftime MCP · product_content（图片）+ product_detail（a_plus / 旧版图片）+ 卖家精灵 badge（EBC / 视频 / LQS）",
      updatedAt: fetchedAt,
      marketplace,
      syncCommand: "npm run listing:sync",
      emptyMessage: "暂未返回 Listing 图册或 A+ 信号",
    },
    null,
    2,
  )} as const;

export const sorftimeListingContentData: Record<string, SorftimeListingContentRecord> = ${JSON.stringify(records, null, 2)};
`;
  fs.writeFileSync(outPath, body, "utf8");
  const ready = Object.values(records).filter(record => record.status === "ready").length;
  console.log(`[done] ${ready}/${asins.length} ASINs → app/sorftime-listing-content-data.ts`);
  if (missingCredential) process.exitCode = 1;
}

main();
