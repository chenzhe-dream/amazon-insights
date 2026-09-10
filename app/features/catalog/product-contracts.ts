import { type CatalogSource } from "../../catalog-source-status";

export type Keyword = { word: string; share: number; type: "自然" | "广告" };

export type VariantDetail = { name: string; reviews: number | null; share: number | null; launch: string | null };

export type Product = {
  asin: string;
  brand: string;
  image: string;
  title: string;
  price: number | null;
  sales: number | null;
  rating: number | null;
  reviews: number | null;
  rank: number | null;
  subRank: number | null;
  rankCategory: string;
  subRankCategory: string;
  buyBoxSeller: string;
  fulfillment: string;
  packageSize: string;
  packageWeight: string;
  specifications: string[];
  launch: string;
  format: string;
  variants: string;
  history: number[];
  prices: number[];
  ranks: number[];
  variantShare: number[];
  variantDetails: VariantDetail[];
  sellingPoints: string[];
  productFamily?: "scooter" | "lighting" | "generic";
  strengths: string[];
  weaknesses: string[];
  unmet: string[];
  scenarios: string[];
  audiences: string[];
  keywords: Keyword[];
  traffic: { natural: number; sponsored: number; recommendation: number };
  catalogSource?: CatalogSource;
  synced: boolean;
};

export const markets = {
  US: { label: "美国站", short: "US", option: "Amazon.com｜美国站", domain: "www.amazon.com" },
  UK: { label: "英国站", short: "UK", option: "Amazon.co.uk｜英国站", domain: "www.amazon.co.uk" },
  CA: { label: "加拿大站", short: "CA", option: "Amazon.ca｜加拿大站", domain: "www.amazon.ca" },
  DE: { label: "德国站", short: "DE", option: "Amazon.de｜德国站", domain: "www.amazon.de" },
} as const;

export type MarketCode = keyof typeof markets;

export function placeholderProduct(asin: string): Product {
  return {
    asin, brand: "等待同步", image: "", title: "等待卖家精灵与 SIF MCP 返回商品数据",
    price: null, sales: null, rating: null, reviews: null, rank: null, subRank: null,
    rankCategory: "等待同步", subRankCategory: "等待同步", buyBoxSeller: "等待同步", fulfillment: "等待同步",
    packageSize: "—", packageWeight: "—", specifications: ["等待同步"],
    launch: "—", format: "—", variants: "—", history: [], prices: [], ranks: [], variantShare: [], variantDetails: [], sellingPoints: ["等待 Listing 内容同步后提炼"],
    strengths: ["数据同步后生成"], weaknesses: ["数据同步后生成"], unmet: ["数据同步后生成"],
    scenarios: ["待分析"], audiences: ["待分析"], keywords: [], traffic: { natural: 0, sponsored: 0, recommendation: 0 }, synced: false,
  };
}

export function sellerSpriteOnlyFieldsUnavailable(product: Product) {
  return product.catalogSource === "sorftime-fallback" || !product.synced;
}

export function variationTheme(product: Product) {
  const source = [product.format, ...product.variantDetails.map(item=>item.name)].join(" ");
  const themes: string[] = [];
  if (/color|颜色/i.test(source)) themes.push("颜色");
  if (/size|尺寸/i.test(source)) themes.push("尺寸");
  if (/style|款式/i.test(source)) themes.push("款式");
  if (/configuration|配置/i.test(source)) themes.push("配置");
  return themes.join("、") || "暂无数据";
}
