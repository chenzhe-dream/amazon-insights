/**
 * VOC 三表合并 → 产品定位结论
 * 对齐 Skill：define-amazon-voc-positioning
 */

import type { AnalysisRuleTrace } from "../shared/product-structure-rules";
import type { ProductFamily } from "./lib/product-family";
import type {
  NegativePriorityRow,
  PositivePriorityRow,
  UnmetOpportunityRow,
} from "./product-launch-analysis";
import {
  classifyVocPriority,
  priorityRank,
} from "../server/domain/voc/priority-rules";

export type VocPositioningRole =
  | "核心保留"
  | "保留并重做"
  | "差异化突破"
  | "新品避坑"
  | "选择性优化"
  | "观察/伪需求"
  | "待验证";

export type VocPriorityLevel = "P0" | "P1" | "P2" | "P3" | "待验证";

export type VocMergedThemeRow = {
  ruleDecisionIds?: string[];
  sourceDecisionIds?: Partial<Record<"positives" | "negatives" | "unmet", string[]>>;
  theme: string;
  lovePct: string;
  negPct: string;
  unmetPct: string;
  judgment: string;
  role: VocPositioningRole;
  priority: VocPriorityLevel;
};

export type VocPositioningDimensionRow = {
  ruleDecisionIds?: string[];
  dimension: string;
  conclusion: string;
  evidence: string;
  priority: string;
  action: string;
};

export type VocOptimizePriorityRow = {
  ruleDecisionIds?: string[];
  priority: VocPriorityLevel;
  direction: string;
  source: string;
  mention: string;
  userImpact: string;
  productAction: string;
  acceptance: string;
  risk: string;
};

export type VocPositioningConclusion = {
  ruleTrace?: AnalysisRuleTrace;
  oneLiner: string;
  rationale: string[];
  dimensionRows: VocPositioningDimensionRow[];
  /** 8 格要点：与 dimensionRows 同源，供新品定义页直接引用 */
  directionCards: VocDirectionCard[];
  mergedThemes: VocMergedThemeRow[];
  /** Original per-ASIN decisions for labels consumed by downstream features. */
  themeDecisionIds?: Record<string, string[]>;
  optimizeRows: VocOptimizePriorityRow[];
  mustKeep: string[];
  mustAvoid: string[];
  mustValidate: string[];
  nextValidations: string[];
  dataBoundary: string;
};

export type VocDirectionCard = {
  key: "audience" | "scenario" | "pain" | "product" | "base" | "diff" | "avoid" | "traffic";
  label: string;
  /** 对应定位方向表维度，便于排查数据是否被二次改写 */
  sourceDimension: string;
  value: string;
  tone: "audience" | "scenario" | "pain" | "product" | "base" | "diff" | "avoid" | "traffic";
};

function readVocDimensionRows(rows: VocPositioningDimensionRow[], dimension: string) {
  return rows.find(row => row.dimension === dimension)?.conclusion?.trim() ?? "";
}

/** 8 格要点严格映射「产品定位方向表」，完整展示、不截断、不混入英文关键词 */
export function buildVocDirectionCards(
  dimensionRows: VocPositioningDimensionRow[],
  mustAvoid: string[]
): VocDirectionCard[] {
  const read = (dimension: string) => readVocDimensionRows(dimensionRows, dimension);
  const form = read("产品形态");
  const price = read("价格档位");
  const coreNeed = read("核心需求");
  const avoidList = mustAvoid.filter(item => item && item !== "数据不足").join("、");
  const avoidFromNeed = coreNeed.match(/规避[：:\s]*(.+)$/)?.[1]?.trim();

  return [
    { key: "audience", label: "做给谁", sourceDimension: "目标人群", value: read("目标人群") || "待验证", tone: "audience" },
    { key: "scenario", label: "什么场景", sourceDimension: "核心场景", value: read("核心场景") || "待验证", tone: "scenario" },
    { key: "pain", label: "解决什么", sourceDimension: "核心需求", value: coreNeed || "待验证", tone: "pain" },
    {
      key: "product",
      label: "做什么产品",
      sourceDimension: "产品形态 + 价格档位",
      value: [form, price].filter(Boolean).join(" · ") || "待验证",
      tone: "product",
    },
    { key: "base", label: "基础功能", sourceDimension: "基础功能", value: read("基础功能") || "待验证", tone: "base" },
    { key: "diff", label: "差异化", sourceDimension: "差异化功能", value: read("差异化功能") || "待验证", tone: "diff" },
    {
      key: "avoid",
      label: "必须规避",
      sourceDimension: "差评避坑",
      value: avoidList || avoidFromNeed || "待验证",
      tone: "avoid",
    },
    { key: "traffic", label: "核心卖点", sourceDimension: "核心卖点", value: read("核心卖点") || "待验证", tone: "traffic" },
  ];
}

type ThemeBucket = {
  id: string;
  label: string;
  pattern: RegExp;
  lovePct: number | null;
  negPct: number | null;
  unmetPct: number | null;
  loveLabel: string | null;
  negLabel: string | null;
  unmetLabel: string | null;
  loveAction: string | null;
  negAction: string | null;
  unmetAction: string | null;
  ruleDecisionIds: string[];
  sourceDecisionIds: Record<"positives" | "negatives" | "unmet", string[]>;
};

const DATA_BOUNDARY =
  "当前结论基于VOC评论提及情况，用于判断用户偏好、痛点和产品机会，不等同于市场规模、销量预测、利润可行性或立项结论；仍需结合市场趋势、竞争、价格、成本、合规、专利和供应链数据验证。";

const SHARED_THEME_DEFS: Array<{ id: string; label: string; pattern: RegExp }> = [
  { id: "durability", label: "结构耐用与可靠性", pattern: /耐用|结构|强度|质量|做工|断裂|松动|reliability|quality/i },
  { id: "assembly", label: "安装与组装体验", pattern: /安装|组装|assembly|install/i },
  { id: "value", label: "性价比感知", pattern: /价格|性价比|value/i },
  { id: "packaging", label: "包装与缺件", pattern: /包装|缺件|破损/i },
  { id: "spares", label: "备件与售后可维护性", pattern: /备件|售后|零件|更换/i },
];

const SCOOTER_THEME_DEFS: Array<{ id: string; label: string; pattern: RegExp }> = [
  { id: "steer", label: "Lean-to-steer 转向体验", pattern: /lean|转向|操控|ease\s*of\s*use|学习曲线|handle\s*quality|倾斜/i },
  { id: "led", label: "LED 发光与趣味体验", pattern: /发光轮|灯轮|light[\s-]?up|乐趣|娱乐|\bfun\b/i },
  { id: "stability", label: "骑行稳定性", pattern: /稳定|晃|摇|平衡|balance/i },
  { id: "handle", label: "可调车把与成长适配", pattern: /车把|可调|高度|handle(?!\s*quality)|档位/i },
  { id: "deck", label: "Deck/踏板尺寸与适龄", pattern: /踏板|deck|尺寸|适龄|身高|size/i },
  { id: "smooth", label: "骑行顺滑", pattern: /顺滑|轴承|卡顿|噪音/i },
  { id: "safety", label: "安全与合规", pattern: /安全|刹车|锐边|astm|cpsia/i },
];

const LIGHTING_THEME_DEFS: Array<{ id: string; label: string; pattern: RegExp }> = [
  { id: "led", label: "LED 照明与色温", pattern: /led|照明|色温|亮度|灯光|lighting|brightness|bulb/i },
  { id: "storage", label: "置物收纳", pattern: /置物|收纳|层板|storage|shelf/i },
  { id: "stability", label: "灯体稳定性", pattern: /稳定|晃|摇|不稳|倾倒|wobble|tip/i },
  { id: "shade", label: "灯罩与透光", pattern: /灯罩|透光|刺眼|shade|glare/i },
  { id: "safety", label: "电气与倾倒安全", pattern: /安全|过热|漏电|倾倒|ul\b|etl/i },
];

function themeDefsFor(family: ProductFamily) {
  if (family === "scooter") return [...SHARED_THEME_DEFS, ...SCOOTER_THEME_DEFS];
  if (family === "lighting") return [...SHARED_THEME_DEFS, ...LIGHTING_THEME_DEFS];
  return SHARED_THEME_DEFS;
}

function parsePct(raw: string | null | undefined): number | null {
  if (!raw || raw === "—" || raw === "暂无数据") return null;
  const match = raw.match(/(\d+(?:\.\d+)?)\s*%/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function formatPctOrDash(value: number | null) {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

function classifyRole(love: number | null, neg: number | null, unmet: number | null): {
  role: VocPositioningRole;
  priority: VocPriorityLevel;
  judgment: string;
} {
  const decision = classifyVocPriority([
    { dimension: "positives", mentionPct: love, label: "普通喜爱主题" },
    { dimension: "negatives", mentionPct: neg, label: "普通差评主题" },
    { dimension: "unmet", mentionPct: unmet, label: "普通未满足主题" },
  ]);
  const loveHigh = decision.reasons.some(reason => reason.startsWith("positives>10:"));
  const negHigh = decision.reasons.some(reason => reason.startsWith("negative>10:"));
  const unmetHigh = decision.reasons.some(reason => reason.startsWith("unmet>10:"));

  if (loveHigh && negHigh) {
    return {
      role: "保留并重做",
      priority: "P0",
      judgment: "价值明确但实现不稳定：保留功能目标，重做结构/材料或交互",
    };
  }
  if (negHigh && unmetHigh) {
    return {
      role: "差异化突破",
      priority: "P0",
      judgment: "行业共性痛点与需求缺口重合：避坑同时验证差异化方案",
    };
  }
  if (negHigh) {
    return {
      role: "新品避坑",
      priority: "P0",
      judgment: "高频差评（＞10%）：新品必须规避或修正，否则损伤评分与退货",
    };
  }
  if (loveHigh && unmetHigh) {
    return {
      role: "核心保留",
      priority: "P1",
      judgment: "已有优势仍有升级空间：在不损伤原优势下强化",
    };
  }
  if (loveHigh) {
    return {
      role: "核心保留",
      priority: "P1",
      judgment: "高频喜爱（＞10%）：核心保留并强化卖点表达",
    };
  }
  if (unmetHigh) {
    return {
      role: "差异化突破",
      priority: "P1",
      judgment: "高频未满足（＞10%）：差异化机会，需验证技术/成本/付费意愿",
    };
  }
  if (decision.level === "P2") {
    return {
      role: "选择性优化",
      priority: "P2",
      judgment: "提及占比 5%～10%：按成本与定位选择性优化",
    };
  }
  if (decision.level === "unknown") {
    return { role: "待验证", priority: "待验证", judgment: "数据不足，无法判断" };
  }
  return {
    role: "观察/伪需求",
    priority: "P3",
    judgment: "提及弱或样本噪声：首版观察，不进入核心规格",
  };
}

function matchBucket(label: string, family: ProductFamily) {
  // An unfamiliar category still has usable VOC. Preserve its actual theme,
  // instead of silently dropping it because no family template recognizes it.
  return themeDefsFor(family).find(def => def.pattern.test(label)) ?? {id:`source:${label}`,label,pattern:/$a/};
}

function buildBuckets(
  positives: PositivePriorityRow[],
  negatives: NegativePriorityRow[],
  unmets: UnmetOpportunityRow[],
  family: ProductFamily
): ThemeBucket[] {
  const map = new Map<string, ThemeBucket>();

  const ensure = (def: { id: string; label: string; pattern: RegExp }) => {
    const current = map.get(def.id);
    if (current) return current;
    const created: ThemeBucket = {
      id: def.id,
      label: def.label,
      pattern: def.pattern,
      lovePct: null,
      negPct: null,
      unmetPct: null,
      loveLabel: null,
      negLabel: null,
      unmetLabel: null,
      loveAction: null,
      negAction: null,
      unmetAction: null,
      ruleDecisionIds: [],
      sourceDecisionIds: { positives: [], negatives: [], unmet: [] },
    };
    map.set(def.id, created);
    return created;
  };

  positives.forEach(row => {
    if (row.theme === "暂无数据") return;
    const def = matchBucket(row.theme, family);
    if (!def) return;
    const bucket = ensure(def);
    bucket.ruleDecisionIds.push(...(row.ruleDecisionIds ?? []));
    bucket.sourceDecisionIds.positives.push(...(row.ruleDecisionIds ?? []));
    const pct = parsePct(row.frequency);
    if (pct !== null && (bucket.lovePct === null || pct > bucket.lovePct)) {
      bucket.lovePct = pct;
      bucket.loveLabel = row.theme;
      bucket.loveAction = row.leverageDirection;
    }
  });

  negatives.forEach(row => {
    if (row.issue === "暂无数据") return;
    const def = matchBucket(row.issue, family);
    if (!def) return;
    const bucket = ensure(def);
    bucket.ruleDecisionIds.push(...(row.ruleDecisionIds ?? []));
    bucket.sourceDecisionIds.negatives.push(...(row.ruleDecisionIds ?? []));
    const pct = parsePct(row.frequency);
    if (pct !== null && (bucket.negPct === null || pct > bucket.negPct)) {
      bucket.negPct = pct;
      bucket.negLabel = row.issue;
      bucket.negAction = row.fixDirection;
    }
  });

  unmets.forEach(row => {
    if (row.need === "暂无数据") return;
    const def = matchBucket(row.need, family);
    if (!def) return;
    const bucket = ensure(def);
    bucket.ruleDecisionIds.push(...(row.ruleDecisionIds ?? []));
    bucket.sourceDecisionIds.unmet.push(...(row.ruleDecisionIds ?? []));
    const fromMarket = parsePct(row.marketValue);
    if (fromMarket !== null && (bucket.unmetPct === null || fromMarket > bucket.unmetPct)) {
      bucket.unmetPct = fromMarket;
      bucket.unmetLabel = row.need;
      bucket.unmetAction = row.proposal;
    } else if (bucket.unmetLabel === null) {
      bucket.unmetLabel = row.need;
      bucket.unmetAction = row.proposal;
    }
  });

  return [...map.values()].filter(bucket => bucket.lovePct !== null || bucket.negPct !== null || bucket.unmetPct !== null || bucket.unmetLabel);
}

function pickTopLabels(rows: Array<{ label: string; pct: number | null }>, count: number) {
  return rows
    .filter(row => row.label && row.label !== "暂无数据")
    .sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1))
    .slice(0, count)
    .map(row => row.label);
}

export function buildVocPositioningConclusion(args: {
  categoryLabel: string;
  family?: ProductFamily;
  priceBand?: string | null;
  positives: PositivePriorityRow[];
  negatives: NegativePriorityRow[];
  unmets: UnmetOpportunityRow[];
  audiences?: string;
  scenarios?: string;
}): VocPositioningConclusion {
  const { categoryLabel, priceBand, positives, negatives, unmets } = args;
  const family = args.family ?? "generic";
  const buckets = buildBuckets(positives, negatives, unmets, family);

  const mergedThemes: VocMergedThemeRow[] = buckets
    .map(bucket => {
      const classified = classifyRole(bucket.lovePct, bucket.negPct, bucket.unmetPct);
      // 安全直接抬升
      if (bucket.id === "safety" && bucket.negPct !== null) {
        classified.role = "新品避坑";
        classified.priority = "P0";
        classified.judgment = "安全相关问题：不受 10% 门槛限制，直接作为新品避坑项";
      }
      return {
        theme: bucket.label,
        ruleDecisionIds: [...new Set(bucket.ruleDecisionIds)],
        sourceDecisionIds: bucket.sourceDecisionIds,
        lovePct: formatPctOrDash(bucket.lovePct),
        negPct: formatPctOrDash(bucket.negPct),
        unmetPct: formatPctOrDash(bucket.unmetPct),
        judgment: classified.judgment,
        role: classified.role,
        priority: classified.priority,
      };
    })
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.theme.localeCompare(b.theme, "zh-CN"));

  const optimizeRows: VocOptimizePriorityRow[] = buckets
    .map(bucket => {
      const classified = classifyRole(bucket.lovePct, bucket.negPct, bucket.unmetPct);
      if (bucket.id === "safety" && bucket.negPct !== null) {
        classified.priority = "P0";
        classified.role = "新品避坑";
      }
      if (classified.priority !== "P0" && classified.priority !== "P1" && classified.priority !== "P2") return null;
      const priority = classified.priority;

      const sources: string[] = [];
      if (bucket.lovePct !== null) sources.push(`喜爱 ${formatPctOrDash(bucket.lovePct)}`);
      if (bucket.negPct !== null) sources.push(`差评 ${formatPctOrDash(bucket.negPct)}`);
      if (bucket.unmetPct !== null) sources.push(`未满足 ${formatPctOrDash(bucket.unmetPct)}`);

      const productAction =
        classified.role === "保留并重做"
          ? [bucket.loveAction, bucket.negAction].filter(Boolean).join("；") || "保留功能目标，重做不稳定实现"
          : classified.role === "新品避坑"
            ? bucket.negAction || "修正或移除导致差评的设计"
            : classified.role === "差异化突破"
              ? bucket.unmetAction || bucket.negAction || "验证差异化方案后写入规格"
              : bucket.loveAction || "保持体验并强化 Listing 表达";

      const acceptance =
        bucket.id === "durability"
          ? family === "lighting"
            ? "建议建立：层板静载/灯杆晃动循环、连接件防松、承重标注一致性"
            : family === "scooter"
              ? "建议建立：连接件载荷/循环松动、跌落抽检、承重标注一致性"
              : "建议建立：按各 ASIN 原反馈复现失效，比较改进前后故障频次、使用时长及问题出现条件；专项指标须对应实际失效部位"
          : bucket.id === "steer"
            ? "建议建立：初学档阻尼可调范围、限位角、安装教学完成率与差评「转向难」下降"
            : bucket.id === "assembly"
              ? "建议建立：目标安装时长、工具数量、缺件率、组装差评占比"
              : bucket.id === "led"
                ? family === "lighting"
                  ? "建议建立：色温档位一致性、灯罩透光/眩光、灯泡寿命抽检"
                  : "建议建立：点亮抽检、振动老化、6 个月失效投诉率"
                : bucket.id === "stability" && family === "lighting"
                  ? "建议建立：倾倒角、底座配重、组装后晃动量"
                  : bucket.id === "storage"
                    ? "建议建立：单层承重、层板间距、常用物品摆放演示"
                    : "建议建立：与该主题对应的可复测指标（未提供目标阈值前不虚构合格线）";

      const userImpact =
        priority === "P0"
          ? "高：直接影响评分、退货或核心使用"
          : priority === "P1"
            ? "高/中：影响购买决策与满意兑现"
            : "中：影响局部体验或便利性";

      const row: VocOptimizePriorityRow = {
        ruleDecisionIds: [...new Set(bucket.ruleDecisionIds)],
        priority,
        direction: bucket.label,
        source: classified.role,
        mention: sources.join(" · ") || "数据不足",
        userImpact,
        productAction,
        acceptance,
        risk:
          classified.role === "差异化突破"
            ? "待验证：技术可行性、成本、专利与付费意愿"
            : classified.role === "保留并重做"
              ? "待验证：重做方案不得损伤高频喜爱点"
              : "待验证：供应链改动幅度与毛利影响",
      };
      return row;
    })
    .filter((row): row is VocOptimizePriorityRow => row !== null)
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority))
    .slice(0, 8);

  const loveTop = pickTopLabels(
    positives.map(row => ({ label: row.theme, pct: parsePct(row.frequency) })),
    3
  );
  const negTop = pickTopLabels(
    negatives.map(row => ({ label: row.issue, pct: parsePct(row.frequency) })),
    3
  );
  const unmetTop = pickTopLabels(
    unmets.map(row => ({ label: row.need, pct: parsePct(row.marketValue) })),
    3
  );

  const audience =
    args.audiences && args.audiences !== "暂无数据"
      ? args.audiences
      : family === "scooter"
        ? "家长/礼物决策人与低龄儿童家庭（待场景样本复核）"
        : "待从 VOC 人群主题确认";
  const scenario =
    args.scenarios && args.scenarios !== "暂无数据"
      ? args.scenarios
      : family === "scooter"
        ? "日常户外/社区骑行与礼物入门场景（待验证）"
        : "待从 VOC 场景主题确认";
  const corePain = negTop[0] ?? (family === "scooter" ? "高频结构/转向差评" : "高频差评主题");
  const coreLove = loveTop[0] ?? (family === "scooter" ? "易装与稳定体验" : "高频好评主题");
  const diffFeature = unmetTop[0] ?? (family === "scooter" ? "可维护备件与低龄转向友好" : "未满足需求主题");
  const priceText = priceBand?.trim() ? `对标竞品价格带 ${priceBand} 的中端升级档` : "中端升级档（具体售价待成本与竞品价带验证）";
  const formName = categoryLabel;

  const oneLiner = `为【${audience}】在【${scenario}】下，解决【${corePain}】，提供一款以【${formName}】为基础、保留并强化【${coreLove}】、重点解决【${negTop.slice(0, 2).join("、") || "高频差评"}】并通过【${diffFeature}】形成竞争力的【${priceText}】产品。`;

  const rationale = [
    loveTop.length
      ? `买家喜爱集中在「${loveTop.join("、")}」，应作为首版不可砍的基础能力与卖点表达。`
      : "买家喜爱数据不足，核心保留项待补齐 VOC 好评样本。",
    negTop.length
      ? `差评集中在「${negTop.join("、")}」，按规则占比＞10% 或结构失效类直接作为新品避坑项。`
      : "差评样本不足，避坑清单待补齐。",
    unmetTop.length
      ? `未满足需求「${unmetTop.join("、")}」提供差异化候选，但不等同于可盈利功能，需验证成本/专利/付费意愿。`
      : "未满足需求数据不足，差异化方向待验证。",
    "同一主题若喜爱与差评同时偏高，判定为「保留并重做」，禁止因差评直接删除已验证喜爱点。",
  ].slice(0, 5);

  const p0Themes = mergedThemes.filter(row => row.priority === "P0").map(row => row.theme);
  const p1Keep = mergedThemes.filter(row => row.role === "核心保留" || row.role === "保留并重做").map(row => row.theme);

  const dimensionRows: VocPositioningDimensionRow[] = [
    {
      dimension: "目标人群",
      conclusion: audience,
      evidence: loveTop.length || negTop.length ? `VOC 人群/动机与好差评主题交叉` : "数据不足",
      priority: "P0",
      action: family === "scooter" ? "Listing 与规格优先服务礼物决策人 + 低龄使用者双角色" : "Listing 与规格优先对齐 VOC 主人群",
    },
    {
      dimension: "核心场景",
      conclusion: scenario,
      evidence: "使用场景维度主题（若已同步）",
      priority: "P0",
      action: family === "scooter" ? "主图/A+ 覆盖日常户外与开箱礼物镜头" : "主图/A+ 覆盖 VOC 主场景与开箱镜头",
    },
    {
      dimension: "核心需求",
      conclusion: `可靠入门：保留 ${coreLove}，规避 ${corePain}`,
      evidence: `喜爱 ${loveTop[0] ?? "—"} · 差评 ${negTop[0] ?? "—"}`,
      priority: "P0",
      action: "规格书同时写入保留项与避坑项，缺一不可立项",
    },
    {
      dimension: "产品形态",
      conclusion: categoryLabel,
      evidence: "类目竞品形态共识 + VOC 场景",
      priority: "P0",
      action: family === "scooter" ? "首代不做全新转向专利平台，优先在成熟形态上重做体验" : "首代在成熟形态上兑现 VOC 保留项与避坑项，不跨形态混装",
    },
    {
      dimension: "基础功能",
      conclusion: p1Keep.slice(0, 4).join("、") || loveTop.join("、") || "待验证",
      evidence: "喜爱占比＞10% 默认 P1 核心保留",
      priority: "P1",
      action: "BOM 冻结：不得为降本砍掉高频喜爱配置",
    },
    {
      dimension: "差异化功能",
      conclusion: unmetTop.slice(0, 3).join("、") || "待验证",
      evidence: "未满足占比或差评×未满足重合主题",
      priority: "P1",
      action: "先做技术/成本/专利与小样本付费意愿验证，再写入量产",
    },
    {
      dimension: "材质/结构",
      conclusion: p0Themes.includes("结构耐用与可靠性")
        ? family === "lighting"
          ? "加强灯杆/层板连接 + 底座配重防晃 + 承重诚实标注"
          : family === "scooter"
            ? "加强前叉/连接件 + 耐磨轮 + 防松紧固"
            : "加强承力连接件与材料厚度，规格标注与实物一致"
        : "维持类目合格结构，重点部位加强待差评结构主题确认",
      evidence: mergedThemes.find(row => row.theme.includes("结构"))?.judgment ?? "待验证",
      priority: p0Themes.some(t => t.includes("结构")) ? "P0" : "P1",
      action: "建立载荷/循环/跌落抽检，承重标注与实物一致",
    },
    {
      dimension: "颜色/SKU",
      conclusion: "待验证（VOC 未单独给出颜色决策）",
      evidence: "数据不足",
      priority: "待验证",
      action: "结合变体销量与评论占比另表决策",
    },
    {
      dimension: "价格档位",
      conclusion: priceText,
      evidence: priceBand ? `竞品价格带 ${priceBand}` : "仅有 VOC，无完整成本模型",
      priority: "P1",
      action: "用「可维护 + 结构可靠」支撑中端溢价，避免纯低价硬刚",
    },
    {
      dimension: "核心卖点",
      conclusion: family === "scooter" ? `可靠可维护的第一辆：${[coreLove, diffFeature].filter(Boolean).join(" + ")}` : `${coreLove} + ${diffFeature}`,
      evidence: "喜爱保留项 × 未满足差异项",
      priority: "P0",
      action:
        family === "scooter"
          ? "五点前三条固定：结构可靠、易装/转向可学、备件可购或低龄友好"
          : "五点前三条对应 VOC 保留项、避坑项与可验证差异点",
    },
  ];

  const mustKeep = loveTop.slice(0, 3);
  const mustAvoid = negTop.slice(0, 3);
  const mustValidate = unmetTop.slice(0, 3);

  const nextValidations =
    family === "scooter"
      ? [
          "竞品价格带、全成本与目标毛利，确认中端升级档是否站得住",
          "结构加强与转向阻尼方案的开模/改模周期与认证影响（ASTM/CPSIA）",
          "未满足项的付费意愿：问卷或广告测款，避免把评论愿望直接当可卖配置",
          "备件 SKU 的 FBA 库存与售后工单时效是否可运营",
          "Lean-to-steer 相关专利布局检索，避免限位/阻尼方案侵权",
        ]
      : family === "lighting"
        ? [
            "竞品价格带、全成本与目标毛利，确认中端升级档是否站得住",
            "灯杆防晃、底座配重与层板承重方案的开模/改模周期",
            "未满足项的付费意愿：问卷或广告测款，避免把评论愿望直接当可卖配置",
            "电气认证（UL/ETL）与倾倒测试范围确认",
            "运输包装破损率与灯罩/层板到货完好率",
          ]
        : [
            "竞品价格带、全成本与目标毛利，确认中端升级档是否站得住",
            "结构加强方案的开模/改模周期与认证影响",
            "未满足项的付费意愿：问卷或广告测款，避免把评论愿望直接当可卖配置",
            "包装破损与缺件售后路径是否可运营",
            "与该类目相关的专利/合规检索",
          ];

  const mustKeepList = mustKeep.length ? mustKeep : ["数据不足"];
  const mustAvoidList = mustAvoid.length ? mustAvoid : ["数据不足"];
  const mustValidateList = mustValidate.length ? mustValidate : ["数据不足"];

  const themeDecisionIds: Record<string, string[]> = {};
  for (const [label, ids] of [
    ...positives.map(row => [`positives:${row.theme}`, row.ruleDecisionIds] as const),
    ...negatives.map(row => [`negatives:${row.issue}`, row.ruleDecisionIds] as const),
    ...unmets.map(row => [`unmet:${row.need}`, row.ruleDecisionIds] as const),
    ...mergedThemes.map(row => [row.theme, row.ruleDecisionIds] as const),
  ]) themeDecisionIds[label] = [...new Set([...(themeDecisionIds[label] ?? []), ...(ids ?? [])])];

  return {
    oneLiner,
    rationale,
    dimensionRows,
    directionCards: buildVocDirectionCards(dimensionRows, mustAvoidList),
    mergedThemes,
    themeDecisionIds,
    optimizeRows,
    mustKeep: mustKeepList,
    mustAvoid: mustAvoidList,
    mustValidate: mustValidateList,
    nextValidations,
    dataBoundary: DATA_BOUNDARY,
  };
}
