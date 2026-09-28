import type {
  SellerSpriteAsinProfit,
  SellerSpriteDistRow,
  SellerSpriteMarketNiche,
} from "./sellersprite-market-niche";

/** 卖家精灵毛利率低于此值视为低毛利、慎入价格带 */
export const LOW_MARGIN_PROFIT_THRESHOLD = 50;
/** 毛利率高于此值自动纳入优先机会；与需求效率同时高才标首选切入 */
export const HIGH_PROFIT_PRIORITY_THRESHOLD = 65;

/** 价格带表格「需求效率」列说明（销量占比 ÷ 链接占比） */
export const DEMAND_EFFICIENCY_FORMULA_NOTE =
  "需求效率 = 该价格带销量占比 ÷ 该价格带链接占比（Top100 样本内）。>1 表示相对链接数更旺销；=1 供需匹配；<1 链接多但卖得少。";

export const DEMAND_EFFICIENCY_FORMULA_SHORT = "销量占比 ÷ 链接占比";

export type ProfitMarginTier = "excellent" | "good" | "medium" | "low" | "caution" | "unknown";

export function isHighProfitPriority(row: PriceBandMetric) {
  return row.avgProfitPct != null && row.avgProfitPct > HIGH_PROFIT_PRIORITY_THRESHOLD;
}

/** 需求效率 ≥1（旺销）或处于类目前 1/3 */
function isHighDemandEfficiency(row: PriceBandMetric, bands: PriceBandMetric[]) {
  if (row.demandEfficiency >= 1) return true;
  const efficiencies = bands.map(band => band.demandEfficiency);
  return percentileRank(row.demandEfficiency, efficiencies) >= 0.66;
}

/** 首选切入：需求效率高 + 毛利率 >65% 同时满足 */
function isPreferredEntryBand(row: PriceBandMetric, bands: PriceBandMetric[]) {
  return isHighProfitPriority(row) && isHighDemandEfficiency(row, bands);
}

/** 卖家精灵毛利率分级解读（与卖家精灵口径一致） */
export function interpretProfitMargin(profitPct: number | null | undefined): {
  tier: ProfitMarginTier;
  label: string;
  shortLabel: string;
} {
  if (profitPct == null || Number.isNaN(profitPct)) {
    return { tier: "unknown", label: "暂无毛利率样本", shortLabel: "待补样本" };
  }
  if (profitPct >= 70) {
    return {
      tier: "excellent",
      label: "平台费用负担低，成本容纳空间较大",
      shortLabel: "成本容纳空间大",
    };
  }
  if (profitPct >= 60) {
    return { tier: "good", label: "毛利空间较好", shortLabel: "毛利空间较好" };
  }
  if (profitPct >= 50) {
    return { tier: "medium", label: "中等，需结合采购和头程", shortLabel: "毛利中等" };
  }
  if (profitPct >= 40) {
    return { tier: "low", label: "毛利空间偏低", shortLabel: "毛利偏低" };
  }
  return {
    tier: "caution",
    label: "平台费用侵蚀明显，需谨慎",
    shortLabel: "低毛利慎入",
  };
}

function buildBandJudgment(row: PriceBandMetric, demandTags: string[]) {
  const profit = interpretProfitMargin(row.avgProfitPct);
  if (profit.tier === "unknown") return "待补样本";
  const parts = [...demandTags];
  if (!parts.includes(profit.shortLabel)) parts.push(profit.shortLabel);
  return parts.join(" · ");
}

export type PriceBandProfitDataStatus = "sufficient" | "insufficient";

export type PriceBandJudgmentResult = {
  text: string;
  kind: "normal" | "excellent_pending_profit" | "pending_verify" | "not_recommended" | "profit_data_insufficient";
};

function computeProfitDataStatus(bands: PriceBandMetric[]) {
  const sampleBandCount = bands.filter(row => row.avgProfitPct != null).length;
  const totalBands = bands.length;
  const coveragePct = totalBands > 0 ? (sampleBandCount / totalBands) * 100 : 0;
  const status: PriceBandProfitDataStatus = coveragePct >= 50 ? "sufficient" : "insufficient";
  return { status, sampleBandCount, totalBands, coveragePct };
}

/** 毛利率缺失时：需求效率、销量均偏弱 */
function isMissingProfitWeakBand(profile: BandRankProfile, _bands: PriceBandMetric[]) {
  if (profile.row.avgProfitPct != null) return false;
  const effWeak = profile.row.demandEfficiency < 0.9 && profile.shareRank < 0.4;
  const salesWeak = profile.unitsRank < 0.4 && profile.avgRank < 0.4;
  return effWeak && salesWeak;
}

/** 毛利率缺失时：需求效率、销量表现好 */
function isMissingProfitStrongBand(profile: BandRankProfile, _bands: PriceBandMetric[]) {
  if (profile.row.avgProfitPct != null) return false;
  const effStrong = profile.row.demandEfficiency >= 1 || profile.shareRank >= 0.55;
  const salesStrong = profile.unitsRank >= 0.5 || profile.avgRank >= 0.5;
  return effStrong && salesStrong;
}

function buildBandJudgmentWithRules(input: {
  row: PriceBandMetric;
  demandTags: string[];
  profile?: BandRankProfile;
  bands: PriceBandMetric[];
  profitDataStatus: PriceBandProfitDataStatus;
}): PriceBandJudgmentResult {
  const { row, demandTags, profile, bands, profitDataStatus } = input;
  const structuralTags = demandTags.filter(tag => tag === "主流成交" || tag === "供给红海");

  if (profitDataStatus === "insufficient") {
    return {
      kind: "profit_data_insufficient",
      text: [...structuralTags, "盈利能力数据不足"].filter(Boolean).join(" · ") || "盈利能力数据不足",
    };
  }

  if (row.avgProfitPct != null) {
    return { kind: "normal", text: buildBandJudgment(row, demandTags) };
  }

  if (profile && isMissingProfitWeakBand(profile, bands)) {
    return {
      kind: "not_recommended",
      text: [...structuralTags, "不建议机会"].join(" · "),
    };
  }

  if (profile && isMissingProfitStrongBand(profile, bands)) {
    const parts = ["优秀机会", "毛利待验证", ...structuralTags];
    return { kind: "excellent_pending_profit", text: parts.join(" · ") };
  }

  return {
    kind: "pending_verify",
    text: [...structuralTags, "待验证"].filter(Boolean).join(" · ") || "待验证",
  };
}

export type PriceBandMetric = {
  label: string;
  priceMid: number;
  products: number;
  units: number;
  unitsShare: number;
  productShare: number;
  avgPerListing: number;
  revenue: number | null;
  revenueShare: number | null;
  demandEfficiency: number;
  asins?: string[];
  /** 价格带内 ASIN 卖家精灵毛利率均值（%） */
  avgProfitPct?: number | null;
  /** 有毛利率样本的 ASIN 数 */
  profitSampleSize?: number;
  /** 卖家精灵毛利率 &lt;50% */
  isLowMargin?: boolean;
  profitTier?: ProfitMarginTier;
  /** 用卖家精灵毛利率倒推的广告前毛利率（%，不含广告/退货） */
  preAdMarginPct?: number;
  /** 采购 + 头程占售价比例（%） */
  productPlusHeadLegPct?: number;
  /** 佣金 + FBA 占售价比例（%） */
  platformFeePct?: number;
  /** 需求 × 毛利综合切入分（0–1） */
  entryScore?: number;
};

export type PriceBandCostModel = {
  productCostRate: number;
  headLegRate: number;
  referralRate: number;
  fbaFeeFixed: number;
  anchorPrice: number;
  anchorMarginPct: number | null;
  source: "calibrated" | "default";
};

export type PriceBandAnalysis = {
  bands: PriceBandMetric[];
  demandBand: PriceBandMetric | null;
  supplyBand: PriceBandMetric | null;
  revenueBand: PriceBandMetric | null;
  redOcean: PriceBandMetric[];
  efficiencyLeaders: PriceBandMetric[];
  /** 销量占比 + 月销 + 链接均销 + 毛利综合得分靠前的价格带 */
  priorityOpportunities: PriceBandMetric[];
  /** 广告前毛利高于中位且需求仍强的验证带 */
  highMarginOpportunities: PriceBandMetric[];
  /** 综合切入分最高的首选价格带 */
  entryBand: PriceBandMetric | null;
  /** 卖家精灵毛利率低于 50% 的慎入价格带 */
  lowMarginBands: PriceBandMetric[];
  costModel: PriceBandCostModel | null;
  medianPreAdMarginPct: number;
  /** @deprecated 使用 priorityOpportunities */
  highPriceOpportunities: PriceBandMetric[];
  medianProducts: number;
  medianAvgPerListing: number;
  medianPriceMid: number;
  medianUnitsShare: number;
  medianUnits: number;
  profitDataStatus: PriceBandProfitDataStatus;
  profitBandCoveragePct: number;
};

/** 常见类目采购成本占售价 */
export const TYPICAL_PRODUCT_COST_RATE = { min: 0.25, mid: 0.3, max: 0.35 };
/** 常见类目头程占售价 */
export const TYPICAL_HEAD_LEG_RATE = { min: 0.07, mid: 0.085, max: 0.1 };
const DEFAULT_REFERRAL_RATE = 0.15;

function normalizeRatio(value: number, max: number) {
  return max > 0 ? value / max : 0;
}

/** 机会分：销量占比 40% + 链接均销 35% + 绝对月销 25% */
export function priceBandOpportunityScore(row: PriceBandMetric, bands: PriceBandMetric[]) {
  const maxShare = Math.max(...bands.map(band => band.unitsShare), 1);
  const maxAvg = Math.max(...bands.map(band => band.avgPerListing), 1);
  const maxUnits = Math.max(...bands.map(band => band.units), 1);
  return (
    normalizeRatio(row.unitsShare, maxShare) * 0.4 +
    normalizeRatio(row.avgPerListing, maxAvg) * 0.35 +
    normalizeRatio(row.units, maxUnits) * 0.25
  );
}

/** 切入分：销量占比 25% + 链接均销 25% + 需求效率 20% + 毛利空间 30%（优先卖家精灵毛利率） */
function bandMarginForScore(row: PriceBandMetric) {
  return row.avgProfitPct ?? row.preAdMarginPct ?? 0;
}

export function priceBandEntryScore(
  row: PriceBandMetric,
  bands: PriceBandMetric[],
  options?: { excludeMargin?: boolean },
) {
  const maxShare = Math.max(...bands.map(band => band.unitsShare), 1);
  const maxAvg = Math.max(...bands.map(band => band.avgPerListing), 1);
  const maxEff = Math.max(...bands.map(band => band.demandEfficiency), 0.01);
  const demandScore =
    normalizeRatio(row.unitsShare, maxShare) * 0.25 +
    normalizeRatio(row.avgPerListing, maxAvg) * 0.25 +
    normalizeRatio(row.demandEfficiency, maxEff) * 0.2;

  const excludeMargin = options?.excludeMargin || row.avgProfitPct == null;
  if (excludeMargin) {
    return demandScore / 0.7;
  }

  const maxMargin = Math.max(...bands.map(band => bandMarginForScore(band)), 0.01);
  return demandScore + normalizeRatio(bandMarginForScore(row), maxMargin) * 0.3;
}

/** 用卖家精灵类目毛利率 + 常见成本占比，倒推各售价的广告前毛利 */
export function buildPriceBandCostModel(niche: SellerSpriteMarketNiche): PriceBandCostModel {
  const productCostRate = TYPICAL_PRODUCT_COST_RATE.mid;
  const headLegRate = TYPICAL_HEAD_LEG_RATE.mid;
  const referralRate = DEFAULT_REFERRAL_RATE;
  const anchorPrice = niche.avgPrice ?? 30;
  const anchorMarginPct = niche.avgProfit;

  let fbaFeeFixed = anchorPrice * 0.12;
  if (anchorMarginPct != null && anchorPrice > 0) {
    const impliedCostRate = 1 - anchorMarginPct / 100;
    const variableRate = productCostRate + headLegRate + referralRate;
    const fbaRateAtAnchor = Math.max(0.05, impliedCostRate - variableRate);
    fbaFeeFixed = fbaRateAtAnchor * anchorPrice;
  }

  return {
    productCostRate,
    headLegRate,
    referralRate,
    fbaFeeFixed,
    anchorPrice,
    anchorMarginPct,
    source: anchorMarginPct != null ? "calibrated" : "default",
  };
}

export function estimatePreAdMarginPct(priceMid: number, model: PriceBandCostModel) {
  if (priceMid <= 0) return 0;
  const platformFeeRate = model.referralRate + model.fbaFeeFixed / priceMid;
  const margin = 1 - model.productCostRate - model.headLegRate - platformFeeRate;
  return Math.max(0, margin * 100);
}

function enrichBandsWithMargin(bands: PriceBandMetric[], niche: SellerSpriteMarketNiche) {
  const costModel = buildPriceBandCostModel(niche);
  for (const band of bands) {
    band.preAdMarginPct = estimatePreAdMarginPct(band.priceMid, costModel);
    band.productPlusHeadLegPct = (costModel.productCostRate + costModel.headLegRate) * 100;
    band.platformFeePct = (costModel.referralRate + costModel.fbaFeeFixed / band.priceMid) * 100;
  }
  return costModel;
}

function enrichBandsWithSellerSpriteProfit(
  bands: PriceBandMetric[],
  prices: SellerSpriteDistRow[],
  asinProfits?: Record<string, SellerSpriteAsinProfit> | null,
) {
  const priceByLabel = new Map(prices.map(row => [row.label, row]));
  for (const band of bands) {
    const priceRow = priceByLabel.get(band.label);
    band.asins = priceRow?.asins ?? [];
    const profits: number[] = [];
    for (const asin of band.asins) {
      const mapped = asinProfits?.[asin]?.profit;
      if (mapped != null) profits.push(mapped);
    }
    if (!profits.length && priceRow?.items?.length) {
      for (const item of priceRow.items) {
        if (item.profit != null) profits.push(item.profit);
      }
    }
    if (profits.length) {
      band.avgProfitPct = profits.reduce((sum, value) => sum + value, 0) / profits.length;
      band.profitSampleSize = profits.length;
      const profit = interpretProfitMargin(band.avgProfitPct);
      band.profitTier = profit.tier;
      band.isLowMargin = band.avgProfitPct < LOW_MARGIN_PROFIT_THRESHOLD;
    }
  }
}

function refreshBandEntryScores(bands: PriceBandMetric[], profitDataStatus: PriceBandProfitDataStatus) {
  const excludeAllMargin = profitDataStatus === "insufficient";
  for (const band of bands) {
    band.entryScore = priceBandEntryScore(band, bands, {
      excludeMargin: excludeAllMargin || band.avgProfitPct == null,
    });
  }
}

type BandRankProfile = {
  row: PriceBandMetric;
  score: number;
  shareRank: number;
  avgRank: number;
  unitsRank: number;
  productRank: number;
};

/** 类目内百分位（0–1），同类目样本自适应，不依赖固定 6%/8% 阈值 */
function percentileRank(value: number, values: number[]) {
  if (values.length <= 1) return 1;
  const less = values.filter(item => item < value).length;
  const equal = values.filter(item => item === value).length;
  return (less + (equal - 1) / 2) / (values.length - 1);
}

function buildBandRankProfiles(bands: PriceBandMetric[]): BandRankProfile[] {
  const shares = bands.map(row => row.unitsShare);
  const avgs = bands.map(row => row.avgPerListing);
  const units = bands.map(row => row.units);
  const products = bands.map(row => row.products);
  return bands.map(row => ({
    row,
    score: row.entryScore ?? priceBandOpportunityScore(row, bands),
    shareRank: percentileRank(row.unitsShare, shares),
    avgRank: percentileRank(row.avgPerListing, avgs),
    unitsRank: percentileRank(row.units, units),
    productRank: percentileRank(row.products, products),
  }));
}

/** 供给红海：链接数偏多 + 均销偏低（相对本类目，不是全市场固定线） */
function isRedOceanTrap(profile: BandRankProfile) {
  return profile.productRank >= 0.66 && profile.avgRank <= 0.34;
}

function pickRedOceanBands(bands: PriceBandMetric[]) {
  return buildBandRankProfiles(bands)
    .filter(isRedOceanTrap)
    .sort((left, right) => right.productRank - left.productRank || left.avgRank - right.avgRank)
    .map(profile => profile.row);
}

function isDemandStrongBand(profile: BandRankProfile, topScore: number) {
  const strongDims = [profile.shareRank, profile.avgRank, profile.unitsRank].filter(rank => rank >= 0.5).length;
  const balancedStrong = strongDims >= 2;
  const nearTopComposite = profile.score >= topScore * 0.68;
  const dualLeader =
    (profile.shareRank >= 0.72 && profile.avgRank >= 0.45) ||
    (profile.avgRank >= 0.72 && profile.shareRank >= 0.45) ||
    (profile.shareRank >= 0.58 && profile.avgRank >= 0.58);
  return balancedStrong || nearTopComposite || dualLeader;
}

function isPriorityOpportunityBand(profile: BandRankProfile, _topScore: number) {
  if (isRedOceanTrap(profile)) return false;
  return isHighProfitPriority(profile.row);
}

/** 需求强但毛利率 ≤65%（或 50–65% 中等毛利）→ 走量验证，不是优先机会 */
function isDemandValidationBand(profile: BandRankProfile, topScore: number) {
  if (isRedOceanTrap(profile)) return false;
  const row = profile.row;
  if (row.avgProfitPct == null) return false;
  if (isHighProfitPriority(row) || row.isLowMargin) return false;
  return isDemandStrongBand(profile, topScore);
}

function isHighMarginBand(
  profile: BandRankProfile,
  medianPriceMid: number,
  medianPreAdMarginPct: number,
  isPriority: boolean,
) {
  const row = profile.row;
  if (row.avgProfitPct != null) {
    if (row.avgProfitPct < 60) return false;
    return isPriority || row.priceMid >= medianPriceMid || row.avgProfitPct >= 70;
  }
  const margin = bandMarginForScore(row);
  if (margin < medianPreAdMarginPct) return false;
  return isPriority || row.priceMid >= medianPriceMid;
}

function pickEntryBand(
  bands: PriceBandMetric[],
  redOcean: PriceBandMetric[],
  _profitDataStatus: PriceBandProfitDataStatus,
) {
  const redSet = new Set(redOcean.map(row => row.label));
  const passesRedOcean = (row: PriceBandMetric) => {
    if (!redSet.has(row.label)) return true;
    return row.avgPerListing >= median(bands.map(item => item.avgPerListing));
  };

  const preferred = bands
    .filter(row => passesRedOcean(row) && !row.isLowMargin && isPreferredEntryBand(row, bands))
    .sort(
      (left, right) =>
        (right.entryScore ?? 0) - (left.entryScore ?? 0) ||
        right.demandEfficiency - left.demandEfficiency ||
        (right.avgProfitPct ?? 0) - (left.avgProfitPct ?? 0),
    );

  return preferred[0] ?? null;
}

function pickPriorityOpportunities(bands: PriceBandMetric[], profitDataStatus: PriceBandProfitDataStatus) {
  if (profitDataStatus === "insufficient") return [];

  const profiles = buildBandRankProfiles(bands);
  return profiles
    .filter(profile => isHighProfitPriority(profile.row) && !isRedOceanTrap(profile))
    .sort(
      (left, right) =>
        (right.row.entryScore ?? 0) - (left.row.entryScore ?? 0) ||
        (right.row.avgProfitPct ?? 0) - (left.row.avgProfitPct ?? 0),
    )
    .map(profile => profile.row);
}

function pickHighMarginOpportunities(
  bands: PriceBandMetric[],
  priorityOpportunities: PriceBandMetric[],
  medianPreAdMarginPct: number,
) {
  const prioritySet = new Set(priorityOpportunities.map(row => row.label));

  return buildBandRankProfiles(bands)
    .filter(profile => {
      const margin = bandMarginForScore(profile.row);
      if (margin < medianPreAdMarginPct) return false;
      return prioritySet.has(profile.row.label) || margin >= medianPreAdMarginPct * 1.04;
    })
    .sort(
      (left, right) =>
        bandMarginForScore(right.row) - bandMarginForScore(left.row) ||
        right.score - left.score,
    )
    .slice(0, 2)
    .map(profile => profile.row);
}

function num(value: number | null | undefined) {
  return value == null || Number.isNaN(value) ? null : value;
}

function pct(value: number | null | undefined, digits = 1) {
  const n = num(value);
  return n == null ? "—" : `${n.toFixed(digits)}%`;
}

function int(value: number | null | undefined) {
  const n = num(value);
  return n == null ? "—" : Math.round(n).toLocaleString("en-US");
}

function money(value: number | null | undefined) {
  const n = num(value);
  return n == null ? "—" : `$${Math.round(n).toLocaleString("en-US")}`;
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function parsePriceMid(label: string) {
  const range = parsePriceRange(label);
  return range?.mid ?? 0;
}

/** 解析价格带区间，用于计算升级跨度 */
export function parsePriceRange(label: string) {
  const cleaned = label.replace(/^\$/, "").trim();
  const range = cleaned.match(/(\d+(?:\.\d+)?)\s*[-–—~]\s*(\d+(?:\.\d+)?)/);
  if (range) {
    const min = Number(range[1]);
    const max = Number(range[2]);
    return { min, max, mid: (min + max) / 2, span: max - min };
  }
  const plus = cleaned.match(/(\d+(?:\.\d+)?)\s*\+/);
  if (plus) {
    const min = Number(plus[1]);
    const span = 10;
    return { min, max: min + span, mid: min + span / 2, span };
  }
  const single = cleaned.match(/(\d+(?:\.\d+)?)/);
  if (single) {
    const min = Number(single[1]);
    return { min, max: min, mid: min, span: 0 };
  }
  return null;
}

/** 相邻价格带升级跨度：下一档下限 − 当前档下限（如 20–30 → 30–40 = +$10） */
function bandUpgradeStep(from: PriceBandMetric, to: PriceBandMetric) {
  const fromRange = parsePriceRange(from.label);
  const toRange = parsePriceRange(to.label);
  if (fromRange && toRange) return Math.max(0, toRange.min - fromRange.min);
  return Math.max(0, Math.round(to.priceMid - from.priceMid));
}

export function buildPriceBandMetrics(prices: SellerSpriteDistRow[]): PriceBandMetric[] {
  const totalProducts = prices.reduce((sum, row) => sum + (row.products ?? 0), 0);
  const totalUnits = prices.reduce((sum, row) => sum + (row.units ?? 0), 0);
  const totalRevenue = prices.reduce((sum, row) => sum + (row.revenue ?? 0), 0);

  return prices
    .map(row => {
      const products = row.products ?? 0;
      const units = row.units ?? 0;
      if (products <= 0) return null;
      const productShare = totalProducts > 0 ? (products / totalProducts) * 100 : 0;
      const unitsShare = row.unitsShare ?? (totalUnits > 0 ? (units / totalUnits) * 100 : 0);
      const revenue = row.revenue ?? null;
      const revenueShare = revenue != null && totalRevenue > 0 ? (revenue / totalRevenue) * 100 : null;
      return {
        label: row.label,
        priceMid: parsePriceMid(row.label),
        products,
        units,
        unitsShare,
        productShare,
        avgPerListing: units / products,
        revenue,
        revenueShare,
        demandEfficiency: productShare > 0 ? unitsShare / productShare : 0,
      };
    })
    .filter((row): row is PriceBandMetric => Boolean(row))
    .sort((left, right) => left.priceMid - right.priceMid);
}

export function analyzePriceBands(
  prices: SellerSpriteDistRow[],
  niche?: SellerSpriteMarketNiche | null,
  asinProfits?: Record<string, SellerSpriteAsinProfit> | null,
): PriceBandAnalysis | null {
  const bands = buildPriceBandMetrics(prices);
  if (bands.length < 2) return null;

  const costModel = niche ? enrichBandsWithMargin(bands, niche) : null;
  enrichBandsWithSellerSpriteProfit(bands, prices, asinProfits);
  const profitMeta = computeProfitDataStatus(bands);
  refreshBandEntryScores(bands, profitMeta.status);

  const medianPreAdMarginPct = median(bands.map(row => bandMarginForScore(row)));

  const medianProducts = median(bands.map(row => row.products));
  const medianAvgPerListing = median(bands.map(row => row.avgPerListing));
  const medianPriceMid = median(bands.map(row => row.priceMid));

  const medianUnitsShare = median(bands.map(row => row.unitsShare));
  const medianUnits = median(bands.map(row => row.units));

  const demandBand = [...bands].sort((left, right) => right.unitsShare - left.unitsShare)[0] ?? null;
  const supplyBand = [...bands].sort((left, right) => right.products - left.products)[0] ?? null;
  const revenueBand =
    bands.some(row => row.revenueShare != null)
      ? [...bands].sort((left, right) => (right.revenueShare ?? 0) - (left.revenueShare ?? 0))[0] ?? null
      : null;

  const redOcean = pickRedOceanBands(bands);

  const profiles = buildBandRankProfiles(bands);
  const efficiencyLeaders = profiles
    .filter(profile => profile.row.unitsShare >= 1 && profile.row.demandEfficiency >= 1)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.row.demandEfficiency - left.row.demandEfficiency,
    )
    .map(profile => profile.row);

  const priorityOpportunities = pickPriorityOpportunities(bands, profitMeta.status);
  const highMarginOpportunities = pickHighMarginOpportunities(
    bands,
    priorityOpportunities,
    medianPreAdMarginPct,
  );
  const entryBand = pickEntryBand(bands, redOcean, profitMeta.status);
  const lowMarginBands = bands.filter(row => row.isLowMargin);

  return {
    bands,
    demandBand,
    supplyBand,
    revenueBand,
    redOcean,
    efficiencyLeaders,
    priorityOpportunities,
    highMarginOpportunities,
    entryBand,
    lowMarginBands,
    costModel,
    medianPreAdMarginPct,
    highPriceOpportunities: priorityOpportunities,
    medianProducts,
    medianAvgPerListing,
    medianPriceMid,
    medianUnitsShare,
    medianUnits,
    profitDataStatus: profitMeta.status,
    profitBandCoveragePct: profitMeta.coveragePct,
  };
}

function formatBandSnapshot(row: PriceBandMetric) {
  const marginLabel =
    row.avgProfitPct != null
      ? ` · 卖家精灵毛利率 ${pct(row.avgProfitPct, 0)}`
      : row.preAdMarginPct != null
        ? ` · 广告前毛利 ${pct(row.preAdMarginPct, 1)}`
        : "";
  return `$${row.label}（${int(row.products)} 链接 · 月销 ${int(row.units)} · 均销 ${int(row.avgPerListing)} 件/链接 · 销量占比 ${pct(row.unitsShare, 1)} · 需求效率 ${row.demandEfficiency.toFixed(2)}${marginLabel}）`;
}

export function buildPriceUpgradePaths(analysis: PriceBandAnalysis) {
  const sorted = [...analysis.bands].sort((left, right) => left.priceMid - right.priceMid);
  const entry = analysis.entryBand ?? analysis.priorityOpportunities[0];
  if (!entry) return [];

  const startIndex = sorted.findIndex(row => row.label === entry.label);
  if (startIndex < 0) return [];

  const paths: string[] = [];
  for (let index = startIndex + 1; index < sorted.length && paths.length < 2; index += 1) {
    const next = sorted[index]!;
    const step = bandUpgradeStep(entry, next);
    if (step <= 0) continue;

    const entryMargin = entry.avgProfitPct ?? entry.preAdMarginPct ?? 0;
    const nextMargin = next.avgProfitPct ?? next.preAdMarginPct ?? 0;
    const marginDelta = nextMargin - entryMargin;
    const entryMarginText = formatBandMarginText(entry);
    const nextMarginText = formatBandMarginText(next);

    let upgradeHint =
      next.demandEfficiency >= 1
        ? "需求效率可承接，适合配置/材质升级"
        : next.unitsShare >= 8
          ? "有销量基础，需用功能差异支撑溢价"
          : "高价带需求偏弱，建议小批量验证";
    if (marginDelta < 1.2) {
      upgradeHint = `毛利提升有限（+${marginDelta.toFixed(1)}pp），${upgradeHint}`;
    }

    paths.push(
      `切入 $${entry.label}（${entryMarginText}，均销 ${int(entry.avgPerListing)} 件，效率 ${entry.demandEfficiency.toFixed(2)}）→ 升级 $${next.label}：+$${Math.round(step)} 售价跨度，${nextMarginText}${marginDelta >= 0.1 ? `（+${marginDelta.toFixed(1)}pp）` : ""}，${upgradeHint}。`,
    );
  }
  return paths;
}

/** 合并原「数据表现」与「机会点分析」，按条列出（上方已有价格带明细表，不再逐段复述） */
export function buildPricePerformanceBullets(analysis: PriceBandAnalysis, niche: SellerSpriteMarketNiche) {
  const lines: string[] = [
    `样本基准：中位链接数 ${int(analysis.medianProducts)}、中位链接均销 ${int(analysis.medianAvgPerListing)} 件/链接；市场均价 ${money(niche.avgPrice)}，卖家精灵毛利率 ${pct(niche.avgProfit, 1)}。`,
  ];

  if (analysis.costModel) {
    const model = analysis.costModel;
    lines.push(
      `成本倒推口径：采购 ${pct(model.productCostRate * 100, 0)}（常见 ${pct(TYPICAL_PRODUCT_COST_RATE.min * 100, 0)}–${pct(TYPICAL_PRODUCT_COST_RATE.max * 100, 0)}）+ 头程 ${pct(model.headLegRate * 100, 1)}（常见 ${pct(TYPICAL_HEAD_LEG_RATE.min * 100, 0)}–${pct(TYPICAL_HEAD_LEG_RATE.max * 100, 0)}）+ 佣金 ${pct(model.referralRate * 100, 0)} + FBA ${money(model.fbaFeeFixed)}（按类目毛利率 ${pct(model.anchorMarginPct, 1)} @ ${money(model.anchorPrice)} 校准）；不含广告与退货。`,
    );
  }

  if (analysis.entryBand) {
    const marginText =
      analysis.entryBand.avgProfitPct != null
        ? `卖家精灵毛利率 ${pct(analysis.entryBand.avgProfitPct, 0)}`
        : `广告前毛利约 ${pct(analysis.entryBand.preAdMarginPct, 1)}`;
    lines.push(
      `首选切入带 $${analysis.entryBand.label}：售价中位 ${money(analysis.entryBand.priceMid)}，${marginText}，销量占比 ${pct(analysis.entryBand.unitsShare, 1)}，链接均销 ${int(analysis.entryBand.avgPerListing)} 件，需求效率 ${analysis.entryBand.demandEfficiency.toFixed(2)}。`,
    );
  }

  if (analysis.lowMarginBands.length) {
    lines.push(
      `低毛利慎入带（毛利率 <${LOW_MARGIN_PROFIT_THRESHOLD}%）：${analysis.lowMarginBands
        .slice(0, 4)
        .map(row => {
          const profit = interpretProfitMargin(row.avgProfitPct);
          return `$${row.label}（${pct(row.avgProfitPct, 0)}，${profit.label}）`;
        })
        .join("；")}。`,
    );
  }

  if (analysis.demandBand && analysis.demandBand.label !== analysis.entryBand?.label) {
    lines.push(`主流成交带 ${formatBandSnapshot(analysis.demandBand)}。`);
  }

  if (analysis.supplyBand && analysis.supplyBand.label !== analysis.demandBand?.label) {
    lines.push(
      `供给红海带 $${analysis.supplyBand.label}：${int(analysis.supplyBand.products)} 链接、链接均销 ${int(analysis.supplyBand.avgPerListing)} 件/链接——链接数最多但单链接产出偏低。`,
    );
  }

  if (analysis.priorityOpportunities.length) {
    lines.push(
      `优先机会带：${analysis.priorityOpportunities
        .slice(0, 3)
        .map(row => formatBandSnapshot(row))
        .join("；")}——销量占比、链接均销、需求效率与广告前毛利综合偏强。`,
    );
  }

  if (analysis.highMarginOpportunities.length) {
    lines.push(
      `高毛利验证带：${analysis.highMarginOpportunities
        .slice(0, 2)
        .map(
          row =>
            `$${row.label}（广告前毛利 ${pct(row.preAdMarginPct, 1)}，均销 ${int(row.avgPerListing)} 件，销量占比 ${pct(row.unitsShare, 1)}）`,
        )
        .join("；")}——售价更高且毛利空间仍可观，适合高配置方案。`,
    );
  } else if (!analysis.priorityOpportunities.length && analysis.efficiencyLeaders.length) {
    lines.push(
      `需求效率更高：${analysis.efficiencyLeaders
        .slice(0, 2)
        .map(row => `$${row.label}（效率 ${row.demandEfficiency.toFixed(2)}，均销 ${int(row.avgPerListing)} 件/链接）`)
        .join("；")}。`,
    );
  }

  const upgradePaths = buildPriceUpgradePaths(analysis);
  if (upgradePaths.length) {
    lines.push(`升级路径：${upgradePaths.join("")}`);
  }

  if (analysis.revenueBand?.revenueShare != null && analysis.revenueBand.label !== analysis.demandBand?.label) {
    lines.push(`销额最集中：$${analysis.revenueBand.label}（销额占比 ${pct(analysis.revenueBand.revenueShare, 1)}）。`);
  }

  if (analysis.redOcean[0]) {
    lines.push(
      `需避开：$${analysis.redOcean[0].label} 等链接密集且均销偏低价格段（${int(analysis.redOcean[0].products)} 链接，均销 ${int(analysis.redOcean[0].avgPerListing)} 件/链接）。`,
    );
  }

  if (!analysis.priorityOpportunities.length && !analysis.highMarginOpportunities.length && !analysis.entryBand) {
    lines.push("当前样本未看到需求与毛利同时突出的价格带，可先在主流成交带做差异化。");
  }

  return lines;
}

function formatBandMarginText(row: PriceBandMetric) {
  if (row.avgProfitPct != null) return `卖家精灵毛利率 ${pct(row.avgProfitPct, 0)}`;
  return `广告前毛利约 ${pct(row.preAdMarginPct, 1)}`;
}

const PRICE_PERFORMANCE_META_PREFIXES = ["样本基准", "成本倒推口径"];
const PRICE_PERFORMANCE_SKIP_IN_CONCLUSION = ["升级路径："];
const PRICE_INTERPRETIVE_SUFFIX = /——.+$/;

function stripInterpretiveSuffix(line: string) {
  return line.replace(PRICE_INTERPRETIVE_SUFFIX, "").trim();
}

/** 从「数据表现」提炼结论：只用上方已列出的指标，不另算或附加解读 */
export function buildPriceOpportunityConclusion(
  analysis: PriceBandAnalysis,
  niche?: SellerSpriteMarketNiche | null,
): string {
  const lines: string[] = [];

  if (analysis.profitDataStatus === "insufficient") {
    const withProfit = analysis.bands.filter(row => row.avgProfitPct != null).length;
    lines.push(
      `毛利率样本覆盖 ${pct(analysis.profitBandCoveragePct, 0)}（${withProfit}/${analysis.bands.length} 个价格带），整体标记「盈利能力数据不足」。`,
    );
  }

  if (niche) {
    lines.push(
      ...buildPricePerformanceBullets(analysis, niche)
        .filter(
          line =>
            !PRICE_PERFORMANCE_META_PREFIXES.some(prefix => line.startsWith(prefix)) &&
            !PRICE_PERFORMANCE_SKIP_IN_CONCLUSION.some(prefix => line.startsWith(prefix)) &&
            line !== "当前样本未看到需求与毛利同时突出的价格带，可先在主流成交带做差异化。",
        )
        .map(stripInterpretiveSuffix)
        .filter(Boolean),
    );
  } else if (analysis.entryBand) {
    lines.push(`首选切入 ${formatBandSnapshot(analysis.entryBand)}。`);
    if (analysis.demandBand && analysis.demandBand.label !== analysis.entryBand.label) {
      lines.push(`主流成交 ${formatBandSnapshot(analysis.demandBand)}。`);
    }
    if (analysis.supplyBand && analysis.supplyBand.label !== analysis.demandBand?.label) {
      lines.push(
        `供给红海 $${analysis.supplyBand.label}（${int(analysis.supplyBand.products)} 链接 · 均销 ${int(analysis.supplyBand.avgPerListing)} 件/链接）。`,
      );
    }
  }

  return lines.join("\n");
}

/** 总览「最大机会」首条价格相关文案，与数据表现首选切入带同源 */
export function buildPriceOpportunityHeadline(
  analysis: PriceBandAnalysis,
  niche?: SellerSpriteMarketNiche | null,
): string | null {
  if (!analysis.entryBand) return null;
  if (niche) {
    const line = buildPricePerformanceBullets(analysis, niche).find(item => item.startsWith("首选切入带"));
    if (line) return stripInterpretiveSuffix(line.replace("首选切入带", "首选切入"));
  }
  return `首选切入 ${formatBandSnapshot(analysis.entryBand)}。`;
}

export function formatPriceBandTableRows(analysis: PriceBandAnalysis) {
  const { profitDataStatus } = analysis;
  const profiles = buildBandRankProfiles(analysis.bands);
  const topScore = Math.max(...profiles.map(profile => profile.score), 0.001);
  const profileByLabel = new Map(profiles.map(profile => [profile.row.label, profile]));
  const prioritySet = new Set(analysis.priorityOpportunities.map(row => row.label));
  const entryLabel = analysis.entryBand?.label;

  return analysis.bands.map(row => {
    const profile = profileByLabel.get(row.label);
    const hasProfitSample = row.avgProfitPct != null;
    const tags: string[] = [];

    if (row.label === analysis.demandBand?.label) tags.push("主流成交");
    if (analysis.redOcean.some(item => item.label === row.label)) tags.push("供给红海");

    if (profitDataStatus === "sufficient" && hasProfitSample) {
      const isPriority = profile
        ? isPriorityOpportunityBand(profile, topScore)
        : prioritySet.has(row.label);
      const isDemandValidation = profile ? isDemandValidationBand(profile, topScore) : false;

      if (row.label === entryLabel && isPreferredEntryBand(row, analysis.bands)) tags.push("首选切入");
      if (isPriority) {
        if (!tags.includes("优先机会")) tags.push("优先机会");
      } else if (isDemandValidation) {
        if (!tags.includes("需求验证")) tags.push("需求验证");
      }
      if (isHighProfitPriority(row) && !tags.includes("高毛利带")) tags.push("高毛利带");
    }

    const judgmentResult = buildBandJudgmentWithRules({
      row,
      demandTags: tags,
      profile,
      bands: analysis.bands,
      profitDataStatus,
    });
    const profit = interpretProfitMargin(row.avgProfitPct);

    return {
      label: row.label,
      priceMid: money(row.priceMid),
      products: int(row.products),
      units: int(row.units),
      avgPerListing: int(row.avgPerListing),
      unitsShare: pct(row.unitsShare, 1),
      productShare: pct(row.productShare, 1),
      demandEfficiency: row.demandEfficiency.toFixed(2),
      avgProfitPct: row.avgProfitPct != null ? pct(row.avgProfitPct, 0) : "—",
      productPlusHeadLegPct: row.productPlusHeadLegPct != null ? pct(row.productPlusHeadLegPct, 1) : "—",
      preAdMarginPct: row.preAdMarginPct != null ? pct(row.preAdMarginPct, 1) : "—",
      tag: judgmentResult.text,
      judgmentKind: judgmentResult.kind,
      profitTier: profit.tier,
      profitHint:
        judgmentResult.kind === "excellent_pending_profit"
          ? "需求与销量表现好，但暂无毛利率样本，需补充 ASIN 数据验证"
          : judgmentResult.kind === "profit_data_insufficient"
            ? "类目大部分价格带缺少毛利率，暂不基于毛利判断"
            : hasProfitSample
              ? profit.label
              : "暂无毛利率样本，需补充 ASIN 数据后再判断",
      isLowMargin: hasProfitSample && (profit.tier === "low" || profit.tier === "caution"),
      isPendingSample: !hasProfitSample,
      isPendingProfitVerify: judgmentResult.kind === "excellent_pending_profit",
      isPendingVerify: judgmentResult.kind === "pending_verify",
      isNotRecommended: judgmentResult.kind === "not_recommended",
      isProfitDataInsufficient: judgmentResult.kind === "profit_data_insufficient",
      demandTags: tags,
    };
  });
}

export function buildPriceDistributionAnalysis(
  prices: SellerSpriteDistRow[],
  niche: SellerSpriteMarketNiche,
  asinProfits?: Record<string, SellerSpriteAsinProfit> | null,
) {
  const analysis = analyzePriceBands(prices, niche, asinProfits);
  if (!analysis) return null;

  const performance = buildPricePerformanceBullets(analysis, niche).join("\n");

  const meaning = [
    "价格带判断 = 需求标签（销量占比、链接均销、需求效率）+ 卖家精灵毛利率解读。",
    "毛利率分级：≥70% 成本容纳空间大；60–70% 毛利较好；50–60% 中等需结合采购头程；40–50% 偏低；<40% 平台费用侵蚀明显需谨慎。",
    `毛利率有值时正常参与评分；>${HIGH_PROFIT_PRIORITY_THRESHOLD}% 才标「优先机会」；需求效率 ≥1 且毛利率 >${HIGH_PROFIT_PRIORITY_THRESHOLD}% 才标「首选切入」；50–65% 且需求强标「需求验证」。`,
    "毛利率缺失时不计毛利分：需求/销量强 →「优秀机会 · 毛利待验证」；一般 →「待验证」；均弱 →「不建议机会」。",
    "同一类目 ≥50% 价格带有毛利率样本才做毛利判断；否则整体标「盈利能力数据不足」。",
  ].join("");

  const conclusion = buildPriceOpportunityConclusion(analysis, niche);

  return {
    analysis,
    performance,
    meaning,
    conclusion,
  };
}

export function buildSynthesisPriceOpportunityText(
  prices: SellerSpriteDistRow[],
  niche: SellerSpriteMarketNiche,
  asinProfits?: Record<string, SellerSpriteAsinProfit> | null,
  analysisInput?: PriceBandAnalysis | null,
) {
  const analysis = analysisInput ?? analyzePriceBands(prices, niche, asinProfits);
  if (!analysis) {
    return `市场均价 ${money(niche.avgPrice)}，新品均价 ${money(niche.newAvgPrice)}；需结合竞品定价与链接均销进一步确认切入带。`;
  }
  return buildPriceOpportunityConclusion(analysis, niche);
}
