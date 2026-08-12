/**
 * Amazon US referral (commission) fee schedule.
 * Source: https://sell.amazon.com/pricing （US 站类目佣金，2026 口径）
 * Note: 费用类目不一定等于前台 BSR 大类；按竞品 rankCategory 做最近匹配。
 */

export type ReferralFeeRule =
  | { type: "flat"; rate: number; minFee?: number }
  | { type: "threshold"; cutoff: number; lowRate: number; highRate: number; minFee?: number }
  | { type: "tiered"; tiers: Array<{ upTo: number | null; rate: number }>; minFee?: number };

export type ResolvedReferralFee = {
  feeCategory: string;
  rankCategory: string;
  rateLabel: string;
  ratePct: number;
  fee: number | null;
  formula: string;
  note: string;
};

/** Official fee-category names → rules */
export const AMAZON_US_REFERRAL_FEES: Record<string, ReferralFeeRule> = {
  "Amazon Device Accessories": { type: "flat", rate: 0.45, minFee: 0.3 },
  "Appliances - Compact": {
    type: "tiered",
    tiers: [
      { upTo: 300, rate: 0.15 },
      { upTo: null, rate: 0.08 },
    ],
    minFee: 0.3,
  },
  "Appliances - Full-size": { type: "flat", rate: 0.08, minFee: 0.3 },
  "Automotive and Powersports": { type: "flat", rate: 0.12, minFee: 0.3 },
  "Base Equipment Power Tools": { type: "flat", rate: 0.12, minFee: 0.3 },
  "Baby Products": { type: "threshold", cutoff: 10, lowRate: 0.08, highRate: 0.15, minFee: 0.3 },
  "Backpacks, Handbags, and Luggage": { type: "flat", rate: 0.15, minFee: 0.3 },
  "Beauty, Health, and Personal Care": { type: "threshold", cutoff: 10, lowRate: 0.08, highRate: 0.15, minFee: 0.3 },
  "Business, Industrial, and Scientific Supplies": { type: "flat", rate: 0.12, minFee: 0.3 },
  "Clothing and Accessories": {
    type: "tiered",
    tiers: [
      { upTo: 15, rate: 0.05 },
      { upTo: 20, rate: 0.1 },
      { upTo: null, rate: 0.17 },
    ],
    minFee: 0.3,
  },
  Computers: { type: "flat", rate: 0.08, minFee: 0.3 },
  "Consumer Electronics": { type: "flat", rate: 0.08, minFee: 0.3 },
  "Electronics Accessories": {
    type: "tiered",
    tiers: [
      { upTo: 100, rate: 0.15 },
      { upTo: null, rate: 0.08 },
    ],
    minFee: 0.3,
  },
  Eyewear: { type: "flat", rate: 0.15, minFee: 0.3 },
  "Fine Art": {
    type: "tiered",
    tiers: [
      { upTo: 100, rate: 0.2 },
      { upTo: 1000, rate: 0.15 },
      { upTo: 5000, rate: 0.1 },
      { upTo: null, rate: 0.05 },
    ],
  },
  Footwear: { type: "flat", rate: 0.15, minFee: 0.3 },
  Furniture: {
    type: "tiered",
    tiers: [
      { upTo: 200, rate: 0.15 },
      { upTo: null, rate: 0.1 },
    ],
    minFee: 0.3,
  },
  "Gift Cards": { type: "flat", rate: 0.2 },
  "Grocery and Gourmet": { type: "threshold", cutoff: 15, lowRate: 0.08, highRate: 0.15 },
  "Home and Kitchen": { type: "flat", rate: 0.15, minFee: 0.3 },
  Jewelry: {
    type: "tiered",
    tiers: [
      { upTo: 250, rate: 0.2 },
      { upTo: null, rate: 0.05 },
    ],
    minFee: 0.3,
  },
  "Lawn and Garden": { type: "flat", rate: 0.15, minFee: 0.3 },
  "Lawn Mowers and Snow Throwers": { type: "threshold", cutoff: 500, lowRate: 0.15, highRate: 0.08, minFee: 0.3 },
  Mattresses: { type: "flat", rate: 0.15, minFee: 0.3 },
  "Media - Books, DVD, Music, Software, Video": { type: "flat", rate: 0.15 },
  "Musical Instruments and AV Production": { type: "flat", rate: 0.15, minFee: 0.3 },
  "Office Products": { type: "flat", rate: 0.15, minFee: 0.3 },
  "Pet Supplies": { type: "flat", rate: 0.15, minFee: 0.3 },
  "Sports and Outdoors": { type: "flat", rate: 0.15, minFee: 0.3 },
  Tires: { type: "flat", rate: 0.1, minFee: 0.3 },
  "Tools and Home Improvement": { type: "flat", rate: 0.15, minFee: 0.3 },
  "Toys and Games": { type: "flat", rate: 0.15, minFee: 0.3 },
  "Video Games and Gaming Accessories": { type: "flat", rate: 0.15 },
  "Video Game Consoles": { type: "flat", rate: 0.08 },
  Watches: {
    type: "tiered",
    tiers: [
      { upTo: 1500, rate: 0.16 },
      { upTo: null, rate: 0.03 },
    ],
    minFee: 0.3,
  },
  "Everything Else": { type: "flat", rate: 0.15, minFee: 0.3 },
};

/** Map Amazon storefront / BSR big-category labels → fee category */
const CATEGORY_ALIASES: Record<string, string> = {
  "sports & outdoors": "Sports and Outdoors",
  "sports and outdoors": "Sports and Outdoors",
  "toys & games": "Toys and Games",
  "toys and games": "Toys and Games",
  "home & kitchen": "Home and Kitchen",
  "home and kitchen": "Home and Kitchen",
  "tools & home improvement": "Tools and Home Improvement",
  "tools and home improvement": "Tools and Home Improvement",
  "lawn & garden": "Lawn and Garden",
  "lawn and garden": "Lawn and Garden",
  "patio, lawn & garden": "Lawn and Garden",
  "baby": "Baby Products",
  "baby products": "Baby Products",
  "beauty & personal care": "Beauty, Health, and Personal Care",
  "health & household": "Beauty, Health, and Personal Care",
  "health and household": "Beauty, Health, and Personal Care",
  "clothing, shoes & jewelry": "Clothing and Accessories",
  "clothing": "Clothing and Accessories",
  "electronics": "Consumer Electronics",
  "cell phones & accessories": "Electronics Accessories",
  "computers & accessories": "Computers",
  "industrial & scientific": "Business, Industrial, and Scientific Supplies",
  "automotive": "Automotive and Powersports",
  "pet supplies": "Pet Supplies",
  "office products": "Office Products",
  "musical instruments": "Musical Instruments and AV Production",
  "furniture": "Furniture",
  "appliances": "Appliances - Compact",
  "video games": "Video Games and Gaming Accessories",
  "books": "Media - Books, DVD, Music, Software, Video",
  "grocery & gourmet food": "Grocery and Gourmet",
};

function normalizeCategoryKey(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function mapRankCategoryToFeeCategory(rankCategory: string | null | undefined): string | null {
  if (!rankCategory?.trim()) return null;
  const raw = rankCategory.trim();
  if (AMAZON_US_REFERRAL_FEES[raw]) return raw;

  const alias = CATEGORY_ALIASES[normalizeCategoryKey(raw)];
  if (alias) return alias;

  // Fuzzy contains match against known fee categories
  const lowered = normalizeCategoryKey(raw);
  const hit = Object.keys(AMAZON_US_REFERRAL_FEES).find(name => {
    const n = normalizeCategoryKey(name);
    return lowered.includes(n) || n.includes(lowered);
  });
  return hit ?? null;
}

export function majorityRankCategory(products: Array<{ rankCategory?: string | null }>): string {
  const counts = new Map<string, number>();
  for (const product of products) {
    const label = product.rankCategory?.trim();
    if (!label || label === "等待同步") continue;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [label, count] of counts) {
    if (count > bestCount) {
      best = label;
      bestCount = count;
    }
  }
  return best || "Sports & Outdoors";
}

function applyMinFee(amount: number, minFee?: number) {
  if (minFee == null) return amount;
  return Math.max(amount, minFee);
}

function computeFeeAmount(rule: ReferralFeeRule, price: number): { fee: number; nominalRate: number } {
  if (rule.type === "flat") {
    return { fee: applyMinFee(price * rule.rate, rule.minFee), nominalRate: rule.rate };
  }

  if (rule.type === "threshold") {
    const rate = price <= rule.cutoff ? rule.lowRate : rule.highRate;
    return { fee: applyMinFee(price * rate, rule.minFee), nominalRate: rate };
  }

  // Marginal tiers (portion-based), matching Amazon compact appliances / furniture style
  let remaining = price;
  let prevCap = 0;
  let fee = 0;
  let lastRate = rule.tiers[0]?.rate ?? 0.15;
  for (const tier of rule.tiers) {
    const cap = tier.upTo;
    const span = cap == null ? remaining : Math.min(remaining, Math.max(0, cap - prevCap));
    if (span > 0) {
      fee += span * tier.rate;
      remaining -= span;
      lastRate = tier.rate;
    }
    if (cap != null) prevCap = cap;
    if (remaining <= 0) break;
  }
  return { fee: applyMinFee(fee, rule.minFee), nominalRate: lastRate };
}

export function formatUsd(amount: number) {
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function parseMoneyInput(raw: string | null | undefined): number | null {
  if (!raw?.trim()) return null;
  const cleaned = raw.replace(/[,$￥]|USD|usd/g, "").replace(/[^\d.]/g, "");
  if (!cleaned) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function rateLabelFromRule(rule: ReferralFeeRule, price: number | null): string {
  if (rule.type === "flat") return `${Math.round(rule.rate * 1000) / 10}%`.replace(/\.0%$/, "%");
  if (rule.type === "threshold") {
    if (price == null) return `≤$${rule.cutoff} ${rule.lowRate * 100}% / >$${rule.cutoff} ${rule.highRate * 100}%`;
    const rate = price <= rule.cutoff ? rule.lowRate : rule.highRate;
    return `${rate * 100}%`;
  }
  if (price == null) {
    return rule.tiers
      .map(tier => (tier.upTo == null ? `${tier.rate * 100}%` : `≤$${tier.upTo} ${tier.rate * 100}%`))
      .join(" / ");
  }
  const { fee } = computeFeeAmount(rule, price);
  const effective = price > 0 ? fee / price : rule.tiers[0]?.rate ?? 0;
  return `${(Math.round(effective * 1000) / 10).toFixed(1).replace(/\.0$/, "")}%`;
}

export function resolveAmazonUsReferralFee(
  rankCategory: string | null | undefined,
  price: number | null = null,
): ResolvedReferralFee {
  const mapped = mapRankCategoryToFeeCategory(rankCategory) ?? "Everything Else";
  const rule = AMAZON_US_REFERRAL_FEES[mapped] ?? AMAZON_US_REFERRAL_FEES["Everything Else"]!;
  const rateLabel = rateLabelFromRule(rule, price);
  const formula =
    rule.type === "flat"
      ? `售价 × ${rateLabelFromRule(rule, null)}`
      : `售价按「${mapped}」类目佣金规则计算`;

  if (price == null) {
    return {
      feeCategory: mapped,
      rankCategory: rankCategory?.trim() || "—",
      rateLabel,
      ratePct: rule.type === "flat" ? rule.rate * 100 : Number(rateLabel.replace("%", "")) || 15,
      fee: null,
      formula,
      note: `匹配费用类目 ${mapped}（来源：竞品 BSR 大类 ${rankCategory || "未识别"}）`,
    };
  }

  const { fee, nominalRate } = computeFeeAmount(rule, price);
  const displayRate =
    rule.type === "flat" ? rateLabelFromRule(rule, null) : `${(Math.round((fee / price) * 1000) / 10).toFixed(1).replace(/\.0$/, "")}%`;

  return {
    feeCategory: mapped,
    rankCategory: rankCategory?.trim() || "—",
    rateLabel: displayRate,
    ratePct: rule.type === "flat" ? rule.rate * 100 : (fee / price) * 100,
    fee,
    formula: rule.type === "flat" ? `售价 × ${displayRate}` : `按 ${mapped} 分段/门槛规则（名义 ${nominalRate * 100}%）`,
    note: `匹配费用类目 ${mapped} · ${formula}`,
  };
}

export function resolveReferralFeeFromProducts(
  products: Array<{ rankCategory?: string | null }>,
  price: number | null = null,
): ResolvedReferralFee {
  const rankCategory = majorityRankCategory(products);
  return resolveAmazonUsReferralFee(rankCategory, price);
}
