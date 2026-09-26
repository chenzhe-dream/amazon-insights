import { formatOnlineDateYear } from "./sorftime-category-dashboard";

export type ListingAgeGroupCode =
  | "new_current_year"
  | "new_previous_year"
  | "growth"
  | "mature"
  | "legacy";

export type ListingAgeSalesShareInput = {
  asin: string;
  listingDate?: string | null;
  listingYear?: string | number | null;
  sales: number;
  salesRank?: number | null;
};

export type ListingAgeSalesPeriod = "last3Months" | "last6Months" | "y2025" | "y2024";

export type ListingAgeSalesShareOptions = {
  analysisDate?: string | Date;
  salesPeriod?: ListingAgeSalesPeriod;
  sampleScope?: string;
  categoryName?: string;
  marketplace?: string;
};

export type AgeDistributionRow = {
  ageGroup: ListingAgeGroupCode;
  productCount: number;
  productShare: number | null;
  sales: number;
  salesShare: number | null;
  salesEfficiencyIndex: number | null;
  avgSalesPerProduct: number | null;
};

export type ListingAgeEntryColor = "green" | "light_green" | "yellow" | "red" | "gray";

export type ListingAgeMarketType =
  | "个别爆款驱动"
  | "新品拥挤型"
  | "老品壁垒型"
  | "升级换代型"
  | "新品友好型"
  | "稳定竞争型"
  | "常规分层"
  | "数据不足";

export type ListingAgeSalesShareResult = {
  skill: "analyze-amazon-listing-age-sales-share";
  version: "1.0.0";
  analysisScope: {
    analysisDate: string;
    analysisYear: number;
    salesPeriod: string;
    sampleScope: string;
    inputGranularity: "asin";
    rawProductCount: number;
    validProductCount: number;
    validTotalSales: number;
    listingYearMissingRate: number;
    confidence: "high" | "medium" | "low" | "insufficient";
  };
  ageDistribution: AgeDistributionRow[];
  coreMetrics: {
    recent2yProductShare: number | null;
    recent2ySalesShare: number | null;
    recent2ySalesEfficiencyIndex: number | null;
    currentYearSalesShare: number | null;
    older3ySalesShare: number | null;
    legacy5ySalesShare: number | null;
    top1ShareWithinRecent2ySales: number | null;
    top3ShareWithinRecent2ySales: number | null;
  };
  classification: {
    marketType: ListingAgeMarketType;
    priorityRule: "P0" | "P1" | "P2" | "P3" | "P4" | "P5" | "P6" | "NA";
    entryColor: ListingAgeEntryColor;
    entryRecommendation: string;
  };
  evidence: string[];
  risks: string[];
  recommendedActions: string[];
  summary: string;
};

const AGE_GROUP_ORDER: ListingAgeGroupCode[] = [
  "new_current_year",
  "new_previous_year",
  "growth",
  "mature",
  "legacy",
];

function pct(part: number, total: number): number | null {
  if (!total) return null;
  return Number(((part / total) * 100).toFixed(2));
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator == null || denominator == null || denominator <= 0) return null;
  return Number((numerator / denominator).toFixed(2));
}

function resolveAnalysisDate(value?: string | Date) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function resolveListingYear(input: ListingAgeSalesShareInput) {
  if (input.listingDate) {
    const year = formatOnlineDateYear(input.listingDate);
    if (year !== "—") return Number(year);
  }
  if (input.listingYear != null && String(input.listingYear).trim() !== "—") {
    const year = Number(String(input.listingYear).trim());
    if (Number.isFinite(year)) return year;
  }
  return null;
}

function ageGroupForAge(listingAge: number): ListingAgeGroupCode {
  if (listingAge <= 0) return "new_current_year";
  if (listingAge === 1) return "new_previous_year";
  if (listingAge === 2) return "growth";
  if (listingAge <= 4) return "mature";
  return "legacy";
}

function salesPeriodLabel(period: ListingAgeSalesPeriod) {
  switch (period) {
    case "last3Months":
      return "近3个月";
    case "last6Months":
      return "近6个月";
    case "y2025":
      return "2025全年";
    case "y2024":
      return "2024全年";
  }
}

function downgradeConfidence(level: "high" | "medium" | "low"): "high" | "medium" | "low" | "insufficient" {
  if (level === "high") return "medium";
  if (level === "medium") return "low";
  return "insufficient";
}

function confidenceFromCount(count: number): "high" | "medium" | "low" {
  if (count >= 80) return "high";
  if (count >= 50) return "medium";
  return "low";
}

function baseEntryFromRecent2yShare(share: number | null): {
  entryColor: ListingAgeEntryColor;
  entryRecommendation: string;
} {
  if (share == null) return { entryColor: "gray", entryRecommendation: "数据不足" };
  if (share >= 40) return { entryColor: "green", entryRecommendation: "建议进入" };
  if (share >= 25) return { entryColor: "light_green", entryRecommendation: "可以进入，但需要差异化" };
  if (share >= 15) return { entryColor: "yellow", entryRecommendation: "谨慎进入" };
  return { entryColor: "red", entryRecommendation: "不建议常规切入" };
}

function capEntryColor(current: ListingAgeEntryColor, cap: ListingAgeEntryColor): ListingAgeEntryColor {
  const rank: Record<ListingAgeEntryColor, number> = {
    green: 4,
    light_green: 3,
    yellow: 2,
    red: 1,
    gray: 0,
  };
  return rank[current] > rank[cap] ? cap : current;
}

export function analyzeListingAgeSalesShare(
  items: ListingAgeSalesShareInput[],
  options?: ListingAgeSalesShareOptions,
): ListingAgeSalesShareResult {
  const analysisDate = resolveAnalysisDate(options?.analysisDate);
  const analysisYear = analysisDate.getFullYear();
  const salesPeriod = options?.salesPeriod ?? "last6Months";
  const sampleScope =
    options?.sampleScope ??
    (options?.categoryName
      ? `${options.marketplace ?? "US"} · ${options.categoryName} · TOP链接`
      : "类目TOP链接样本");

  const rawProductCount = items.length;
  const seen = new Set<string>();
  const validRows: Array<ListingAgeSalesShareInput & { listingYear: number; listingAge: number; ageGroup: ListingAgeGroupCode }> =
    [];
  let missingYearCount = 0;

  for (const item of items) {
    const asin = String(item.asin ?? "").trim();
    if (!asin || seen.has(asin)) continue;
    seen.add(asin);
    const sales = Number(item.sales);
    if (!Number.isFinite(sales) || sales < 0) continue;
    const listingYear = resolveListingYear(item);
    if (listingYear == null) {
      missingYearCount += 1;
      continue;
    }
    if (listingYear > analysisYear) continue;
    const listingAge = Math.max(0, analysisYear - listingYear);
    validRows.push({
      ...item,
      asin,
      sales,
      listingYear,
      listingAge,
      ageGroup: ageGroupForAge(listingAge),
    });
  }

  const validProductCount = validRows.length;
  const validTotalSales = validRows.reduce((sum, row) => sum + row.sales, 0);
  const listingYearMissingRate = rawProductCount ? Number(((missingYearCount / rawProductCount) * 100).toFixed(2)) : 100;

  let confidence: "high" | "medium" | "low" | "insufficient" = confidenceFromCount(validProductCount);
  if (listingYearMissingRate > 20) confidence = downgradeConfidence(confidence);
  if (listingYearMissingRate > 40 || validTotalSales <= 0 || validProductCount < 20) {
    confidence = "insufficient";
  }

  const groupStats = new Map<
    ListingAgeGroupCode,
    { productCount: number; sales: number }
  >();
  for (const code of AGE_GROUP_ORDER) groupStats.set(code, { productCount: 0, sales: 0 });
  for (const row of validRows) {
    const bucket = groupStats.get(row.ageGroup)!;
    bucket.productCount += 1;
    bucket.sales += row.sales;
  }

  const ageDistribution: AgeDistributionRow[] = AGE_GROUP_ORDER.map(ageGroup => {
    const bucket = groupStats.get(ageGroup)!;
    const productShare = pct(bucket.productCount, validProductCount);
    const salesShare = pct(bucket.sales, validTotalSales);
    return {
      ageGroup,
      productCount: bucket.productCount,
      productShare,
      sales: bucket.sales,
      salesShare,
      salesEfficiencyIndex: ratio(salesShare, productShare),
      avgSalesPerProduct: bucket.productCount ? Number((bucket.sales / bucket.productCount).toFixed(2)) : null,
    };
  });

  const sumGroups = (codes: ListingAgeGroupCode[]) => {
    let productCount = 0;
    let sales = 0;
    for (const code of codes) {
      const bucket = groupStats.get(code)!;
      productCount += bucket.productCount;
      sales += bucket.sales;
    }
    const productShare = pct(productCount, validProductCount);
    const salesShare = pct(sales, validTotalSales);
    return {
      productCount,
      sales,
      productShare,
      salesShare,
      salesEfficiencyIndex: ratio(salesShare, productShare),
    };
  };

  const recent2y = sumGroups(["new_current_year", "new_previous_year"]);
  const older3y = sumGroups(["mature", "legacy"]);
  const legacy5y = sumGroups(["legacy"]);
  const currentYear = groupStats.get("new_current_year")!;

  const recent2yRows = validRows.filter(row => row.listingAge <= 1).sort((a, b) => b.sales - a.sales);
  const recent2ySalesTotal = recent2y.sales;
  const top1ShareWithinRecent2ySales = recent2yRows[0]
    ? pct(recent2yRows[0].sales, recent2ySalesTotal)
    : null;
  const top3ShareWithinRecent2ySales = recent2yRows.length
    ? pct(
        recent2yRows.slice(0, 3).reduce((sum, row) => sum + row.sales, 0),
        recent2ySalesTotal,
      )
    : null;

  const coreMetrics = {
    recent2yProductShare: recent2y.productShare,
    recent2ySalesShare: recent2y.salesShare,
    recent2ySalesEfficiencyIndex: recent2y.salesEfficiencyIndex,
    currentYearSalesShare: pct(currentYear.sales, validTotalSales),
    older3ySalesShare: older3y.salesShare,
    legacy5ySalesShare: legacy5y.salesShare,
    top1ShareWithinRecent2ySales,
    top3ShareWithinRecent2ySales,
  };

  if (confidence === "insufficient") {
    return {
      skill: "analyze-amazon-listing-age-sales-share",
      version: "1.0.0",
      analysisScope: {
        analysisDate: analysisDate.toISOString().slice(0, 10),
        analysisYear,
        salesPeriod: salesPeriodLabel(salesPeriod),
        sampleScope,
        inputGranularity: "asin",
        rawProductCount,
        validProductCount,
        validTotalSales,
        listingYearMissingRate,
        confidence,
      },
      ageDistribution,
      coreMetrics,
      classification: {
        marketType: "数据不足",
        priorityRule: "NA",
        entryColor: "gray",
        entryRecommendation: "数据不足",
      },
      evidence: [
        `有效样本 ${validProductCount} 条，总销量 ${Math.round(validTotalSales).toLocaleString()}，上架年份缺失率 ${listingYearMissingRate.toFixed(2)}%`,
      ],
      risks: ["样本量或上架年份完整性不足，当前结论只能作参考"],
      recommendedActions: ["补齐上架时间缺失链接", "确认统计周期与 TOP 样本一致后重新分析"],
      summary: "上架年份或销量样本不足，暂不输出确定性准入判断；请补齐数据后重新运行分析。",
    };
  }

  let marketType: ListingAgeMarketType = "常规分层";
  let priorityRule: ListingAgeSalesShareResult["classification"]["priorityRule"] = "P6";
  let entryColor: ListingAgeEntryColor = baseEntryFromRecent2yShare(coreMetrics.recent2ySalesShare).entryColor;
  let entryRecommendation = baseEntryFromRecent2yShare(coreMetrics.recent2ySalesShare).entryRecommendation;

  const recent2ySalesShare = coreMetrics.recent2ySalesShare ?? 0;
  const recent2yProductShare = coreMetrics.recent2yProductShare ?? 0;
  const recent2yEfficiency = coreMetrics.recent2ySalesEfficiencyIndex ?? 0;
  const older3ySalesShare = coreMetrics.older3ySalesShare ?? 0;

  if (
    (top1ShareWithinRecent2ySales ?? 0) >= 50 ||
    (top3ShareWithinRecent2ySales ?? 0) >= 80
  ) {
    marketType = "个别爆款驱动";
    priorityRule = "P0";
    entryColor = capEntryColor(entryColor, "yellow");
    entryRecommendation = "谨慎进入";
  } else if (
    recent2yProductShare >= 40 &&
    recent2ySalesShare < 25 &&
    recent2yEfficiency < 0.8
  ) {
    marketType = "新品拥挤型";
    priorityRule = "P1";
    entryColor = recent2ySalesShare < 15 ? "red" : "yellow";
    entryRecommendation = recent2ySalesShare < 15 ? "不建议常规切入" : "谨慎进入";
  } else if (older3ySalesShare >= 65 && recent2ySalesShare < 25) {
    marketType = "老品壁垒型";
    priorityRule = "P2";
    entryColor = recent2ySalesShare < 15 ? "red" : "yellow";
    entryRecommendation = recent2ySalesShare < 15 ? "不建议常规切入" : "谨慎进入";
  } else if (
    recent2ySalesShare >= 40 &&
    recent2yEfficiency >= 1 &&
    older3ySalesShare < 60
  ) {
    marketType = "新品友好型";
    priorityRule = "P4";
    entryColor = "green";
    entryRecommendation = "建议进入";
  } else if (
    recent2ySalesShare >= 25 &&
    recent2ySalesShare < 40 &&
    older3ySalesShare >= 40 &&
    older3ySalesShare < 65
  ) {
    marketType = "稳定竞争型";
    priorityRule = "P5";
    entryColor = "light_green";
    entryRecommendation = "可以进入，但需要差异化";
  }

  const evidence: string[] = [
    `近2年链接（上架年龄0–1年）销量占比 ${recent2ySalesShare.toFixed(2)}%，商品数占比 ${recent2yProductShare.toFixed(2)}%，效率指数 ${recent2yEfficiency.toFixed(2)}`,
    `3年以上老链接销量占比 ${older3ySalesShare.toFixed(2)}%${(coreMetrics.legacy5ySalesShare ?? 0) >= 50 ? "，5年以上老链接占比偏高" : ""}`,
    `当年新品销量占比 ${(coreMetrics.currentYearSalesShare ?? 0).toFixed(2)}%，近2年Top1/Top3销量集中度 ${(top1ShareWithinRecent2ySales ?? 0).toFixed(2)}% / ${(top3ShareWithinRecent2ySales ?? 0).toFixed(2)}%`,
  ];

  const risks: string[] = [];
  if ((top1ShareWithinRecent2ySales ?? 0) >= 40) {
    risks.push("近2年新品销量高度集中在少数头部 ASIN，整体新品友好度可能被高估");
  }
  if (recent2yProductShare >= 35 && recent2yEfficiency < 0.8) {
    risks.push("新品链接供给偏多，但单位链接销量获取效率偏低");
  }
  if (older3ySalesShare >= 60) {
    risks.push("成熟/老链接仍占据主要销量，需要评价与广告预算才能突破");
  }
  if (listingYearMissingRate > 0) {
    risks.push(`仍有 ${listingYearMissingRate.toFixed(2)}% 链接缺失上架年份，年龄分层存在偏差`);
  }
  if (!risks.length) risks.push("当前快照未见显著结构性异常，仍需结合 VOC、关键词与利润验证");

  const recommendedActions: string[] = [];
  if (entryColor === "green" || entryColor === "light_green") {
    recommendedActions.push("进入 VOC、关键词需求与竞品主图/规格对比，验证可差异化方向");
    recommendedActions.push("拆解近2年高销量新品的 price band、形态与卖点组合");
  } else if (entryColor === "yellow") {
    recommendedActions.push("拆解近2年低销量新品的失败共性（价格、形态、评论门槛）");
    recommendedActions.push("小批量测款或广告小预算验证，再决定是否放大");
  } else {
    recommendedActions.push("避免常规同质化新品直接切入，优先寻找规格/场景/价格带空档");
    recommendedActions.push("若仍要做，需准备明显产品差异或成本优势");
  }
  recommendedActions.push(`继续观察 ${salesPeriodLabel(salesPeriod)} 与 2025/2024 多周期是否一致`);

  const summary = [
    `基于 ${sampleScope} ${validProductCount} 条有效链接、${salesPeriodLabel(salesPeriod)} 销量，市场呈「${marketType}」。`,
    `近2年新品销量占比 ${recent2ySalesShare.toFixed(2)}%（效率 ${recent2yEfficiency.toFixed(2)}），3年以上老品占 ${older3ySalesShare.toFixed(2)}%。`,
    `${entryRecommendation}（置信度：${confidence === "high" ? "高" : confidence === "medium" ? "中" : "低"}）。`,
  ].join("");

  return {
    skill: "analyze-amazon-listing-age-sales-share",
    version: "1.0.0",
    analysisScope: {
      analysisDate: analysisDate.toISOString().slice(0, 10),
      analysisYear,
      salesPeriod: salesPeriodLabel(salesPeriod),
      sampleScope,
      inputGranularity: "asin",
      rawProductCount,
      validProductCount,
      validTotalSales,
      listingYearMissingRate,
      confidence,
    },
    ageDistribution,
    coreMetrics,
    classification: {
      marketType,
      priorityRule,
      entryColor,
      entryRecommendation,
    },
    evidence,
    risks,
    recommendedActions,
    summary,
  };
}

export function buildListingAgeSalesShareInputsFromProducts(
  products: Array<{
    asin: string;
    onlineDate: string | null;
    sales: {
      last3Months?: number;
      last6Months?: number;
      y2024?: number;
      y2025?: number;
    };
    bsrRank?: number | null;
    rank?: number;
  }>,
  salesPeriod: ListingAgeSalesPeriod = "last6Months",
): ListingAgeSalesShareInput[] {
  return products.map(product => ({
    asin: product.asin,
    listingDate: product.onlineDate,
    sales:
      salesPeriod === "last3Months"
        ? product.sales.last3Months ?? 0
        : salesPeriod === "last6Months"
          ? product.sales.last6Months ?? 0
          : salesPeriod === "y2025"
            ? product.sales.y2025 ?? 0
            : product.sales.y2024 ?? 0,
    salesRank: product.bsrRank ?? product.rank ?? null,
  }));
}

export function listingAgeEntryColorLabel(color: ListingAgeEntryColor) {
  switch (color) {
    case "green":
      return "建议进入";
    case "light_green":
      return "可进入 · 需差异化";
    case "yellow":
      return "谨慎进入";
    case "red":
      return "不建议常规切入";
    case "gray":
      return "数据不足";
  }
}

export function listingAgeGroupLabel(code: ListingAgeGroupCode) {
  switch (code) {
    case "new_current_year":
      return "当年新品";
    case "new_previous_year":
      return "次新品";
    case "growth":
      return "成长型";
    case "mature":
      return "成熟型";
    case "legacy":
      return "老商品";
  }
}

export type ListingAgeGroupMeta = {
  label: string;
  listingAgeRange: string;
  listingYearRange: string;
};

/** 链接年龄 = 分析年份 − 上架年份；分组规则见 Skill「链接年龄分组」 */
export function listingAgeGroupMeta(code: ListingAgeGroupCode, analysisYear: number): ListingAgeGroupMeta {
  switch (code) {
    case "new_current_year":
      return {
        label: "当年新品",
        listingAgeRange: "0 年",
        listingYearRange: String(analysisYear),
      };
    case "new_previous_year":
      return {
        label: "次新品",
        listingAgeRange: "1 年",
        listingYearRange: String(analysisYear - 1),
      };
    case "growth":
      return {
        label: "成长型",
        listingAgeRange: "2 年",
        listingYearRange: String(analysisYear - 2),
      };
    case "mature":
      return {
        label: "成熟型",
        listingAgeRange: "3–4 年",
        listingYearRange: `${analysisYear - 4}–${analysisYear - 3}`,
      };
    case "legacy":
      return {
        label: "老商品",
        listingAgeRange: "≥5 年",
        listingYearRange: `≤${analysisYear - 5}`,
      };
  }
}

export const LISTING_AGE_EFFICIENCY_INDEX_NOTE =
  "效率指数 = 该组销量占比 ÷ 该组链接占比；>1 表示单位链接拿量高于样本均值，<1 表示链接多但销量偏少。";

export const LISTING_AGE_GROUP_RULE_NOTE =
  "链接年龄 = 分析年份 − 上架年份；成熟型 = 上架 3–4 年，老商品 = 上架 ≥5 年（对应上架年份见下表）。";
