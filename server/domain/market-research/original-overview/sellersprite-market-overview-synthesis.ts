import {
  analyzePriceBands,
  buildPriceOpportunityHeadline,
  buildSynthesisPriceOpportunityText,
} from "./sellersprite-market-price-analysis";
import type {
  SellerSpriteDistRow,
  SellerSpriteMarketNiche,
  SellerSpriteMarketReport,
  SellerSpriteTrendPoint,
} from "./sellersprite-market-niche";

export const MARKET_SYNTHESIS_VERSION = 6;

/** 近 6 个月新品占比超过此值，视为仍有新品进入窗口 */
const NEW_PRODUCT_MATURITY_THRESHOLD = 10;

export type MarketOpportunityGrade =
  | "极高机会"
  | "高机会"
  | "良好机会"
  | "一般机会"
  | "谨慎机会"
  | "低机会";

export type MarketEntryRecommendation =
  | "重点准入"
  | "优先准入"
  | "建议准入"
  | "可评估准入"
  | "谨慎准入"
  | "不建议准入";

/** 雷达图与下方 6 段分析共用同一套维度定义 */
export const MARKET_SYNTHESIS_DIMENSIONS = [
  { key: "marketDemand", label: "市场需求", max: 25, sectionKey: "demand" },
  { key: "marketCompetition", label: "市场竞争", max: 20, sectionKey: "competition" },
  { key: "marketMaturity", label: "市场成熟度", max: 10, sectionKey: "maturity" },
  { key: "newEntryBarrier", label: "新品进入难度", max: 15, sectionKey: "newEntry" },
  { key: "productOpportunity", label: "产品机会", max: 15, sectionKey: "productOpportunity" },
  { key: "priceOpportunity", label: "价格机会", max: 15, sectionKey: "priceOpportunity" },
] as const;

export type MarketSynthesisDimensionKey = (typeof MARKET_SYNTHESIS_DIMENSIONS)[number]["key"];
export type MarketSynthesisSectionKey = (typeof MARKET_SYNTHESIS_DIMENSIONS)[number]["sectionKey"];

export type MarketSynthesisScores = Record<MarketSynthesisDimensionKey, number>;

export type MarketOverviewSynthesis = {
  version: number;
  score: number;
  grade: MarketOpportunityGrade;
  gradeLabel: MarketEntryRecommendation;
  gradeDefinition: string;
  scores: MarketSynthesisScores;
  sections: {
    demand: string;
    competition: string;
    maturity: string;
    newEntry: string;
    productOpportunity: string;
    priceOpportunity: string;
  };
  topOpportunities: string[];
  topRisks: string[];
  finalVerdict: string;
  crossSignals: string[];
};

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

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function dropIncompleteMonth(points: SellerSpriteTrendPoint[]) {
  if (points.length < 3) return points;
  const last = points.at(-1);
  const prev = points.at(-2);
  if (!last || !prev || prev.value <= 0) return points;
  if (last.value < prev.value * 0.4) return points.slice(0, -1);
  return points;
}

function yoyChange(points: SellerSpriteTrendPoint[]) {
  const latest = points.at(-1);
  if (!latest) return null;
  const [year, month] = latest.month.split("-").map(Number);
  if (!year || !month) return null;
  const prior = points.find(point => point.month === `${year - 1}-${String(month).padStart(2, "0")}`);
  if (!prior || !prior.value) return null;
  return { latest, prior, change: ((latest.value - prior.value) / prior.value) * 100 };
}

function trendDirection(points: SellerSpriteTrendPoint[]): "up" | "flat" | "down" | "unknown" {
  const clean = dropIncompleteMonth(points);
  if (clean.length < 6) return "unknown";
  const recent = clean.slice(-6);
  const prior = clean.slice(-12, -6);
  if (prior.length < 3) return "unknown";
  const recentAvg = recent.reduce((sum, point) => sum + point.value, 0) / recent.length;
  const priorAvg = prior.reduce((sum, point) => sum + point.value, 0) / prior.length;
  if (priorAvg <= 0) return "unknown";
  const change = (recentAvg - priorAvg) / priorAvg;
  if (change > 0.05) return "up";
  if (change < -0.05) return "down";
  return "flat";
}

function aggregateKeywordTrend(pointsList: SellerSpriteTrendPoint[][]) {
  const map = new Map<string, number>();
  for (const points of pointsList) {
    for (const point of points) {
      map.set(point.month, (map.get(point.month) ?? 0) + point.value);
    }
  }
  return [...map.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([month, value]) => ({ month, value }));
}

function crnTier(share: number | null | undefined) {
  const n = num(share);
  if (n == null) return "unknown" as const;
  if (n < 40) return "low" as const;
  if (n < 55) return "mid" as const;
  return "high" as const;
}

function scoreFromCrn(share: number | null | undefined, weight: number) {
  const tier = crnTier(share);
  if (tier === "low") return weight;
  if (tier === "mid") return weight * 0.65;
  if (tier === "high") return weight * 0.3;
  return weight * 0.5;
}

function findRow(rows: SellerSpriteDistRow[], testers: Array<(label: string) => boolean>) {
  return rows.find(row => testers.some(test => test(row.label))) ?? null;
}

function shareOf(rows: SellerSpriteDistRow[], match: (label: string) => boolean, key: "unitsShare" | "asinRatio" = "unitsShare") {
  return rows.filter(row => match(row.label)).reduce((sum, row) => sum + (row[key] ?? 0), 0);
}

const EBC_SLICE_LABELS = ["有A+有视频", "有A+无视频", "无A+有视频", "无A+无视频"] as const;

function ebcSliceRow(rows: SellerSpriteDistRow[], label: string) {
  return rows.find(row => row.label === label && !row.label.startsWith("新品"));
}

/** A+ / 视频链接占比（与 A+视频分布模块四档口径一致，避免重复累加出 200%） */
function computeEbcCoverage(ebc: SellerSpriteDistRow[], niche: SellerSpriteMarketNiche) {
  const slices = EBC_SLICE_LABELS.map(label => ebcSliceRow(ebc, label)).filter(
    (row): row is SellerSpriteDistRow => Boolean(row),
  );
  const totalProducts = slices.reduce((sum, row) => sum + (row.products ?? 0), 0);
  const bothRow = ebcSliceRow(ebc, "有A+有视频");
  const noAplusVideoRow = ebcSliceRow(ebc, "无A+有视频");
  const aplusNoVideoRow = ebcSliceRow(ebc, "有A+无视频");
  const withAplusProducts = (bothRow?.products ?? 0) + (aplusNoVideoRow?.products ?? 0);
  const withVideoProducts = (bothRow?.products ?? 0) + (noAplusVideoRow?.products ?? 0);
  const aplusCoverage =
    niche.ebcProportion ?? (totalProducts > 0 ? (withAplusProducts / totalProducts) * 100 : null);
  const videoCoverage = totalProducts > 0 ? (withVideoProducts / totalProducts) * 100 : null;
  return { aplusCoverage, videoCoverage };
}

function buildNewEntrySectionText(input: {
  newRatio: number;
  newSalesEfficiency: number | null;
  lowReviewShare: number;
  highReviewShare: number;
  niche: SellerSpriteMarketNiche;
  aplusCoverage: number | null;
  videoCoverage: number | null;
}) {
  const { newRatio, newSalesEfficiency, lowReviewShare, highReviewShare, niche, aplusCoverage, videoCoverage } =
    input;

  const contentParts: string[] = [];
  if (aplusCoverage != null && videoCoverage != null) {
    const aplusLow = aplusCoverage < 50;
    const videoLow = videoCoverage < 50;
    if (aplusLow && videoLow) {
      contentParts.push(
        `A+ 覆盖 ${pct(aplusCoverage, 0)}、视频覆盖 ${pct(videoCoverage, 0)} 均低于 50%，Listing 内容配置尚未饱和，对新品友好`,
      );
    } else if (aplusLow) {
      contentParts.push(
        `A+ 覆盖 ${pct(aplusCoverage, 0)} 低于 50%，A+ 仍是新品可补位的切入点；视频覆盖 ${pct(videoCoverage, 0)}`,
      );
    } else if (videoLow) {
      contentParts.push(
        `视频覆盖 ${pct(videoCoverage, 0)} 低于 50%，视频内容对新品仍相对友好；A+ 覆盖 ${pct(aplusCoverage, 0)}`,
      );
    } else {
      contentParts.push(
        `A+ 覆盖 ${pct(aplusCoverage, 0)}、视频覆盖 ${pct(videoCoverage, 0)} 均已超 50%，内容配置已成基础门槛`,
      );
    }
  } else if (aplusCoverage != null) {
    contentParts.push(
      aplusCoverage < 50
        ? `A+ 覆盖 ${pct(aplusCoverage, 0)} 低于 50%，对新品相对友好`
        : `A+ 覆盖 ${pct(aplusCoverage, 0)} 已超 50%，需重视 Listing 内容质量`,
    );
  }

  let demandPart = "";
  if (newRatio >= 15 && (newSalesEfficiency ?? 0) >= 0.5) {
    demandPart = `新品占比 ${pct(newRatio, 0)} 且均销达到样本均销的 ${newSalesEfficiency != null ? `${Math.round(newSalesEfficiency * 100)}%` : "—"}，属于新品友好信号；Review＜300 区间销量占比约 ${pct(lowReviewShare, 1)}，${lowReviewShare >= 10 ? "低 Review 仍能分到量" : "Review 门槛仍偏高"}`;
  } else if (newRatio >= 8) {
    demandPart = `新品占比 ${pct(newRatio, 0)}，但新品均销 ${int(niche.newAvgUnits)} 仅为样本均销 ${int(niche.avgUnits)} 的 ${newSalesEfficiency != null ? `${Math.round(newSalesEfficiency * 100)}%` : "—"}；500+ Review 区间占销量 ${pct(highReviewShare, 1)}，进入需预留评论积累周期`;
  } else {
    demandPart = `新品占比 ${pct(newRatio, 0)} 偏低，且高 Review 商品占销量 ${pct(highReviewShare, 1)}；新链接更难快速进入主流成交带`;
  }

  return [...contentParts, demandPart].filter(Boolean).join("；") + "。";
}

function demandSalesCross(
  demandDir: "up" | "flat" | "down" | "unknown",
  salesDir: "up" | "flat" | "down" | "unknown",
) {
  if (demandDir === "up" && salesDir === "up") return "强增长市场";
  if (demandDir === "up" && salesDir === "flat") return "需求增长但转化尚未完全释放";
  if (demandDir === "flat" && salesDir === "up") return "成交抬升，可能存在客单价或产品升级";
  if (demandDir === "down" && salesDir === "down") return "衰退市场";
  if (demandDir === "unknown" || salesDir === "unknown") return "需求与成交联动信号不完整";
  return "需求与成交同步性一般";
}

function tripleCrnLabel(product: number | null, brand: number | null, seller: number | null) {
  const tiers = [crnTier(product), crnTier(brand), crnTier(seller)];
  const highCount = tiers.filter(tier => tier === "high").length;
  const lowCount = tiers.filter(tier => tier === "low").length;
  if (highCount === 3) return "高度垄断市场，进入难度高";
  if (highCount >= 2) return "强竞争市场，头部优势明显";
  if (lowCount === 3) return "碎片化市场，进入相对友好";
  if (highCount === 1) return "局部头部市场，仍可寻找细分机会";
  return "中等竞争市场，需靠差异化和价格带错位";
}

function gradeFromScore(score: number): Pick<MarketOverviewSynthesis, "grade" | "gradeLabel" | "gradeDefinition"> {
  if (score >= 80) {
    return {
      grade: "极高机会",
      gradeLabel: "重点准入",
      gradeDefinition:
        "市场需求、增长、竞争、利润与新品机会整体表现优秀，属于重点开发市场，可优先投入产品、供应链与运营资源。",
    };
  }
  if (score >= 70) {
    return {
      grade: "高机会",
      gradeLabel: "优先准入",
      gradeDefinition:
        "市场需求强、趋势较好，同时存在竞争空档或产品升级机会，值得优先安排开发资源。",
    };
  }
  if (score >= 60) {
    return {
      grade: "良好机会",
      gradeLabel: "建议准入",
      gradeDefinition:
        "市场需求与经营空间较好，竞争强度相对可接受，存在明确产品切入机会，可进入产品定义阶段。",
    };
  }
  if (score >= 50) {
    return {
      grade: "一般机会",
      gradeLabel: "可评估准入",
      gradeDefinition:
        "市场基本符合进入条件，但机会不够突出，需进一步结合 VOC、关键词需求与竞品短板确认切入点。",
    };
  }
  if (score >= 40) {
    return {
      grade: "谨慎机会",
      gradeLabel: "谨慎准入",
      gradeDefinition:
        "存在一定市场需求，但竞争、利润或增长空间不足，仅建议在有明显产品差异化或供应链优势时进入。",
    };
  }
  return {
    grade: "低机会",
    gradeLabel: "不建议准入",
    gradeDefinition: "市场需求、增长、竞争或利润等核心指标存在明显短板，进入后成功概率较低。",
  };
}

export function buildMarketOverviewSynthesis(
  niche: SellerSpriteMarketNiche,
  report: SellerSpriteMarketReport | null,
): MarketOverviewSynthesis {
  const keywords = report?.keywordTrends ?? [];
  const sales = dropIncompleteMonth(report?.salesTrend ?? []);
  const amount = dropIncompleteMonth(report?.salesAmountTrend ?? []);
  const views = dropIncompleteMonth(report?.productDemand?.pageViews ?? []);
  const prices = report?.prices ?? [];
  const listingAge = report?.listingAge ?? [];
  const ratingCounts = report?.ratingCounts ?? [];
  const ratingValues = report?.ratingValues ?? [];
  const ebc = report?.ebc ?? [];

  const keywordAggregate = aggregateKeywordTrend(keywords.map(item => item.points));
  const keywordDir = trendDirection(keywordAggregate);
  const salesDir = trendDirection(sales);
  const viewsDir = trendDirection(views);
  const salesYoy = yoyChange(sales);
  const keywordYoy = yoyChange(keywordAggregate);

  const totalUnits = niche.totalUnits ?? 0;
  const topKeywordSearches = keywords.reduce((sum, item) => sum + (item.searches ?? 0), 0);
  const productCrn = niche.productCrn;
  const brandCrn = niche.brandCrn;
  const sellerCrn = niche.sellerCrn;

  const demandCross = demandSalesCross(keywordDir, salesDir);
  const tripleCrn = tripleCrnLabel(productCrn, brandCrn, sellerCrn);

  const oldListing = findRow(listingAge, [label => /3年以上|36|三年以上/.test(label)]);
  const youngListingShare = shareOf(
    listingAge,
    label => /1个月|3个月|半年|1年$|12个月|一年内|1年以内|0-6|6-12/.test(label),
  );
  const highReviewShare = shareOf(ratingCounts, label => /500|1000|以上/.test(label) && !/1-50|50-100|100-200|200-300|300-500/.test(label));
  const lowReviewShare = shareOf(ratingCounts, label => /1-50|50-100|100-300|<50|＜50/.test(label));
  const midLowRatingShare = shareOf(ratingValues, label => /4\.0|4\.1|4\.2|4\.3|＜4/.test(label));

  const newRatio = niche.newRatio ?? 0;
  const newSalesEfficiency =
    niche.newAvgUnits != null && niche.avgUnits != null && niche.avgUnits > 0
      ? niche.newAvgUnits / niche.avgUnits
      : null;

  const priceAnalysis = analyzePriceBands(prices, niche, report?.asinProfits);
  const { aplusCoverage, videoCoverage } = computeEbcCoverage(ebc, niche);

  const amountYoy = yoyChange(amount);
  const priceUpgrade =
    salesYoy != null && amountYoy != null && amountYoy.change > salesYoy.change + 3
      ? "销售额增速快于销量，客单价或高价值带在抬升"
      : salesYoy != null && amountYoy != null && salesYoy.change > amountYoy.change + 3
        ? "销量增速快于销售额，低价带或降价竞争在加剧"
        : null;

  const supplyGrowth = newRatio;
  const demandGrowth =
    keywordYoy?.change ?? salesYoy?.change ?? (keywordDir === "up" ? 8 : keywordDir === "down" ? -8 : 0);
  const supplyDemandSignal =
    demandGrowth > supplyGrowth + 5
      ? "需求扩张速度高于新增供给，机会在增强"
      : supplyGrowth > demandGrowth + 5
        ? "新增商品增速快于需求，未来竞争可能加剧"
        : "供需增速大致同步";

  const crossSignals = [
    `需求×销售：${demandCross}${salesYoy != null ? `（样本月销同比 ${salesYoy.change >= 0 ? "+" : ""}${salesYoy.change.toFixed(1)}%）` : ""}`,
    `三大集中度：${tripleCrn}`,
    supplyDemandSignal,
    priceUpgrade,
  ].filter((item): item is string => Boolean(item));

  let demandScore = 0;
  if (totalUnits >= 100_000) demandScore += 10;
  else if (totalUnits >= 50_000) demandScore += 8;
  else if (totalUnits >= 20_000) demandScore += 6;
  else if (totalUnits >= 5_000) demandScore += 4;
  else demandScore += 2;
  if (topKeywordSearches >= 200_000) demandScore += 6;
  else if (topKeywordSearches >= 80_000) demandScore += 4;
  else if (topKeywordSearches >= 20_000) demandScore += 2;
  if (keywordDir !== "down" && salesDir !== "down") demandScore += 4;
  demandScore = clamp(demandScore, 0, 20);

  let growthScore = 0;
  if (keywordDir === "up") growthScore += 6;
  else if (keywordDir === "flat") growthScore += 3;
  if (salesDir === "up") growthScore += 6;
  else if (salesDir === "flat") growthScore += 3;
  if (viewsDir === "up") growthScore += 4;
  else if (viewsDir === "flat") growthScore += 2;
  if (salesYoy != null) {
    if (salesYoy.change >= 10) growthScore += 4;
    else if (salesYoy.change >= 0) growthScore += 2;
    else growthScore -= 3;
  }
  growthScore = clamp(growthScore, 0, 20);

  const competitionScore = clamp(
    (scoreFromCrn(productCrn, 7) + scoreFromCrn(brandCrn, 7) + scoreFromCrn(sellerCrn, 6)) * 1,
    0,
    20,
  );

  let newEntryScore = 0;
  if (newRatio >= 20) newEntryScore += 4;
  else if (newRatio >= 12) newEntryScore += 3;
  else if (newRatio >= 6) newEntryScore += 1;
  if (newSalesEfficiency != null && newSalesEfficiency >= 0.6) newEntryScore += 4;
  else if (newSalesEfficiency != null && newSalesEfficiency >= 0.35) newEntryScore += 2;
  if (lowReviewShare >= 15) newEntryScore += 4;
  else if (lowReviewShare >= 8) newEntryScore += 2;
  if (crnTier(productCrn) === "low") newEntryScore += 3;
  else if (crnTier(productCrn) === "mid") newEntryScore += 1;
  if (aplusCoverage != null && aplusCoverage < 50) newEntryScore += 2;
  else if (aplusCoverage != null && aplusCoverage < 60) newEntryScore += 1;
  if (videoCoverage != null && videoCoverage < 50) newEntryScore += 2;
  else if (videoCoverage != null && videoCoverage < 60) newEntryScore += 1;
  if (
    aplusCoverage != null &&
    videoCoverage != null &&
    aplusCoverage < 50 &&
    videoCoverage < 50
  ) {
    newEntryScore += 1;
  }
  if (
    aplusCoverage != null &&
    videoCoverage != null &&
    aplusCoverage >= 50 &&
    videoCoverage >= 50
  ) {
    newEntryScore -= 1;
  }
  newEntryScore = clamp(newEntryScore, 0, 15);

  let productOpportunityScore = 0;
  if (midLowRatingShare >= 15) productOpportunityScore += 5;
  else if (midLowRatingShare >= 8) productOpportunityScore += 3;
  if (viewsDir === "up") productOpportunityScore += 4;
  else if (viewsDir === "flat") productOpportunityScore += 2;
  if (crnTier(productCrn) === "low") productOpportunityScore += 3;
  else if (crnTier(productCrn) === "mid") productOpportunityScore += 1;
  if ((niche.returnRatio ?? 0) > (niche.avgReturnRatio ?? 0) + 1) productOpportunityScore += 2;
  productOpportunityScore = clamp(productOpportunityScore, 0, 15);

  let priceOpportunityScore = 0;
  if (priceAnalysis?.priorityOpportunities.length) priceOpportunityScore += 6;
  if (priceAnalysis?.highMarginOpportunities.length) priceOpportunityScore += 3;
  // @ts-expect-error Original v6 compares undefined to 1 (false); retain exact runtime behavior.
  if (priceAnalysis?.priorityOpportunities.length > 1) priceOpportunityScore += 2;
  if (
    priceAnalysis?.demandBand &&
    priceAnalysis.supplyBand &&
    priceAnalysis.demandBand.label !== priceAnalysis.supplyBand.label
  ) {
    priceOpportunityScore += 2;
  }
  priceOpportunityScore = clamp(priceOpportunityScore, 0, 15);

  let maturityScore = 10;
  const oldListingShare = oldListing?.unitsShare ?? 0;
  const newProductWindowOpen = newRatio > NEW_PRODUCT_MATURITY_THRESHOLD;
  if (oldListingShare >= 55) maturityScore -= newProductWindowOpen ? 2 : 3;
  else if (oldListingShare >= 40) maturityScore -= newProductWindowOpen ? 1 : 2;
  if ((aplusCoverage ?? 0) >= 80) maturityScore -= 2;
  else if ((aplusCoverage ?? 0) >= 60) maturityScore -= 1;
  if ((videoCoverage ?? 0) >= 60) maturityScore -= 1;
  if (highReviewShare >= 55) maturityScore -= newProductWindowOpen ? 2 : 3;
  else if (highReviewShare >= 40) maturityScore -= newProductWindowOpen ? 1 : 2;
  if ((niche.amazonSelfProportion ?? 0) >= 35) maturityScore -= 1;
  if (newRatio > 20) maturityScore += 3;
  else if (newRatio > 15) maturityScore += 2;
  else if (newRatio > NEW_PRODUCT_MATURITY_THRESHOLD) maturityScore += 2;
  else if (newRatio <= 5) maturityScore -= 2;
  else if (newRatio <= NEW_PRODUCT_MATURITY_THRESHOLD) maturityScore -= 1;
  maturityScore = clamp(maturityScore, 0, 10);

  const marketDemandScore = clamp(Math.round((demandScore / 20) * 12.5 + (growthScore / 20) * 12.5), 0, 25);

  const scores: MarketSynthesisScores = {
    marketDemand: marketDemandScore,
    marketCompetition: Math.round(competitionScore),
    marketMaturity: Math.round(maturityScore),
    newEntryBarrier: Math.round(newEntryScore),
    productOpportunity: Math.round(productOpportunityScore),
    priceOpportunity: Math.round(priceOpportunityScore),
  };
  const score = MARKET_SYNTHESIS_DIMENSIONS.reduce((sum, dim) => sum + scores[dim.key], 0);
  const { grade, gradeLabel, gradeDefinition } = gradeFromScore(score);

  const demandTrendText =
    keywordDir === "up" && salesDir === "up"
      ? "搜索需求与实际销量同步增长"
      : keywordDir === "down" && salesDir === "down"
        ? "搜索需求与实际销量同步走弱"
        : keywordDir === "flat" && salesDir === "flat"
          ? "搜索与成交长期平稳，属成熟型需求"
          : demandCross;

  const sections = {
    demand: `行业整体样本月销 ${int(totalUnits)}、核心词合计月搜约 ${int(topKeywordSearches)}；${demandTrendText}。${salesYoy != null ? `最近完整月同比 ${salesYoy.change >= 0 ? "+" : ""}${salesYoy.change.toFixed(1)}%。` : ""}${views.length ? `类目浏览量近 6 个月${viewsDir === "up" ? "继续抬升" : viewsDir === "down" ? "有所回落" : "波动平稳"}。` : ""}`.trim(),
    competition: `商品集中度 ${pct(productCrn, 1)}、品牌 ${pct(brandCrn, 1)}、卖家 ${pct(sellerCrn, 1)}；${tripleCrn}。Top 品牌 ${report?.brands?.[0]?.label ?? "—"} 占 ${pct(report?.brands?.[0]?.unitsShare, 1)}，头部卖家 ${report?.sellers?.[0]?.label ?? "—"} 占 ${pct(report?.sellers?.[0]?.unitsShare, 1)}。`,
    maturity: `${oldListingShare >= 45 ? "老品（3 年以上）仍拿走主要销量，" : "老品销量占比未绝对垄断，"}A+ 覆盖 ${pct(aplusCoverage, 0)}${videoCoverage != null ? `、视频覆盖 ${pct(videoCoverage, 0)}` : ""}；FBA ${pct(niche.fbaProportion, 0)}、Amazon 自营销量 ${pct(niche.amazonSelfProportion, 1)}。${niche.newCount != null ? `近 6 个月 ${int(niche.newCount)} 个新品占样本 ${pct(newRatio, 0)}` : "近 6 个月新品"}${newRatio > NEW_PRODUCT_MATURITY_THRESHOLD ? "，高于 10% 门槛，说明新品仍可进入" : newRatio > 5 ? "，占比一般，进入需更强差异化" : "，占比偏低，老品占主导"}。`,
    newEntry: buildNewEntrySectionText({
      newRatio,
      newSalesEfficiency,
      lowReviewShare,
      highReviewShare,
      niche,
      aplusCoverage,
      videoCoverage,
    }),
    productOpportunity: priceAnalysis?.demandBand
      ? `${midLowRatingShare >= 12 ? `4.0–4.3 分区间占 ${pct(midLowRatingShare, 1)} 销量，体验优化仍可能换来转化；` : "主流评分偏高，产品体验优化难度较大；"}${viewsDir === "up" ? "类目浏览量仍在增长，细分功能/配置需求尚未饱和。" : viewsDir === "down" ? "浏览量近端走弱，新品需用更明确的功能差异抢量。" : "需求结构相对稳定，机会在差评痛点与配置升级。"}${crnTier(productCrn) !== "high" ? "商品集中度未绝对垄断，长尾链接仍能靠产品差异分到量。" : "头部 ASIN 占比较高，新品需做可感知的功能/配置差异。"}`
      : "缺少足够结构数据，优先从差评痛点、适用场景和配置完整性找产品切入口。",
    priceOpportunity: buildSynthesisPriceOpportunityText(prices, niche, report?.asinProfits, priceAnalysis),
  };

  const topOpportunities: string[] = [];
  if (priceAnalysis) {
    const headline = buildPriceOpportunityHeadline(priceAnalysis, niche);
    if (headline) {
      topOpportunities.push(headline);
    } else if (priceAnalysis.priorityOpportunities[0]) {
      topOpportunities.push(
        `优先价格带 $${priceAnalysis.priorityOpportunities[0].label}：月销 ${int(priceAnalysis.priorityOpportunities[0].units)}、链接均销 ${int(priceAnalysis.priorityOpportunities[0].avgPerListing)} 件、销量占比 ${pct(priceAnalysis.priorityOpportunities[0].unitsShare, 1)}。`,
      );
    } else if (priceAnalysis.highMarginOpportunities[0]) {
      topOpportunities.push(
        `高毛利价格带 $${priceAnalysis.highMarginOpportunities[0].label}：链接均销 ${int(priceAnalysis.highMarginOpportunities[0].avgPerListing)} 件，适合验证高客单配置。`,
      );
    }
  }
  if ((aplusCoverage ?? 100) < 60 || (videoCoverage ?? 100) < 60) {
    topOpportunities.push("A+/视频覆盖尚未饱和，Listing 内容补位仍有机会。");
  }
  if (midLowRatingShare >= 12) {
    topOpportunities.push("部分高销量产品评分集中在 4.0–4.3，产品体验优化仍可能换来转化。");
  }
  if (crnTier(productCrn) === "low" && crnTier(brandCrn) !== "high") {
    topOpportunities.push("商品与品牌集中度未形成绝对垄断，长尾链接仍能分到份额。");
  }
  if (viewsDir === "up") {
    topOpportunities.push("类目浏览量近端继续增长，细分曝光需求尚未完全饱和。");
  }
  while (topOpportunities.length < 1) {
    topOpportunities.push("需结合下方各模块明细进一步确认差异化切入点。");
    break;
  }

  const topRisks: string[] = [];
  if (supplyGrowth > demandGrowth + 5) {
    topRisks.push("新增商品增速可能快于需求扩张，未来竞争或进一步加剧。");
  }
  if (crnTier(brandCrn) === "high" || crnTier(productCrn) === "high") {
    topRisks.push("头部商品/品牌份额偏高，自然位与品牌认知壁垒明显。");
  }
  if (highReviewShare >= 45) {
    topRisks.push(`主流销量集中在高 Review 区间（约 ${pct(highReviewShare, 1)}），新品评论积累周期长。`);
  }
  if ((niche.amazonSelfProportion ?? 0) >= 30) {
    topRisks.push(`Amazon 自营销量占比 ${pct(niche.amazonSelfProportion, 1)}，第三方需直面 Retail 竞争。`);
  }
  if (keywordDir === "down" || salesDir === "down") {
    topRisks.push("搜索或成交近端走弱，需警惕类目需求收缩。");
  }
  while (topRisks.length < 1) {
    topRisks.push("竞争与运营投入仍高于轻资产类目，需控制库存与广告试错成本。");
    break;
  }

  const productDir = priceAnalysis?.demandBand ? `$${priceAnalysis.demandBand.label} 成交带` : "核心成交价格带";
  const priceDir = priceAnalysis?.entryBand
    ? `$${priceAnalysis.entryBand.label}（${priceAnalysis.entryBand.avgProfitPct != null ? `毛利率 ${pct(priceAnalysis.entryBand.avgProfitPct, 0)}` : `广告前毛利 ${pct(priceAnalysis.entryBand.preAdMarginPct, 1)}`}）`
    : priceAnalysis?.priorityOpportunities[0]
      ? `$${priceAnalysis.priorityOpportunities[0].label}`
      : priceAnalysis?.highMarginOpportunities[0]
        ? `$${priceAnalysis.highMarginOpportunities[0].label} 高毛利带`
        : productDir;
  const mainRisk = topRisks[0] ?? "竞争加剧";

  let finalVerdict = "";
  if (gradeLabel === "重点准入" || gradeLabel === "优先准入") {
    finalVerdict = `${gradeLabel}：${gradeDefinition} 建议重点关注「${productDir} × ${priceDir}」，主要风险为${mainRisk.replace(/。$/, "")}。`;
  } else if (gradeLabel === "建议准入") {
    finalVerdict = `${gradeLabel}：${gradeDefinition} 建议优先验证「${productDir} × ${priceDir}」，并关注 ${mainRisk.replace(/。$/, "")}。`;
  } else if (gradeLabel === "可评估准入") {
    finalVerdict = `${gradeLabel}：${gradeDefinition} 建议结合 VOC 与关键词进一步验证「${productDir} × ${priceDir}」。`;
  } else if (gradeLabel === "谨慎准入") {
    finalVerdict = `${gradeLabel}：${gradeDefinition}${totalUnits >= 20_000 ? ` 市场规模 ${int(totalUnits)} 件/月，但集中度 ${pct(productCrn, 1)} / 品牌 ${pct(brandCrn, 1)}，Review 壁垒 ${highReviewShare >= 40 ? "偏高" : "中等"}。` : ""}`;
  } else {
    finalVerdict = `${gradeLabel}：${gradeDefinition}${keywordDir === "down" || salesDir === "down" ? " 需求或销量近端走弱。" : ""}${productCrn != null ? ` 商品/品牌/卖家集中度 ${pct(productCrn, 1)} / ${pct(brandCrn, 1)} / ${pct(sellerCrn, 1)}。` : ""}`;
  }

  return {
    version: MARKET_SYNTHESIS_VERSION,
    score,
    grade,
    gradeLabel,
    gradeDefinition,
    scores,
    sections,
    topOpportunities: topOpportunities.slice(0, 3),
    topRisks: topRisks.slice(0, 3),
    finalVerdict,
    crossSignals,
  };
}
