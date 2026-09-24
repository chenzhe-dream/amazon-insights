import { formatPriceBand } from "./sorftime-category-dashboard";

export type ResearchGrade = "GREEN" | "YELLOW" | "RED" | "GRAY";

export type DemandLevel = "core" | "important" | "niche" | "small";

export type CompetitionLevel =
  | "single_dominant"
  | "few_concentrated"
  | "moderate"
  | "dispersed";

export type BrandLayoutType = "single_band" | "dual_band" | "multi_band" | "unknown";

export type BrandPriceOpportunityInput = {
  linkId: string;
  brand: string;
  priceBand: string;
  productShape?: string;
  sales: {
    last3Months: number;
    last6Months: number;
    y2024: number;
    y2025: number;
  };
};

export type BrandPriceOpportunityOptions = {
  analysisDate?: string | Date;
  sampleScope?: string;
  categoryName?: string;
  marketplace?: string;
};

export type PriceBandOpportunityRow = {
  priceBand: string;
  sales: number;
  bandShare: number | null;
  demandLevel: DemandLevel | null;
  demandLabel: string;
  brandCount: number;
  linkCount: number;
  leaderBrand: string | null;
  bandCr1: number | null;
  bandCr3: number | null;
  monthlySalesPerLink: number | null;
  outputIndex: number | null;
  growth: number | null;
  shareChangePp: number | null;
  topLinkShare: number | null;
  competitionLevel: CompetitionLevel | null;
  competitionLabel: string;
  trendLabel: string;
  grade: ResearchGrade;
  provisionalGrade: ResearchGrade | null;
  ruleHits: string[];
  evidence: string[];
  limitations: string[];
};

export type BrandBandPerformance = {
  priceBand: string;
  sales: number;
  brandWithinBandShare: number | null;
  bandWithinBrandShare: number | null;
  brandEfficiency: number | null;
  growth: number | null;
  shareChangePp: number | null;
};

export type BrandOpportunityRow = {
  brand: string;
  sales: number;
  brandShare: number | null;
  linkCount: number;
  productShapes: string[];
  mainBands: string[];
  advantageBands: string[];
  layoutType: BrandLayoutType;
  layoutLabel: string;
  bandPerformance: BrandBandPerformance[];
};

export type BrandPriceOpportunityResult = {
  skill: "analyze-amazon-brand-price-opportunity";
  version: "1.0.0";
  analysisScope: {
    analysisDate: string;
    structuralPeriod: string;
    trendPeriod: string;
    sampleScope: string;
    rawLinkCount: number;
    validLinkCount: number;
    validTotalSales: number;
    priceBandCount: number;
    brandCount: number;
    unknownBrandShare: number | null;
    confidence: "high" | "medium" | "low" | "insufficient";
  };
  priceBands: PriceBandOpportunityRow[];
  brands: BrandOpportunityRow[];
  classification: {
    primaryResearchBand: string | null;
    primaryGrade: ResearchGrade;
    marketDemandSummary: string;
    brandStructureSummary: string;
    headline: string;
  };
  evidence: string[];
  risks: string[];
  recommendedActions: string[];
  summary: string;
};

const UNKNOWN_BRAND = "—";

function share(part: number, total: number): number | null {
  if (!total) return null;
  return part / total;
}

function pct2(value: number | null): string {
  if (value == null || Number.isNaN(value)) return "—";
  return `${(value * 100).toFixed(2)}%`;
}

function isRealBrand(brand: string) {
  return brand.trim() !== "" && brand !== UNKNOWN_BRAND;
}

function resolveAnalysisDate(value?: string | Date) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function demandLevel(bandShare: number | null): DemandLevel | null {
  if (bandShare == null) return null;
  if (bandShare >= 0.2) return "core";
  if (bandShare >= 0.1) return "important";
  if (bandShare >= 0.05) return "niche";
  return "small";
}

function demandLabel(level: DemandLevel | null) {
  switch (level) {
    case "core":
      return "核心需求";
    case "important":
      return "重要需求";
    case "niche":
      return "细分需求";
    case "small":
      return "小规模需求";
    default:
      return "待验证";
  }
}

function competitionLevel(cr1: number | null, cr3: number | null): CompetitionLevel | null {
  if (cr1 == null || cr3 == null) return null;
  if (cr1 >= 0.5) return "single_dominant";
  if (cr3 >= 0.7) return "few_concentrated";
  if (cr3 >= 0.4) return "moderate";
  return "dispersed";
}

function competitionLabel(level: CompetitionLevel | null) {
  switch (level) {
    case "single_dominant":
      return "单品牌主导";
    case "few_concentrated":
      return "少数品牌集中";
    case "moderate":
      return "中度集中";
    case "dispersed":
      return "品牌分散";
    default:
      return "待验证";
  }
}

function gradeLabel(grade: ResearchGrade) {
  switch (grade) {
    case "GREEN":
      return "优先研究";
    case "YELLOW":
      return "差异化研究";
    case "RED":
      return "暂缓";
    case "GRAY":
      return "待验证";
  }
}

function gradeRank(grade: ResearchGrade) {
  switch (grade) {
    case "GREEN":
      return 0;
    case "YELLOW":
      return 1;
    case "GRAY":
      return 2;
    case "RED":
      return 3;
  }
}

function trendLabel(growth: number | null, shareChangePp: number | null) {
  const growthDir =
    growth == null ? "未知" : growth >= 0.1 ? "增长" : growth <= -0.1 ? "下降" : "稳定";
  const shareDir =
    shareChangePp == null
      ? "未知"
      : shareChangePp >= 1
        ? "份额上升"
        : shareChangePp <= -1
          ? "份额下降"
          : "份额稳定";

  if (growthDir === "未知" || shareDir === "未知") return "趋势待验证";
  if (growthDir === "增长" && shareDir === "份额上升") return "销量扩大、相对位置增强";
  if (growthDir === "增长" && shareDir === "份额下降") return "随整体增长但相对落后";
  if (growthDir === "下降" && shareDir === "份额上升") return "相对抗跌";
  if (growthDir === "下降" && shareDir === "份额下降") return "双重走弱";
  return `${growthDir} · ${shareDir}`;
}

function computeGrowth(current: number, previous: number): number | null {
  if (previous <= 0) {
    if (current > 0) return null;
    return 0;
  }
  return current / previous - 1;
}

function computeBandGrade(input: {
  bandShare: number | null;
  outputIndex: number | null;
  growth: number | null;
  shareChangePp: number | null;
  bandCr1: number | null;
  bandCr3: number | null;
  brandCount: number;
  linkCount: number;
  topLinkShare: number | null;
  previousSales: number;
}): { grade: ResearchGrade; provisionalGrade: ResearchGrade | null; ruleHits: string[]; limitations: string[] } {
  const ruleHits: string[] = [];
  const limitations: string[] = [];
  let grade: ResearchGrade = "YELLOW";
  let provisionalGrade: ResearchGrade | null = null;

  const trendValid =
    input.growth != null &&
    input.shareChangePp != null &&
    !(input.previousSales > 0 && input.previousSales < 100);

  if (input.bandShare == null || input.outputIndex == null || input.bandCr1 == null || input.bandCr3 == null) {
    return {
      grade: "GRAY",
      provisionalGrade: null,
      ruleHits: ["R6-结构不可评"],
      limitations: ["缺少完整分母、产出指数或集中度，无法给出确定研究等级"],
    };
  }

  if (
    input.bandShare < 0.05 &&
    input.outputIndex < 0.7
  ) {
    grade = "RED";
    ruleHits.push("R6-RED-1: 小规模需求且低产出");
  } else if (
    trendValid &&
    input.growth! <= -0.1 &&
    input.shareChangePp! <= -1 &&
    input.outputIndex < 1
  ) {
    grade = "RED";
    ruleHits.push("R6-RED-2: 趋势走弱且产出偏低");
  } else if (
    input.bandShare >= 0.1 &&
    input.outputIndex >= 1.2 &&
    input.bandCr1 < 0.4 &&
    input.bandCr3 < 0.7 &&
    (input.growth == null || input.growth > -0.1)
  ) {
    grade = "GREEN";
    ruleHits.push("R6-GREEN: 需求、产出、分散度与趋势综合达标");
  } else {
    grade = "YELLOW";
    ruleHits.push("R6-YELLOW: 数据可评但未满足优先研究全部条件");
  }

  if (input.brandCount < 3 || input.linkCount < 5) {
    provisionalGrade = grade;
    grade = "GRAY";
    limitations.push(
      input.brandCount < 3
        ? `价格带内真实品牌仅 ${input.brandCount} 个，样本不足`
        : `价格带链接仅 ${input.linkCount} 条，样本不足`,
    );
    ruleHits.push("R6-修正: 样本不足降为待验证");
  } else if (grade === "GREEN" && input.topLinkShare != null && input.topLinkShare >= 0.5) {
    provisionalGrade = "GREEN";
    grade = "YELLOW";
    limitations.push("单链接销量占比过高，成功可能依赖个别链接");
    ruleHits.push("R6-修正: 单链接依赖降为差异化研究");
  } else if (grade === "GREEN" && !trendValid) {
    provisionalGrade = "GREEN";
    grade = "YELLOW";
    limitations.push("近3个月对比前期基数偏低，趋势信号不足");
    ruleHits.push("R6-修正: 低基数趋势降为差异化研究");
  }

  return { grade, provisionalGrade, ruleHits, limitations };
}

function computeBrandLayout(
  bandShares: Array<{ priceBand: string; shareWithinBrand: number | null }>,
): { layoutType: BrandLayoutType; layoutLabel: string; mainBands: string[] } {
  const valid = bandShares
    .filter(item => item.shareWithinBrand != null && item.shareWithinBrand > 0)
    .sort((a, b) => (b.shareWithinBrand ?? 0) - (a.shareWithinBrand ?? 0));

  if (!valid.length) {
    return { layoutType: "unknown", layoutLabel: "待验证", mainBands: [] };
  }

  const top = valid[0];
  if ((top.shareWithinBrand ?? 0) >= 0.6) {
    return { layoutType: "single_band", layoutLabel: "单价格带集中", mainBands: [top.priceBand] };
  }

  const top2Sum = (valid[0].shareWithinBrand ?? 0) + (valid[1]?.shareWithinBrand ?? 0);
  if (top2Sum >= 0.8) {
    return {
      layoutType: "dual_band",
      layoutLabel: "双价格带集中",
      mainBands: valid.slice(0, 2).map(item => item.priceBand),
    };
  }

  return {
    layoutType: "multi_band",
    layoutLabel: "多价格带分布",
    mainBands: valid.slice(0, 2).map(item => item.priceBand),
  };
}

export function analyzeBrandPriceOpportunity(
  inputs: BrandPriceOpportunityInput[],
  options: BrandPriceOpportunityOptions = {},
): BrandPriceOpportunityResult {
  const analysisDate = resolveAnalysisDate(options.analysisDate);
  const rawLinkCount = inputs.length;
  const validInputs = inputs.filter(
    item =>
      item.linkId &&
      Number.isFinite(item.sales.last6Months) &&
      item.sales.last6Months >= 0,
  );
  const validLinkCount = validInputs.length;
  const validTotalSales = validInputs.reduce((sum, item) => sum + item.sales.last6Months, 0);

  const sampleScope =
    options.sampleScope ??
    (options.categoryName
      ? `${options.marketplace ?? "US"} · ${options.categoryName} · TOP${rawLinkCount}`
      : `TOP${rawLinkCount}`);

  if (!validLinkCount || !validTotalSales) {
    return {
      skill: "analyze-amazon-brand-price-opportunity",
      version: "1.0.0",
      analysisScope: {
        analysisDate: analysisDate.toISOString().slice(0, 10),
        structuralPeriod: "近6个月",
        trendPeriod: "近3个月 vs 前3个月",
        sampleScope,
        rawLinkCount,
        validLinkCount,
        validTotalSales: 0,
        priceBandCount: 0,
        brandCount: 0,
        unknownBrandShare: null,
        confidence: "insufficient",
      },
      priceBands: [],
      brands: [],
      classification: {
        primaryResearchBand: null,
        primaryGrade: "GRAY",
        marketDemandSummary: "数据不足",
        brandStructureSummary: "数据不足",
        headline: "数据不足",
      },
      evidence: ["有效销量为 0，无法计算价格带与品牌结构"],
      risks: ["样本内链接缺少近6个月销量，结论不可用"],
      recommendedActions: ["先拉取完整 TOP 销售与历史趋势后再分析"],
      summary: `${sampleScope} 缺少有效销量，品牌·价格带机会分析暂不可用。`,
    };
  }

  type BandAccumulator = {
    priceBand: string;
    sales6m: number;
    sales3m: number;
    salesPrev3m: number;
    linkCount: number;
    brandSales: Map<string, number>;
    linkSales: number[];
  };

  const bandMap = new Map<string, BandAccumulator>();
  const total3m = validInputs.reduce((sum, item) => sum + item.sales.last3Months, 0);
  const totalPrev3m = validInputs.reduce(
    (sum, item) => sum + Math.max(0, item.sales.last6Months - item.sales.last3Months),
    0,
  );

  for (const item of validInputs) {
    const priceBand = item.priceBand?.trim() || "—";
    const brand = item.brand?.trim() || UNKNOWN_BRAND;
    const current =
      bandMap.get(priceBand) ??
      ({
        priceBand,
        sales6m: 0,
        sales3m: 0,
        salesPrev3m: 0,
        linkCount: 0,
        brandSales: new Map<string, number>(),
        linkSales: [],
      } satisfies BandAccumulator);

    current.sales6m += item.sales.last6Months;
    current.sales3m += item.sales.last3Months;
    current.salesPrev3m += Math.max(0, item.sales.last6Months - item.sales.last3Months);
    current.linkCount += 1;
    current.linkSales.push(item.sales.last6Months);
    current.brandSales.set(brand, (current.brandSales.get(brand) ?? 0) + item.sales.last6Months);
    bandMap.set(priceBand, current);
  }

  const priceBands: PriceBandOpportunityRow[] = [...bandMap.values()]
    .map(band => {
      const bandShare = share(band.sales6m, validTotalSales);
      const demand = demandLevel(bandShare);
      const realBrandEntries = [...band.brandSales.entries()].filter(([brand]) => isRealBrand(brand));
      const realBrandCount = realBrandEntries.length;
      const brandCount = band.brandSales.size;
      const sortedRealBrands = realBrandEntries.sort((a, b) => b[1] - a[1]);
      const leaderBrand = sortedRealBrands[0]?.[0] ?? null;
      const bandCr1 = share(sortedRealBrands[0]?.[1] ?? 0, band.sales6m);
      const bandCr3 = share(
        sortedRealBrands.slice(0, 3).reduce((sum, [, sales]) => sum + sales, 0),
        band.sales6m,
      );
      const competition = competitionLevel(bandCr1, bandCr3);
      const outputIndex =
        bandShare != null && validLinkCount > 0
          ? bandShare / (band.linkCount / validLinkCount)
          : null;
      const growth = computeGrowth(band.sales3m, band.salesPrev3m);
      const shareCurrent = share(band.sales3m, total3m);
      const sharePrevious = share(band.salesPrev3m, totalPrev3m);
      const shareChangePp =
        shareCurrent != null && sharePrevious != null ? (shareCurrent - sharePrevious) * 100 : null;
      const topLinkShare = share(Math.max(...band.linkSales, 0), band.sales6m);
      const monthlySalesPerLink = band.linkCount > 0 ? band.sales6m / band.linkCount / 6 : null;

      const gradeResult = computeBandGrade({
        bandShare,
        outputIndex,
        growth,
        shareChangePp,
        bandCr1,
        bandCr3,
        brandCount: realBrandCount,
        linkCount: band.linkCount,
        topLinkShare,
        previousSales: band.salesPrev3m,
      });

      const evidence = [
        `近6个月销量 ${Math.round(band.sales6m).toLocaleString()}，样本份额 ${pct2(bandShare)}（${demandLabel(demand)}）`,
        `品牌结构：${competitionLabel(competition)}，CR1 ${pct2(bandCr1)} / CR3 ${pct2(bandCr3)}${leaderBrand ? `，领先 ${leaderBrand}` : ""}`,
        `链接产出指数 ${outputIndex?.toFixed(2) ?? "—"}，单链月均 ${monthlySalesPerLink != null ? Math.round(monthlySalesPerLink).toLocaleString() : "—"}`,
        `趋势：${trendLabel(growth, shareChangePp)}（增长 ${growth != null ? `${(growth * 100).toFixed(1)}%` : "—"}，份额变化 ${shareChangePp != null ? `${shareChangePp.toFixed(2)}pp` : "—"}）`,
      ];

      return {
        priceBand: band.priceBand,
        sales: band.sales6m,
        bandShare,
        demandLevel: demand,
        demandLabel: demandLabel(demand),
        brandCount: realBrandCount,
        linkCount: band.linkCount,
        leaderBrand,
        bandCr1,
        bandCr3,
        monthlySalesPerLink,
        outputIndex,
        growth,
        shareChangePp,
        topLinkShare,
        competitionLevel: competition,
        competitionLabel: competitionLabel(competition),
        trendLabel: trendLabel(growth, shareChangePp),
        grade: gradeResult.grade,
        provisionalGrade: gradeResult.provisionalGrade,
        ruleHits: gradeResult.ruleHits,
        evidence,
        limitations: gradeResult.limitations,
      } satisfies PriceBandOpportunityRow;
    })
    .sort((left, right) => (right.bandShare ?? 0) - (left.bandShare ?? 0));

  type BrandAccumulator = {
    brand: string;
    sales6m: number;
    sales3m: number;
    salesPrev3m: number;
    linkCount: number;
    bandSales: Map<string, number>;
    shapeLinks: Map<string, number>;
  };

  const brandMap = new Map<string, BrandAccumulator>();
  for (const item of validInputs) {
    const brand = item.brand?.trim() || UNKNOWN_BRAND;
    const priceBand = item.priceBand?.trim() || "—";
    const productShape = item.productShape?.trim() || "—";
    const current =
      brandMap.get(brand) ??
      ({
        brand,
        sales6m: 0,
        sales3m: 0,
        salesPrev3m: 0,
        linkCount: 0,
        bandSales: new Map<string, number>(),
        shapeLinks: new Map<string, number>(),
      } satisfies BrandAccumulator);
    current.sales6m += item.sales.last6Months;
    current.sales3m += item.sales.last3Months;
    current.salesPrev3m += Math.max(0, item.sales.last6Months - item.sales.last3Months);
    current.linkCount += 1;
    current.bandSales.set(priceBand, (current.bandSales.get(priceBand) ?? 0) + item.sales.last6Months);
    current.shapeLinks.set(productShape, (current.shapeLinks.get(productShape) ?? 0) + 1);
    brandMap.set(brand, current);
  }

  const bandTotals = new Map(priceBands.map(row => [row.priceBand, row.sales]));
  const brands: BrandOpportunityRow[] = [...brandMap.values()]
    .map(brand => {
      const brandShare = share(brand.sales6m, validTotalSales);
      const bandPerformance: BrandBandPerformance[] = [...brand.bandSales.entries()]
        .map(([priceBand, sales]) => {
          const bandTotal = bandTotals.get(priceBand) ?? 0;
          const growth = computeGrowth(
            validInputs
              .filter(item => (item.brand?.trim() || UNKNOWN_BRAND) === brand.brand && (item.priceBand?.trim() || "—") === priceBand)
              .reduce((sum, item) => sum + item.sales.last3Months, 0),
            validInputs
              .filter(item => (item.brand?.trim() || UNKNOWN_BRAND) === brand.brand && (item.priceBand?.trim() || "—") === priceBand)
              .reduce((sum, item) => sum + Math.max(0, item.sales.last6Months - item.sales.last3Months), 0),
          );
          const brand3m = validInputs
            .filter(item => (item.brand?.trim() || UNKNOWN_BRAND) === brand.brand && (item.priceBand?.trim() || "—") === priceBand)
            .reduce((sum, item) => sum + item.sales.last3Months, 0);
          const brandPrev3m = validInputs
            .filter(item => (item.brand?.trim() || UNKNOWN_BRAND) === brand.brand && (item.priceBand?.trim() || "—") === priceBand)
            .reduce((sum, item) => sum + Math.max(0, item.sales.last6Months - item.sales.last3Months), 0);
          const shareCurrent = share(brand3m, total3m);
          const sharePrevious = share(brandPrev3m, totalPrev3m);
          const bandRow = priceBands.find(row => row.priceBand === priceBand);
          const bandWithinBrandShare = share(sales, brand.sales6m);
          const brandWithinBandShare = share(sales, bandTotal);
          const brandEfficiency =
            bandWithinBrandShare != null &&
            bandRow?.outputIndex != null &&
            bandRow.outputIndex > 0
              ? (brandWithinBandShare ?? 0) / (bandWithinBrandShare ?? 1) / (1 / (bandRow.outputIndex || 1))
              : null;
          return {
            priceBand,
            sales,
            brandWithinBandShare,
            bandWithinBrandShare,
            brandEfficiency: brandEfficiency != null && Number.isFinite(brandEfficiency) ? brandEfficiency : null,
            growth,
            shareChangePp:
              shareCurrent != null && sharePrevious != null ? (shareCurrent - sharePrevious) * 100 : null,
          };
        })
        .sort((a, b) => b.sales - a.sales);

      const layout = computeBrandLayout(
        bandPerformance.map(item => ({
          priceBand: item.priceBand,
          shareWithinBrand: item.bandWithinBrandShare,
        })),
      );
      const advantageBands = [...bandPerformance]
        .filter(item => item.brandWithinBandShare != null)
        .sort((a, b) => (b.brandWithinBandShare ?? 0) - (a.brandWithinBandShare ?? 0))
        .slice(0, 2)
        .map(item => item.priceBand);
      const productShapes = [...brand.shapeLinks.entries()]
        .filter(([shape]) => shape && shape !== "—")
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "zh-CN"))
        .map(([shape]) => shape);

      return {
        brand: brand.brand,
        sales: brand.sales6m,
        brandShare,
        linkCount: brand.linkCount,
        productShapes,
        mainBands: layout.mainBands,
        advantageBands,
        layoutType: layout.layoutType,
        layoutLabel: layout.layoutLabel,
        bandPerformance,
      } satisfies BrandOpportunityRow;
    })
    .sort((left, right) => right.sales - left.sales);

  const unknownBrandSales =
    brandMap.get(UNKNOWN_BRAND)?.sales6m ??
    [...brandMap.entries()].filter(([brand]) => !isRealBrand(brand)).reduce((sum, [, row]) => sum + row.sales6m, 0);
  const unknownBrandShare = share(unknownBrandSales, validTotalSales);

  const sortedBands = [...priceBands].sort((left, right) => {
    const gradeDiff = gradeRank(left.grade) - gradeRank(right.grade);
    if (gradeDiff !== 0) return gradeDiff;
    return (right.bandShare ?? 0) - (left.bandShare ?? 0);
  });
  const primaryBand = sortedBands[0] ?? null;
  const primaryGrade = primaryBand?.grade ?? "GRAY";

  const coreBands = priceBands.filter(row => row.demandLevel === "core" || row.demandLevel === "important");
  const topBrand = brands.find(item => isRealBrand(item.brand)) ?? brands[0] ?? null;
  const top3BrandShare =
    brands
      .filter(item => isRealBrand(item.brand))
      .slice(0, 3)
      .reduce((sum, item) => sum + (item.brandShare ?? 0), 0) ?? null;

  const confidence: BrandPriceOpportunityResult["analysisScope"]["confidence"] =
    validLinkCount < 20 || priceBands.length < 2
      ? "low"
      : unknownBrandShare != null && unknownBrandShare > 0.15
        ? "medium"
        : "high";

  const marketDemandSummary =
    coreBands.length > 0
      ? `核心/重要需求集中在 ${coreBands.slice(0, 3).map(row => row.priceBand).join("、")}`
      : "样本内未出现明显核心价格带，需求较分散";

  const brandStructureSummary =
    top3BrandShare != null && top3BrandShare >= 0.7
      ? `Top3 品牌占样本 ${pct2(top3BrandShare)}，品牌集中`
      : top3BrandShare != null && top3BrandShare < 0.4
        ? `Top3 品牌仅占 ${pct2(top3BrandShare)}，品牌较分散`
        : `Top3 品牌占 ${pct2(top3BrandShare)}，中度集中`;

  const headline =
    primaryBand && primaryBand.grade !== "GRAY"
      ? `${primaryBand.priceBand} · ${gradeLabel(primaryBand.grade)}`
      : primaryBand?.provisionalGrade
        ? `${primaryBand.priceBand} · ${gradeLabel(primaryBand.provisionalGrade)}（样本待验证）`
        : "待验证";

  const evidence = [
    marketDemandSummary,
    brandStructureSummary,
    `共 ${priceBands.length} 个价格带，详见下方研究表（份额、产出指数、竞争结构、趋势）`,
    topBrand
      ? `样本第一品牌 ${topBrand.brand}（${pct2(topBrand.brandShare)}），布局 ${topBrand.layoutLabel}`
      : "品牌结构待验证",
  ];

  const risks: string[] = [];
  if (unknownBrandShare != null && unknownBrandShare >= 0.1) {
    risks.push(`未知品牌销量占 ${pct2(unknownBrandShare)}，集中度与品牌布局存在偏差`);
  }
  if (priceBands.some(row => row.priceBand === "—")) {
    risks.push("存在缺失价格信息的链接，已知价格带份额之和可能低于 100%");
  }
  const singleLinkBands = priceBands.filter(row => row.topLinkShare != null && row.topLinkShare >= 0.5);
  if (singleLinkBands.length) {
    risks.push(`${singleLinkBands.map(row => row.priceBand).join("、")} 存在单链接依赖`);
  }
  if (!risks.length) risks.push("当前为 TOP 样本回溯结构，仍需 VOC、关键词与成本验证");

  const recommendedActions: string[] = [];
  const greenBands = priceBands.filter(row => row.grade === "GREEN" || row.provisionalGrade === "GREEN");
  const yellowBands = priceBands.filter(row => row.grade === "YELLOW");

  if (greenBands.length) {
    recommendedActions.push(
      `优先拆解 ${greenBands.slice(0, 2).map(row => row.priceBand).join("、")} 的头部品牌链接与规格配置`,
    );
    recommendedActions.push("补充 VOC、关键词搜索量与转化，验证差异化切入点");
  } else if (yellowBands.length) {
    recommendedActions.push(
      `在 ${yellowBands.slice(0, 2).map(row => row.priceBand).join("、")} 寻找产出指数较高但品牌集中度较低的细分位`,
    );
    recommendedActions.push("对比头部品牌主力 SKU 的功能/规格/评论痛点，避免同质铺货");
  } else {
    recommendedActions.push("暂缓常规同质化切入，优先寻找被低估价格带或高效小品牌定位");
  }
  if (topBrand && isRealBrand(topBrand.brand)) {
    recommendedActions.push(`拆解样本头部品牌 ${topBrand.brand} 在 ${topBrand.mainBands.join("、")} 的链接布局`);
  }

  const summary = [
    `基于 ${sampleScope} ${validLinkCount} 条链接、近6个月销量 ${Math.round(validTotalSales).toLocaleString()}，${marketDemandSummary}。`,
    `${brandStructureSummary}；请结合下方价格带研究表综合判断，勿仅凭单一低价带做切入决策。`,
    `此为样本内研究顺序，不代表可直接立项或定价结论（置信度：${confidence === "high" ? "高" : confidence === "medium" ? "中" : "低"}）。`,
  ].join("");

  return {
    skill: "analyze-amazon-brand-price-opportunity",
    version: "1.0.0",
    analysisScope: {
      analysisDate: analysisDate.toISOString().slice(0, 10),
      structuralPeriod: "近6个月",
      trendPeriod: "近3个月 vs 前3个月",
      sampleScope,
      rawLinkCount,
      validLinkCount,
      validTotalSales,
      priceBandCount: priceBands.length,
      brandCount: brands.filter(item => isRealBrand(item.brand)).length,
      unknownBrandShare,
      confidence,
    },
    priceBands,
    brands,
    classification: {
      primaryResearchBand: primaryBand?.priceBand ?? null,
      primaryGrade,
      marketDemandSummary,
      brandStructureSummary,
      headline,
    },
    evidence,
    risks,
    recommendedActions,
    summary,
  };
}

export function buildBrandPriceOpportunityInputsFromProducts(
  products: Array<{
    asin: string;
    brand: string;
    priceBand?: string | null;
    price?: number | null;
    productShape?: string | null;
    productShapeHint?: string | null;
    sales: {
      last3Months?: number;
      last6Months?: number;
      y2024?: number;
      y2025?: number;
    };
  }>,
  options?: {
    getShape?: (asin: string) => string;
  },
): BrandPriceOpportunityInput[] {
  return products.map(product => ({
    linkId: product.asin,
    brand: product.brand?.trim() || UNKNOWN_BRAND,
    priceBand: product.priceBand?.trim() || formatPriceBand(product.price ?? null),
    productShape: resolveBrandAnalysisProductShape(product, options?.getShape),
    sales: {
      last3Months: product.sales.last3Months ?? 0,
      last6Months: product.sales.last6Months ?? 0,
      y2024: product.sales.y2024 ?? 0,
      y2025: product.sales.y2025 ?? 0,
    },
  }));
}

const PENDING_SHAPE_LABELS = new Set(["—", "待视觉分类", "待分类", "未分类"]);

function resolveBrandAnalysisProductShape(
  product: {
    asin: string;
    productShape?: string | null;
    productShapeHint?: string | null;
  },
  getShape?: (asin: string) => string,
) {
  const manual = getShape?.(product.asin)?.trim();
  const raw = manual || product.productShape?.trim() || product.productShapeHint?.trim() || "";
  if (!raw || PENDING_SHAPE_LABELS.has(raw)) return "—";
  return raw;
}

export function researchGradeLabel(grade: ResearchGrade) {
  return gradeLabel(grade);
}

export function researchGradeColor(grade: ResearchGrade): "green" | "yellow" | "red" | "gray" {
  switch (grade) {
    case "GREEN":
      return "green";
    case "YELLOW":
      return "yellow";
    case "RED":
      return "red";
    case "GRAY":
      return "gray";
  }
}
