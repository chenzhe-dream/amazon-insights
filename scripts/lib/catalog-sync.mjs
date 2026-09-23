import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { callSellerSpriteMcpTool, readSellerSpriteSecretKey } from "./sellersprite-mcp-client.mjs";
import { detectProductFamily } from "./product-family.mjs";
import { localizeSellingPoints } from "./selling-point-zh.mjs";
import { localizeSpecifications } from "./specification-zh.mjs";
import { extractExportArrayLiteral, readCachedArrayExport } from "./sync-cache.mjs";

const root = path.resolve(import.meta.dirname, "../..");
export const catalogPath = path.join(root, "app", "competitor-data.ts");
const rufusPath = path.join(root, "app", "rufus-voc-data.ts");

/** Captures the generated catalog at the catalog phase boundary in the job mirror. */
export function captureCatalogForSyncJob(asins, filePath = catalogPath, capturedAt = new Date().toISOString()) {
  const before = fs.statSync(filePath);
  const bytes = fs.readFileSync(filePath);
  const after = fs.statSync(filePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) {
    throw new Error("Generated catalog changed while it was captured");
  }
  const literal = extractExportArrayLiteral(bytes.toString("utf8"), "refreshedCatalog");
  if (!literal) throw new Error("Generated catalog export is missing");
  const records = JSON.parse(literal);
  if (!Array.isArray(records)) throw new Error("Generated catalog is not an array");
  const requested = new Set(asins);
  const catalog = records.filter(item => item && typeof item === "object" && !Array.isArray(item) && requested.has(item.asin));
  if (new Set(catalog.map(item => item.asin)).size !== catalog.length) throw new Error("Generated catalog has duplicate requested ASINs");
  return { catalog, evidence: {
    sourceKind: "generated-file",
    sourceRef: "app/competitor-data.ts#refreshedCatalog",
    sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    sourceUpdatedAt: after.mtime.toISOString(),
    capturedAt: new Date(capturedAt).toISOString(),
  } };
}

export function readCatalogAsins() {
  if (!fs.existsSync(catalogPath)) return [];
  const source = fs.readFileSync(catalogPath, "utf8");
  return [...source.matchAll(/"asin":\s*"([A-Z0-9]{10})"/g)].map(match => match[1]);
}

export function catalogHasAsin(asin) {
  return readCatalogAsins().includes(asin);
}

export function asinsNeedingCatalogSync(asins) {
  return asins.filter(asin => !catalogHasAsin(asin));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function formatFulfillment(code) {
  if (code === "AMZ") return "Amazon 自营配送";
  if (code === "FBA") return "Amazon 配送（FBA）";
  if (code === "FBM") return "卖家自配送（FBM）";
  return code || "—";
}

function normalizeCatalogImageUrl(url) {
  return String(url ?? "").trim().replace(/_AC_SR\d+,\d+_/g, "_AC_US600_");
}

function formatLaunch(ms) {
  if (!ms) return "—";
  const date = new Date(Number(ms));
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().slice(0, 10);
}

function parseSpecifications(detail, family) {
  return localizeSpecifications(detail, family);
}

function last12TrendPoints(points) {
  return [...(points ?? [])]
    .filter(point => point?.month)
    .sort((a, b) => String(a.month).localeCompare(String(b.month)))
    .slice(-12);
}

function pickSalesValue(point) {
  return toNumber(point?.parentUnitSales) ?? toNumber(point?.childUnitSales) ?? 0;
}

export function buildCatalogEntryFromSellerSprite(detail, trendPoints) {
  const points = last12TrendPoints(trendPoints);
  const subRank = detail.subcategories?.[0]?.rank ?? null;
  const history = points.map(pickSalesValue);
  const prices = points.map(point => toNumber(point?.averagePrice) ?? toNumber(point?.price) ?? 0);
  const ranks = points.map(() => subRank ?? detail.bsrRank ?? 0);
  const latestSales = history.length ? history[history.length - 1] : null;
  const features = Array.isArray(detail.features) ? detail.features.filter(Boolean) : [];
  const variationList = Array.isArray(detail.variationList) ? detail.variationList : [];
  const category = `${detail.subcategories?.[0]?.label || ""} ${detail.bsrLabel || ""}`.trim();
  const family = detectProductFamily({
    title: detail.title || "",
    category,
    features,
  });

  return {
    asin: detail.asin,
    catalogSource: "sellerSprite",
    brand: detail.brand || "—",
    image: normalizeCatalogImageUrl(detail.zoomImageUrl || detail.imageUrl || ""),
    title: detail.title || detail.asin,
    price: toNumber(detail.price),
    sales: latestSales,
    rating: toNumber(detail.rating),
    reviews: toNumber(detail.ratings) ?? toNumber(detail.reviews) ?? 0,
    rank: toNumber(detail.bsrRank),
    subRank,
    rankCategory: detail.bsrLabel || "—",
    subRankCategory: detail.subcategories?.[0]?.label || "—",
    buyBoxSeller: detail.sellerName || "—",
    fulfillment: formatFulfillment(detail.fulfillment),
    packageSize: detail.dimensions || "—",
    packageWeight: detail.weight || "—",
    productFamily: family,
    specifications: parseSpecifications(detail, family),
    launch: formatLaunch(detail.availableDate ?? detail.createdTime),
    format: detail.skuList?.length ? detail.skuList.join(" · ") : "—",
    variants: detail.variations ? `${detail.variations}个变体` : "—",
    listingBullets: features,
    sellingPoints: localizeSellingPoints(features, {
      family,
      title: detail.title || "",
      category,
    }),
    history: history.length ? history : [],
    prices: prices.length ? prices : [],
    ranks: ranks.length ? ranks : subRank != null ? [subRank] : [],
    variantShare: [],
    variantDetails: variationList.map(item => ({
      name: `${item.attribute ?? "Variant"} · ${item.asin}`,
      reviews: null,
      share: null,
      launch: null,
    })),
    strengths: features.slice(0, 3).length ? features.slice(0, 3) : ["卖家精灵 Listing 已入库，待评论分析"],
    weaknesses: ["Sorftime 评论分析同步中"],
    unmet: ["Sorftime 评论分析同步中"],
    scenarios: ["待 VOC / 评论分析"],
    audiences: ["待 VOC / 评论分析"],
    keywords: [],
    traffic: { natural: 0, sponsored: 0, recommendation: 0 },
    synced: true,
  };
}

export function ensureCatalogProductFamilies(filePath = catalogPath) {
  if (!fs.existsSync(filePath)) return [];
  const catalog = readCachedArrayExport(filePath, "refreshedCatalog");
  if (!Array.isArray(catalog) || !catalog.length) return catalog ?? [];

  let source = fs.readFileSync(filePath, "utf8");
  let changed = false;
  const next = catalog.map(item => {
    const family = detectProductFamily({
      title: item.title ?? "",
      category: `${item.subRankCategory ?? ""} ${item.rankCategory ?? ""}`,
      features: item.sellingPoints ?? [],
    });
    const marker = `"asin": "${item.asin}"`;
    const start = source.indexOf(marker);
    if (start < 0) return { ...item, productFamily: family };
    // Scan to this JSON object's closing brace, ignoring braces inside strings.
    // Long titles can put productFamily well past the former 500-character window.
    let windowEnd=source.length,depth=0,quoted=false,escaped=false;
    for(let i=start;i<source.length;i++){
      const char=source[i];
      if(quoted){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;continue}
      if(char==='"')quoted=true;
      else if(char==='{')depth++;
      else if(char==='}'){if(depth===0){windowEnd=i+1;break}depth--}
    }
    const window = source.slice(start, windowEnd);
    if (new RegExp(`"productFamily":\\s*"${family}"`).test(window)) {
      return { ...item, productFamily: family };
    }
    changed = true;
    let patchedWindow;
    if (/"productFamily":\s*"[^"]*"/.test(window)) {
      patchedWindow = window.replace(/"productFamily":\s*"[^"]*"/, `"productFamily": "${family}"`);
    } else {
      patchedWindow = window.replace(marker, `${marker},\n    "productFamily": "${family}"`);
    }
    source = source.slice(0, start) + patchedWindow + source.slice(windowEnd);
    return { ...item, productFamily: family };
  });

  if (changed) fs.writeFileSync(filePath, source, "utf8");
  return next;
}

export function appendCatalogEntry(entry) {
  if (!fs.existsSync(catalogPath)) throw new Error(`missing ${catalogPath}`);
  let source = fs.readFileSync(catalogPath, "utf8");
  if (source.includes(`"asin": "${entry.asin}"`)) {
    return false;
  }
  const block = `,\n  ${JSON.stringify(entry, null, 2).replace(/^/gm, "  ").trim()}\n`;
  source = source.replace(/\n\];\s*$/, `${block}];`);
  fs.writeFileSync(catalogPath, source, "utf8");
  return true;
}

export function ensureRufusVocPendingStub(asin, rating, reviewCount) {
  if (!fs.existsSync(rufusPath)) return;
  let source = fs.readFileSync(rufusPath, "utf8");
  if (source.includes(`${asin}:`)) return;

  const pendingLine = "待在 Alexa for Shopping 对话框提问七问后，按回复原文录入。";
  const block = `  ${asin}: {
    captureStatus: "pending",
    alexaReport: {
      title: "顾客评价深度分析",
      asin: "${asin}",
      rating: ${rating ?? 0},
      reviewCount: ${reviewCount ?? 0},
      prompt: rufusVocMeta.prompt,
      overallConclusion: "${pendingLine}",
      captureNote: "请在 Amazon App → 商品页 → Alexa for Shopping 对话框提问，将回复截图或原文发回后录入。",
      captureStatus: "pending",
    },
    attention: ["${pendingLine}"],
    positives: ["${pendingLine}"],
    negatives: ["${pendingLine}"],
    unmet: ["${pendingLine}"],
    audiences: ["${pendingLine}"],
    scenarios: ["${pendingLine}"],
    motives: ["${pendingLine}"],
  },
`;
  source = source.replace(/\n};\n\nexport const rufusVocDimensions/, `\n${block}};\n\nexport const rufusVocDimensions`);
  fs.writeFileSync(rufusPath, source, "utf8");
}

export async function syncCatalogAsins(asins, marketplace = "US") {
  ensureCatalogProductFamilies();
  const secretKey = readSellerSpriteSecretKey();
  if (!secretKey) {
    throw new Error("未找到卖家精灵 MCP secret-key，无法自动入库 catalog");
  }

  const pending = asinsNeedingCatalogSync(asins);
  if (!pending.length) {
    console.log("[catalog] all ASINs already in competitor-data.ts");
    return { added: [], skipped: asins };
  }

  const added = [];
  for (const asin of pending) {
    process.stdout.write(`[catalog] ${asin} ... `);
    try {
      const detailRaw = await callSellerSpriteMcpTool(secretKey, "asin_detail", {
        marketplace,
        asin,
      });
      if (detailRaw?.code && detailRaw.code !== "OK") {
        throw new Error(`${detailRaw.code}: ${detailRaw.message ?? "asin_detail 失败"}`);
      }
      const detail = detailRaw?.data ?? detailRaw;
      if (!detail?.asin) throw new Error("asin_detail 返回为空");

      let trendPoints = [];
      try {
        const trendRaw = await callSellerSpriteMcpTool(secretKey, "asin_sales_trend", { marketplace, asin });
        if (!trendRaw?.code || trendRaw.code === "OK") {
          trendPoints = trendRaw?.data?.salesTrendPoints ?? [];
        }
      } catch {
        // 趋势可选，不影响底库入库
      }

      const entry = buildCatalogEntryFromSellerSprite(detail, trendPoints);
      if (appendCatalogEntry(entry)) {
        ensureRufusVocPendingStub(asin, entry.rating ?? 0, entry.reviews ?? 0);
        added.push(asin);
        console.log(`${entry.brand} · ${entry.subRankCategory}`);
      } else {
        console.log("already exists");
      }
    } catch (error) {
      console.log(`failed (${error instanceof Error ? error.message : String(error)})`);
      throw error;
    }
    await sleep(1200);
  }

  return { added, skipped: asins.filter(asin => !added.includes(asin)) };
}
