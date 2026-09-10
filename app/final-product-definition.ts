/**
 * VOC × 关键词 → 最终产品定义
 * 对齐 Skill：define-amazon-product-from-voc-keywords
 */

import type { KeywordLaunchConclusions } from "./keyword-demand-conclusions";
import { formatSeasonMonthLabel } from "./keyword-demand-conclusions";
import type { VocPositioningConclusion, VocMergedThemeRow, VocPriorityLevel } from "./features/voc/voc-positioning";

export type FinalProductRole =
  | "核心基础"
  | "核心强化"
  | "保留并重做"
  | "差异化突破"
  | "体验优化"
  | "新品避坑"
  | "可选配置"
  | "暂不开发"
  | "待验证";

export type FinalOpportunityGrade = "A" | "B" | "C" | "D";

export type FinalCrossRow = {
  theme: string;
  vocEvidence: string;
  keywordEvidence: string;
  marketDemand: string;
  userValue: string;
  competition: string;
  judgment: string;
  role: FinalProductRole;
  priority: VocPriorityLevel | "待验证";
};

export type FinalDefinitionRow = {
  dimension: string;
  conclusion: string;
  vocBasis: string;
  keywordBasis: string;
  action: string;
  priority: string;
  pending: string;
};

export type FinalKeywordGroupRow = {
  type: string;
  keywords: string;
  productLink: string;
  listingAngle: string;
  skuHint: string;
};

export type FinalPriorityRow = {
  priority: string;
  direction: string;
  evidence: string;
  businessImpact: string;
  action: string;
  acceptance: string;
};

export type FinalFeatureLayers = {
  mustHave: Array<{ item: string; evidence: string }>;
  differentiation: Array<{ item: string; evidence: string }>;
  optional: Array<{ item: string; evidence: string }>;
  notInV1: Array<{ item: string; evidence: string }>;
  p0Avoid: Array<{ item: string; evidence: string }>;
};

export type FinalProductDefinitionReport = {
  meta: {
    categoryLabel: string;
    productCount: number;
    dataMonth: string;
    analyzedAt: string;
    sources: string[];
  };
  hasData: boolean;
  oneLiner: string;
  /** 一句话定义拆成可读卡片，避免长段挤在一起 */
  oneLinerCards: Array<{
    key: string;
    label: string;
    value: string;
    tone: "audience" | "scenario" | "pain" | "product" | "base" | "diff" | "avoid" | "traffic";
  }>;
  rationale: Array<{
    key: string;
    label: string;
    value: string;
    highlight?: string;
    tone: "keyword" | "voc" | "negative" | "dual" | "p0" | "combo" | "default";
  }>;
  opportunity: {
    grade: FinalOpportunityGrade;
    gradeLabel: string;
    judgment: string;
    demandBasis: string;
    entryPath: string;
    mainRisks: string;
    note: string;
  };
  crossRows: FinalCrossRow[];
  definitionRows: FinalDefinitionRow[];
  featureLayers: FinalFeatureLayers;
  keywordGroups: FinalKeywordGroupRow[];
  priorityRows: FinalPriorityRow[];
  risks: string[];
  nextValidations: string[];
  dataBoundary: string;
};

const DATA_BOUNDARY =
  "当前最终产品定义由VOC与关键词需求交叉推导。关键词数据反映搜索需求和市场入口，VOC反映使用体验与需求缺口；两者均不能单独证明销量、利润或立项可行性。完整立项仍需验证竞争、成本利润、专利合规、MOQ、供应链和现金投入。";

const THEME_KEYWORD_PATTERNS: Array<{ themePattern: RegExp; keywordPattern: RegExp }> = [
  { themePattern: /耐用|结构|可靠|质量/, keywordPattern: /durable|sturdy|heavy\s*duty|steel|metal|strong|quality|solid/i },
  { themePattern: /lean|转向|操控/, keywordPattern: /lean|steer|turn|handlebar|easy\s*to\s*use|ride/i },
  { themePattern: /安装|组装/, keywordPattern: /assembl|install|easy\s*setup|tool\s*free|easy\s*to\s*assemble/i },
  { themePattern: /led|发光|灯|礼物|乐趣/, keywordPattern: /led|light|glow|gift|fun|pink/i },
  { themePattern: /稳定|平衡/, keywordPattern: /stable|balance|3\s*wheel|three\s*wheel|tricycle/i },
  { themePattern: /车把|可调|高度/, keywordPattern: /adjustable|height|handlebar/i },
  { themePattern: /踏板|deck|适龄|尺寸|年龄|幼儿|儿童/, keywordPattern: /deck|wide|toddler|child|kids?|age|year|niñ|\d+\s*[-–]\s*\d+/i },
  { themePattern: /备件|售后|可维护/, keywordPattern: /replacement|spare|part|wheel|kit/i },
  { themePattern: /折叠|便携/, keywordPattern: /fold|portable|travel|compact/i },
  { themePattern: /安全|刹车/, keywordPattern: /safe|brake|helmet/i },
  { themePattern: /顺滑|骑行/, keywordPattern: /smooth|ride|pu\s*wheel|wheel/i },
];

function demandLevelFromVolume(volume: number | null | undefined, fallback: "中" | "中高" = "中") {
  if (volume != null && volume > 10000) return { demand: "高", strength: "high" as const };
  if (volume != null && volume >= 3000) return { demand: "中高", strength: "mid" as const };
  return { demand: fallback, strength: "mid" as const };
}
function normalizeSeasonalityText(raw: string | null | undefined) {
  if (!raw || raw === "—" || raw === "待验证") return raw ?? null;
  return raw.replace(/\b(\d{4})-(\d{2})\b/g, (_match, _year: string, month: string) => {
    const label = formatSeasonMonthLabel(month);
    return label ?? `${Number(month)}月`;
  });
}

function keywordItemValue(keyword: KeywordLaunchConclusions | null, sectionId: string, label: string) {
  const section = keyword?.sections.find(item => item.id === sectionId);
  const item = section?.items.find(row => row.label === label);
  const value = item?.value?.trim();
  if (!value || value === "—") return null;
  if (label.includes("旺季") || label.includes("淡季") || label.includes("季节")) {
    return normalizeSeasonalityText(value);
  }
  return value;
}

function pickTexts(items: Array<string | null | undefined>, limit = 4) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const text = item?.replace(/\s+/g, " ").trim();
    if (!text || text === "—" || text === "暂无数据") continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

/** 截短说明文，优先保留「」内主题；maxParts 控制主题数量，maxChars 控制总长 */
function shortenField(raw: string | null | undefined, maxParts = 4, maxChars = 96) {
  const text = raw?.replace(/\s+/g, " ").trim() ?? "";
  if (!text) return "—";
  const quoted = [...text.matchAll(/「([^」]+)」/g)].map(m => m[1].trim()).filter(Boolean);
  if (quoted.length) {
    const joined = quoted.slice(0, maxParts).join("、");
    return joined.length > maxChars ? `${joined.slice(0, maxChars - 1)}…` : joined;
  }
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}

function extractQuotedThemes(raw: string | null | undefined, limit = 3) {
  const text = raw?.replace(/\s+/g, " ").trim() ?? "";
  const quoted = [...text.matchAll(/「([^」]+)」/g)].map(m => m[1].trim()).filter(Boolean);
  return quoted.slice(0, limit);
}

function formatVolume(value: number | null | undefined) {
  if (value == null || value <= 0) return "—";
  return value.toLocaleString();
}

function matchKeywordEvidence(theme: string, keyword: KeywordLaunchConclusions | null) {
  if (!keyword?.hasData) return { text: "关键词数据未就绪", demand: "无法判断", strength: "none" as const };

  const rule = THEME_KEYWORD_PATTERNS.find(item => item.themePattern.test(theme));
  const pool = [
    ...(keyword.functionMatrix ?? []).map(row => ({ keyword: row.keyword, volume: row.volume, type: row.type as string })),
    ...(keyword.keywordCombos ?? []).map(row => ({ keyword: row.keyword, volume: row.volume, type: "组合词" })),
  ];
  const hits = rule ? pool.filter(row => rule.keywordPattern.test(row.keyword)) : [];
  hits.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));

  const audience = keywordItemValue(keyword, "customer_profile", "核心使用人群");
  const age = keywordItemValue(keyword, "customer_profile", "重点年龄段");
  const scenario = keywordItemValue(keyword, "customer_profile", "主要使用场景");

  if (/人群|年龄|适龄|幼儿|儿童|家长|deck|踏板/i.test(theme) && (audience || age || hits.length)) {
    const top = hits[0];
    const level = demandLevelFromVolume(top?.volume, "中高");
    return {
      text: top
        ? `${top.keyword}（月搜 ${formatVolume(top.volume)}）`
        : [audience, age].filter(Boolean).join(" · ") || "人群/年龄词存在",
      demand: level.demand,
      strength: level.strength,
    };
  }
  if (/场景|户外|旅行|礼物/.test(theme) && (scenario || hits.length)) {
    const top = hits[0];
    const level = demandLevelFromVolume(top?.volume, "中");
    return {
      text: top ? `${top.keyword}（月搜 ${formatVolume(top.volume)}）` : scenario || "场景词存在",
      demand: level.demand,
      strength: level.strength,
    };
  }

  if (hits.length) {
    const top = hits[0]!;
    const level = demandLevelFromVolume(top.volume, top.type === "基础必备" || top.type === "高关注" ? "中高" : "中");
    return {
      text: `${top.keyword}（${top.type} · 月搜 ${formatVolume(top.volume)}）`,
      demand: level.demand,
      strength: level.strength,
    };
  }

  return {
    text: "无明显对应高相关搜索词；可能为体验隐性需求",
    demand: "低/隐性",
    strength: "low" as const,
  };
}

function mapRole(
  vocRole: VocMergedThemeRow["role"],
  kwStrength: "high" | "mid" | "low" | "none",
  priority: VocPriorityLevel
): { role: FinalProductRole; judgment: string; priority: VocPriorityLevel | "待验证" } {
  if (vocRole === "新品避坑" || priority === "P0") {
    return {
      role: "新品避坑",
      judgment:
        kwStrength === "high" || kwStrength === "mid"
          ? "市场有搜索，但现有供给体验差/存在失效风险 → 保留功能目标并重做实现，P0 避坑"
          : "使用后痛点明确，即使搜索弱也必须解决，不强行做成获客卖点",
      priority: "P0",
    };
  }
  if (vocRole === "核心保留") {
    if (kwStrength === "high") {
      return {
        role: "核心基础",
        judgment: "VOC 高喜爱 × 关键词高需求 → 双重验证核心基础",
        priority: priority === "待验证" ? "P1" : priority,
      };
    }
    return {
      role: "核心强化",
      judgment: "VOC 高喜爱但搜索未必是获客词 → 保留体验基础，不作为唯一流量卖点",
      priority: priority === "P0" ? "P0" : "P1",
    };
  }
  if (vocRole === "保留并重做") {
    return {
      role: "保留并重做",
      judgment: "喜爱与差评同时偏高 → 保留功能目标，重做结构/说明/耐久实现",
      priority: priority === "P0" ? "P0" : "P1",
    };
  }
  if (vocRole === "差异化突破") {
    if (kwStrength === "high") {
      return { role: "差异化突破", judgment: "VOC 未满足 × 关键词高需求/组合机会 → 强差异化候选", priority: "P1" };
    }
    return { role: "待验证", judgment: "VOC 未满足但搜索偏弱 → 体验差异化候选，需用户/概念测试", priority: "待验证" };
  }
  if (vocRole === "选择性优化") {
    return {
      role: kwStrength === "high" ? "可选配置" : "体验优化",
      judgment: kwStrength === "high" ? "中频 VOC × 有搜索支撑 → 可选配置/变体" : "中频体验优化，首版控制范围",
      priority: "P2",
    };
  }
  if (vocRole === "观察/伪需求") {
    return {
      role: "暂不开发",
      judgment: "VOC 弱信号；若关键词亦弱则首版排除，避免堆功能",
      priority: "P3",
    };
  }
  return { role: "待验证", judgment: "证据不足或冲突，标记待验证", priority: "待验证" };
}

function decideGrade(
  keyword: KeywordLaunchConclusions | null,
  voc: VocPositioningConclusion,
  crossRows: FinalCrossRow[]
): FinalProductDefinitionReport["opportunity"] {
  const kwGrade = keyword?.verdict.grade ?? "C";
  const hasP0 = crossRows.some(row => row.priority === "P0");
  const dualCore = crossRows.some(row => row.role === "核心基础" || row.role === "核心强化");
  const diffReady = crossRows.some(row => row.role === "差异化突破");
  const demandScale = keywordItemValue(keyword, "market_demand", "核心需求规模") ?? "需求规模待验证";
  const competition = keywordItemValue(keyword, "competition", "竞争进入难度") ?? "竞争待验证";
  const note = "需求与产品定义等级，不等同于完整立项审批（成本/利润/专利/合规/MOQ/供应链待验证）";

  if (!keyword?.hasData) {
    return {
      grade: "C",
      gradeLabel: "C级：观察/小范围验证",
      judgment: "关键词需求未就绪，仅有 VOC 定位，不得给出完整市场进入结论",
      demandBasis: voc.oneLiner,
      entryPath: "先补齐关键词需求与功能分层，再复评",
      mainRisks: "市场规模与转化无法判断",
      note,
    };
  }

  if (kwGrade === "D") {
    return {
      grade: "D",
      gradeLabel: "D级：不建议",
      judgment: "关键词机会弱或错配，不宜按当前产品定义进入",
      demandBasis: `${keyword.headline}；${demandScale}`,
      entryPath: "不建议进入当前定义；可换细分形态后重评",
      mainRisks: competition,
      note,
    };
  }

  if (kwGrade === "A" && dualCore && (diffReady || hasP0)) {
    return {
      grade: hasP0 ? "B" : "A",
      gradeLabel: hasP0 ? "B级：优化后立项" : "A级：建议立项",
      judgment: hasP0
        ? "需求与双重验证成立，但仍有 P0 避坑项需先闭合验收路径"
        : "需求规模、核心人群/形态清晰，核心功能获 VOC×关键词双重验证",
      demandBasis: `${keyword.headline}；${demandScale}`,
      entryPath: hasP0 ? "P0 验收通过后小批量/正式立项" : "按最终定义进入 PRD 与清单复核",
      mainRisks: [competition, ...voc.mustAvoid.slice(0, 2)].filter(Boolean).join("；") || "待验证",
      note,
    };
  }

  if (kwGrade === "A" || kwGrade === "B") {
    return {
      grade: "B",
      gradeLabel: "B级：优化后立项",
      judgment: "需求真实，但差异化、P0 方案、规格或竞争仍有待优化项",
      demandBasis: `${keyword.headline}；${demandScale}`,
      entryPath: "优化 P0/差异化方案后立项",
      mainRisks: competition,
      note,
    };
  }

  return {
    grade: "C",
    gradeLabel: "C级：观察/小范围验证",
    judgment: "需求偏细分或证据冲突，建议样品/概念测试后再扩量",
    demandBasis: `${keyword.headline}；${demandScale}`,
    entryPath: "小范围验证 → 复评机会等级",
    mainRisks: competition,
    note,
  };
}

function buildCrossRows(voc: VocPositioningConclusion, keyword: KeywordLaunchConclusions | null): FinalCrossRow[] {
  const competition =
    keywordItemValue(keyword, "competition", "需求匹配缺口") ??
    keywordItemValue(keyword, "competition", "竞争进入难度") ??
    "待验证";

  return voc.mergedThemes.map(theme => {
    const kw = matchKeywordEvidence(theme.theme, keyword);
    const mapped = mapRole(theme.role, kw.strength, theme.priority);
    const userValue =
      theme.lovePct !== "—" || theme.negPct !== "—" || theme.unmetPct !== "—"
        ? `喜爱 ${theme.lovePct} · 差评 ${theme.negPct} · 未满足 ${theme.unmetPct}`
        : "VOC 证据不足";

    return {
      theme: theme.theme,
      vocEvidence: theme.judgment,
      keywordEvidence: kw.text,
      marketDemand: kw.demand,
      userValue,
      competition,
      judgment: mapped.judgment,
      role: mapped.role,
      priority: mapped.priority,
    };
  });
}

function buildDefinitionRows(args: {
  categoryLabel: string;
  voc: VocPositioningConclusion;
  keyword: KeywordLaunchConclusions | null;
  priceBand?: string | null;
  crossRows: FinalCrossRow[];
}): FinalDefinitionRow[] {
  const { categoryLabel, voc, keyword, priceBand, crossRows } = args;
  const audience =
    keywordItemValue(keyword, "customer_profile", "核心使用人群") ??
    voc.dimensionRows.find(row => row.dimension === "目标人群")?.conclusion ??
    "待验证";
  const age = keywordItemValue(keyword, "customer_profile", "重点年龄段");
  const scenario =
    keywordItemValue(keyword, "customer_profile", "主要使用场景") ??
    voc.dimensionRows.find(row => row.dimension === "核心场景")?.conclusion ??
    "待验证";
  const motive = keywordItemValue(keyword, "customer_profile", "核心购买动机") ?? "待验证";
  const form =
    keywordItemValue(keyword, "product_dev", "建议产品形态") ??
    voc.dimensionRows.find(row => row.dimension === "产品形态")?.conclusion ??
    categoryLabel;
  const baseFn = keywordItemValue(keyword, "product_dev", "基础功能清单");
  const diffFn = keywordItemValue(keyword, "product_dev", "差异化功能清单");
  const material = keywordItemValue(keyword, "product_dev", "建议材质与规格");
  const colorSku = keywordItemValue(keyword, "product_dev", "建议颜色/SKU");
  const price = keywordItemValue(keyword, "product_dev", "建议目标售价") ?? (priceBand ? `竞品带 ${priceBand}` : "待验证");
  const demand = keywordItemValue(keyword, "market_demand", "核心需求规模") ?? "待验证";
  const trend = keywordItemValue(keyword, "market_demand", "近12个月趋势") ?? "待验证";
  const season = keywordItemValue(keyword, "market_demand", "旺季 / 淡季") ?? "待验证";
  const p0 = crossRows.filter(row => row.priority === "P0").map(row => row.theme);
  const core = crossRows
    .filter(row => row.role === "核心基础" || row.role === "核心强化" || row.role === "保留并重做")
    .map(row => row.theme);
  const diff = crossRows.filter(row => row.role === "差异化突破").map(row => row.theme);
  const combos = (keyword?.keywordCombos ?? []).slice(0, 5).map(row => row.keyword).join("、") || "待验证";
  const paramsFromAudience =
    keywordItemValue(keyword, "customer_profile", "人群→产品参数") ?? "需将年龄/人群转为尺寸、承重、安全与操作难度";

  return [
    {
      dimension: "目标市场",
      conclusion: `Amazon US · ${categoryLabel}`,
      vocBasis: voc.dimensionRows.find(row => row.dimension === "产品形态")?.evidence ?? "VOC 类目样本",
      keywordBasis: demand,
      action: "按该细分进入 PRD，不跨形态混装",
      priority: "P0",
      pending: "站点/类目口径需与关键词同步一致",
    },
    {
      dimension: "需求规模与趋势",
      conclusion: `${demand}；趋势 ${trend}`,
      vocBasis: "VOC 不直接证明市场规模",
      keywordBasis: [demand, trend].join(" · "),
      action: "以去重词群而非单一大词判断容量",
      priority: "P0",
      pending: trend.includes("—") ? "趋势样本不足" : "—",
    },
    {
      dimension: "季节性",
      conclusion: season,
      vocBasis: "礼物/节日场景若出现于 VOC 动机则交叉",
      keywordBasis: season,
      action: "按旺季窗口规划到货与礼盒 SKU",
      priority: "P1",
      pending: season === "待验证" || season === "—" ? "完整 12–24 月季节性待补" : "—",
    },
    {
      dimension: "目标人群/年龄",
      conclusion: [audience, age].filter(Boolean).join(" · "),
      vocBasis: voc.dimensionRows.find(row => row.dimension === "目标人群")?.conclusion ?? "—",
      keywordBasis: [audience, age].filter(Boolean).join(" · ") || "—",
      action: paramsFromAudience,
      priority: "P0",
      pending: age ? "—" : "年龄段词不足，承重/尺寸待测",
    },
    {
      dimension: "核心场景",
      conclusion: scenario,
      vocBasis: voc.dimensionRows.find(row => row.dimension === "核心场景")?.conclusion ?? "—",
      keywordBasis: scenario,
      action: "场景转成便携/稳定/户外耐候等规格要求",
      priority: "P0",
      pending: "—",
    },
    {
      dimension: "购买动机",
      conclusion: motive,
      vocBasis: "喜爱/动机主题",
      keywordBasis: motive,
      action: "礼物动机影响包装与开箱，不自动等于高价接受度",
      priority: "P1",
      pending: motive === "待验证" ? "动机词弱" : "—",
    },
    {
      dimension: "核心痛点",
      conclusion: voc.mustAvoid.slice(0, 3).join("、") || p0.join("、") || "待验证",
      vocBasis: voc.mustAvoid.join("、") || "—",
      keywordBasis: keywordItemValue(keyword, "customer_profile", "主要痛点/未满足需求") ?? "流量词痛点弱，以 VOC 为准",
      action: "P0 痛点写入规格书与验收，不得因搜索弱删除",
      priority: "P0",
      pending: "—",
    },
    {
      dimension: "产品形态",
      conclusion: form,
      vocBasis: voc.dimensionRows.find(row => row.dimension === "产品形态")?.conclusion ?? "—",
      keywordBasis: form,
      action: "只选一个主形态；冲突形态拆 SKU/二代，不堆叠",
      priority: "P0",
      pending: "—",
    },
    {
      dimension: "基础功能",
      conclusion: pickTexts([baseFn, ...core], 5).join("；") || "待验证",
      vocBasis: voc.mustKeep.join("、") || "—",
      keywordBasis: baseFn ?? "—",
      action: "标准配置，不作为唯一差异化口号",
      priority: "P1",
      pending: "—",
    },
    {
      dimension: "差异化功能",
      conclusion:
        pickTexts([diffFn && !diffFn.includes("暂无") ? diffFn : null, ...diff, ...voc.mustValidate], 3).join("；") ||
        "待验证",
      vocBasis: voc.mustValidate.join("、") || "—",
      keywordBasis: diffFn ?? "—",
      action: "先做技术/成本/专利与付费意愿验证",
      priority: "P1",
      pending: "成本、专利、供应链可行性待验证",
    },
    {
      dimension: "规格/尺寸",
      conclusion: paramsFromAudience,
      vocBasis: voc.dimensionRows.find(row => row.dimension === "材质/结构")?.conclusion ?? "—",
      keywordBasis: keywordItemValue(keyword, "customer_profile", "最关注属性/规格") ?? "—",
      action: "年龄词 → 承重、把位、Deck 高度、安全间距",
      priority: "P0",
      pending: "工程参数待样机测量",
    },
    {
      dimension: "材质/结构",
      conclusion: material || voc.dimensionRows.find(row => row.dimension === "材质/结构")?.conclusion || "待验证",
      vocBasis: voc.dimensionRows.find(row => row.dimension === "材质/结构")?.evidence ?? "—",
      keywordBasis: material ?? "—",
      action: "关键结构件循环载荷与耐磨抽检",
      priority: p0.some(t => /结构|耐用/.test(t)) ? "P0" : "P1",
      pending: "材料牌号与供应商待定",
    },
    {
      dimension: "颜色/SKU",
      conclusion: colorSku || "主推 1–2 色，避免仅凭颜色词扩 SKU",
      vocBasis: voc.dimensionRows.find(row => row.dimension === "颜色/SKU")?.conclusion ?? "VOC 颜色证据弱",
      keywordBasis: colorSku ?? "—",
      action: "颜色结合变体销量与库存风险，不按搜索量盲目扩色",
      priority: "P2",
      pending: "变体销量交叉待补",
    },
    {
      dimension: "价格档位",
      conclusion: price,
      vocBasis: voc.dimensionRows.find(row => row.dimension === "价格档位")?.conclusion ?? "—",
      keywordBasis: price,
      action: "入门/中端拆分看形态与配置；无成本数据不定精确售价",
      priority: "P1",
      pending: "BOM/物流/广告费未闭合前不定最终挂牌价",
    },
    {
      dimension: "核心卖点",
      conclusion:
        voc.dimensionRows.find(row => row.dimension === "核心卖点")?.conclusion ??
        pickTexts([...core.slice(0, 2), ...diff.slice(0, 1)], 3).join(" + "),
      vocBasis: "喜爱保留 × 未满足差异",
      keywordBasis: combos,
      action: "卖点必须对应可验证功能/参数/场景结果",
      priority: "P0",
      pending: "—",
    },
    {
      dimension: "避坑要求",
      conclusion: p0.join("、") || voc.mustAvoid.join("、") || "待验证",
      vocBasis: voc.mustAvoid.join("、"),
      keywordBasis:
        (keyword?.functionMatrix ?? [])
          .filter(row => row.type === "伪需求")
          .map(row => row.keyword)
          .join("、") || "伪需求词少，以 VOC P0 为准",
      action: "P0 写入一票否决与出厂验收",
      priority: "P0",
      pending: "—",
    },
  ];
}

function buildFeatureLayers(
  crossRows: FinalCrossRow[],
  keyword: KeywordLaunchConclusions | null,
  voc: VocPositioningConclusion
): FinalFeatureLayers {
  const mustHave = pickTexts(
    [
      ...crossRows
        .filter(row => row.role === "核心基础" || row.role === "核心强化" || row.role === "保留并重做")
        .map(row => `${row.theme}（${row.role}）`),
      ...(keyword?.functionMatrix ?? [])
        .filter(row => row.type === "基础必备" || row.type === "高关注")
        .map(row => `${row.keyword}（关键词${row.type}）`),
      ...voc.mustKeep.map(item => `${item}（VOC 核心保留）`),
    ],
    6
  ).map(item => ({ item, evidence: "VOC×关键词交叉 / 功能分层" }));

  const differentiation = pickTexts(
    [
      ...crossRows.filter(row => row.role === "差异化突破").map(row => row.theme),
      ...(keyword?.functionMatrix ?? []).filter(row => row.type === "差异化").map(row => row.keyword),
      ...voc.mustValidate,
    ],
    4
  ).map(item => ({ item, evidence: "未满足需求 × 关键词差异化/组合机会" }));

  const optional = pickTexts(
    [
      ...crossRows.filter(row => row.role === "可选配置" || row.role === "体验优化").map(row => row.theme),
      keywordItemValue(keyword, "product_dev", "建议颜色/SKU"),
    ],
    4
  ).map(item => ({ item, evidence: "中频需求或变体逻辑" }));

  const notInV1 = pickTexts(
    [
      ...crossRows.filter(row => row.role === "暂不开发").map(row => row.theme),
      ...(keyword?.functionMatrix ?? []).filter(row => row.type === "伪需求").map(row => `${row.keyword}（伪需求）`),
      "首代全新专利转向机构 + 大改模具同步推进",
      "仅凭高搜索宽泛大词堆功能",
    ],
    5
  ).map(item => ({ item, evidence: "伪需求 / 高复杂度 / 低转化风险" }));

  const p0Avoid = pickTexts(
    [
      ...crossRows.filter(row => row.priority === "P0" || row.role === "新品避坑").map(row => `${row.theme}：${row.judgment}`),
      ...voc.mustAvoid.map(item => `${item}（VOC 避坑）`),
    ],
    5
  ).map(item => ({ item, evidence: "P0：安全/无法使用/高频差评，关键词不得降级" }));

  return { mustHave, differentiation, optional, notInV1, p0Avoid };
}

function buildKeywordGroups(keyword: KeywordLaunchConclusions | null): FinalKeywordGroupRow[] {
  if (!keyword?.hasData) {
    return [
      {
        type: "待补齐",
        keywords: "关键词需求未就绪",
        productLink: "—",
        listingAngle: "—",
        skuHint: "—",
      },
    ];
  }

  const combos = keyword.keywordCombos.slice(0, 4);
  const base = keyword.functionMatrix.filter(row => row.type === "基础必备" || row.type === "高关注").slice(0, 4);
  const diff = keyword.functionMatrix.filter(row => row.type === "差异化").slice(0, 3);
  const audience = keywordItemValue(keyword, "customer_profile", "核心使用人群");
  const age = keywordItemValue(keyword, "customer_profile", "重点年龄段");
  const scenario = keywordItemValue(keyword, "customer_profile", "主要使用场景");
  const form = keywordItemValue(keyword, "product_dev", "建议产品形态");
  const risk = keyword.functionMatrix.filter(row => row.type === "伪需求").map(row => row.keyword).join("、");

  return [
    {
      type: "核心主词 / 组合词",
      keywords: combos.map(row => `${row.keyword}（${formatVolume(row.volume)}）`).join("、") || "—",
      productLink: "主形态 + 人群/年龄适配",
      listingAngle: "标题与后端词优先承接月搜>10k 组合词",
      skuHint: "主推 SKU",
    },
    {
      type: "产品形态词",
      keywords: form ?? "—",
      productLink: "结构路线与主图形态一致",
      listingAngle: "主图 1 明确形态，避免坐立/电动等错配流量",
      skuHint: "主形态唯一",
    },
    {
      type: "高转化功能词",
      keywords: base.map(row => row.keyword).join("、") || "—",
      productLink: "基础必备/高关注配置",
      listingAngle: "Bullet 前三条对应可验证功能",
      skuHint: "全 SKU 标配",
    },
    {
      type: "人群 / 年龄词",
      keywords: [audience, age].filter(Boolean).join(" · ") || "—",
      productLink: "尺寸、承重、安全、操作难度",
      listingAngle: "适龄与承重诚实标注",
      skuHint: "按年龄带拆变体（若冲突则拆线）",
    },
    {
      type: "场景词",
      keywords: scenario ?? "—",
      productLink: "便携/户外/礼物包装等环境要求",
      listingAngle: "A+ 场景镜头与搜索词一致",
      skuHint: "礼盒版可作季节 SKU",
    },
    {
      type: "差异化长尾词",
      keywords: [...diff.map(row => row.keyword), ...combos.slice(0, 2).map(row => row.keyword)].join("、") || "—",
      productLink: "差异化功能与未满足需求",
      listingAngle: "用于精准广告与长尾自然流量",
      skuHint: "主推或高配",
    },
    {
      type: "不匹配 / 风险词",
      keywords: risk || "宽泛大词、品牌词、错配形态词",
      productLink: "不进入核心定义",
      listingAngle: "否词/避免堆砌",
      skuHint: "不做",
    },
  ];
}

function buildPriorityRows(
  voc: VocPositioningConclusion,
  crossRows: FinalCrossRow[],
  keyword: KeywordLaunchConclusions | null
): FinalPriorityRow[] {
  const fromVoc = voc.optimizeRows
    .filter(row => row.priority === "P0" || row.priority === "P1")
    .slice(0, 4)
    .map(row => ({
      priority: row.priority,
      direction: row.direction,
      evidence: `${row.source} · ${row.mention}`,
      businessImpact: row.userImpact,
      action: row.productAction,
      acceptance: row.acceptance,
    }));

  const fromCross = crossRows
    .filter(row => row.priority === "P0" || (row.priority === "P1" && row.role === "差异化突破"))
    .slice(0, 3)
    .map(row => ({
      priority: String(row.priority),
      direction: row.theme,
      evidence: `VOC：${row.vocEvidence}；KW：${row.keywordEvidence}`,
      businessImpact: row.userValue,
      action: row.judgment,
      acceptance: row.priority === "P0" ? "出厂抽检 + 差评主题回落" : "可感知卖点可演示/可证明",
    }));

  const kwBoost =
    keyword?.hasData && keyword.keywordCombos[0]
      ? [
          {
            priority: "P1",
            direction: `承接组合词「${keyword.keywordCombos[0].keyword}」`,
            evidence: `月搜 ${formatVolume(keyword.keywordCombos[0].volume)} · ${keyword.verdict.gradeLabel}`,
            businessImpact: "匹配高搜索入口，降低流量错配",
            action: "产品参数与 Listing 与该词群人群/年龄一致",
            acceptance: "主词相关流量占比与转化不劣化",
          },
        ]
      : [];

  const merged = [...fromVoc, ...fromCross, ...kwBoost];
  const seen = new Set<string>();
  return merged
    .filter(row => {
      const key = `${row.priority}|${row.direction}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 6);
}

function buildOneLiner(voc: VocPositioningConclusion): {
  oneLiner: string;
  cards: FinalProductDefinitionReport["oneLinerCards"];
} {
  const cards = voc.directionCards.map(({ key, label, value, tone }) => ({
    key,
    label,
    value,
    tone,
  }));
  return { oneLiner: voc.oneLiner, cards };
}

export function buildFinalProductDefinition(args: {
  categoryLabel: string;
  productCount: number;
  dataMonth: string;
  vocPositioning: VocPositioningConclusion;
  keyword: KeywordLaunchConclusions | null;
  priceBand?: string | null;
  hasVocData: boolean;
}): FinalProductDefinitionReport {
  const { categoryLabel, productCount, dataMonth, vocPositioning, keyword, priceBand, hasVocData } = args;

  if (!hasVocData) {
    return {
      meta: {
        categoryLabel,
        productCount,
        dataMonth,
        analyzedAt: new Date().toISOString().slice(0, 10),
        sources: ["VOC 产品定义", "关键词需求分析"],
      },
      hasData: false,
      oneLiner: "VOC 数据未就绪，无法输出最终产品定义。",
      oneLinerCards: [],
      rationale: [
        {
          key: "pending",
          label: "待补齐",
          value: "请先完成竞品 VOC 洞察与产品定义结论页同步。",
          tone: "default",
        },
      ],
      opportunity: {
        grade: "D",
        gradeLabel: "D级：不建议",
        judgment: "缺少 VOC 输入",
        demandBasis: "—",
        entryPath: "补数据后再评",
        mainRisks: "无法判断",
        note: DATA_BOUNDARY,
      },
      crossRows: [],
      definitionRows: [],
      featureLayers: { mustHave: [], differentiation: [], optional: [], notInV1: [], p0Avoid: [] },
      keywordGroups: [],
      priorityRows: [],
      risks: [],
      nextValidations: ["同步 VOC 七维与三表", "同步 SIF 关键词需求"],
      dataBoundary: DATA_BOUNDARY,
    };
  }

  const crossRows = buildCrossRows(vocPositioning, keyword);
  const definitionRows = buildDefinitionRows({ categoryLabel, voc: vocPositioning, keyword, priceBand, crossRows });
  const featureLayers = buildFeatureLayers(crossRows, keyword, vocPositioning);
  const keywordGroups = buildKeywordGroups(keyword);
  const priorityRows = buildPriorityRows(vocPositioning, crossRows, keyword);
  const opportunity = decideGrade(keyword, vocPositioning, crossRows);
  const { oneLiner, cards: oneLinerCards } = buildOneLiner(vocPositioning);

  const demandScale = keywordItemValue(keyword, "market_demand", "核心需求规模");
  const dualThemes = crossRows
    .filter(row => row.role === "核心基础" || row.role === "核心强化")
    .slice(0, 2)
    .map(row => row.theme);
  const p0Themes = crossRows
    .filter(row => row.priority === "P0")
    .slice(0, 2)
    .map(row => row.theme);
  const negLine = vocPositioning.rationale.find(item => /差评/.test(item)) ?? vocPositioning.rationale[1] ?? null;

  const rationale: FinalProductDefinitionReport["rationale"] = [];
  if (keyword?.hasData) {
    rationale.push({
      key: "keyword",
      label: "关键词机会",
      highlight: keyword.verdict.gradeLabel,
      value: [keyword.headline.replace(keyword.verdict.gradeLabel, "").replace(/^[·\s]+/, ""), demandScale]
        .filter(Boolean)
        .join("。"),
      tone: "keyword",
    });
  } else {
    rationale.push({
      key: "keyword",
      label: "关键词机会",
      value: "关键词需求未就绪，市场规模判断待验证。",
      tone: "default",
    });
  }
  {
    const loveRaw = vocPositioning.rationale[0] ?? vocPositioning.oneLiner;
    const loveThemes = extractQuotedThemes(loveRaw, 3);
    rationale.push({
      key: "voc",
      label: "VOC 喜爱保留",
      highlight: loveThemes.length ? loveThemes.join("、") : undefined,
      value: loveThemes.length
        ? "应作为首版不可砍的基础能力与卖点表达。"
        : shortenField(loveRaw, 4, 96),
      tone: "voc",
    });
  }
  if (negLine) {
    const negThemes = extractQuotedThemes(negLine, 3);
    rationale.push({
      key: "negative",
      label: "差评避坑",
      highlight: negThemes.length ? negThemes.join("、") : undefined,
      value: negThemes.length
        ? "占比 >10% 或结构失效类，直接写入新品避坑与验收。"
        : shortenField(negLine.replace(/^差评集中在[:：]?\s*/, "").trim(), 4, 96),
      tone: "negative",
    });
  }
  if (dualThemes.length) {
    rationale.push({
      key: "dual",
      label: "双重验证",
      highlight: dualThemes.join("、"),
      value: "VOC 喜爱与关键词需求同时成立，优先作为首版基础能力。",
      tone: "dual",
    });
  }
  if (p0Themes.length) {
    rationale.push({
      key: "p0",
      label: "P0 不可删",
      highlight: p0Themes.join("、"),
      value: "即使搜索弱，也必须写入规格与验收，不得因流量弱剔除。",
      tone: "p0",
    });
  }
  if (keyword?.keywordCombos[0]) {
    rationale.push({
      key: "combo",
      label: "流量入口",
      highlight: keyword.keywordCombos[0].keyword,
      value: `月搜 ${formatVolume(keyword.keywordCombos[0].volume)} · 标题/后端词优先承接`,
      tone: "combo",
    });
  }

  const risks = pickTexts(
    [
      keywordItemValue(keyword, "launch_decision", "主要风险"),
      keywordItemValue(keyword, "competition", "竞争进入难度"),
      ...vocPositioning.optimizeRows.filter(row => row.priority === "P0").map(row => row.risk),
      "成本/毛利/广告费模型未闭合",
      "专利与儿童品合规（ASTM/CPSIA）待检索",
      "MOQ 与旺季备货匹配待验证",
    ],
    6
  );

  const nextValidations = pickTexts(
    [
      ...vocPositioning.nextValidations,
      keyword?.dataGaps[0] ?? null,
      "P0 结构/备件/转向方案工程样机验收",
      "差异化功能成本与付费意愿小样本测试",
      "核心组合词 Listing 匹配与否词策略",
      "完整立项清单：利润、专利、合规、供应链",
    ],
    6
  );

  return {
    meta: {
      categoryLabel,
      productCount,
      dataMonth,
      analyzedAt: new Date().toISOString().slice(0, 10),
      sources: ["VOC 产品定义结论", "关键词需求分析", "Sorftime/SIF 交叉证据"],
    },
    hasData: true,
    oneLiner,
    oneLinerCards,
    rationale,
    opportunity,
    crossRows,
    definitionRows,
    featureLayers,
    keywordGroups,
    priorityRows,
    risks,
    nextValidations,
    dataBoundary: DATA_BOUNDARY,
  };
}
