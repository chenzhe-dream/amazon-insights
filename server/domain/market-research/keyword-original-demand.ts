import {SCENE_PATTERNS,W4_FAMILIES,detectW2Label} from '../../../shared/market-keyword-semantic-rules';
// Preserved archive business algorithm. Estimation and pre-merge score behavior are intentional.
import { classifyKeywordDetailed } from "../../../app/keyword-classifier";
import type { KeywordCategory } from "../../../app/keyword-meaning-taxonomy";
import type { ProductKeywordRow, ProductKeywordSearchReport, ProductKeywordTrendPoint } from "../../../shared/market-keyword-original-input";
type ManualDimensions = NonNullable<ProductKeywordSearchReport['manualDimensions']>;

const W4_LABELS: Partial<Record<KeywordCategory, string>> = {
  function: "功能",
  material_style: "材质风格",
  attribute_spec: "规格",
  benefit: "利益",
};



const W5_LABELS: Record<string, string> = {
  growing: "上升期",
  mature_stable: "成熟稳定",
  recent_weakening: "早期预警",
  structural_declining: "结构性下滑",
  无趋势数据: "无趋势数据",
};

export type KeywordDemandDimensionRow = {
  label: string;
  keywords: string[];
  monthlySearches: number;
  sharePct: number;
  note?: string;
};

export type KeywordDemandDimensionSummary = {
  id: "W1" | "W2" | "W3" | "W4" | "W5";
  title: string;
  question: string;
  conclusion: string;
  rows: KeywordDemandDimensionRow[];
  dataQuality?: string;
};

export type KeywordDemandSynthesis = {
  headline: string;
  bullets: string[];
  clusters: KeywordDemandCluster[];
};

type ClusterDraft = {
  id: string;
  name: string;
  w1What: string;
  w2Who: string | null;
  w3Where: string | null;
  w4Features: Set<string>;
  keywords: string[];
  monthlySearches: number;
  yoyGrowth: number | null;
  growth3m: number | null;
  ppcBid: number | null;
  w5Diagnosis: string;
};

export type KeywordDemandClusterComputed = {
  rawGrowth: number;
  s1: number;
  s2: number;
  s3: number;
  s4: number;
  s5: number;
  pvs: number;
  sharePct: number;
  quadrant: "主战场" | "红海" | "机会缝隙" | "暂缓区";
  demandClass: "主流需求" | "细分需求" | "观察需求";
  validationTier: "P1" | "P2" | "P3" | "P4";
  warnings: string[];
};

export type KeywordDemandCluster = Omit<ClusterDraft, "w4Features"> & {
  w4Features: string[];
  computed: KeywordDemandClusterComputed;
};

export type KeywordDemandDevelopmentRow = {
  direction: string;
  evidence: string;
  priority: string;
  feasibility: string;
};

export type KeywordDemandValidationRow = {
  hypothesis: string;
  method: string;
  tier: KeywordDemandClusterComputed["validationTier"];
  effort: string;
  quadrant: KeywordDemandClusterComputed["quadrant"];
};

export type AmazonKeywordDemandReport = {
  skillName: "amazon-keyword-demand-analysis" | "amazon-demand-five-dimensions-model";
  status: "ok" | "partial" | "insufficient_data";
  scope: {
    marketplace: string;
    productScope: string;
    source: string;
    sampleCount: number;
    totalMonthlyVolume: number;
    trendEnrichedCount: number;
  };
  sampleWarning: string | null;
  dataNotes: string[];
  dimensions: {
    w1: KeywordDemandDimensionSummary;
    w2: KeywordDemandDimensionSummary;
    w3: KeywordDemandDimensionSummary;
    w4: KeywordDemandDimensionSummary;
    w5: KeywordDemandDimensionSummary;
  };
  synthesis: KeywordDemandSynthesis;
  mainstream: KeywordDemandCluster[];
  niche: KeywordDemandCluster[];
  developmentDirections: KeywordDemandDevelopmentRow[];
  validationPriorities: KeywordDemandValidationRow[];
};

function pct(values: number[], target: number) {
  if (!values.length || new Set(values).size === 1) return 50;
  const below = values.filter(value => value < target).length;
  const equal = values.filter(value => value === target).length;
  return ((below + 0.5 * equal) / values.length) * 100;
}

function median(values: number[]) {
  const clean = values.filter(value => Number.isFinite(value));
  if (!clean.length) return 0;
  const sorted = [...clean].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function detectW1(keyword: string, productSeed: string) {
  const text = keyword.toLowerCase();
  const seed = productSeed.trim().toLowerCase();
  if (seed && seed !== "product" && text.includes(seed)) return productSeed;
  if (/floor[\s-]?lamp|floorlamp/.test(text)) return "floor lamp";
  if (/standing lamp|stand up lamp|pole lamp|stand lamp/.test(text)) return "standing lamp";
  if (/tall floor|tall lamp/.test(text)) return "tall lamp";
  if (/\blamp\b/.test(text) && !/floor|standing|tall|table|desk|night/.test(text)) return "lamp";
  return productSeed;
}

function detectW3(keyword: string) {
  return SCENE_PATTERNS.find(entry => entry.pattern.test(keyword))?.label ?? null;
}

function growthFromTrend(trend: ProductKeywordTrendPoint[]): {
  growth: number | null;
  windowMonths: number;
  warning?: string;
} {
  const sorted = [...trend].sort((left, right) => left.month.localeCompare(right.month));
  const len = sorted.length;
  const windowMonths = Math.min(12, Math.floor(len / 2));
  if (windowMonths < 6) {
    return { growth: null, windowMonths: 0, warning: `仅 ${len} 个月趋势，不足以计算增速` };
  }
  const recent = sorted.slice(-windowMonths).reduce((sum, point) => sum + point.volume, 0);
  const prior = sorted.slice(-windowMonths * 2, -windowMonths).reduce((sum, point) => sum + point.volume, 0);
  if (prior <= 0) return { growth: null, windowMonths, warning: "前期搜索量为 0" };
  return { growth: recent / prior - 1, windowMonths };
}

function formatTrendGrowthNote(trend: ProductKeywordTrendPoint[], diagnosis: string) {
  const { growth, windowMonths, warning } = growthFromTrend(trend);
  if (growth != null) {
    const signed = `${growth >= 0 ? "+" : ""}${(growth * 100).toFixed(0)}%`;
    return `${W5_LABELS[diagnosis] ?? diagnosis} · 近${windowMonths}月 ${signed}`;
  }
  return warning ? `${W5_LABELS[diagnosis] ?? diagnosis} · ${warning}` : W5_LABELS[diagnosis] ?? diagnosis;
}

function growth3mFromTrend(trend: ProductKeywordTrendPoint[]) {
  if (trend.length < 6) return null;
  const sorted = [...trend].sort((left, right) => left.month.localeCompare(right.month));
  const recent = sorted.slice(-3).reduce((sum, point) => sum + point.volume, 0);
  const prior = sorted.slice(-6, -3).reduce((sum, point) => sum + point.volume, 0);
  if (prior <= 0) return null;
  return recent / prior - 1;
}

function diagnoseW5(yoy: number | null, growth3m: number | null) {
  const raw = yoy == null && growth3m == null ? null : (yoy ?? 0) * 0.6 + (growth3m ?? 0) * 0.4;
  if (raw == null) return "无趋势数据";
  if (raw >= 0.2) return "growing";
  if (raw <= -0.2) return "recent_weakening";
  return "mature_stable";
}

function quadrantLabel(s1: number, s3: number): KeywordDemandClusterComputed["quadrant"] {
  if (s1 >= 50 && s3 >= 50) return "主战场";
  if (s1 >= 50 && s3 < 50) return "红海";
  if (s1 < 50 && s3 >= 50) return "机会缝隙";
  return "暂缓区";
}

function demandClassLabel(sharePct: number, s1: number, s2: number, s3: number): KeywordDemandClusterComputed["demandClass"] {
  if (sharePct >= 10 || s1 >= 75) return "主流需求";
  if (sharePct < 10 && s1 < 75 && (s2 >= 60 || s3 >= 60)) return "细分需求";
  return "观察需求";
}

function validationTier(
  pvs: number,
  quadrant: KeywordDemandClusterComputed["quadrant"],
  w5Diagnosis: string,
): KeywordDemandClusterComputed["validationTier"] {
  if (w5Diagnosis === "structural_declining" || w5Diagnosis === "structural_declining_seasonal_dip") {
    return "P4";
  }
  if (pvs >= 70) return quadrant === "红海" ? "P2" : "P1";
  if (pvs >= 55) return quadrant === "暂缓区" ? "P3" : "P2";
  if (pvs >= 40) return "P3";
  return "P4";
}

function tierMethod(tier: KeywordDemandClusterComputed["validationTier"]) {
  if (tier === "P1") return "小批量试单 50–200 + SP 精准测词";
  if (tier === "P2") return "SP 长尾测词为主，极小单或不下单";
  if (tier === "P3") return "Listing 埋词 + 自然位监测，不投广告";
  return "不投入，保留监测";
}

function tierEffort(tier: KeywordDemandClusterComputed["validationTier"]) {
  if (tier === "P1") return "14 天";
  if (tier === "P2") return "7–14 天";
  if (tier === "P3") return "30 天";
  return "—";
}

function buildClusters(report: ProductKeywordSearchReport) {
  const drafts = new Map<string, ClusterDraft>();
  const rows = report.keywords.filter(row => row.keyword && row.monthlySearchVolume != null);
  const classifyContext = report.classifyContext ?? { productNouns: [report.productName] };

  rows.forEach(row => {
    const classified = classifyKeywordDetailed(row.keyword, classifyContext);
    if (classified.category === "brand_competitor" && !report.manualGroups) return;

    const manual = report.manualGroups?.[row.keyword];
    if (report.manualGroups && !manual) return;

    const manualDimensions=report.manualDimensions?.[row.keyword];
    const w1 = manualDimensions ? (manualDimensions.W1[0] ?? report.productName) : detectW1(row.keyword, report.productName);
    const w3 = manualDimensions ? (manualDimensions.W3[0] ?? null) : (detectW3(row.keyword) ?? (classified.category === "scenario" ? "场景词" : null));
    const w2 = manualDimensions ? (manualDimensions.W2[0] ?? null) : detectW2Label(row.keyword, classified.category);
    const w4Tag = W4_LABELS[classified.category];
    const id = manual?.id ?? `${w1}::${w3 ?? "通用"}::${w2 ?? ""}`;
    const name = manual?.name ?? `${w1}${w3 ? ` · ${w3}` : " · 通用"}${w2 ? ` · ${w2}` : ""}`;
    const existing = drafts.get(id) ?? {
      id,
      name,
      w1What: w1,
      w2Who: w2,
      w3Where: w3,
      w4Features: new Set<string>(),
      keywords: [],
      monthlySearches: 0,
      yoyGrowth: null,
      growth3m: null,
      ppcBid: null,
      w5Diagnosis: "无趋势数据",
    };

    existing.keywords.push(row.keyword);
    existing.monthlySearches += row.monthlySearchVolume ?? 0;
    if (manual) manual.features.forEach(feature=>existing.w4Features.add(feature));
    if (manualDimensions) manualDimensions.W4.forEach(feature=>existing.w4Features.add(feature));
    else if (w4Tag) existing.w4Features.add(w4Tag);

    const yoy = growthFromTrend(row.trend ?? []).growth;
    const g3 = growth3mFromTrend(row.trend ?? []);
    if (yoy != null) {
      existing.yoyGrowth =
        existing.yoyGrowth == null
          ? yoy
          : existing.monthlySearches === 0 ? null : (existing.yoyGrowth * (existing.monthlySearches - (row.monthlySearchVolume ?? 0)) +
              yoy * (row.monthlySearchVolume ?? 0)) /
            existing.monthlySearches;
    }
    if (g3 != null) {
      existing.growth3m =
        existing.growth3m == null
          ? g3
          : existing.monthlySearches === 0 ? null : (existing.growth3m * (existing.monthlySearches - (row.monthlySearchVolume ?? 0)) +
              g3 * (row.monthlySearchVolume ?? 0)) /
            existing.monthlySearches;
    }
    if (row.cpcExactBid != null) {
      existing.ppcBid =
        existing.ppcBid == null
          ? row.cpcExactBid
          : (existing.ppcBid + row.cpcExactBid) / 2;
    }
    existing.w5Diagnosis = diagnoseW5(existing.yoyGrowth, existing.growth3m);
    drafts.set(id, existing);
  });

  return [...drafts.values()];
}

function scoreClusters(clusters: ClusterDraft[]): KeywordDemandCluster[] {
  if (!clusters.length) return [];

  const monthly = clusters.map(cluster => cluster.monthlySearches);
  const yoy = clusters.map(cluster => cluster.yoyGrowth);
  const g3m = clusters.map(cluster => cluster.growth3m);
  const ppc = clusters.map(cluster => cluster.ppcBid);

  const medPpc = median(ppc.map(value => value ?? NaN).filter(Number.isFinite));

  const baseMonthly = monthly;
  const baseYoy = yoy.map(value => value ?? 0);
  const baseG3m = g3m.map(value => value ?? 0);
  const basePpc = ppc.map(value => value ?? medPpc);
  const totalMonthly = baseMonthly.reduce((sum, value) => sum + value, 0) || 1;

  const rawGrowths = clusters.map((_, index) => {
    if (yoy[index] == null && g3m[index] == null) return 0;
    if (yoy[index] == null) return baseG3m[index];
    if (g3m[index] == null) return baseYoy[index];
    return 0.6 * baseYoy[index] + 0.4 * baseG3m[index];
  });

  const compositeGrowthBase = clusters.map((_, index) => rawGrowths[index]);

  return clusters.map((cluster, index) => {
    const s1 = pct(baseMonthly, baseMonthly[index]);
    const s2 = pct(compositeGrowthBase, rawGrowths[index]);
    const s3 = 50;
    const s4 = 0.5 * pct(basePpc.map(value => -value), -basePpc[index]) + 0.5 * 50;
    const s5 = 50;
    const pvs = 0.28 * s1 + 0.22 * s2 + 0.2 * s3 + 0.18 * s4 + 0.12 * s5;
    const sharePct = (baseMonthly[index] / totalMonthly) * 100;
    const quadrant = quadrantLabel(s1, s3);
    const demandClass = demandClassLabel(sharePct, s1, s2, s3);
    const tier = validationTier(pvs, quadrant, cluster.w5Diagnosis);
    const warnings = [
      "⚠ 竞争度未验证（缺供需比/ABA Top3）",
      cluster.yoyGrowth == null || cluster.growth3m == null ? "⚠ 增速不完整" : "",
      "⚠ 价值空间未验证（缺均价）",
    ].filter(Boolean);

    return {
      ...cluster,
      w4Features: [...cluster.w4Features],
      computed: {
        rawGrowth: rawGrowths[index],
        s1,
        s2,
        s3,
        s4,
        s5,
        pvs,
        sharePct,
        quadrant,
        demandClass,
        validationTier: tier,
        warnings,
      },
    };
  });
}

function detectW4Family(keyword: string) {
  return W4_FAMILIES.find(entry => entry.pattern.test(keyword))?.label ?? null;
}

function assignedDimensionLabels(manual: ManualDimensions | undefined, keyword: string, dimension: keyof ManualDimensions[string]): string[] | undefined {
  const assignment = manual?.[keyword];
  return assignment ? assignment[dimension] : undefined;
}

function aggregateDimensionRows(
  rows: ProductKeywordRow[],
  productSeed: string,
  pickLabel: (keyword: string, classified: ReturnType<typeof classifyKeywordDetailed>) => string | readonly string[] | null,
  totalVolume: number,
) {
  const buckets = new Map<string, { keywords: string[]; monthlySearches: number }>();

  rows.forEach(row => {
    const classified = classifyKeywordDetailed(row.keyword, { productNouns: [productSeed] });
    if (classified.category === "brand_competitor") return;
    const labels = pickLabel(row.keyword, classified);
    if (!labels || (Array.isArray(labels) && !labels.length)) return;
    for (const label of (Array.isArray(labels) ? labels : [labels])) {
      const existing = buckets.get(label) ?? { keywords: [], monthlySearches: 0 };
      existing.keywords.push(row.keyword);
      existing.monthlySearches += row.monthlySearchVolume ?? 0;
      buckets.set(label, existing);
    }
  });

  return [...buckets.entries()]
    .map(([label, bucket]) => ({
      label,
      keywords: bucket.keywords.sort((left, right) => left.localeCompare(right)),
      monthlySearches: bucket.monthlySearches,
      sharePct: totalVolume > 0 ? (bucket.monthlySearches / totalVolume) * 100 : 0,
    }))
    .sort((left, right) => right.monthlySearches - left.monthlySearches);
}

function buildW1Summary(rows: ProductKeywordRow[], productSeed: string, totalVolume: number, manual?: ManualDimensions): KeywordDemandDimensionSummary {
  const dimensionRows = aggregateDimensionRows(rows, productSeed, keyword => assignedDimensionLabels(manual, keyword, 'W1') ?? detectW1(keyword, productSeed), totalVolume);
  const top = dimensionRows[0];
  const second = dimensionRows[1];
  const topShare = top?.sharePct ?? 0;

  let conclusion = "样本内未识别到明确产品形态。";
  if (top) {
    conclusion =
      topShare >= 30
        ? `需求主干为「${top.label}」（约 ${topShare.toFixed(1)}% 样本搜索量），需作为产品线核心。`
        : `产品形态较分散，「${top.label}」仅占约 ${topShare.toFixed(1)}%，需同时覆盖多个同义入口。`;
    if (second && second.sharePct >= 7) {
      conclusion += ` 同时须覆盖「${second.label}」（约 ${second.sharePct.toFixed(1)}%），避免丢失上位/同义词流量。`;
    }
  }

  return {
    id: "W1",
    title: "W1 What",
    question: "用户需要什么产品？",
    conclusion,
    rows: dimensionRows,
  };
}

function buildW2Summary(rows: ProductKeywordRow[], productSeed: string, totalVolume: number, manual?: ManualDimensions): KeywordDemandDimensionSummary {
  let matchedKeywordCount = 0;
  const dimensionRows = aggregateDimensionRows(
    rows,
    productSeed,
    (keyword, classified) => {
      const labels = assignedDimensionLabels(manual, keyword, 'W2');
      if (labels !== undefined) { if (labels.length) matchedKeywordCount += 1; return labels; }
      const label = detectW2Label(keyword, classified.category);
      if (label) matchedKeywordCount += 1;
      return label;
    },
    totalVolume,
  );
  const coveredShare = dimensionRows.reduce((sum, row) => sum + row.sharePct, 0);
  const coverageNote = `基于上方 ${rows.length} 条扩展词 · 识别 ${matchedKeywordCount} 条含人群词 · 人群词占样本 ${coveredShare.toFixed(1)}%`;

  let conclusion = "样本几乎无明确人群词，需求默认面向家庭通用用户，不宜强行细分年龄/性别。";
  if (dimensionRows.length) {
    const top = dimensionRows[0];
    conclusion =
      coveredShare < 5
        ? `人群信号极弱（合计 < 5%），仅见「${top.label}」等零散词，默认家庭通用定位。`
        : `「${top.label}」人群信号最强（约 ${top.sharePct.toFixed(1)}%）；含人群词合计约 ${coveredShare.toFixed(1)}%，均来自上方同一批扩展词。`;
  }

  return {
    id: "W2",
    title: "W2 Who",
    question: "谁在使用？",
    conclusion,
    rows: dimensionRows,
    dataQuality: coverageNote,
  };
}

function buildW3Summary(rows: ProductKeywordRow[], productSeed: string, totalVolume: number, manual?: ManualDimensions): KeywordDemandDimensionSummary {
  const dimensionRows = aggregateDimensionRows(
    rows,
    productSeed,
    keyword => {
      const labels = assignedDimensionLabels(manual, keyword, 'W3');
      if (labels !== undefined) return labels;
      const w3 = detectW3(keyword);
      if (w3) return w3;
      const classified = classifyKeywordDetailed(keyword, { productNouns: [productSeed] });
      return classified.category === "scenario" ? "其他场景" : null;
    },
    totalVolume,
  );

  let conclusion = "样本内无明确场景词，Listing 需按通用家居场景表达。";
  if (dimensionRows.length) {
    const [top, second] = dimensionRows;
    conclusion = `场景需求清晰：「${top.label}」为首要切入口（约 ${top.sharePct.toFixed(1)}%）。`;
    if (second) {
      conclusion += ` 「${second.label}」为第二场景（约 ${second.sharePct.toFixed(1)}%）。`;
    }
    conclusion += " 含 W3 的词属于场景需求，开发价值通常高于纯属性词。";
  }

  return {
    id: "W3",
    title: "W3 Where",
    question: "用在什么地方？",
    conclusion,
    rows: dimensionRows,
    dataQuality: dimensionRows.length ? undefined : "样本无 W3 场景词素",
  };
}

function buildW4Summary(rows: ProductKeywordRow[], productSeed: string, totalVolume: number, manual?: ManualDimensions): KeywordDemandDimensionSummary {
  const buckets = new Map<string, { keywords: string[]; monthlySearches: number }>();

  rows.forEach(row => {
    const classified = classifyKeywordDetailed(row.keyword, { productNouns: [productSeed] });
    if (classified.category === "brand_competitor") return;

    const assigned = assignedDimensionLabels(manual, row.keyword, 'W4');
    const labels = assigned ?? [detectW4Family(row.keyword) ?? W4_LABELS[classified.category]].filter((label): label is string => Boolean(label));
    for (const label of labels) {
      const existing = buckets.get(label) ?? { keywords: [], monthlySearches: 0 };
      existing.keywords.push(row.keyword);
      existing.monthlySearches += row.monthlySearchVolume ?? 0;
      buckets.set(label, existing);
    }
  });

  const dimensionRows = [...buckets.entries()]
    .map(([label, bucket]) => ({
      label,
      keywords: bucket.keywords.sort((left, right) => left.localeCompare(right)),
      monthlySearches: bucket.monthlySearches,
      sharePct: totalVolume > 0 ? (bucket.monthlySearches / totalVolume) * 100 : 0,
    }))
    .sort((left, right) => right.monthlySearches - left.monthlySearches);

  let conclusion = "样本内属性/功能词较弱，差异化宜从 VOC 与竞品规格补证。";
  if (dimensionRows.length) {
    const topLabels = dimensionRows.slice(0, 2).map(row => row.label);
    const topShare = dimensionRows.slice(0, 2).reduce((sum, row) => sum + row.sharePct, 0);
    conclusion = `功能/属性切口集中在「${topLabels.join("、")}」（合计约 ${topShare.toFixed(1)}%），宜写入五点与 A+，但规模通常低于场景词。`;
  }

  return {
    id: "W4",
    title: "W4 Which",
    question: "关注什么功能/属性？",
    conclusion,
    rows: dimensionRows,
    dataQuality: dimensionRows.length ? undefined : "样本无 W4 属性词素",
  };
}

function buildW5Summary(
  rows: ProductKeywordRow[],
  totalVolume: number,
  trendEnrichedCount: number,
  scoredClusters: KeywordDemandCluster[],
): KeywordDemandDimensionSummary {
  const withTrend = rows.filter(row => row.trend.length >= 6);
  const yoyValues = withTrend
    .map(row => growthFromTrend(row.trend).growth)
    .filter((value): value is number => value != null);
  const g3Values = withTrend
    .map(row => growth3mFromTrend(row.trend ?? []))
    .filter((value): value is number => value != null);

  const avgYoy = yoyValues.length ? yoyValues.reduce((sum, value) => sum + value, 0) / yoyValues.length : null;
  const avgG3 = g3Values.length ? g3Values.reduce((sum, value) => sum + value, 0) / g3Values.length : null;
  const poolDiagnosis = diagnoseW5(avgYoy, avgG3);

  const trendRows: KeywordDemandDimensionRow[] = withTrend
    .map(row => {
      const yoy = growthFromTrend(row.trend).growth;
      const g3 = growth3mFromTrend(row.trend ?? []);
      const diagnosis = diagnoseW5(yoy, g3);
      return {
        label: row.keyword,
        keywords: [row.keyword],
        monthlySearches: row.monthlySearchVolume ?? 0,
        sharePct: totalVolume > 0 ? ((row.monthlySearchVolume ?? 0) / totalVolume) * 100 : 0,
        note: formatTrendGrowthNote(row.trend, diagnosis),
      };
    })
    .sort((left, right) => right.monthlySearches - left.monthlySearches)
    .slice(0, 8);

  const diagnosisCounts = scoredClusters.reduce<Record<string, number>>((acc, cluster) => {
    acc[cluster.w5Diagnosis] = (acc[cluster.w5Diagnosis] ?? 0) + 1;
    return acc;
  }, {});

  let conclusion = "趋势尚未补拉，W5 不参与定量判断，验证动作维持 P2/P3。";
  if (trendEnrichedCount > 0) {
    const label = W5_LABELS[poolDiagnosis] ?? poolDiagnosis;
    conclusion = `已补拉 ${trendEnrichedCount}/${rows.length} 条趋势，池级判读「${label}」。`;
    if (poolDiagnosis === "growing") {
      conclusion += " 可优先小单验证，但需结合竞争度再定备货。";
    } else if (poolDiagnosis === "mature_stable") {
      conclusion += " 靠差异化抢份额，不靠增量扩张。";
    } else if (poolDiagnosis === "recent_weakening") {
      conclusion += " 缩小试单规模，避免扩产。";
    }
    const declining = diagnosisCounts.structural_declining ?? 0;
    if (declining > 0) {
      conclusion += ` ${declining} 个需求簇呈结构性下滑，应标记 P4。`;
    }
  }

  const seasonTags = [...new Set(rows.map(row => row.peakSeason).filter(Boolean))];
  const dataQuality =
    trendEnrichedCount === 0
      ? "无趋势数据 · 数据源 Sorftime keyword_trend"
      : trendEnrichedCount < rows.length
        ? `部分趋势 · ${trendEnrichedCount}/${rows.length} · 增速=近N月等长窗口对比（非日历年同比）`
        : seasonTags.length === 1 && seasonTags[0] === "均衡"
          ? "季节标签均为「均衡」· 增速=近N月等长窗口对比（非日历年同比）"
          : "数据源 Sorftime keyword_trend · 增速=近N月等长窗口对比（非日历年同比）";

  return {
    id: "W5",
    title: "W5 How",
    question: "需求如何变化？",
    conclusion,
    rows: trendRows,
    dataQuality,
  };
}

function buildSynthesis(
  w1: KeywordDemandDimensionSummary,
  w2: KeywordDemandDimensionSummary,
  w3: KeywordDemandDimensionSummary,
  w4: KeywordDemandDimensionSummary,
  w5: KeywordDemandDimensionSummary,
  clusters: KeywordDemandCluster[],
): KeywordDemandSynthesis {
  const topW1 = w1.rows[0]?.label ?? "未知形态";
  const topW3 = w3.rows[0]?.label;
  const topW4 = w4.rows[0]?.label;

  const bullets = [
    `W1：以「${topW1}」为主线，同步覆盖样本内其他同义/上位形态。`,
    w2.rows.length
      ? `W2：存在「${w2.rows[0].label}」等人群词，但规模有限，默认家庭通用。`
      : "W2：无强人群信号，不做儿童/老人等窄人群首推。",
    topW3
      ? `W3：首选「${topW3}」场景切入，场景图与结构需对应使用环境。`
      : "W3：场景词不足，先用通用家居表达。",
    topW4
      ? `W4：优先验证「${topW4}」等功能/属性卖点。`
      : "W4：属性词弱，差异化从 VOC 补证。",
    w5.dataQuality?.includes("无趋势")
      ? "W5：趋势未齐，备货与扩产决策暂缓。"
      : `W5：${w5.conclusion}`,
  ];

  const headline =
    topW3 && topW4
      ? `建议以「${topW1} · ${topW3} · ${topW4}」作为首批验证表达式，规模优先看 W1+W3，差异化看 W4。`
      : topW3
        ? `建议以「${topW1} · ${topW3}」作为首批验证表达式，W4 作 Listing 强化。`
        : `建议以「${topW1}」通用主线验证，待 W3/W4 词证补齐后再切场景/属性款。`;

  return {
    headline,
    bullets,
    clusters: clusters.slice(0, 8),
  };
}

function mergeSmallClusters(clusters: KeywordDemandCluster[], totalVolume: number) {
  const threshold = totalVolume * 0.01;
  const kept: KeywordDemandCluster[] = [];
  const absorbed: KeywordDemandCluster[] = [];

  clusters.forEach(cluster => {
    if (cluster.monthlySearches >= threshold || cluster.computed.s2 >= 60) {
      kept.push(cluster);
    } else {
      absorbed.push(cluster);
    }
  });

  if (!kept.length && clusters.length) {
    return [clusters.sort((left, right) => right.monthlySearches - left.monthlySearches)[0]];
  }

  absorbed.forEach(cluster => {
    const parent =
      kept.find(item => item.w1What === cluster.w1What && item.w3Where === cluster.w3Where) ??
      kept.find(item => item.w1What === cluster.w1What) ??
      kept[0];
    if (!parent) return;
    parent.keywords.push(...cluster.keywords);
    parent.monthlySearches += cluster.monthlySearches;
    cluster.w4Features.forEach(feature => parent.w4Features.push(feature));
  });

  return kept.sort((left, right) => right.monthlySearches - left.monthlySearches);
}

export function buildAmazonKeywordDemandReport(report: ProductKeywordSearchReport): AmazonKeywordDemandReport {
  const rows = report.keywords.filter(row => row.keyword && row.monthlySearchVolume != null);
  if (!rows.length) {
    const emptyDimension = (id: "W1" | "W2" | "W3" | "W4" | "W5", title: string, question: string): KeywordDemandDimensionSummary => ({
      id,
      title,
      question,
      conclusion: "暂无数据",
      rows: [],
    });
    return {
      skillName: "amazon-keyword-demand-analysis",
      status: "insufficient_data",
      scope: {
        marketplace: report.marketplace,
        productScope: report.productName,
        source: "Sorftime keyword_extends",
        sampleCount: 0,
        totalMonthlyVolume: 0,
        trendEnrichedCount: 0,
      },
      sampleWarning: null,
      dataNotes: ["缺少有效关键词样本"],
      dimensions: {
        w1: emptyDimension("W1", "W1 What", "用户需要什么产品？"),
        w2: emptyDimension("W2", "W2 Who", "谁在使用？"),
        w3: emptyDimension("W3", "W3 Where", "用在什么地方？"),
        w4: emptyDimension("W4", "W4 Which", "关注什么功能/属性？"),
        w5: emptyDimension("W5", "W5 How", "需求如何变化？"),
      },
      synthesis: { headline: "暂无足够样本", bullets: [], clusters: [] },
      mainstream: [],
      niche: [],
      developmentDirections: [],
      validationPriorities: [],
    };
  }

  const totalVolume = rows.reduce((sum, row) => sum + (row.monthlySearchVolume ?? 0), 0);
  const trendEnrichedCount = rows.filter(row => row.trend.length > 0).length;
  const drafts = buildClusters(report);
  let scored = scoreClusters(drafts);
  scored = report.manualGroups ? scored.sort((a,b)=>b.monthlySearches-a.monthlySearches) : mergeSmallClusters(scored, totalVolume);

  const mainstream = scored.filter(cluster => cluster.computed.demandClass === "主流需求");
  const niche = scored.filter(cluster => cluster.computed.demandClass === "细分需求");

  const w1 = buildW1Summary(rows, report.productName, totalVolume, report.manualDimensions);
  const w2 = buildW2Summary(rows, report.productName, totalVolume, report.manualDimensions);
  const w3 = buildW3Summary(rows, report.productName, totalVolume, report.manualDimensions);
  const w4 = buildW4Summary(rows, report.productName, totalVolume, report.manualDimensions);
  const w5 = buildW5Summary(rows, totalVolume, trendEnrichedCount, scored);
  const synthesis = buildSynthesis(w1, w2, w3, w4, w5, scored);

  const developmentDirections: KeywordDemandDevelopmentRow[] = scored
    .filter(cluster => cluster.computed.validationTier === "P1" || cluster.computed.validationTier === "P2")
    .slice(0, 6)
    .map(cluster => ({
      direction: cluster.w4Features.length
        ? `${cluster.name} · 强化${cluster.w4Features.join("/")}`
        : `${cluster.name} 主需求验证`,
      evidence: `${cluster.keywords.slice(0, 3).join("、")} · ${Math.round(cluster.monthlySearches).toLocaleString()}/月`,
      priority: cluster.computed.validationTier,
      feasibility:
        cluster.computed.quadrant === "红海"
          ? "需差异化卖点后再切入"
          : cluster.computed.quadrant === "机会缝隙"
            ? "适合小单/变体试水"
            : "可按标准链接验证",
    }));

  const validationPriorities: KeywordDemandValidationRow[] = scored
    .filter(cluster => cluster.computed.validationTier !== "P4")
    .slice(0, 8)
    .map(cluster => ({
      hypothesis: cluster.name,
      method: tierMethod(cluster.computed.validationTier),
      tier: cluster.computed.validationTier,
      effort: tierEffort(cluster.computed.validationTier),
      quadrant: cluster.computed.quadrant,
    }));

  return {
    skillName: "amazon-keyword-demand-analysis",
    status: trendEnrichedCount > 0 ? "ok" : "partial",
    scope: {
      marketplace: report.marketplace,
      productScope: report.productName,
      source: "Sorftime keyword_extends",
      sampleCount: rows.length,
      totalMonthlyVolume: totalVolume,
      trendEnrichedCount,
    },
    sampleWarning: rows.length < 30 ? "样本量不足（< 30），结论仅供参考" : null,
    dataNotes: [
      `数据来自页面 Sorftime 扩展词缓存，非全类目词池`,
      trendEnrichedCount > 0
        ? `趋势已补拉 ${trendEnrichedCount}/${rows.length}，W5 采用 Sorftime 月搜索量等长窗口增速（非日历年同比）`
        : "趋势尚未补拉完成，W5 标记为无趋势数据",
      "S3/S5 缺 Sorftime 供需比与均价，按中性分位估算并标注 ⚠",
    ],
    dimensions: { w1, w2, w3, w4, w5 },
    synthesis,
    mainstream,
    niche,
    developmentDirections,
    validationPriorities,
  };
}

/** @deprecated use buildAmazonKeywordDemandReport */
export const buildProductKeywordDemandAnalysis = buildAmazonKeywordDemandReport;
