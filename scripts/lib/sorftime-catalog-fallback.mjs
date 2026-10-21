import { normalizeSorftimeProfile } from './sorftime-profile-normalize.mjs';
import { projectMarketplaceCurrency, formatMarketplaceMoney } from './project-marketplace-money.mjs';

export const SORFTIME_CATALOG_PROFILE_VERSION = 1;
export const SORFTIME_CATALOG_PROFILE_FIELDS = Object.freeze([
  'title', 'image', 'brand', 'buyBoxSeller', 'fulfillment', 'price', 'rating', 'reviews',
  'launch', 'variants', 'packageSize', 'packageWeight', 'rankCategory', 'subRankCategory', 'subRank',
]);

export function asinsNeedingSorftimeCatalogSync(asins, { catalogProducts = [], marketplace = 'US' } = {}) {
  return asins.filter(asin => {
    const site = marketplace.trim().toUpperCase();
    const entry = catalogProducts.find(item => item.asin === asin &&
      (item.marketplace === site || site === 'US' && item.marketplace == null));
    return !entry || entry.catalogSource === 'sorftime-fallback'
      && entry.marketplace === marketplace.trim().toUpperCase()
      && !(Number.isInteger(entry.catalogProfileVersion) && entry.catalogProfileVersion >= SORFTIME_CATALOG_PROFILE_VERSION);
  });
}

export function buildCatalogEntryFromSorftime({ asin, marketplace, detail }) {
  const profile = normalizeSorftimeProfile(detail, { asin, marketplace });
  const { fbaFee } = profile;
  const catalogFieldSources = Object.fromEntries(SORFTIME_CATALOG_PROFILE_FIELDS.filter(field => profile[field] != null).map(field => [field, 'sorftime']));

  return {
    asin,
    marketplace: marketplace.trim().toUpperCase(),
    currency: projectMarketplaceCurrency(marketplace),
    catalogSource: "sorftime-fallback",
    catalogProfileVersion: SORFTIME_CATALOG_PROFILE_VERSION,
    catalogFieldSources,
    brand: profile.brand ?? "品牌暂缺（Sorftime 未验证）",
    image: profile.image ?? "",
    title: profile.title ?? asin,
    price: profile.price,
    sales: null,
    rating: profile.rating,
    reviews: profile.reviews,
    rank: null,
    subRank: profile.subRank,
    rankCategory: profile.rankCategory ?? '类目名称暂缺',
    subRankCategory: profile.subRankCategory ?? '类目名称暂缺',
    buyBoxSeller: profile.buyBoxSeller ?? "暂缺（SellerSprite）",
    fulfillment: profile.fulfillment ?? "暂缺（SellerSprite）",
    packageSize: profile.packageSize ?? '—',
    packageWeight: profile.packageWeight ?? "—",
    specifications: [
      "Sorftime 基础商品兜底",
      ...(fbaFee == null ? [] : [`Sorftime FBA 费用估算：${formatMarketplaceMoney(fbaFee, marketplace)}`]),
    ],
    launch: profile.launch ?? "—",
    format: "—",
    variants: profile.variants ?? "—",
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
