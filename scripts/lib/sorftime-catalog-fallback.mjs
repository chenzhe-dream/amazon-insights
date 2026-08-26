import { parseImageList } from "./sorftime-listing-parse.mjs";

function schemaError() {
  return new TypeError("Sorftime catalog schema invalid");
}

function optionalText(value) {
  if (value == null) return null;
  if (typeof value !== "string") throw schemaError();
  return value.trim() || null;
}

function optionalNonNegativeNumber(value) {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw schemaError();
  return value;
}

function normalizeCategory(value) {
  const text = optionalText(value);
  return text?.replace(/\s*\(Rank:\s*\d+\)\s*$/i, "").trim() || "类目名称暂缺";
}

function normalizePackageSize(value) {
  const text = optionalText(value);
  if (!text) return "—";
  return /\bcm\b/i.test(text) ? text : `${text} cm`;
}

function normalizeImages(value) {
  if (value == null) return [];
  if (typeof value !== "string" && !Array.isArray(value)) throw schemaError();
  if (Array.isArray(value) && value.some(item => item != null && typeof item !== "string")) {
    throw schemaError();
  }
  return parseImageList(value);
}

export function buildCatalogEntryFromSorftime({ asin, marketplace, detail }) {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) throw schemaError();
  if (typeof asin !== "string" || !/^[A-Z0-9]{10}$/.test(asin)) throw schemaError();
  if (typeof marketplace !== "string" || !marketplace.trim()) throw schemaError();

  const detailAsin = optionalText(detail.asin);
  if (detailAsin && detailAsin.toUpperCase() !== asin) {
    throw new TypeError("Sorftime catalog ASIN mismatch");
  }

  const title = optionalText(detail.title) ?? asin;
  const images = normalizeImages(detail.main_image);
  const fbaFee = optionalNonNegativeNumber(detail.fba_fee);
  const packageSize = normalizePackageSize(detail.package_size_cm);
  optionalText(detail.node_id);
  const rankCategory = normalizeCategory(detail.top_category);
  const subRankCategory = normalizeCategory(detail.subcategory);

  return {
    asin,
    marketplace: marketplace.trim().toUpperCase(),
    catalogSource: "sorftime-fallback",
    brand: "品牌暂缺（Sorftime 未验证）",
    image: images[0] ?? "",
    title,
    price: null,
    sales: null,
    rating: null,
    reviews: null,
    rank: null,
    subRank: null,
    rankCategory,
    subRankCategory,
    buyBoxSeller: "暂缺（SellerSprite）",
    fulfillment: "暂缺（SellerSprite）",
    packageSize,
    packageWeight: "—",
    specifications: [
      "Sorftime 基础商品兜底",
      ...(fbaFee == null ? [] : [`Sorftime FBA 费用估算：$${fbaFee.toFixed(2)}`]),
    ],
    launch: "—",
    format: "—",
    variants: "—",
    history: [],
    prices: [],
    ranks: [],
    variantShare: [],
    variantDetails: [],
    sellingPoints: ["待 Listing 与评论模块补充"],
    strengths: ["Sorftime 基础数据已获取"],
    weaknesses: ["SellerSprite 专属字段暂缺"],
    unmet: ["待补充"],
    scenarios: ["待分析"],
    audiences: ["待分析"],
    keywords: [],
    traffic: { natural: 0, sponsored: 0, recommendation: 0 },
    synced: false,
  };
}
