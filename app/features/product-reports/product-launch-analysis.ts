import { sorftimeSalesTrendData, sorftimeSalesTrendMeta } from "../../sorftime-sales-trend-data";
import {
  buildVocDevelopmentSummary,
  hasVocDevelopmentData,
  type VocDevelopmentDimensionSummary,
  type VocThemeAggregate,
} from "../voc/voc-development-summary";
import { canonicalTheme } from "../voc/voc-theme-merge";
import {
  legacyNegativePriorityDisplay,
  legacyPositivePriorityDisplay,
} from "../../../server/domain/voc/priority-rules";
import { buildLaunchChecklist, launchChecklistMeta, type LaunchChecklistGroup, type LaunchChecklistResearchContext } from "./launch-checklist";
import { buildVocPositioningConclusion, type VocPositioningConclusion } from "../voc/voc-positioning";
import { familyFromProducts, type ProductFamily } from "../../lib/product-family";
import type { KeywordDemandAnalysis } from "../keywords/keyword-demand-analysis";
import {
  buildKeywordLaunchConclusions,
  type KeywordLaunchConclusions,
} from "../keywords/keyword-demand-conclusions";
import type { ManualAlexaVocNormalizedRecord } from "../../../shared/agent-contracts";

export type LaunchProductInput = {
  asin: string;
  brand: string;
  title?: string;
  price?: number | null;
  sales?: number | null;
  rating?: number | null;
  reviews?: number | null;
  launch?: string | null;
  subRankCategory?: string;
  rankCategory?: string;
  productFamily?: "scooter" | "lighting" | "generic";
};

export type ProductLaunchRuntimeSources = Readonly<{
  manualVocByAsin: Readonly<Record<string, ManualAlexaVocNormalizedRecord | undefined>>;
  keywordDemand: KeywordDemandAnalysis | null;
}>;

export type LaunchVerdict = "approve" | "conditional" | "hold";

export type LaunchConclusionRow = {
  question: string;
  answer: string;
};

export type DimensionAnchor = {
  dimension: string;
  topThemes: string;
  insight: string;
};

export type CrossAnalysisRow = {
  anchor: string;
  left: string;
  right: string;
  insight: string;
};

export type CrossAnalysisSection = {
  id: string;
  title: string;
  subtitle: string;
  rows: CrossAnalysisRow[];
  conclusion: string;
};

export type OpportunityScore = {
  id: string;
  name: string;
  frequency: number;
  pain: number;
  market: number;
  gap: number;
  differentiation: number;
  premium: number;
  feasibility: number;
  costImpact: number;
  compliance: number;
  /** 1–5 加权均值，供内部阈值与 checklist 使用 */
  priority: number;
  /** 0–100 分制（priority×20），对齐 VOC 洞察 Skill 分档 */
  priorityScore: number;
  demandEvidence: string;
  marketEvidence: string;
  recommendation: string;
  tier: "P0" | "P1" | "P2";
};

export type VocInsightRow = {
  dimension: string;
  label: string;
  mentionPct: string;
  feedback: string;
  impact: "高" | "中" | "低";
  implication: string;
};

export type NegativePriorityRow = {
  issue: string;
  frequency: string;
  severity: "高" | "中" | "低";
  industryWide: string;
  impactStages: string;
  shouldFix: string;
  fixDirection: string;
};

/** 买家喜爱优先级表（对齐亚马逊「买家喜爱什么」） */
export type PositivePriorityRow = {
  theme: string;
  detail: string;
  frequency: string;
  valueLevel: "高" | "中" | "低";
  industryWide: string;
  impactStages: string;
  shouldKeep: string;
  leverageDirection: string;
};

export type UnmetOpportunityRow = {
  need: string;
  audience: string;
  scenario: string;
  competitorStatus: string;
  marketValue: string;
  difficulty: string;
  proposal: string;
};

export type FinalDecision = "优先立项" | "建议小批量测试" | "继续观察" | "暂不开发";

export type FinalAnswerRow = {
  question: string;
  answer: string;
};

export type ProductDirectionProposal = {
  id: string;
  directionName: string;
  positioning: string;
  targetAudience: string;
  coreScenarios: string;
  painPoints: string;
  baseFeatures: string;
  differentiatedFeatures: string;
  avoidFeatures: string;
  materialStructure: string;
  accessoryBundle: string;
  priceRange: string;
  coreSellingPoints: string;
  competitorDifference: string;
  qualityRisks: string;
  complianceRisks: string;
  developmentDifficulty: string;
  launchPriority: string;
};

export const productDirectionFieldLabels: Array<{ key: keyof Omit<ProductDirectionProposal, "id" | "directionName">; label: string }> = [
  { key: "positioning", label: "产品定位" },
  { key: "targetAudience", label: "核心目标人群" },
  { key: "coreScenarios", label: "核心使用场景" },
  { key: "painPoints", label: "要解决的主要痛点" },
  { key: "baseFeatures", label: "必须保留的基础功能" },
  { key: "differentiatedFeatures", label: "建议增加的差异化功能" },
  { key: "avoidFeatures", label: "不建议增加的伪需求或高成本功能" },
  { key: "materialStructure", label: "建议材质、结构、尺寸或配置" },
  { key: "accessoryBundle", label: "建议配件组合" },
  { key: "priceRange", label: "建议价格带" },
  { key: "coreSellingPoints", label: "核心卖点" },
  { key: "competitorDifference", label: "与现有竞品的差异" },
  { key: "qualityRisks", label: "潜在质量风险" },
  { key: "complianceRisks", label: "潜在合规与专利风险" },
  { key: "developmentDifficulty", label: "开发难度" },
  { key: "launchPriority", label: "立项优先级" },
];

export type DefinitionSynthesisEvidence = {
  source: "关键词需求分析" | "竞品 VOC 洞察" | "产品机会评分";
  point: string;
};

export type DefinitionSynthesis = {
  headline: string;
  vocSummary: string;
  keywordSummary: string;
  mergedConclusion: string;
  recommendedName: string;
  recommendedDirection: string;
  decision: FinalDecision;
  evidence: DefinitionSynthesisEvidence[];
  dataGaps: string[];
};

export type ProductLaunchAnalysis = {
  meta: {
    productCount: number;
    brands: string[];
    categoryLabel: string;
    dataMonth: string;
    sources: string[];
    analyzedAt: string;
  };
  /** ≤300 字执行摘要（Skill §1） */
  executiveSummary: string;
  verdict: {
    status: LaunchVerdict;
    title: string;
    summary: string;
    reasons: string[];
  };
  conclusions: LaunchConclusionRow[];
  /** VOC 洞察汇总表（Skill §2） */
  vocInsightRows: VocInsightRow[];
  dimensionAnchors: DimensionAnchor[];
  /** 差评问题优先级表（Skill §3） */
  negativePriorityRows: NegativePriorityRow[];
  /** 买家喜爱优先级表（对齐亚马逊「买家喜爱什么」） */
  positivePriorityRows: PositivePriorityRow[];
  /** 未满足需求机会表（Skill §4） */
  unmetOpportunityRows: UnmetOpportunityRow[];
  /** VOC 三表合并产品定位结论（define-amazon-voc-positioning） */
  vocPositioning: VocPositioningConclusion;
  crossAnalyses: CrossAnalysisSection[];
  marketRows: Array<{ metric: string; data: string; judgment: string }>;
  supplyRows: Array<{ direction: string; feasibility: string; risk: string }>;
  opportunities: OpportunityScore[];
  productDefinition: {
    name: string;
    mustHave: string[];
    niceToHave: string[];
    avoid: string[];
    targetPrice: string;
  };
  productDirections: ProductDirectionProposal[];
  /** 关键词 × VOC 汇总后的产品定义结论 */
  definitionSynthesis: DefinitionSynthesis;
  keywordConclusions: KeywordLaunchConclusions | null;
  /** 最终开品结论九问（Skill §7） */
  finalAnswers: FinalAnswerRow[];
  finalDecision: FinalDecision;
  checklist: LaunchChecklistGroup[];
  checklistMeta: {
    verticalLabel: string;
    policy: string;
    totalItems: number;
    version: string;
  };
  checklistResearch: LaunchChecklistResearchContext;
};

type DimKey = "attention" | "positives" | "negatives" | "unmet" | "audiences" | "scenarios" | "motives";

type SummaryMap = Map<DimKey, VocDevelopmentDimensionSummary>;

function formatPct(value: number) {
  return value >= 1 ? value.toFixed(1) : value.toFixed(2);
}

function themePct(themes: VocThemeAggregate[], pattern: RegExp, dimension: DimKey) {
  const match = themes.find(theme => pattern.test(theme.label) || pattern.test(canonicalTheme(theme.label, dimension).label));
  return match?.mentionPct ?? 0;
}

function findTheme(themes: VocThemeAggregate[], pattern: RegExp, dimension: DimKey) {
  return themes.find(theme => pattern.test(theme.label) || pattern.test(canonicalTheme(theme.label, dimension).label));
}

function topLabels(themes: VocThemeAggregate[], count = 5) {
  return themes.slice(0, count).map(theme => theme.label);
}

function topThemesWithPct(themes: VocThemeAggregate[], count = 4) {
  return themes
    .slice(0, count)
    .map(theme => `${theme.label} ${formatPct(theme.mentionPct)}%`)
    .join(" · ");
}

function calcPriority(scores: Pick<OpportunityScore, "frequency" | "pain" | "market" | "gap" | "differentiation" | "premium" | "feasibility">) {
  return (
    scores.frequency * 0.2 +
    scores.pain * 0.2 +
    scores.market * 0.15 +
    scores.gap * 0.15 +
    scores.differentiation * 0.15 +
    scores.premium * 0.1 +
    scores.feasibility * 0.05
  );
}

function latestSorftimeVolume(asin: string) {
  const record = sorftimeSalesTrendData[asin];
  if (!record || record.status !== "ready" || !record.volume.length) return null;
  const latest = record.volume[record.volume.length - 1];
  return latest;
}

function inferCategoryLabel(products: LaunchProductInput[]) {
  const fromProduct = products.find(product => product.subRankCategory && product.subRankCategory !== "等待同步")?.subRankCategory;
  return fromProduct ?? "当前对标类目";
}

function buildMarketContext(products: LaunchProductInput[]) {
  const rows = products.map(product => {
    const trend = latestSorftimeVolume(product.asin);
    const sales = trend?.value ?? product.sales ?? 0;
    return {
      brand: product.brand,
      asin: product.asin,
      sales,
      month: trend?.month,
      price: product.price,
    };
  });

  const totalSales = rows.reduce((sum, row) => sum + row.sales, 0);
  const priced = rows.filter(row => row.price !== null && row.price !== undefined);
  const minPrice = priced.length ? Math.min(...priced.map(row => row.price!)) : null;
  const maxPrice = priced.length ? Math.max(...priced.map(row => row.price!)) : null;
  const leader = [...rows].sort((a, b) => b.sales - a.sales)[0];
  const dataMonth = rows.find(row => row.month)?.month ?? sorftimeSalesTrendMeta.updatedAt;

  return { rows, totalSales, minPrice, maxPrice, leader, dataMonth };
}

function conceptStrength(summary: SummaryMap, patterns: RegExp[], dimensions: DimKey[]) {
  let weight = 0;
  dimensions.forEach(dimension => {
    const themes = summary.get(dimension)?.themes ?? [];
    patterns.forEach(pattern => {
      const theme = findTheme(themes, pattern, dimension);
      if (theme) weight += theme.mentionPct / 100;
    });
  });
  return weight;
}

function buildConclusions(summary: SummaryMap, market: ReturnType<typeof buildMarketContext>): LaunchConclusionRow[] {
  const attention = summary.get("attention")?.themes ?? [];
  const negatives = summary.get("negatives")?.themes ?? [];
  const unmet = summary.get("unmet")?.themes ?? [];
  const motives = summary.get("motives")?.themes ?? [];

  const concernOrder = topLabels(attention, 5).join(" > ");
  const negTop = findTheme(negatives, /耐用|结构/, "negatives");
  const unmetTop = findTheme(unmet, /耐用|结构|备件/, "unmet");
  const leanNeg = findTheme(negatives, /lean|转向/, "negatives");
  const spares = findTheme(unmet, /备件|售后/, "unmet");

  const commonProblems = [
    negTop ? `${negTop.label}（维度内 ${formatPct(negTop.mentionPct)}%）` : topLabels(negatives, 2).join("、"),
    leanNeg ? "Lean-to-steer 学习门槛偏高" : null,
    spares ? "备件/售后渠道不足" : "售后与备件响应慢",
  ]
    .filter(Boolean)
    .join(" + ");

  const unmetAnswer =
    unmetTop && spares
      ? `「${unmetTop.label} + ${spares.label}」— 差评 ${negTop ? formatPct(negTop.mentionPct) : "—"}% / 未满足 ${formatPct(unmetTop.mentionPct)}% 维度内权重`
      : unmetTop
        ? `「${unmetTop.label}」— 未满足维度内 ${formatPct(unmetTop.mentionPct)}%`
        : topLabels(unmet, 2).join("、");

  const direction =
    "「可维护的耐用入门产品」：加强结构/连接件 + 官方备件包 + 低龄友好转向说明/限位 + 保留 LED/礼物属性，不做纯噱头款";

  const verdictMarket =
    market.totalSales >= 8000
      ? `样本竞品合计约 ${Math.round(market.totalSales / 1000) * 1000}+ 件/月`
      : market.totalSales > 0
        ? `样本竞品合计约 ${market.totalSales.toLocaleString()} 件/月`
        : "待 Sorftime 销量同步";

  return [
    {
      question: "类目消费者最关注什么",
      answer: concernOrder || "待 VOC 数据就绪后归纳",
    },
    {
      question: "竞品最大共同问题",
      answer: commonProblems || topLabels(negatives, 3).join("、"),
    },
    {
      question: "最有价值的未满足需求",
      answer: unmetAnswer,
    },
    {
      question: "最值得开发的产品方向",
      answer: direction,
    },
    {
      question: "是否建议立项",
      answer: `建议立项 — ${verdictMarket}，痛点清晰；避开同质化红海，以「可靠 + 可维护」切位`,
    },
  ];
}

function impactLevel(pct: number): "高" | "中" | "低" {
  if (pct >= 15) return "高";
  if (pct >= 8) return "中";
  return "低";
}

function scoreBand(priorityScore: number): FinalDecision {
  if (priorityScore >= 80) return "优先立项";
  if (priorityScore >= 65) return "建议小批量测试";
  if (priorityScore >= 50) return "继续观察";
  return "暂不开发";
}

function opportunityRecommendation(priorityScore: number, tier: OpportunityScore["tier"]): string {
  const band = scoreBand(priorityScore);
  if (band === "优先立项") return `${tier} · 优先立项`;
  if (band === "建议小批量测试") return `${tier} · 建议验证 / 小批量测试`;
  if (band === "继续观察") return `${tier} · 谨慎开发`;
  return `${tier} · 暂不建议开发`;
}

function inferNegativeImpactStages(label: string): string {
  const stages: string[] = [];
  if (/包装|缺件|货不对|描述/.test(label)) stages.push("转化", "差评");
  if (/耐用|结构|质量|轮|灯|led|漏气|充气|reliability|quality/i.test(label)) stages.push("退货", "差评", "复购");
  if (/安装|组装|assembly|install/i.test(label)) stages.push("差评", "推荐");
  if (/安全|稳/.test(label)) stages.push("转化", "退货", "差评");
  if (/lean|转向|ease|handle|尺寸|适配|踏板|deck|size|操控/i.test(label)) stages.push("差评", "复购");
  if (/价格|性价比/.test(label)) stages.push("点击", "转化");
  return [...new Set(stages)].join("、") || "差评";
}

/**
 * 差评「解决方向」：对齐亚马逊 Product Opportunity / 主要投诉「如何解决」口径——
 * 给出可落地的产品改动 + Listing/包装动作，禁止「有助于…但未说明…」式空话。
 * 无法映射到明确动作时返回「需人工介入：…」。
 */
function inferScooterFixDirection(label: string): string {
  const text = label.trim();

  // 转向 / Lean-to-steer / 操控 / Ease of use
  if (/lean|转向|ease\s*of\s*use|操控|难转|转不动|学习曲线|handle\s*quality|倾斜转向/i.test(text)) {
    return [
      "产品：前叉加可调阻尼（出厂「初学档」偏软）+ 低龄限位块（限制最大倾斜角）；2–4 岁 SKU 可选更低 Deck",
      "包装：盒内插页 + QR 30 秒 Lean-to-steer 教学视频（站姿/重心示意）",
      "Listing：主图/A+ 放转向动图；五点写清适龄与「倾斜转向需练习 5–10 分钟」预期",
    ].join("；");
  }

  // 组装 / 安装
  if (/安装|组装|assembly|install/i.test(text)) {
    return [
      "产品：立管预装或免工具快拆；零件按 ①②③ 编号；盒内附对应规格六角扳手",
      "包装：一张图文「三步装完」卡 + QR 安装视频；出厂抽检「无说明书/缺件」",
      "Listing：A+ 放编号爆炸图与安装时长承诺（如「多数买家 <10 分钟」）；禁用空泛「易于组装」而无步骤",
    ].join("；");
  }

  // 充气 / 漏气 / 轮胎
  if (/充气|漏气|inflation|deflation|气胎|爆胎/i.test(text)) {
    return [
      "产品：改免充气实心 PU 轮（首选）或双层防刺气胎 + 盒内迷你气筒/补胎片",
      "Listing/包装：标题与五点明确写「Solid / Airless Wheels · 免充气」；气胎版须标注推荐 PSI",
      "若继续用气胎却无法承诺防刺性能 → 需人工介入：确认轮组 BOM 与质检标准",
    ].join("；");
  }

  // 耐用 / 结构 / 轮子磨损
  if (/耐用|结构|强度|断裂|松动|quality|reliability|轮子|耐磨/i.test(text)) {
    return [
      "产品：前轴/前叉连接件加厚或加金属衬套；后轮升耐磨 PU（硬度标注）；关键螺丝螺纹胶 + 防松垫圈",
      "运营：FBA 上架「备件包」独立 ASIN（前轮×1 + 后轮×2 + 紧固件），说明书印复购二维码",
      "质检：出厂做连接件扭矩与跌落抽检；Listing 诚实标注承重 lb，避免虚标",
    ].join("；");
  }

  // LED / 灯效
  if (/led|发光|灯效|不亮|熄灭/i.test(text)) {
    return [
      "产品：改用成熟长寿命灯轮模组（目标骑行 6 个月不熄）或可换电池/模组设计",
      "质检：出厂点亮抽检 + 振动老化抽检",
      "Listing：写清「感应发光、无需开关」与预期寿命；避免「最亮」类无法验证的夸大词",
    ].join("；");
  }

  // 稳定性
  if (/稳定|晃|摇|倾倒|balance/i.test(text)) {
    return [
      "产品：加宽轮距/踏板；降低 Deck；优化重心；必要时加前轮尺寸或配重",
      "Listing：主图展示站姿与轮距；适龄身高表与承重表放在五点前两条",
    ].join("；");
  }

  // 骑行顺滑
  if (/顺滑|卡顿|噪音|轴承|滑动/i.test(text)) {
    return [
      "产品：升级密封轴承 + 轮轴同心度管控；PU 轮硬度公差收紧",
      "质检：出厂滚动阻力与异响抽检",
      "Listing：避免「像滑行在冰上」等无法兑现的文案",
    ].join("；");
  }

  // 尺寸 / Deck / 踏板 / 适龄
  if (/尺寸|size|deck|踏板|身高|适龄|承重/i.test(text)) {
    return [
      "产品：按年龄段拆 SKU（如 2–4 岁更低 Deck / 更短把立；5–8 岁标准款）",
      "Listing+包装：印「身高—把立档位」对照表与最大承重；主图放儿童比例示意",
    ].join("；");
  }

  // 缺件 / 包装破损
  if (/缺件|包装|破损|少零件/i.test(text)) {
    return [
      "包装：泡棉/卡槽固定易损件；装箱清单扫码复核",
      "运营：站内开通「缺件补寄」话术与备件库存；A-to-Z/退货率周监控",
    ].join("；");
  }

  // 备件 / 售后
  if (/备件|售后|零件|更换/i.test(text)) {
    return [
      "运营：FBA 备件独立 SKU + 说明书/Q&A/品牌站统一入口",
      "客服：预设「轮组/螺丝包」工单模板，承诺时效（如 2 个工作日内发货）",
    ].join("；");
  }

  // 安全
  if (/安全|夹手|锐边|cert|astm|cpsia/i.test(text)) {
    return [
      "产品：去锐边、加握把护套、刹车可及性复核",
      "合规：出厂附 ASTM F963 / CPSIA 测试报告摘要；Listing 合规声明与适龄一致",
      "若涉及新结构认证范围不明 → 需人工介入：法务/认证工程师确认测试项",
    ].join("；");
  }

  // 价格 / 性价比 —— 通常不是结构问题
  if (/价格|性价比|贵|便宜/i.test(text)) {
    return [
      "运营：用「备件可购 + 结构加强」支撑溢价，或做礼盒/基础款双 SKU 分层",
      "Listing：对比表写清多出来的配置（阻尼/备件/免充气），避免只降价硬刚",
    ].join("；");
  }

  // 货不对板 / 描述不符
  if (/货不对|不符|描述|图实|misleading/i.test(text)) {
    return [
      "Listing：主图/视频与实拍同批次；删除未量产功能图",
      "运营：改版后 A/B 检查差评关键词「not as described」是否下降",
    ].join("；");
  }

  return `需人工介入：主题「${text}」暂无标准动作库映射——请产品/供应链确认是结构件、电子件还是文案预期问题后补具体 BOM 与 Listing 改法`;
}

function inferLightingFixDirection(label: string): string {
  const text = label.trim();
  if (/led|照明|色温|亮度|灯光|bulb|lighting/i.test(text)) {
    return [
      "产品：标配可替换 LED 灯泡 + 稳定色温档位（如 3000K/4000K/5000K）；灯罩柔光不刺眼",
      "质检：色温一致性与亮灯抽检；到货含灯声明与实物一致",
      "Listing：写清色温档位、是否含灯泡、适用房间；避免「最亮」类无法验证的夸大词",
    ].join("；");
  }
  if (/耐用|结构|强度|质量|reliability|quality|板材|连接/i.test(text)) {
    return [
      "产品：灯杆/层板连接加厚或金属件；底座配重防晃；层板承重诚实标注",
      "质检：组装后晃动循环与层板静载抽检",
      "Listing：五点写清层数、单层承重、占地尺寸",
    ].join("；");
  }
  if (/稳定|晃|摇|倾倒|wobble|tip/i.test(text)) {
    return [
      "产品：加大/加重底座；降低重心；层板螺丝防松",
      "Listing：主图展示客厅角落摆放与承重演示；避免虚标稳固",
    ].join("；");
  }
  if (/置物|收纳|层板|storage|shelf/i.test(text)) {
    return [
      "产品：层板间距覆盖相框/绿植/书本常见高度；单层承重可验证",
      "Listing：A+ 放置物场景与承重表；主图避免只拍空架",
    ].join("；");
  }
  if (/灯罩|透光|刺眼|shade|glare/i.test(text)) {
    return [
      "产品：布艺/亚麻或足够厚度灯罩，向上出光减少眩光",
      "Listing：夜景图展示柔光；写清灯罩材质",
    ].join("；");
  }
  if (/安装|组装|assembly|install/i.test(text)) {
    return [
      "产品：立杆预装或免工具快拆；零件按 ①②③ 编号；盒内附对应规格扳手",
      "包装：一张图文「三步装完」卡 + QR 安装视频",
      "Listing：A+ 放编号爆炸图与安装时长承诺，禁用空泛「易于组装」",
    ].join("；");
  }
  if (/缺件|包装|破损/i.test(text)) {
    return [
      "包装：灯罩/层板独立卡槽或泡沫护角；装箱清单扫码复核",
      "运营：站内开通破损补寄话术与备件库存",
    ].join("；");
  }
  if (/安全/i.test(text)) {
    return [
      "产品：倾倒稳定、电线/开关位置复核、过热防护",
      "合规：UL/ETL 等适用认证摘要随货；Listing 声明与实物一致",
    ].join("；");
  }
  if (/价格|性价比/i.test(text)) {
    return [
      "运营：用「灯架一体 + 稳固承重」支撑溢价，或做基础款/多层款双 SKU",
      "Listing：对比表写清层数、色温、是否含灯泡",
    ].join("；");
  }
  return `需人工介入：主题「${text}」暂无灯具标准动作库映射——请确认是结构、照明还是包装问题后补具体 BOM 与 Listing 改法`;
}

function inferGenericFixDirection(label: string): string {
  const text = label.trim();
  if (/安装|组装|assembly|install/i.test(text)) {
    return [
      "产品：预装或减少工具步骤；零件编号；盒内附对应工具",
      "包装：图文安装卡 + QR 视频",
      "Listing：A+ 放爆炸图与可验证安装时长，禁用空泛「易于组装」",
    ].join("；");
  }
  if (/耐用|结构|质量|reliability|quality/i.test(text)) {
    return [
      "产品：加强承力连接件与材料厚度；规格/承重诚实标注",
      "质检：出厂做关键部位载荷或循环抽检",
      "Listing：五点写可验证结构参数，避免无法兑现的夸大词",
    ].join("；");
  }
  if (/包装|破损|缺件/i.test(text)) {
    return ["包装：易损件卡槽固定；装箱清单复核", "运营：破损/缺件补寄路径与库存"].join("；");
  }
  if (/led|灯|照明/i.test(text)) {
    return [
      "产品：按该类目实际光源需求设计（禁止套用滑板车灯轮方案）",
      "Listing：写清光源规格与是否含灯泡/电池",
    ].join("；");
  }
  return `需人工介入：主题「${text}」暂无该类目标准动作库——请产品/供应链确认后补具体 BOM 与 Listing 改法`;
}

function inferFixDirection(label: string, family: ProductFamily = "generic"): string {
  if (family === "scooter") return inferScooterFixDirection(label);
  if (family === "lighting") return inferLightingFixDirection(label);
  return inferGenericFixDirection(label);
}

function buildDimensionAnchors(summary: SummaryMap): DimensionAnchor[] {
  return (["attention", "positives", "negatives", "unmet", "scenarios", "audiences", "motives"] as DimKey[]).map(key => {
    const item = summary.get(key);
    const themes = item?.themes ?? [];
    return {
      dimension: item?.label ?? key,
      topThemes: themes.length ? topThemesWithPct(themes, 5) : "暂无数据",
      insight: item?.guidance || "暂无数据",
    };
  });
}

function buildVocInsightRows(summary: SummaryMap, productCount: number): VocInsightRow[] {
  const rows: VocInsightRow[] = [];
  (["attention", "positives", "negatives", "unmet", "scenarios", "audiences", "motives"] as DimKey[]).forEach(key => {
    const item = summary.get(key);
    const themes = (item?.themes ?? []).slice(0, 4);
    if (!themes.length) {
      rows.push({
        dimension: item?.label ?? key,
        label: "暂无数据",
        mentionPct: "—",
        feedback: "暂无数据",
        impact: "低",
        implication: item?.guidance || "待同步 VOC / 评论分析后补齐",
      });
      return;
    }
    themes.forEach(theme => {
      const brandCoverage = theme.brands.length
        ? `覆盖 ${theme.brands.slice(0, 3).join("、")}${theme.brands.length > 3 ? " 等" : ""}`
        : `样本 ${productCount} 款`;
      const sourceNote = theme.sources.length ? theme.sources.join("+") : "VOC";
      rows.push({
        dimension: item?.label ?? key,
        label: theme.label,
        mentionPct: `${formatPct(theme.mentionPct)}%`,
        feedback: `${brandCoverage} · 来源 ${sourceNote}`,
        impact: impactLevel(theme.mentionPct),
        implication: item?.guidance || "结合交叉分析判断开发优先级",
      });
    });
  });
  return rows;
}

function buildNegativePriorityRows(summary: SummaryMap, productCount: number, family: ProductFamily): NegativePriorityRow[] {
  const themes = summary.get("negatives")?.themes ?? [];
  if (!themes.length) {
    return [
      {
        issue: "暂无数据",
        frequency: "—",
        severity: "低",
        industryWide: "暂无数据",
        impactStages: "—",
        shouldFix: "待数据",
        fixDirection: "同步差评主题后再评估",
      },
    ];
  }

  return themes.slice(0, 8).map(theme => {
    const severity = impactLevel(theme.mentionPct);
    const industryWide =
      theme.brands.length >= Math.max(2, Math.ceil(productCount * 0.5))
        ? `是（${theme.brands.length}/${productCount} 品牌）`
        : `偏个别（${theme.brands.length}/${productCount} 品牌）`;
    const shouldFix = legacyNegativePriorityDisplay(theme.mentionPct, severity);
    return {
      issue: theme.label,
      frequency: `${formatPct(theme.mentionPct)}%（维度内）`,
      severity,
      industryWide,
      impactStages: inferNegativeImpactStages(theme.label),
      shouldFix,
      fixDirection: inferFixDirection(theme.label, family),
    };
  });
}

function inferPositiveImpactStages(label: string): string {
  const stages: string[] = [];
  if (/安装|组装|ease|上手|易用/i.test(label)) stages.push("转化", "差评抑制", "推荐");
  if (/质量|耐用|做工|结构|稳|quality/i.test(label)) stages.push("转化", "复购", "推荐");
  if (/led|发光|灯|乐趣|娱乐|fun|礼物/i.test(label)) stages.push("点击", "转化");
  if (/车把|可调|handle|高度/i.test(label)) stages.push("转化", "复购");
  if (/价格|性价比|value/i.test(label)) stages.push("点击", "转化");
  if (/安全/i.test(label)) stages.push("转化", "推荐");
  return [...new Set(stages)].join("、") || "转化、推荐";
}

function inferLoveDetail(label: string, family: ProductFamily = "generic"): string {
  const text = label.trim();
  if (family === "lighting") {
    if (/质量|做工|耐用|结构|quality/i.test(text)) return "顾客重视整体做工扎实、灯体稳固，愿意为「买得放心」买单。";
    if (/led|照明|色温|亮度|灯光/i.test(text)) return "顾客看重照明效果与色温氛围，客厅/卧室场景下的柔光与亮度是核心满意来源。";
    if (/置物|收纳|层板|storage/i.test(text)) return "顾客认可灯架一体的收纳展示能力，认为能节省空间并兼作边几。";
    if (/安装|组装/i.test(text)) return "顾客重视开箱即装、步骤少、说明清楚。";
    if (/稳定|晃/i.test(text)) return "顾客在意落地后是否晃动、倾倒，稳固直接影响评分。";
    if (/价格|性价比/i.test(text)) return "顾客认为定价合理、灯架一体比分件购买更划算。";
  }
  if (family !== "scooter") {
    if (/质量|做工|耐用|结构|quality/i.test(text)) return "顾客重视整体做工扎实、质感可靠，愿意为「买得放心」买单。";
    if (/安装|组装/i.test(text)) return "顾客重视开箱即装、步骤少、说明清楚。";
    if (/价格|性价比/i.test(text)) return "顾客认为定价合理、物有所值。";
    return `顾客在评论中明确认可「${text}」，视为购买后满意的核心来源。`;
  }
  if (/质量|做工|耐用|结构|quality/i.test(text)) return "顾客重视整体做工扎实、质感可靠，愿意为「买得放心」买单。";
  if (/led|发光|灯|乐趣|娱乐|fun|礼物/i.test(text)) return "顾客看重孩子使用中的乐趣，尤其是夜间灯光带来的视觉与礼物场景吸引力。";
  if (/安装|组装|ease|上手|易用/i.test(text)) return "顾客重视开箱即装、孩子能快速上手建立骑行信心。";
  if (/车把|可调|handle|高度/i.test(text)) return "顾客喜爱可调节、可延伸的车把，认为成长适配实用性强。";
  if (/稳定|平衡/i.test(text)) return "顾客认可三轮稳定与低重心带来的安全感，降低初学摔车顾虑。";
  if (/价格|性价比|value/i.test(text)) return "顾客认为定价合理、物有所值，配置与价格匹配时转化更高。";
  if (/安全/i.test(text)) return "顾客把刹车、圆角、适龄标注等安全细节视为下单前提。";
  if (/顺滑|轴承|轮/i.test(text)) return "顾客喜欢顺滑滚动与安静骑行体验，直接影响好评与推荐。";
  return `顾客在评论中明确认可「${text}」，视为购买后满意的核心来源。`;
}

/**
 * 好评「强化方向」：对齐亚马逊「买家喜爱什么→如何解决」——
 * 说明如何在产品上保留/强化，并在 Listing 明确兑现；禁止空泛夸奖。
 */
function inferLeverageDirection(label: string, family: ProductFamily = "generic"): string {
  const text = label.trim();
  if (family === "lighting") {
    if (/质量|做工|耐用|结构|quality/i.test(text)) {
      return [
        "产品：保持层板承重与灯杆稳固为 P0 标配，不因降本改薄板",
        "Listing：五点首条写「层板承重 xx lb / 灯杆防晃」；A+ 放层板与底座特写",
      ].join("；");
    }
    if (/led|照明|色温|亮度|灯光/i.test(text)) {
      return [
        "产品：保留三色温或柔光灯罩为标配；灯泡可替换",
        "Listing：主图/视频必须出客厅或卧室氛围光；色温切换演示放图册前张",
      ].join("；");
    }
    if (/置物|收纳|层板|storage/i.test(text)) {
      return [
        "产品：保留多层置物为标配，层间距覆盖相框/绿植/书本",
        "Listing：主图与 A+ 放置物场景，不只拍空架",
      ].join("；");
    }
    if (/安装|组装/i.test(text)) {
      return [
        "产品：保持预装或 ≤3 步组装；零件编号与扳手标配",
        "包装：盒内「三步装完」卡 + QR 安装视频",
        "Listing：A+ 放编号爆炸图与可验证安装时长",
      ].join("；");
    }
    if (/稳定|晃/i.test(text)) {
      return [
        "产品：保持底座配重与防松连接；不减配加重底座冒充轻便",
        "Listing：主图展示摆放稳固与承重演示",
      ].join("；");
    }
  }
  if (family !== "scooter") {
    if (/质量|做工|耐用|结构|quality/i.test(text)) {
      return [
        "产品：保持承力结构与材料厚度为 P0 标配，不因降本砍结构",
        "Listing：五点写可验证结构参数；A+ 放材质特写",
      ].join("；");
    }
    if (/安装|组装/i.test(text)) {
      return [
        "产品：保持预装或少步骤组装；零件编号",
        "包装：图文安装卡 + QR 视频",
        "Listing：A+ 放爆炸图与可验证安装时长",
      ].join("；");
    }
    return `需人工介入：主题「${text}」暂无该类目标准强化动作库——确认卖点类型后写入五点与 BOM`;
  }

  if (/质量|做工|耐用|结构|quality/i.test(text)) {
    return [
      "产品：保持加厚连接件/耐磨轮/螺纹防松为 P0 标配，不因降本砍结构",
      "Listing：五点首条写「加厚前叉/金属衬套/承重 xx lb」；A+ 放材质特写与扭矩/跌落抽检说明",
      "包装：说明书标注关键螺丝扭矩与定期紧固提醒，降低后期松动差评反噬好评",
    ].join("；");
  }

  if (/led|发光|灯|乐趣|娱乐|fun|礼物/i.test(text)) {
    return [
      "产品：保留感应 LED 灯轮为标配；优先长寿命模组，避免「亮但不耐用」反噬",
      "Listing：主图/视频必须出夜骑发光镜头；礼物场景图放在图册第 2–3 张",
      "运营：Q4 礼盒版可捆绑备用灯轮或彩盒，但结构规格不缩水",
    ].join("；");
  }

  if (/安装|组装|ease|上手|易用/i.test(text)) {
    return [
      "产品：保持预装/免工具或 ≤3 步组装；零件编号与扳手标配",
      "包装：盒内「三步装完」卡 + QR 安装视频",
      "Listing：A+ 放编号爆炸图与「多数买家 <10 分钟」可验证表述，禁止只写「易于组装」",
    ].join("；");
  }

  if (/车把|可调|handle|高度/i.test(text)) {
    return [
      "产品：保留 4 档（或连续）可调把立 + 防滑握把；锁扣防松设计不降级",
      "Listing：五点写清档位数与身高对照；主图放调节演示",
      "包装：身高—档位对照表印在插页正面",
    ].join("；");
  }

  if (/稳定|平衡/i.test(text)) {
    return [
      "产品：保持三轮宽距 + 低 Deck 重心；不改窄轮距冒充「更灵活」",
      "Listing：主图展示站姿与轮距；适龄/承重表前置",
    ].join("；");
  }

  if (/价格|性价比|value/i.test(text)) {
    return [
      "运营：用「结构加强 + 备件可购 + LED」做价值锚点，基础款/礼盒款双 SKU 分层",
      "Listing：对比表写清多出来的配置，避免只堆低价词；优惠券文案与价值点一致",
    ].join("；");
  }

  if (/安全/i.test(text)) {
    return [
      "产品：保留后轮刹车、圆角、防滑踏板；合规证书随货",
      "Listing：适龄与 ASTM/CPSIA 声明与实物一致；安全卖点放五点前两条",
    ].join("；");
  }

  if (/顺滑|轴承|轮/i.test(text)) {
    return [
      "产品：密封轴承 + PU 轮径公差维持现有好评水准",
      "质检：滚动异响抽检；Listing 可用「静音滚动」但需有抽检依据",
    ].join("；");
  }

  return `需人工介入：主题「${text}」暂无标准强化动作库——请确认是结构卖点、电子卖点还是价格锚点后，再写入五点与 BOM 冻结清单`;
}

function buildPositivePriorityRows(summary: SummaryMap, productCount: number, family: ProductFamily): PositivePriorityRow[] {
  const themes = summary.get("positives")?.themes ?? [];
  if (!themes.length) {
    return [
      {
        theme: "暂无数据",
        detail: "暂无数据",
        frequency: "—",
        valueLevel: "低",
        industryWide: "暂无数据",
        impactStages: "—",
        shouldKeep: "待数据",
        leverageDirection: "同步好评主题后再评估",
      },
    ];
  }

  return themes.slice(0, 8).map(theme => {
    const valueLevel = impactLevel(theme.mentionPct);
    const industryWide =
      theme.brands.length >= Math.max(2, Math.ceil(productCount * 0.5))
        ? `是（${theme.brands.length}/${productCount} 品牌）`
        : `偏个别（${theme.brands.length}/${productCount} 品牌）`;
    const shouldKeep = legacyPositivePriorityDisplay(
      theme.mentionPct,
      valueLevel,
    );
    return {
      theme: theme.label,
      detail: inferLoveDetail(theme.label, family),
      frequency: `${formatPct(theme.mentionPct)}%（维度内）`,
      valueLevel,
      industryWide,
      impactStages: inferPositiveImpactStages(theme.label),
      shouldKeep,
      leverageDirection: inferLeverageDirection(theme.label, family),
    };
  });
}

function buildUnmetOpportunityRows(
  summary: SummaryMap,
  market: ReturnType<typeof buildMarketContext>,
  family: ProductFamily
): UnmetOpportunityRow[] {
  const unmet = summary.get("unmet")?.themes ?? [];
  const audiences = topLabels(summary.get("audiences")?.themes ?? [], 2).join("、") || "暂无数据";
  const scenarios = topLabels(summary.get("scenarios")?.themes ?? [], 2).join("、") || "暂无数据";
  const priceBand =
    market.minPrice !== null && market.maxPrice !== null
      ? `$${market.minPrice.toFixed(0)}–$${market.maxPrice.toFixed(0)}`
      : "暂无数据";

  if (!unmet.length) {
    return [
      {
        need: "暂无数据",
        audience: audiences,
        scenario: scenarios,
        competitorStatus: "暂无数据",
        marketValue: "暂无数据",
        difficulty: "—",
        proposal: "同步未满足需求主题后再评估",
      },
    ];
  }

  return unmet.slice(0, 6).map((theme, index) => {
    const negMatch = findTheme(summary.get("negatives")?.themes ?? [], new RegExp(theme.label.slice(0, 4)), "negatives");
    const competitorStatus = negMatch
      ? `竞品差评亦高（${negMatch.label} ${formatPct(negMatch.mentionPct)}%）`
      : "现有竞品解决较差或未系统解决";
    const marketValue =
      theme.mentionPct >= 12
        ? `高 · 维度内 ${formatPct(theme.mentionPct)}% · 价格带 ${priceBand}`
        : `中 · 维度内 ${formatPct(theme.mentionPct)}% · 价格带 ${priceBand}`;
    const difficulty = index === 0 ? "中（结构/备件可落地）" : index <= 2 ? "中低（说明/微调优先）" : "视改模范围而定";
    return {
      need: theme.label,
      audience: audiences,
      scenario: scenarios,
      competitorStatus,
      marketValue,
      difficulty,
      proposal: inferFixDirection(theme.label, family),
    };
  });
}

function keywordEvidenceNote(keyword: KeywordLaunchConclusions | null) {
  if (!keyword?.hasData) {
    return "关键词需求未就绪，市场需求规模仅为 VOC 代理判断";
  }

  const keywords = [
    ...keyword.functionMatrix.map(row => row.keyword),
    ...keyword.keywordCombos.map(row => row.keyword),
  ].filter((value, index, values) => value && values.indexOf(value) === index).slice(0, 3);
  const evidence = keywords.length ? keywords.join("、") : keyword.headline;
  return `关键词需求已交叉验证：${evidence}；仅作搜索需求证据，不替代 VOC、利润与合规验证`;
}

function buildExecutiveSummary(
  summary: SummaryMap,
  market: ReturnType<typeof buildMarketContext>,
  opportunities: OpportunityScore[],
  finalDecision: FinalDecision,
  categoryLabel: string,
  keyword: KeywordLaunchConclusions | null,
): string {
  const attention = topLabels(summary.get("attention")?.themes ?? [], 3).join("、") || "暂无数据";
  const negatives = topLabels(summary.get("negatives")?.themes ?? [], 2).join("、") || "暂无数据";
  const unmet = topLabels(summary.get("unmet")?.themes ?? [], 2).join("、") || "暂无数据";
  const topOpp = opportunities[0];
  const salesNote =
    market.totalSales > 0 ? `样本竞品合计约 ${Math.round(market.totalSales).toLocaleString()} 件/月` : "月销待同步";
  const direction = topOpp?.name ?? "待机会评分就绪";
  const scoreNote = topOpp ? `首要机会综合 ${topOpp.priorityScore.toFixed(0)} 分` : "机会分暂无";

  const keywordNote = keywordEvidenceNote(keyword);
  const text = `${keywordNote}。${categoryLabel}消费者最关注「${attention}」；竞品共同问题集中在「${negatives}」。最有价值的未满足需求是「${unmet}」，建议优先开发「${direction}」。${salesNote}，${scoreNote}。综合结论：${finalDecision}。`;
  return text.length > 300 ? `${text.slice(0, 297)}…` : text;
}

function buildFinalAnswers(
  summary: SummaryMap,
  market: ReturnType<typeof buildMarketContext>,
  opportunities: OpportunityScore[],
  productDirections: ProductDirectionProposal[],
  productDefinition: ProductLaunchAnalysis["productDefinition"],
  finalDecision: FinalDecision,
  categoryLabel: string
): FinalAnswerRow[] {
  const topOpp = opportunities[0];
  const topDirection = productDirections[0];
  const painPoints = topLabels(summary.get("negatives")?.themes ?? [], 3);
  const keepPoints = topLabels(summary.get("positives")?.themes ?? [], 3);
  const fakeNeeds = productDefinition.avoid.slice(0, 3);
  const audiences = topLabels(summary.get("audiences")?.themes ?? [], 2).join("、") || "暂无数据";
  const priceBand =
    market.minPrice !== null && market.maxPrice !== null
      ? `$${market.minPrice.toFixed(0)}–$${market.maxPrice.toFixed(0)}（建议售价 ${productDefinition.targetPrice}）`
      : productDefinition.targetPrice;
  const rivals = market.rows
    .slice(0, 3)
    .map(row => row.brand)
    .join("、");

  return [
    {
      question: "是否建议进入该类目或开发该产品？",
      answer: `${finalDecision} — ${categoryLabel}；依据首要机会「${topOpp?.name ?? "暂无"}」${topOpp ? `${topOpp.priorityScore.toFixed(0)} 分` : ""}`,
    },
    {
      question: "最推荐开发哪一个方向？",
      answer: topDirection ? `${topDirection.id} ${topDirection.directionName}` : "暂无数据",
    },
    {
      question: "应重点解决哪三个消费者痛点？",
      answer: painPoints.length ? painPoints.map((item, i) => `${i + 1}. ${item}`).join("；") : "暂无数据",
    },
    {
      question: "应保留哪三个成熟卖点？",
      answer: keepPoints.length ? keepPoints.map((item, i) => `${i + 1}. ${item}`).join("；") : "暂无数据",
    },
    {
      question: "哪些需求属于伪需求，不建议开发？",
      answer: fakeNeeds.length ? fakeNeeds.join("；") : "暂无数据",
    },
    {
      question: "产品应定位于哪个价格带和目标人群？",
      answer: `${priceBand}；人群：${audiences}`,
    },
    {
      question: "新产品与头部竞品相比，核心差异化是什么？",
      answer: topDirection?.competitorDifference || topDirection?.coreSellingPoints || "暂无数据",
    },
    {
      question: "产品立项前还需要验证哪些数据？",
      answer: [
        market.totalSales < 3000 ? "扩大竞品样本验证市场容量" : null,
        "BOM 成本与目标毛利",
        "关键结构件/LED 寿命测试",
        "ASTM/CPSIA 变更范围",
        rivals ? `对标 ${rivals} 的备件与售后能力` : null,
      ]
        .filter(Boolean)
        .join("；"),
    },
    {
      question: "最终结论（四选一）",
      answer: finalDecision,
    },
  ];
}

function buildCrossAnalyses(summary: SummaryMap, market: ReturnType<typeof buildMarketContext>): CrossAnalysisSection[] {
  const attention = summary.get("attention")?.themes ?? [];
  const negatives = summary.get("negatives")?.themes ?? [];
  const unmet = summary.get("unmet")?.themes ?? [];
  const scenarios = summary.get("scenarios")?.themes ?? [];
  const audiences = summary.get("audiences")?.themes ?? [];
  const positives = summary.get("positives")?.themes ?? [];
  const motives = summary.get("motives")?.themes ?? [];

  const cross1Rows: CrossAnalysisRow[] = [];
  const durabilityNeg = findTheme(negatives, /耐用|结构/, "negatives");
  const durabilityUnmet = findTheme(unmet, /耐用|结构/, "unmet");
  if (durabilityNeg || findTheme(attention, /质量|耐用/, "attention")) {
    cross1Rows.push({
      anchor: "耐用/结构",
      left: "消费者期待：质量/耐用为首要关注",
      right: durabilityNeg ? `竞品差评维度内 ${formatPct(durabilityNeg.mentionPct)}%` : "竞品耐用口碑薄弱",
      insight: "最大缺口：家长买「能陪很久的第一辆车」，竞品普遍出现结构/轮子问题",
    });
  }
  const leanAttention = findTheme(attention, /lean|转向/, "attention");
  const leanNeg = findTheme(negatives, /lean|转向/, "negatives");
  if (leanAttention || leanNeg) {
    cross1Rows.push({
      anchor: "Lean-to-steer 转向",
      left: leanAttention ? `关注点：${leanAttention.label}` : "与第一辆/低龄强绑定",
      right: leanNeg ? `差评/未满足 ${formatPct(leanNeg.mentionPct)}%` : "低龄难独立转弯",
      insight: "不是放弃 lean-steer，而是缺低龄友好调校与说明",
    });
  }
  const installPos = findTheme(positives, /安装/, "positives");
  const installNeg = findTheme(negatives, /安装|质控|包装/, "negatives");
  if (installPos || installNeg) {
    cross1Rows.push({
      anchor: "安装便捷",
      left: installPos ? `关注点/好评：${installPos.label}` : "易装是购买前提",
      right: installNeg ? `差评/未满足 ${formatPct(installNeg.mentionPct)}%` : "出厂质控参差",
      insight: "装得好是卖点，装不好是雷 — 需出厂 QC",
    });
  }
  const ledAttention = findTheme(attention, /led|发光/, "attention");
  const ledNeg = findTheme(negatives, /led|发光|灯/, "negatives");
  if (ledAttention || ledNeg) {
    cross1Rows.push({
      anchor: "LED 发光",
      left: ledAttention ? `关注点 ${formatPct(ledAttention.mentionPct)}%` : "礼物场景引流",
      right: ledNeg ? `Mixed 差评 ${formatPct(ledNeg.mentionPct)}%` : "灯效寿命参差",
      insight: "LED 是引流不是护城河 — 灯不亮伤害礼物场景",
    });
  }

  const firstScene = findTheme(scenarios, /第一辆|入门/, "scenarios");
  const leanUnmet = findTheme(unmet, /lean|转向|踏板|deck/i, "unmet");
  const outdoorScene = findTheme(scenarios, /户外|社区/, "scenarios");
  const giftScene = findTheme(scenarios, /礼物|节日/, "scenarios");

  const cross2Rows: CrossAnalysisRow[] = [
    firstScene || leanUnmet
      ? {
          anchor: "第一辆 / 2–4 岁入门",
          left: firstScene?.label ?? "第一辆滑板车",
          right: leanUnmet?.label ?? "转向/踏板优化",
          insight: "缺真正低幼友好方案，现有 lean-steer 偏大龄",
        }
      : null,
    outdoorScene || durabilityUnmet
      ? {
          anchor: "户外/社区日常",
          left: outdoorScene?.label ?? "户外骑行",
          right: durabilityUnmet?.label ?? "结构/轮子耐用",
          insight: "高强度日常使用下，轮子与连接件是瓶颈",
        }
      : null,
    giftScene || findTheme(unmet, /包装|缺件|led/i, "unmet")
      ? {
          anchor: "礼物/节日",
          left: giftScene?.label ?? "礼物场景",
          right: "LED 长期亮 + 包装完整 + 售后快",
          insight: "礼物场景对「开箱即完美 + 灯不丢人」敏感",
        }
      : null,
  ].filter((row): row is CrossAnalysisRow => Boolean(row));

  const giftAudience = findTheme(audiences, /礼物|祖父母|家长/, "audiences");
  const boyAudience = findTheme(audiences, /儿子|男孩/, "audiences");
  const cross3Rows: CrossAnalysisRow[] = [
    {
      anchor: "祖父母/礼物购买者",
      left: giftAudience?.label ?? "礼物决策者",
      right: "转向说明不清、组装困惑、缺件",
      insight: "需要免工具 + 图文/QR 视频 + 礼盒完整",
    },
    {
      anchor: "2–3 岁幼儿",
      left: "低龄入门",
      right: leanUnmet?.label ?? "Deck 偏高、转向阻力大",
      insight: "更低踏板、更轻转向阻力或转向限位",
    },
    {
      anchor: "5–8 岁 / 多孩家庭",
      left: boyAudience?.label ?? "较大龄儿童",
      right: findTheme(unmet, /承重|适龄/, "unmet")?.label ?? "承重标注混乱",
      insight: "透明承重 + 结构冗余标注",
    },
  ];

  const giftMotive = findTheme(motives, /礼物|孩子喜欢/, "motives");
  const stableMotive = findTheme(motives, /稳定|新手/, "motives");
  const ledMotive = findTheme(motives, /发光|led/i, "motives");
  const cross4Rows: CrossAnalysisRow[] = [
    giftMotive
      ? {
          anchor: "礼物 / 孩子喜欢",
          left: giftMotive.label,
          right: "LED + 易组装 + 稳定",
          insight: "转化靠第一眼（灯/色）+ 第一小时（好装、稳）",
        }
      : null,
    stableMotive
      ? {
          anchor: "新手稳定性",
          left: stableMotive.label,
          right: findTheme(positives, /结构|稳定/, "positives")?.label ?? "结构稳固",
          insight: "满意靠宽踏板、低重心、不晃",
        }
      : null,
    ledMotive
      ? {
          anchor: "发光功能",
          left: ledMotive.label,
          right: findTheme(positives, /led|发光/, "positives")?.label ?? "LED 好评",
          insight: "可保留，但须耐久模组，否则动机反噬",
        }
      : null,
  ].filter((row): row is CrossAnalysisRow => Boolean(row));

  const priceBand =
    market.minPrice !== null && market.maxPrice !== null
      ? `$${market.minPrice.toFixed(0)}–$${market.maxPrice.toFixed(0)}`
      : "待价格同步";

  return [
    {
      id: "attention-negatives",
      title: "顾客关注点 × 差评点",
      subtitle: "判断消费者最关注但竞品表现最差的地方",
      rows: cross1Rows.length ? cross1Rows : [{ anchor: "—", left: "待数据", right: "待数据", insight: "同步 VOC 后自动生成" }],
      conclusion: "立项应打 Reliability-first（可靠优先），而非 Lighting-first。",
    },
    {
      id: "unmet-scenarios",
      title: "未满足需求 × 使用场景",
      subtitle: "判断哪些场景缺少合适的产品解决方案",
      rows: cross2Rows,
      conclusion: "最有场景价值的是「日常户外 + 第一辆入门 + 送礼」交集下的耐用可维护方案。",
    },
    {
      id: "audiences-negatives",
      title: "使用人群 × 差评点",
      subtitle: "判断不同人群在尺寸、安全性、操作方式等方面的特殊痛点",
      rows: cross3Rows,
      conclusion: "人群差异主要在年龄/体重段的操作与说明，开发重点应是低龄转向+踏板与承重诚实标注。",
    },
    {
      id: "motives-positives",
      title: "购买动机 × 好评点",
      subtitle: "判断哪些功能真正推动消费者下单并形成满意体验",
      rows: cross4Rows.length
        ? cross4Rows
        : [{ anchor: "—", left: "待数据", right: "待数据", insight: "同步 VOC 后自动生成" }],
      conclusion: "转化公式 = 礼物/LED 吸引 + 产品质量/安装兑现 + 稳定/可调延长使用；须补齐耐用后半段。",
    },
    {
      id: "market-opportunity",
      title: "评论机会 × Sorftime 市场数据",
      subtitle: "判断需求是否具有足够的销量、价格空间和市场容量",
      rows: market.rows.slice(0, 4).map(row => ({
        anchor: row.brand,
        left: `${row.sales.toLocaleString()} 件/月`,
        right: row.price ? `$${row.price}` : "—",
        insight: row === market.leader ? "头部单品有量，礼物季脉冲强" : "类目中间价位竞争密集",
      })),
      conclusion: `价格带 ${priceBand}；「耐用+备件」方向有足够销量与 $5–10 溢价空间。`,
    },
    {
      id: "supply-opportunity",
      title: "评论机会 × 供应链能力",
      subtitle: "判断建议是否能够落地，避免成本过高或合规风险过大",
      rows: [],
      conclusion: "首代可落地组合 = 结构加强 + 备件包 + 转向说明/微调 + 保留 LED；避免首代同时改 Deck 模具 + 新转向专利。",
    },
  ];
}

function buildMarketRows(market: ReturnType<typeof buildMarketContext>) {
  const leader = market.leader;
  const leaderGmv =
    leader && leader.price ? `~$${Math.round((leader.sales * leader.price) / 1000)}k/月` : "待核算";
  const priceBand =
    market.minPrice !== null && market.maxPrice !== null
      ? `$${market.minPrice.toFixed(0)}–$${market.maxPrice.toFixed(0)}`
      : "—";

  return [
    {
      metric: "样本竞品月销",
      data: market.rows.map(row => `${row.brand} ${row.sales.toLocaleString()}`).join(" · "),
      judgment: market.totalSales >= 5000 ? "类目有量，头部单品 5k 级" : "样本量偏小，需扩大竞品范围",
    },
    {
      metric: "价格带",
      data: priceBand,
      judgment: "中间价位最拥挤，可凭「备件+耐用」支撑 +$5–10",
    },
    {
      metric: "头部月销额（示例）",
      data: leader ? `${leader.brand} ${leaderGmv}` : "—",
      judgment: "礼物季脉冲强，Q3 立项、Q4 备货节奏合理",
    },
    {
      metric: "数据月份",
      data: market.dataMonth,
      judgment: "Sorftime product_trend 最新月",
    },
  ];
}

function buildSupplyRows(family: ProductFamily): ProductLaunchAnalysis["supplyRows"] {
  if (family === "lighting") {
    return [
      { direction: "底座配重 + 灯杆防晃连接", feasibility: "★★★★ 现有五金件可改", risk: "增重/成本 +5–10%" },
      { direction: "层板承重加强 + 诚实标注", feasibility: "★★★★ 板材加厚或金属支架", risk: "体积/运费上升" },
      { direction: "三色温可替换 LED + 柔光灯罩", feasibility: "★★★★ 成熟灯泡供应链", risk: "需标注是否含灯泡" },
      { direction: "安装说明/QR + 编号零件", feasibility: "★★★★★ 包装 insert", risk: "无新认证" },
      { direction: "灯罩/层板运输护角", feasibility: "★★★★ 包材改版", risk: "包材成本" },
      { direction: "全新智能灯控平台", feasibility: "★★ 周期长", risk: "不建议首代立项" },
    ];
  }
  if (family !== "scooter") {
    return [
      { direction: "承力结构加强 + 规格诚实标注", feasibility: "★★★★ 现有工艺可改", risk: "成本上升" },
      { direction: "安装体验（编号零件 + QR）", feasibility: "★★★★★ 包装 insert", risk: "无新认证" },
      { direction: "包装防破损改版", feasibility: "★★★★ 包材改版", risk: "包材成本" },
      { direction: "备件/售后补寄路径", feasibility: "★★★★ FBA 配件 SKU", risk: "需备库存" },
    ];
  }
  return [
    { direction: "加厚前轴/前轮支架 + 金属衬套", feasibility: "★★★★ 现有铝件工艺可改", risk: "增重/成本 +8–12%" },
    { direction: "官方备件包（后轮×2 + 前轮×1 + 螺丝）", feasibility: "★★★★★ FBA 配件 SKU", risk: "需备库存与 ASIN 维护" },
    { direction: "转向阻力调校 + 说明书/QR", feasibility: "★★★★ 机构微调 + 包装 insert", risk: "无新认证" },
    { direction: "长寿命 LED（模组化可换）", feasibility: "★★★ 需换供应商/测寿命", risk: "成本 + 电子合规" },
    { direction: "更低 Deck 新模具", feasibility: "★★★ 开模 + 重心重算", risk: "CPSIA/ASTM 需重测" },
    { direction: "全新专利转向机构", feasibility: "★★ 周期长", risk: "不建议首代立项" },
  ];
}

function buildOpportunities(summary: SummaryMap, market: ReturnType<typeof buildMarketContext>, family: ProductFamily): OpportunityScore[] {
  const marketScore = market.totalSales >= 8000 ? 5 : market.totalSales >= 4000 ? 4 : 3;

  const scooterTemplates: Array<
    Omit<OpportunityScore, "priority" | "priorityScore" | "demandEvidence" | "marketEvidence" | "recommendation"> & {
      relevance: number;
    }
  > = [
    {
      id: "A",
      name: "耐用结构 + 官方备件包",
      frequency: 5,
      pain: 5,
      market: marketScore,
      gap: 5,
      differentiation: 4,
      premium: 4,
      feasibility: 4,
      costImpact: 3,
      compliance: 5,
      tier: "P0",
      relevance: conceptStrength(summary, [/耐用/, /结构/, /备件/], ["negatives", "unmet", "attention"]),
    },
    {
      id: "B",
      name: "低龄友好 Lean-to-steer（限位+说明）",
      frequency: 4,
      pain: 4,
      market: marketScore,
      gap: 4,
      differentiation: 4,
      premium: 3,
      feasibility: 4,
      costImpact: 4,
      compliance: 5,
      tier: "P0",
      relevance: conceptStrength(summary, [/lean|转向/, /第一辆/, /踏板/], ["unmet", "negatives", "scenarios"]),
    },
    {
      id: "C",
      name: "长寿命/可换 LED 模组",
      frequency: 4,
      pain: 3,
      market: 4,
      gap: 3,
      differentiation: 2,
      premium: 2,
      feasibility: 3,
      costImpact: 2,
      compliance: 3,
      tier: "P2",
      relevance: conceptStrength(summary, [/led|发光/], ["attention", "motives", "negatives"]),
    },
    {
      id: "D",
      name: "低幼 Deck 高度优化（2–3 岁）",
      frequency: 3,
      pain: 3,
      market: 3,
      gap: 4,
      differentiation: 4,
      premium: 3,
      feasibility: 3,
      costImpact: 2,
      compliance: 3,
      tier: "P1",
      relevance: conceptStrength(summary, [/踏板|deck/i, /2.*岁/], ["unmet", "scenarios"]),
    },
  ];

  const lightingTemplates: typeof scooterTemplates = [
    {
      id: "A",
      name: "灯杆防晃 + 底座配重",
      frequency: 5,
      pain: 5,
      market: marketScore,
      gap: 5,
      differentiation: 4,
      premium: 4,
      feasibility: 4,
      costImpact: 3,
      compliance: 5,
      tier: "P0",
      relevance: Math.max(0.2, conceptStrength(summary, [/晃|不稳|结构|耐用|wobble/], ["negatives", "unmet", "attention"])),
    },
    {
      id: "B",
      name: "置物层板承重与间距",
      frequency: 4,
      pain: 4,
      market: marketScore,
      gap: 4,
      differentiation: 4,
      premium: 3,
      feasibility: 4,
      costImpact: 4,
      compliance: 5,
      tier: "P0",
      relevance: Math.max(0.2, conceptStrength(summary, [/置物|收纳|层板|storage|shelf/], ["positives", "unmet", "motives"])),
    },
    {
      id: "C",
      name: "三色温/柔光灯罩",
      frequency: 4,
      pain: 3,
      market: 4,
      gap: 3,
      differentiation: 3,
      premium: 3,
      feasibility: 4,
      costImpact: 4,
      compliance: 4,
      tier: "P1",
      relevance: Math.max(0.15, conceptStrength(summary, [/led|照明|色温|灯罩|亮度/], ["positives", "attention", "negatives"])),
    },
    {
      id: "D",
      name: "安装体验与运输完好",
      frequency: 3,
      pain: 3,
      market: 3,
      gap: 3,
      differentiation: 2,
      premium: 2,
      feasibility: 5,
      costImpact: 4,
      compliance: 5,
      tier: "P1",
      relevance: Math.max(0.15, conceptStrength(summary, [/安装|组装|包装|破损/], ["negatives", "positives", "unmet"])),
    },
  ];

  const genericTemplates: typeof scooterTemplates = (summary.get("negatives")?.themes ?? [])
    .slice(0, 3)
    .map((theme, index) => ({
      id: String.fromCharCode(65 + index),
      name: theme.label,
      frequency: 4,
      pain: 4,
      market: marketScore,
      gap: 4,
      differentiation: 3,
      premium: 3,
      feasibility: 4,
      costImpact: 3,
      compliance: 4,
      tier: (index === 0 ? "P0" : "P1") as "P0" | "P1",
      relevance: Math.max(0.2, theme.mentionPct / 100),
    }));

  const templates =
    family === "scooter" ? scooterTemplates : family === "lighting" ? lightingTemplates : genericTemplates.length ? genericTemplates : lightingTemplates;

  return templates
    .filter(item => item.relevance > 0.08)
    .map(item => {
      const { relevance, ...scores } = item;
      const boosted = {
        ...scores,
        frequency: Math.min(5, Math.round(scores.frequency * (0.85 + relevance * 0.3))),
        pain: Math.min(5, Math.round(scores.pain * (0.85 + relevance * 0.3))),
        gap: Math.min(5, Math.round(scores.gap * (0.85 + relevance * 0.3))),
      };
      const priority = Number(calcPriority(boosted).toFixed(2));
      const priorityScore = Number((priority * 20).toFixed(1));
      const demandEvidence = `需求${boosted.frequency}/痛点${boosted.pain}/缺口${boosted.gap}（VOC 相关度 ${(relevance * 100).toFixed(0)}%）`;
      const marketEvidence =
        market.totalSales > 0
          ? `样本月销 ${Math.round(market.totalSales).toLocaleString()} · 市场分 ${boosted.market}/5`
          : `市场分 ${boosted.market}/5 · 月销暂无数据`;
      return {
        ...boosted,
        priority,
        priorityScore,
        demandEvidence,
        marketEvidence,
        recommendation: opportunityRecommendation(priorityScore, boosted.tier),
      };
    })
    .sort((a, b) => b.priorityScore - a.priorityScore || b.priority - a.priority);
}

function uniqueTexts(items: Array<string | null | undefined>, limit = 6) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const text = item?.replace(/\s+/g, " ").trim();
    if (!text || text === "—" || text === "暂无数据" || text === "待 VOC 归纳") continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function keywordItemValue(keyword: KeywordLaunchConclusions | null, sectionId: string, label: string) {
  const section = keyword?.sections.find(item => item.id === sectionId);
  const item = section?.items.find(row => row.label === label);
  const value = item?.value?.trim();
  return value && value !== "—" ? value : null;
}

function formatFunctionDemand(row: { keyword: string; type: string; volume: number | null; action: string }) {
  const volume = row.volume != null && row.volume > 0 ? `月搜 ${row.volume.toLocaleString()}` : "月搜待补";
  return `${row.keyword}（${row.type} · ${volume}）`;
}

function buildKeywordConclusions(
  analysis: KeywordDemandAnalysis | null,
  products: LaunchProductInput[],
): KeywordLaunchConclusions | null {
  return analysis ? buildKeywordLaunchConclusions(analysis, products) : null;
}

function buildProductDefinition(
  opportunities: OpportunityScore[],
  market: ReturnType<typeof buildMarketContext>,
  summary: SummaryMap,
  negativePriorityRows: NegativePriorityRow[],
  unmetOpportunityRows: UnmetOpportunityRow[],
  keyword: KeywordLaunchConclusions | null
) {
  const topOpp = opportunities[0];
  const combo = keyword?.keywordCombos[0];
  const categoryHint = topLabels(summary.get("attention")?.themes ?? [], 1)[0];
  const name = combo
    ? `${combo.keyword} / ${topOpp?.name ?? "需求组合导向定义"}`
    : topOpp
      ? topOpp.name
      : categoryHint
        ? `${categoryHint}导向产品定义`
        : "待信号汇总的产品定义";

  const mustHave = uniqueTexts(
    [
      ...(keyword?.functionMatrix ?? [])
        .filter(row => row.type === "基础必备" || row.type === "高关注")
        .map(formatFunctionDemand),
      ...negativePriorityRows
        .filter(row => row.shouldFix.includes("P0") || row.severity === "高")
        .map(row => `VOC 必修：${row.fixDirection}（针对「${row.issue}」）`),
      ...unmetOpportunityRows.slice(0, 2).map(row => `VOC 未满足：${row.proposal}（「${row.need}」）`),
      topOpp ? `机会主轴：${topOpp.name}` : null,
    ],
    6
  );

  const niceToHave = uniqueTexts(
    [
      ...(keyword?.functionMatrix ?? []).filter(row => row.type === "差异化").map(formatFunctionDemand),
      ...unmetOpportunityRows.slice(2, 5).map(row => row.proposal),
      keywordItemValue(keyword, "product_dev", "建议颜色/SKU"),
      "说明书/Listing 内嵌备件复购入口",
    ],
    5
  );

  const avoid = uniqueTexts(
    [
      ...(keyword?.functionMatrix ?? [])
        .filter(row => row.type === "伪需求")
        .map(row => `${row.keyword}（伪需求 · ${row.action}）`),
      "仅堆外观/发光噱头、不解决高频差评结构问题",
      "首代同时推进全新专利机构 + 大改模具",
      "与头部竞品正面拼最低价、无差异化",
    ],
    5
  );

  const kwPrice = keywordItemValue(keyword, "product_dev", "建议目标售价");
  const anchorPrice = market.minPrice ?? 55;
  const targetLow = Math.round(anchorPrice + 5);
  const targetHigh = Math.round(anchorPrice + 15);
  const targetPrice =
    kwPrice ??
    `$${targetLow}.99–$${targetHigh}.99（较竞品样本价带上探，用差异化功能支撑溢价）`;

  return {
    name,
    mustHave: mustHave.length
      ? mustHave
      : ["待 VOC 差评 / 关键词功能分层就绪后再锁定 Must-have"],
    niceToHave: niceToHave.length ? niceToHave : ["待差异化功能信号补齐"],
    avoid: avoid.length ? avoid : ["避免无证据堆功能"],
    targetPrice,
  };
}

function enrichDirectionsWithKeyword(
  directions: ProductDirectionProposal[],
  keyword: KeywordLaunchConclusions | null,
  productDefinition: ProductLaunchAnalysis["productDefinition"]
) {
  if (!keyword?.hasData) return directions;

  const audience = keywordItemValue(keyword, "customer_profile", "核心使用人群");
  const age = keywordItemValue(keyword, "customer_profile", "重点年龄段");
  const scenario = keywordItemValue(keyword, "customer_profile", "主要使用场景");
  const baseFn = keywordItemValue(keyword, "product_dev", "基础功能清单");
  const diffFn = keywordItemValue(keyword, "product_dev", "差异化功能清单");
  const material = keywordItemValue(keyword, "product_dev", "建议材质与规格");
  const price = keywordItemValue(keyword, "product_dev", "建议目标售价");
  const fakeNeeds = (keyword.functionMatrix ?? [])
    .filter(row => row.type === "伪需求")
    .map(row => row.keyword)
    .join("、");
  const combos = keyword.keywordCombos
    .slice(0, 3)
    .map(row => `${row.keyword}（${row.volume?.toLocaleString() ?? "—"}）`)
    .join("、");
  const kwAudience = [audience, age].filter(Boolean).join(" · ");

  return directions.map((direction, index) => ({
    ...direction,
    positioning:
      index === 0 && keyword.verdict.productProposal
        ? `【关键词】${keyword.verdict.gradeLabel} · ${keyword.verdict.opportunityType}。${direction.positioning}`
        : direction.positioning,
    targetAudience: kwAudience || direction.targetAudience,
    coreScenarios: scenario || direction.coreScenarios,
    baseFeatures: baseFn && baseFn !== "—" ? baseFn : direction.baseFeatures,
    differentiatedFeatures:
      diffFn && !diffFn.includes("暂无明显") ? `${diffFn}；${direction.differentiatedFeatures}` : direction.differentiatedFeatures,
    avoidFeatures: fakeNeeds ? `${fakeNeeds}；${direction.avoidFeatures}` : direction.avoidFeatures,
    materialStructure: material || direction.materialStructure,
    priceRange: index === 0 && price ? `${price}（关键词推算）` : direction.priceRange,
    coreSellingPoints: combos
      ? `高频组合词：${combos}。推荐定义「${productDefinition.name}」。${direction.coreSellingPoints}`
      : direction.coreSellingPoints,
    launchPriority:
      index === 0
        ? `${direction.launchPriority} · 关键词${keyword.verdict.gradeLabel}`
        : direction.launchPriority,
  }));
}

function buildDefinitionSynthesis(args: {
  categoryLabel: string;
  executiveSummary: string;
  finalDecision: FinalDecision;
  productDefinition: ProductLaunchAnalysis["productDefinition"];
  productDirections: ProductDirectionProposal[];
  opportunities: OpportunityScore[];
  negativePriorityRows: NegativePriorityRow[];
  unmetOpportunityRows: UnmetOpportunityRow[];
  keyword: KeywordLaunchConclusions | null;
}): DefinitionSynthesis {
  const {
    categoryLabel,
    executiveSummary,
    finalDecision,
    productDefinition,
    productDirections,
    opportunities,
    negativePriorityRows,
    unmetOpportunityRows,
    keyword,
  } = args;

  const topDirection = productDirections[0];
  const topOpp = opportunities[0];
  const topNegative = negativePriorityRows.find(row => row.issue !== "暂无数据");
  const topUnmet = unmetOpportunityRows.find(row => row.need !== "暂无数据");
  const demandScale = keywordItemValue(keyword, "market_demand", "核心需求规模");

  const vocSummary = executiveSummary;
  const keywordSummary = keyword?.hasData
    ? `${keyword.headline}。${keyword.verdict.productProposal}`
    : "关键词需求数据未就绪，本次定义以 VOC 机会评分为主。";

  const mergedConclusion = [
    `综合「关键词需求分析」与「竞品 VOC 洞察」，${categoryLabel}建议产品定义为「${productDefinition.name}」。`,
    topDirection ? `优先开发方向：${topDirection.id} ${topDirection.directionName}。` : "",
    `Must-have 锁定：${productDefinition.mustHave.slice(0, 3).join("；")}。`,
    `目标价位 ${productDefinition.targetPrice}。`,
    `综合决策：${finalDecision}${keyword?.hasData ? `（关键词 ${keyword.verdict.gradeLabel}）` : ""}。`,
  ]
    .filter(Boolean)
    .join("");

  const taggedEvidence: DefinitionSynthesisEvidence[] = [];
  if (keyword?.hasData && demandScale) {
    taggedEvidence.push({ source: "关键词需求分析", point: `需求规模：${demandScale}` });
  }
  if (keyword?.hasData && keyword.verdict.productProposal) {
    taggedEvidence.push({ source: "关键词需求分析", point: keyword.verdict.productProposal });
  }
  if (keyword?.keywordCombos[0]) {
    taggedEvidence.push({
      source: "关键词需求分析",
      point: `高频组合词「${keyword.keywordCombos[0].keyword}」月搜 ${keyword.keywordCombos[0].volume?.toLocaleString() ?? "—"}`,
    });
  }
  if (topNegative) {
    taggedEvidence.push({
      source: "竞品 VOC 洞察",
      point: `共同差评「${topNegative.issue}」→ ${topNegative.fixDirection}`,
    });
  }
  if (topUnmet) {
    taggedEvidence.push({
      source: "竞品 VOC 洞察",
      point: `未满足「${topUnmet.need}」→ ${topUnmet.proposal}`,
    });
  }
  if (topOpp) {
    taggedEvidence.push({
      source: "产品机会评分",
      point: `首推「${topOpp.name}」${topOpp.priorityScore.toFixed(0)} 分（${topOpp.tier}）`,
    });
  }

  return {
    headline: `${finalDecision} · ${productDefinition.name}`,
    vocSummary,
    keywordSummary,
    mergedConclusion,
    recommendedName: productDefinition.name,
    recommendedDirection: topDirection ? `${topDirection.id} ${topDirection.directionName}` : "待方向生成",
    decision: finalDecision,
    evidence: taggedEvidence,
    dataGaps: keyword?.dataGaps ?? [],
  };
}

function themeLine(summary: SummaryMap, key: DimKey, count = 3, patterns?: RegExp[]) {
  const themes = summary.get(key)?.themes ?? [];
  const picked = patterns?.length
    ? themes.filter(theme => patterns.some(pattern => pattern.test(theme.label)))
    : themes;
  return (picked.length ? picked : themes)
    .slice(0, count)
    .map(theme => theme.label)
    .join("、") || "待 VOC 归纳";
}

function difficultyLabel(score: number) {
  const labels = ["很低", "较低", "中等", "较高", "很高"];
  const clamped = Math.max(1, Math.min(5, Math.round(score)));
  return `${labels[clamped - 1]}（${clamped}/5）`;
}

function priorityLabel(opp: OpportunityScore | undefined, rank: number) {
  if (!opp) return `P2 · 观察项 · 综合排序 #${rank}`;
  return `${opp.tier} · 机会分 ${opp.priority.toFixed(2)} · 综合排序 #${rank}`;
}

function priceBandText(market: ReturnType<typeof buildMarketContext>, offsetLow = 5, offsetHigh = 12) {
  const anchor = market.minPrice ?? 55;
  const low = Math.round(anchor + offsetLow);
  const high = Math.round(anchor + offsetHigh);
  return `$${low}.99–$${high}.99`;
}

function competitorNames(products: LaunchProductInput[], count = 4) {
  return products
    .slice(0, count)
    .map(product => product.brand)
    .filter(Boolean)
    .join("、") || "样本竞品";
}

function buildProductDirectionProposals(
  summary: SummaryMap,
  market: ReturnType<typeof buildMarketContext>,
  opportunities: OpportunityScore[],
  products: LaunchProductInput[],
  family: ProductFamily
): ProductDirectionProposal[] {
  const category = inferCategoryLabel(products);
  if (family !== "scooter") {
    const rivals = competitorNames(products);
    const audiences = themeLine(summary, "audiences", 3) || "待 VOC 人群确认";
    const scenarios = themeLine(summary, "scenarios", 3) || "待 VOC 场景确认";
    const positives = themeLine(summary, "positives", 3) || "高频好评主题";
    const negatives = themeLine(summary, "negatives", 3) || "高频差评主题";
    const unmet = themeLine(summary, "unmet", 3) || "未满足需求主题";
    const priceBand =
      market.minPrice !== null && market.maxPrice !== null
        ? `$${market.minPrice.toFixed(0)}–$${market.maxPrice.toFixed(0)}`
        : "竞品价格带待补";
    const lighting = family === "lighting";
    return [
      {
        id: "方向 A",
        directionName: lighting ? "稳固置物落地灯（Reliability-first）" : `${category} 可靠基础款`,
        positioning: `${category}中端定位：先兑现稳固与主功能，再谈差异化`,
        targetAudience: audiences,
        coreScenarios: scenarios,
        painPoints: negatives,
        baseFeatures: lighting
          ? `多层置物 + LED 照明 + 可替换灯泡；保留 ${positives}`
          : `该类目主功能必须保留：${positives}`,
        differentiatedFeatures: lighting
          ? "底座配重防晃 + 层板承重标注 + 柔光灯罩"
          : unmet,
        avoidFeatures: lighting ? "首代不做全新智能灯控平台；不虚标承重" : "不把未验证功能写入首版",
        materialStructure: lighting
          ? "灯杆金属连接 + 加重底座 + 层板承重可抽检"
          : "承力结构加强，规格与实物一致",
        accessoryBundle: lighting ? "备用灯泡/螺丝包可选" : "关键易损件备件路径",
        priceRange: priceBand,
        coreSellingPoints: lighting ? "灯架一体、稳固不晃、柔光不刺眼" : positives,
        competitorDifference: `相对 ${rivals}：把 VOC 差评「${negatives}」做成可验收规格`,
        qualityRisks: lighting ? "层板薄、灯杆晃、运输破损" : "结构降本反噬好评",
        complianceRisks: lighting ? "UL/ETL 与倾倒测试范围待确认" : "该类目适用认证待确认",
        developmentDifficulty: "中",
        launchPriority: "P0",
      },
      {
        id: "方向 B",
        directionName: lighting ? "客厅氛围光 + 置物展示款" : `${category} 场景强化款`,
        positioning: `围绕 VOC 场景「${scenarios}」做可感知差异`,
        targetAudience: audiences,
        coreScenarios: scenarios,
        painPoints: unmet,
        baseFeatures: positives,
        differentiatedFeatures: lighting ? "三色温切换 + 置物场景主图体系" : unmet,
        avoidFeatures: "把搜索大词直接当产品功能堆砌",
        materialStructure: lighting ? "灯罩柔光材质 + 层间距覆盖相框/绿植" : "按场景转规格，不空喊场景词",
        accessoryBundle: "场景演示配件可选",
        priceRange: priceBand,
        coreSellingPoints: lighting ? "客厅角落一盏多用" : scenarios,
        competitorDifference: `相对 ${rivals}：场景兑现可拍照、可复测`,
        qualityRisks: "色温/亮度投诉或场景货不对板",
        complianceRisks: "光源宣称需可验证",
        developmentDifficulty: "中",
        launchPriority: "P1",
      },
      {
        id: "方向 C",
        directionName: lighting ? "易装防破损运营款" : `${category} 体验优化款`,
        positioning: "用安装与包装体验降低差评，不改主形态",
        targetAudience: audiences,
        coreScenarios: "开箱安装与到货完好",
        painPoints: themeLine(summary, "negatives", 2, [/安装|包装|破损/]) || "安装/包装差评",
        baseFeatures: "编号零件 + 图文安装 + 护角包装",
        differentiatedFeatures: "QR 安装视频与缺件补寄路径",
        avoidFeatures: "空泛「易于组装」而无步骤",
        materialStructure: "包材与卡槽改版，不改主结构模具",
        accessoryBundle: "扳手/螺丝按编号随货",
        priceRange: priceBand,
        coreSellingPoints: "开箱即装、到货完好",
        competitorDifference: `相对 ${rivals}：安装时长与破损率可抽检`,
        qualityRisks: "说明不清仍导致差评",
        complianceRisks: "低",
        developmentDifficulty: "低",
        launchPriority: "P1",
      },
    ];
  }

  const rivals = competitorNames(products);
  const oppMap = new Map(opportunities.map(item => [item.id, item]));

  const durabilityPain = themeLine(summary, "negatives", 2, [/耐用|结构|轮/]);
  const unmetSpares = themeLine(summary, "unmet", 2, [/备件|售后/]);
  const audiences = themeLine(summary, "audiences", 3);
  const scenarios = themeLine(summary, "scenarios", 3);
  const motives = themeLine(summary, "motives", 3);
  const positives = themeLine(summary, "positives", 3, [/安装|质量|稳定|led/i]);
  const leanPain = themeLine(summary, "negatives", 2, [/lean|转向/]) || themeLine(summary, "unmet", 2, [/lean|转向|踏板/]);
  const giftScenarios = themeLine(summary, "scenarios", 2, [/礼物|节日|生日/]) || "礼物/节日赠礼";
  const attentionTop = themeLine(summary, "attention", 4);

  const directionA: ProductDirectionProposal = {
    id: "方向 A",
    directionName: "可维护耐用入门款（Reliability-first）",
    positioning: `${category}中高端入门定位：不做最低价 LED 车，做「结构可靠 + 官方可购备件」的长期陪伴型第一辆`,
    targetAudience: `${audiences}；家长/礼物决策人优先`,
    coreScenarios: `${scenarios}；以日常户外 + 入门练习为主`,
    painPoints: `${durabilityPain}；${unmetSpares || "备件/售后渠道不足"}`,
    baseFeatures: `三轮稳定结构、Lean-to-steer、可调手把、后轮刹车、基础 LED、易装包装；保留 ${positives || "安装便捷与质量口碑"}`,
    differentiatedFeatures: "加厚前轴/连接件 + 耐磨 PU 后轮；FBA 官方备件包（前轮×1 + 后轮×2 + 紧固件）；QR 30 秒组装/转向说明",
    avoidFeatures: "纯发光噱头无结构升级；首代全新专利转向机构；与头部低价 sit-stand 正面硬刚",
    materialStructure: "铝合金 Deck 加强筋；钢质前轴 + 金属衬套；PU 轮 80A+；130lb 承重诚实标注；4 档可调手把",
    accessoryBundle: "主品 + 备件包独立 SKU；说明书内附复购链接；可选螺丝/工具小包",
    priceRange: `${priceBandText(market, 5, 12)}（较样本均价 +$5–10，用「可维护」支撑溢价）`,
    coreSellingPoints: "「坏了能买到件、修完继续骑」；耐用结构；官方备件；保留礼物场景 LED",
    competitorDifference: `相对 ${rivals}：竞品普遍缺官方备件与结构冗余，差评集中在 1–4 个月损坏；我们以可维护性切位`,
    qualityRisks: "结构加强后增重；备件 SKU 库存与版本匹配；装配一致性需 QC",
    complianceRisks: "沿用现有平台改件，ASTM/CPSIA 变更风险低；避免未验证的新电子方案",
    developmentDifficulty: difficultyLabel(6 - (oppMap.get("A")?.feasibility ?? 4)),
    launchPriority: priorityLabel(oppMap.get("A"), 1),
  };

  const directionB: ProductDirectionProposal = {
    id: "方向 B",
    directionName: "低龄友好第一辆（Low-age Lean-to-steer）",
    positioning: "聚焦 2–4 岁真正低幼入门：解决「转不动、够不着、学不会」",
    targetAudience: "2–4 岁幼儿家庭；祖父母/首次送礼家长",
    coreScenarios: `${themeLine(summary, "scenarios", 2, [/第一辆|入门/]) || "第一辆滑板车"}、${themeLine(summary, "scenarios", 2, [/室内|户外/]) || "社区/室内短骑"}`,
    painPoints: `${leanPain}；${themeLine(summary, "unmet", 2, [/踏板|deck|承重/i]) || "踏板偏高、转向学习曲线陡"}`,
    baseFeatures: "三轮 + Lean-to-steer + 宽踏板 + 可调手把 + 基础 LED；保留易装与稳定",
    differentiatedFeatures: "转向阻力限位/可调；盒内 QR 低幼转向教学；更低踏板或 step-through 设计（小改模）；承重/适龄标签前置",
    avoidFeatures: "完全取消 Lean-to-steer；首代大改 Deck 模具 + 新转向专利同步推进",
    materialStructure: "轻量转向机构微调；更短初始把位；Deck 高度下降 1–2cm（小改）；软握把",
    accessoryBundle: "教学卡/二维码卡片；可选低幼贴纸套装（无额外结构件）",
    priceRange: `${priceBandText(market, 3, 10)}（中等溢价，靠体验差异而非堆 LED）`,
    coreSellingPoints: "更低幼友好；转向更易掌握；第一辆更安心",
    competitorDifference: `竞品 Lean-to-steer 偏大龄；我们在 ${rivals} 差评高频的转向/踏板问题上做限位与说明`,
    qualityRisks: "转向限位调参不当影响大龄段；Deck 小改需重心复测",
    complianceRisks: "Deck/把位变更需复测 ASTM；说明文案避免过度安全承诺",
    developmentDifficulty: difficultyLabel(6 - (oppMap.get("B")?.feasibility ?? 4)),
    launchPriority: priorityLabel(oppMap.get("B"), 2),
  };

  const directionC: ProductDirectionProposal = {
    id: "方向 C",
    directionName: "礼物季礼盒版（Gift-ready Bundle）",
    positioning: "礼物场景中高端 SKU：第一眼吸引 + 开箱完美 + 结构不缩水",
    targetAudience: `${themeLine(summary, "audiences", 2, [/礼物|祖父母|家长/]) || "礼物购买者"}；${themeLine(summary, "motives", 2, [/礼物|孩子喜欢/]) || motives}`,
    coreScenarios: `${giftScenarios}；生日/节日赠礼`,
    painPoints: `${themeLine(summary, "negatives", 2, [/led|发光|包装|缺件/]) || "LED 失效、包装缺件、开箱体验差"}`,
    baseFeatures: `${positives || "易装、稳定、LED 基础款"}；保留三轮与可调把`,
    differentiatedFeatures: "礼盒包装 SKU；长寿命/可换 LED 模组；出厂全检 + 缺件补寄承诺；备件包捆绑礼盒版",
    avoidFeatures: "最亮 LED 军备竞赛；过度包装导致成本失控；无结构升级的纯外观礼盒",
    materialStructure: "成熟 LED 模组（目标 6 个月不熄）；加固包装内衬；礼盒版可沿用方向 A 结构件",
    accessoryBundle: "礼盒主品 + 备件小包 + LED 备用轮（可选）；节日限定配色",
    priceRange: `${priceBandText(market, 8, 18)}（礼盒溢价 +$8–15，Q4 礼物季）`,
    coreSellingPoints: "「送得出手、亮得持久、坏了有件」；礼盒开箱体验；孩子第一眼 WOW",
    competitorDifference: `礼物场景下 ${rivals} LED 寿命参差；我们绑定耐久模组 + 备件 + 礼盒 QC`,
    qualityRisks: "LED 模组批次一致性；礼盒运输破损；多 SKU 库存压力",
    complianceRisks: "LED 电子件需合规证书；节日营销文案注意适龄声明",
    developmentDifficulty: difficultyLabel(6 - (oppMap.get("C")?.feasibility ?? 3)),
    launchPriority: priorityLabel(oppMap.get("C"), 3),
  };

  const deckRelevance = conceptStrength(summary, [/踏板|deck/i, /2.*岁/], ["unmet", "scenarios"]);
  const directionD: ProductDirectionProposal = {
    id: "方向 D",
    directionName: "低幼 Deck 优化款（2–3 岁专项）",
    positioning: "更窄人群切入：2–3 岁独立蹬地入门，牺牲部分大龄段通用性",
    targetAudience: "2–3 岁幼儿；身高/腿长偏小的孩子",
    coreScenarios: "室内/平滑地面短骑；从坐滑到站滑的过渡前期",
    painPoints: themeLine(summary, "unmet", 3, [/踏板|deck|蹬地|2.*岁/i]) || "Deck 偏高、低龄难蹬地",
    baseFeatures: "三轮、低把位、宽踏板、基础 LED、易装",
    differentiatedFeatures: "更低 Deck 新模具；更轻车身；转向阻力更低；明确 2–3 岁适龄标签",
    avoidFeatures: "与方向 B 同时首代大改 Deck + 新转向；追求 8–10 岁通用性",
    materialStructure: "Deck 降高 2–3cm 新模；更轻量管材；PU 软轮可选",
    accessoryBundle: "低幼护具推荐卡（非捆绑）；备件包简化版",
    priceRange: `${priceBandText(market, 6, 14)}（小批量 niche 定价）`,
    coreSellingPoints: "真正 2–3 岁能蹬地；更低重心更稳",
    competitorDifference: "竞品多覆盖 1–14 岁泛化；我们专注低幼 Deck 高度",
    qualityRisks: "新模开模周期；重心变化影响转向；大龄段市场收窄",
    complianceRisks: "Deck/重心变更需完整 ASTM/CPSIA 重测；IP 注意现有 Lean-to-steer 专利布局",
    developmentDifficulty: difficultyLabel(6 - (oppMap.get("D")?.feasibility ?? 3)),
    launchPriority: priorityLabel(oppMap.get("D"), 4),
  };

  const directions = [directionA, directionB, directionC];
  if (deckRelevance > 0.12 && oppMap.get("D")) {
    directions.push(directionD);
  }

  return directions.slice(0, Math.max(3, Math.min(4, directions.length)));
}

function applyKeywordEvidenceToVerdict(
  verdict: ProductLaunchAnalysis["verdict"],
  keyword: KeywordLaunchConclusions | null,
  hasVocData: boolean,
): ProductLaunchAnalysis["verdict"] {
  if (!hasVocData) {
    const boundary = keyword?.hasData
      ? "关键词不能替代缺失 VOC"
      : keywordEvidenceNote(keyword);
    return {
      ...verdict,
      summary: `${verdict.summary} ${boundary}。`,
      reasons: [...verdict.reasons, boundary],
    };
  }

  if (!keyword?.hasData) {
    const boundary = keywordEvidenceNote(keyword);
    return {
      ...verdict,
      title: `${verdict.title}（关键词待验证）`,
      summary: `${verdict.summary} ${boundary}。`,
      reasons: [...verdict.reasons, boundary],
    };
  }

  const evidence = keywordEvidenceNote(keyword);
  return {
    ...verdict,
    summary: `${verdict.summary} ${evidence}。`,
    reasons: [...verdict.reasons, evidence],
  };
}

function buildVerdict(
  opportunities: OpportunityScore[],
  market: ReturnType<typeof buildMarketContext>,
  hasData: boolean,
  keyword: KeywordLaunchConclusions | null,
) {
  const top = opportunities[0];
  const priority = top?.priority ?? 0;

  if (!hasData) {
    return applyKeywordEvidenceToVerdict({
      status: "hold" as const,
      title: "暂不建议立项",
      summary: "VOC 或评论分析数据尚未就绪，请先同步数据源后重新评估。",
      reasons: ["缺少 VOC 七维汇总", "无法计算交叉分析与机会优先级"],
    }, keyword, hasData);
  }

  if (priority >= 4.5 && market.totalSales >= 5000) {
    return applyKeywordEvidenceToVerdict({
      status: "conditional" as const,
      title: "建议立项：有条件通过",
      summary: "需求真实、竞品缺口清晰、供应链可落地；需确认 BOM、LED 寿命与毛利模型后全票通过。",
      reasons: [
        "需求真实且高频：耐用/结构横跨关注、差评、未满足，且头部 ASIN 月销可观",
        "竞品缺口清晰：「坏了能买到件、能修能继续骑」尚未被普遍解决",
        "供应链可落地：P0 不需全新平台，合规风险低于新 Deck/新转向专利",
      ],
    }, keyword, hasData);
  }

  if (priority >= 3.5) {
    return applyKeywordEvidenceToVerdict({
      status: "conditional" as const,
      title: "建议立项：有条件通过",
      summary: "方向可行但需补齐市场或供应链验证后再全款立项。",
      reasons: [
        `首要机会「${top?.name ?? "—"}」优先级 ${priority.toFixed(2)}`,
        market.totalSales >= 3000 ? "样本月销支持中等体量类目" : "建议扩大竞品样本验证市场容量",
        "优先落地结构加强 + 备件包 + 说明优化组合",
      ],
    }, keyword, hasData);
  }

  return applyKeywordEvidenceToVerdict({
    status: "hold" as const,
    title: "建议观察，暂缓立项",
    summary: "当前 VOC 信号未形成足够强的高优先级机会，或市场样本不足。",
    reasons: ["机会优先级偏低", "建议同步更多竞品 VOC 与 Sorftime 销量后复评"],
  }, keyword, hasData);
}

function applyKeywordEvidenceToVocPositioning(
  positioning: VocPositioningConclusion,
  keyword: KeywordLaunchConclusions | null,
): VocPositioningConclusion {
  if (!keyword?.hasData) {
    const boundary = "关键词需求未就绪，当前定位保持 VOC 代理判断，不代表搜索需求规模已验证";
    return {
      ...positioning,
      rationale: [...positioning.rationale, boundary],
      nextValidations: ["补齐目标 ASIN 的关键词需求数据", ...positioning.nextValidations].slice(0, 6),
      dataBoundary: `${positioning.dataBoundary} ${boundary}。`,
    };
  }

  const evidence = keywordEvidenceNote(keyword);
  return {
    ...positioning,
    rationale: [...positioning.rationale, evidence],
    nextValidations: ["继续验证关键词规模、趋势与转化是否支持该 VOC 定位", ...positioning.nextValidations].slice(0, 6),
    dataBoundary: `${positioning.dataBoundary} ${evidence}。`,
  };
}

export function buildProductLaunchAnalysis(
  products: readonly LaunchProductInput[],
  sources: ProductLaunchRuntimeSources,
): ProductLaunchAnalysis {
  const productList = [...products];
  const family = familyFromProducts(productList);
  const summaries = buildVocDevelopmentSummary(productList.map(product => ({
    asin: product.asin,
    brand: product.brand,
    productFamily: product.productFamily ?? family,
  })), sources.manualVocByAsin);
  const summary: SummaryMap = new Map(summaries.map(item => [item.key, item]));
  const market = buildMarketContext(productList);
  const hasData = hasVocDevelopmentData(productList, sources.manualVocByAsin);
  const opportunities = buildOpportunities(summary, market, family);
  const crossAnalyses = buildCrossAnalyses(summary, market);
  const supplyRows = buildSupplyRows(family);

  crossAnalyses.find(section => section.id === "supply-opportunity")!.rows = supplyRows.map(row => ({
    anchor: row.direction,
    left: row.feasibility,
    right: row.risk,
    insight: row.feasibility.includes("★★★★★") ? "优先落地" : row.feasibility.includes("★★") ? "首代回避" : "可纳入 P0/P1",
  }));

  const keywordConclusions = buildKeywordConclusions(sources.keywordDemand, productList);
  const verdict = buildVerdict(opportunities, market, hasData, keywordConclusions);
  const negativePriorityRows = buildNegativePriorityRows(summary, productList.length, family);
  const positivePriorityRows = buildPositivePriorityRows(summary, productList.length, family);
  const unmetOpportunityRows = buildUnmetOpportunityRows(summary, market, family);
  const productDefinition = buildProductDefinition(
    opportunities,
    market,
    summary,
    negativePriorityRows,
    unmetOpportunityRows,
    keywordConclusions
  );
  const productDirections = enrichDirectionsWithKeyword(
    buildProductDirectionProposals(summary, market, opportunities, productList, family),
    keywordConclusions,
    productDefinition
  );
  const topScore = opportunities[0]?.priorityScore ?? 0;
  const finalDecision: FinalDecision = !hasData
    ? "暂不开发"
    : verdict.status === "hold"
      ? topScore >= 50
        ? "继续观察"
        : "暂不开发"
      : scoreBand(topScore);
  const executiveSummary = buildExecutiveSummary(
    summary,
    market,
    opportunities,
    finalDecision,
    inferCategoryLabel(productList),
    keywordConclusions,
  );
  const vocInsightRows = buildVocInsightRows(summary, productList.length);
  const topAudiencesLabel = summary.get("audiences")?.themes?.slice(0, 2).map(t => t.label).join("、");
  const topScenariosLabel = summary.get("scenarios")?.themes?.slice(0, 2).map(t => t.label).join("、");
  const priceBandForPositioning =
    market.minPrice !== null && market.maxPrice !== null
      ? `$${market.minPrice.toFixed(0)}–$${market.maxPrice.toFixed(0)}`
      : null;
  const vocPositioning = applyKeywordEvidenceToVocPositioning(buildVocPositioningConclusion({
    categoryLabel: inferCategoryLabel(productList),
    family,
    priceBand: priceBandForPositioning,
    positives: positivePriorityRows,
    negatives: negativePriorityRows,
    unmets: unmetOpportunityRows,
    audiences: topAudiencesLabel,
    scenarios: topScenariosLabel,
  }), keywordConclusions);
  const definitionSynthesis = buildDefinitionSynthesis({
    categoryLabel: inferCategoryLabel(productList),
    executiveSummary,
    finalDecision,
    productDefinition,
    productDirections,
    opportunities,
    negativePriorityRows,
    unmetOpportunityRows,
    keyword: keywordConclusions,
  });
  const finalAnswers = buildFinalAnswers(
    summary,
    market,
    opportunities,
    productDirections,
    productDefinition,
    finalDecision,
    inferCategoryLabel(productList)
  );
  const topNegative = summary.get("negatives")?.themes[0]?.label;
  const topUnmet = summary.get("unmet")?.themes[0]?.label;
  const topAttention = summary.get("attention")?.themes[0]?.label;
  const topMotives = summary.get("motives")?.themes?.slice(0, 2).map(t => t.label).join("、");
  const topAudiences = summary.get("audiences")?.themes?.slice(0, 2).map(t => t.label).join("、");
  const topScenarios = summary.get("scenarios")?.themes?.slice(0, 2).map(t => t.label).join("、");
  const priceBand =
    market.minPrice !== null && market.maxPrice !== null
      ? `$${market.minPrice}–$${market.maxPrice}`
      : undefined;
  const sampleSales =
    market.totalSales > 0 ? `${market.totalSales.toLocaleString()} 件/月` : undefined;
  const checklistResult = buildLaunchChecklist({
    products: productList.map(product => ({
      asin: product.asin,
      brand: product.brand,
      title: product.title,
      subRankCategory: product.subRankCategory,
      rankCategory: product.rankCategory,
      price: product.price,
      sales: product.sales,
      rating: product.rating,
      reviews: product.reviews,
      launch: product.launch,
    })),
    opportunities,
    categoryLabel: inferCategoryLabel(productList),
    topNegativeLabel: topNegative,
    topUnmetLabel: topUnmet,
    topAttentionLabel: topAttention,
    topMotivesLabel: topMotives,
    topAudiencesLabel: topAudiences,
    topScenariosLabel: topScenarios,
    targetPrice: productDefinition.targetPrice,
    priceBand,
    sampleSales,
    dataMonth: market.dataMonth,
    verdictTitle: `${finalDecision} · ${verdict.title} · ${keywordEvidenceNote(keywordConclusions)}`,
    hasVoc: hasData,
    productDefinitionName: productDefinition.name,
  });
  const totalItems = checklistResult.groups.reduce((sum, group) => {
    if (group.kind === "table" || group.kind === "score") return sum;
    return sum + group.items.length;
  }, 0);

  return {
    meta: {
      productCount: products.length,
      brands: productList.map(product => product.brand),
      categoryLabel: inferCategoryLabel(productList),
      dataMonth: market.dataMonth,
      sources: ["VOC 核心主题", "Sorftime 智能评论分析", "Sorftime 月销量 trend", "SIF 关键词需求", "竞品 catalog"],
      analyzedAt: new Date().toISOString().slice(0, 10),
    },
    executiveSummary,
    verdict,
    conclusions: buildConclusions(summary, market),
    vocInsightRows,
    dimensionAnchors: buildDimensionAnchors(summary),
    negativePriorityRows,
    positivePriorityRows,
    unmetOpportunityRows,
    vocPositioning,
    crossAnalyses,
    marketRows: buildMarketRows(market),
    supplyRows,
    opportunities,
    productDefinition,
    productDirections,
    definitionSynthesis,
    keywordConclusions,
    finalAnswers,
    finalDecision,
    checklist: checklistResult.groups,
    checklistMeta: {
      verticalLabel: checklistResult.verticalLabel,
      policy: launchChecklistMeta.policy,
      totalItems,
      version: checklistResult.version,
    },
    checklistResearch: checklistResult.research,
  };
}

export function hasProductLaunchAnalysis(
  products: readonly LaunchProductInput[],
  sources: ProductLaunchRuntimeSources,
) {
  return hasVocDevelopmentData(products, sources.manualVocByAsin);
}
