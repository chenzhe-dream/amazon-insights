import {
  formatUsd,
  parseMoneyInput,
  resolveReferralFeeFromProducts,
  type ResolvedReferralFee,
} from "./amazon-us-referral-fees";
import {
  approvalRoles,
  companyLaunchMarginThresholdPct,
  complianceCategoryMatrix,
  launchChecklistVersion,
  scoreDimensions,
  vetoItems,
} from "./launch-checklist-template";

export const checklistSourceLabels: Record<ChecklistFieldSource, string> = {
  auto: "系统已抓取",
  manual: "需人工填写",
  verify: "系统预填 · 待核验",
  check: "需人工勾选",
};

type LaunchChecklistAutoContext = {
  hasVoc: boolean;
  competitorTable: LaunchChecklistStructuredTable;
  marketInsight: string;
  differentiation: string;
  vocSummary: string;
  referralFee: ResolvedReferralFee;
  suggestedSellPrice: number | null;
};

function checklistEntry(
  id: string,
  label: string,
  source: ChecklistFieldSource,
  autoValue?: string,
  placeholder?: string,
): LaunchChecklistEntry {
  return { id, label, source, autoValue, placeholder };
}

function manualChecklistField(label: string, placeholder = "请填写") {
  return checklistEntry(label, label, "manual", undefined, placeholder);
}

function checkOnlyField(id: string, label: string) {
  return checklistEntry(id, label, "check");
}

function buildCompetitorSnapshotTable(products: ChecklistProductInput[]): LaunchChecklistStructuredTable {
  return {
    headers: ["ASIN", "品牌", "售价", "月销量", "评分", "评论数", "上架时间"],
    rows: products.map(product => [
      { key: `${product.asin}-asin`, text: product.asin, source: "auto" },
      { key: `${product.asin}-brand`, text: product.brand || "—", source: "auto" },
      {
        key: `${product.asin}-price`,
        text: product.price != null ? `$${product.price}` : "—",
        source: product.price != null ? "auto" : "manual",
        placeholder: "待同步",
      },
      {
        key: `${product.asin}-sales`,
        text: product.sales != null ? String(product.sales) : "—",
        source: product.sales != null ? "auto" : "manual",
        placeholder: "待同步",
      },
      {
        key: `${product.asin}-rating`,
        text: product.rating != null ? String(product.rating) : "—",
        source: product.rating != null ? "auto" : "manual",
      },
      {
        key: `${product.asin}-reviews`,
        text: product.reviews != null ? String(product.reviews) : "—",
        source: product.reviews != null ? "auto" : "manual",
      },
      {
        key: `${product.asin}-launch`,
        text: product.launch || "—",
        source: product.launch ? "auto" : "manual",
      },
    ]),
  };
}

function buildAutoContext(input: {
  products: ChecklistProductInput[];
  ctx: LaunchChecklistResearchContext;
  hasVoc: boolean;
  productDefinitionName?: string;
}): LaunchChecklistAutoContext {
  const competitorTable = buildCompetitorSnapshotTable(input.products);
  const vocParts = [
    input.ctx.topAttention !== "待 VOC 同步" ? `关注：${input.ctx.topAttention}` : null,
    input.ctx.topNegative !== "待 VOC 同步" ? `差评：${input.ctx.topNegative}` : null,
    input.ctx.topUnmet !== "待 VOC 同步" ? `未满足：${input.ctx.topUnmet}` : null,
    input.ctx.topMotives !== "待 VOC 同步" ? `购买动机：${input.ctx.topMotives}` : null,
  ].filter(Boolean);

  const suggestedSellPrice =
    parseMoneyInput(input.ctx.targetPrice.match(/\$?\d+(?:\.\d+)?/)?.[0] ?? "") ??
    parseMoneyInput(input.ctx.priceBand.match(/\$?\d+(?:\.\d+)?/)?.[0] ?? "");
  const referralFee = resolveReferralFeeFromProducts(input.products, suggestedSellPrice);

  return {
    hasVoc: input.hasVoc,
    competitorTable,
    marketInsight: `样本 ${input.ctx.productCount} 个 ASIN · 售价 ${input.ctx.priceBand} · 合计月销 ${input.ctx.sampleSales}（${input.ctx.dataMonth}）`,
    differentiation: [input.ctx.topOpportunity, input.productDefinitionName].filter(Boolean).join(" · ") || "待机会评分",
    vocSummary: vocParts.join("；") || "待 VOC 同步",
    referralFee,
    suggestedSellPrice,
  };
}

function enrichChecklistGroups(
  groups: LaunchChecklistGroup[],
  ctx: LaunchChecklistResearchContext,
  auto: LaunchChecklistAutoContext,
): LaunchChecklistGroup[] {
  return groups.map(group => {
    const enriched: LaunchChecklistGroup = { ...group };

    if (group.id === "basic-info") {
      enriched.entries = [
        checklistEntry("basic-product", "产品名称/内部编号", ctx.productName.includes("待填写") ? "manual" : "auto", ctx.productName),
        checklistEntry("basic-category", "品类/细分类目", "auto", `${ctx.categoryNode}（${ctx.verticalLabel}）`),
        checklistEntry("basic-site", "目标站点", "auto", ctx.targetSite.replace("（可在基本信息中修改）", "")),
        checklistEntry("basic-audience", "目标人群/年龄段", auto.hasVoc ? "auto" : "verify", ctx.targetAudience),
        checklistEntry("basic-scenario", "核心使用场景", auto.hasVoc ? "auto" : "verify", ctx.coreScenarios),
        manualChecklistField("预计上架时间", "如 2026-Q4"),
        manualChecklistField("旺季起止月份", "如 10–12 月"),
        manualChecklistField("产品开发负责人"),
        manualChecklistField("运营负责人"),
        manualChecklistField("供应商"),
      ];
    }

    if (group.id === "market-opportunity") {
      enriched.entries = [
        checklistEntry("m-kw", "已明确核心关键词、细分类目节点和目标价格带", "auto", `${ctx.categoryNode} · ${ctx.priceBand}`),
        checklistEntry("m-trend", "已获取类目近 12～24 个月销量、销售额及旺淡季趋势", auto.hasVoc ? "verify" : "check", auto.marketInsight),
        checklistEntry("m-capacity", "已确认目标价格带的市场容量、销量占比及增长趋势", "verify", auto.marketInsight),
        checklistEntry(
          "m-sample",
          "已分析头部、中腰部和新品竞品，样本不少于 10 个 ASIN",
          ctx.productCount >= 10 ? "auto" : "verify",
          `当前 ${ctx.productCount} 个（见竞品快照表）`,
        ),
        checklistEntry("m-params", "已分析竞品销量、售价、评分、评论数、上架时间、变体数量和促销情况", "verify", "见下方竞品快照表"),
        checklistEntry("m-voc", "已完成 VOC 分析（关注/好评/差评/未满足/人群/场景/动机）", auto.hasVoc ? "auto" : "check", auto.vocSummary),
        checklistEntry("m-diff", "已确认至少 1 个核心差异化", auto.hasVoc ? "auto" : "verify", auto.differentiation),
        checklistEntry("m-diff-evidence", "差异化功能有明确消费者需求证据或竞品数据支持", auto.hasVoc ? "verify" : "check", auto.vocSummary),
        checkOnlyField("m-season-type", "已判断产品属于常年款、季节款、节日款或事件驱动款"),
        checkOnlyField("m-season-window", "已确认剩余销售窗口足以覆盖生产、认证、运输、上架和推广周期"),
      ];
      enriched.competitorTable = auto.competitorTable;
    }

    if (group.id === "market-conclusion") {
      enriched.entries = [
        checkOnlyField("m-opp", "类目机会：□ 高　□ 中　□ 低"),
        checkOnlyField("m-pos", "产品定位：□ 引流款　□ 主销款　□ 利润款　□ 形象款　□ 配件延伸"),
        checklistEntry("m-gap", "是否存在明确需求缺口", auto.hasVoc ? "verify" : "check", auto.hasVoc ? `未满足 Top：${ctx.topUnmet}` : undefined),
        manualChecklistField("主要需求证据", "填写 VOC/数据依据"),
      ];
    }

    if (group.id === "final-conclusion") {
      enriched.entries = [
        checkOnlyField("final-verdict", "立项结论：□ 建议立项　□ 有条件立项　□ 小批量测试　□ 继续观察　□ 不立项"),
        manualChecklistField("首单建议数量"),
        manualChecklistField("预计月销量（保守/基准/乐观）", "如 800 / 1200 / 1800"),
        checklistEntry("final-price", "目标售价", "auto", ctx.targetPrice),
        manualChecklistField("基准平台毛利润率", "如 18%"),
        manualChecklistField("上架目标日期", "如 2026-11-01"),
        manualChecklistField("立项前必须关闭的问题"),
        manualChecklistField("责任人及完成时间"),
      ];
    }

    if (group.id === "pricing-market") {
      enriched.entries = group.items.map((text, index) =>
        checklistEntry(
          `pricing-${index}`,
          text,
          index <= 1 ? "auto" : "check",
          index <= 1 ? `${ctx.priceBand} · 建议 ${ctx.targetPrice}` : undefined,
        ),
      );
    }

    if (group.id === "mpq-forecast") {
      enriched.entries = group.items.map((text, index) =>
        checklistEntry(`mpq-${index}`, text, index === 1 ? "auto" : "check", index === 1 ? ctx.sampleSales : undefined),
      );
    }

    if (group.id === "supply-feasibility") {
      enriched.entries = group.items.map((text, index) =>
        checklistEntry(`supply-${index}`, text, index === 0 ? "verify" : "check", index === 0 ? auto.differentiation : undefined),
      );
    }

    if (group.items.length && group.kind === "table" && !enriched.entries) {
      enriched.entries = group.items.map((text, index) => checkOnlyField(`${group.id}-${index}`, text));
    }

    if (group.table && group.kind === "table") {
      if (group.id === "pricing-model") {
        const fee = auto.referralFee;
        const sellPriceText = auto.suggestedSellPrice != null ? formatUsd(auto.suggestedSellPrice) : "";
        const commissionAmount = fee.fee != null ? formatUsd(fee.fee) : "";
        enriched.description = [
          group.description,
          `${fee.note}；佣金 = ${fee.formula}（随「含税/前台售价」联动）`,
        ]
          .filter(Boolean)
          .join(" · ");
        enriched.dataHints = [
          ...(group.dataHints ?? []),
          `BSR 大类 ${fee.rankCategory} → 费用类目 ${fee.feeCategory} · ${fee.rateLabel}`,
        ];
        enriched.structuredTable = {
          headers: group.table.headers,
          rows: group.table.rows.map((row, rowIndex) => {
            const label = row[0] ?? "";
            const isSellPrice = label.includes("含税") || label.includes("前台售价");
            const isCommission = label.includes("亚马逊佣金");

            return row.map((cell, cellIndex) => {
              const key = `${group.id}-${rowIndex}-${cellIndex}`;
              if (cellIndex === 0) {
                return { key, text: cell, source: "auto" as const };
              }
              if (isSellPrice && cellIndex === 1) {
                return {
                  key,
                  text: sellPriceText,
                  source: sellPriceText ? ("verify" as const) : ("manual" as const),
                  placeholder: "请填写售价，佣金将自动联动",
                };
              }
              if (isCommission && cellIndex === 1) {
                return {
                  key,
                  text: commissionAmount,
                  source: "auto" as const,
                  placeholder: "售价 × 类目佣金比例",
                };
              }
              if (isCommission && cellIndex === 2) {
                return { key, text: fee.rateLabel, source: "auto" as const };
              }
              return {
                key,
                text: cell,
                source: "manual" as const,
                placeholder: cell.trim() ? undefined : "请填写",
              };
            });
          }),
        };
      } else {
        enriched.structuredTable = {
          headers: group.table.headers,
          rows: group.table.rows.map((row, rowIndex) =>
            row.map((cell, cellIndex) => ({
              key: `${group.id}-${rowIndex}-${cellIndex}`,
              text: cell,
              source: cell.trim() ? (group.id === "compliance-vertical" ? "auto" : "manual") : "manual",
              placeholder: cell.trim() ? undefined : "请填写",
            })),
          ),
        };
      }
    }

    if (group.kind === "score" && group.table) {
      enriched.structuredTable = {
        headers: group.table.headers,
        rows: group.table.rows.map((row, rowIndex) =>
          row.map((cell, cellIndex) => ({
            key: `${group.id}-${rowIndex}-${cellIndex}`,
            text: cell,
            source: cellIndex >= 2 ? "manual" : "auto",
            placeholder: cellIndex >= 2 ? "0–100" : undefined,
          })),
        ),
      };
    }

    if ((group.kind === "checks" || group.kind === "veto") && !enriched.entries) {
      enriched.entries = group.items.map((text, index) => checkOnlyField(`${group.id}-${index}`, text));
    }

    if (group.kind === "notes" && !enriched.entries) {
      enriched.entries = group.items.map((text, index) => {
        const needsInput = /_{2,}/.test(text);
        const label = text.includes("：") ? text.split("：")[0]! : text;
        if (needsInput) {
          return manualChecklistField(label, text.includes("□") ? text : "请填写");
        }
        return checkOnlyField(`${group.id}-${index}`, text);
      });
    }

    return enriched;
  });
}

export function parseTableCellOptions(text: string): { type: "radio"; options: string[] } | { type: "single" } | null {
  const trimmed = text.trim();
  if (!trimmed.includes("□")) return null;
  if (trimmed === "□") return { type: "single" };
  const options = [...trimmed.matchAll(/□\s*([^□]+?)(?=\s*□|$)/g)]
    .map(match => match[1].trim())
    .filter(Boolean);
  if (options.length >= 2) return { type: "radio", options };
  if (options.length === 1) return { type: "single" };
  return null;
}

export type ChecklistProductInput = {
  asin: string;
  brand: string;
  title?: string;
  subRankCategory?: string;
  rankCategory?: string;
  price?: number | null;
  sales?: number | null;
  rating?: number | null;
  reviews?: number | null;
  launch?: string | null;
};

export type ChecklistFieldSource = "auto" | "manual" | "verify" | "check";

export type LaunchChecklistEntry = {
  id: string;
  label: string;
  source: ChecklistFieldSource;
  autoValue?: string;
  placeholder?: string;
};

export type LaunchChecklistTableCell = {
  key: string;
  text: string;
  source: ChecklistFieldSource;
  placeholder?: string;
};

export type LaunchChecklistStructuredTable = {
  headers: string[];
  rows: LaunchChecklistTableCell[][];
};

export type LaunchChecklistGroupKind = "info" | "checks" | "table" | "notes" | "veto" | "score";

export type LaunchChecklistGroup = {
  id: string;
  section: string;
  title: string;
  description?: string;
  kind?: LaunchChecklistGroupKind;
  items: string[];
  entries?: LaunchChecklistEntry[];
  dataHints?: string[];
  table?: { headers: string[]; rows: string[][] };
  structuredTable?: LaunchChecklistStructuredTable;
  competitorTable?: LaunchChecklistStructuredTable;
};

export type LaunchChecklistResearchContext = {
  productName: string;
  categoryNode: string;
  targetSite: string;
  targetAudience: string;
  coreScenarios: string;
  verticalLabel: string;
  productCount: number;
  brands: string;
  asinList: string;
  priceBand: string;
  sampleSales: string;
  dataMonth: string;
  topAttention: string;
  topNegative: string;
  topUnmet: string;
  topOpportunity: string;
  targetPrice: string;
  topMotives: string;
  verdictTitle: string;
};

export type BusinessVertical =
  | "lighting"
  | "outdoor"
  | "furniture"
  | "home"
  | "toys"
  | "water_sports"
  | "garden"
  | "general";

export const businessVerticalLabels: Record<BusinessVertical, string> = {
  lighting: "灯具",
  outdoor: "户外运动",
  furniture: "家具",
  home: "家居",
  toys: "玩具",
  water_sports: "水上运动",
  garden: "园艺",
  general: "通用",
};

const VERTICAL_PATTERNS: Record<Exclude<BusinessVertical, "general">, RegExp[]> = {
  lighting: [/light/i, /lamp/i, /灯具/, /照明/, /flashlight/i, /headlamp/i, /lantern/i, /bulb/i],
  outdoor: [
    /outdoor/i,
    /sport/i,
    /scooter/i,
    /camping/i,
    /hiking/i,
    /运动/,
    /户外/,
    /kick scooter/i,
    /cycling/i,
    /fitness/i,
  ],
  furniture: [/furniture/i, /desk/i, /chair/i, /table/i, /shelf/i, /床/, /家具/, /沙发/, /cabinet/i],
  home: [/home/i, /kitchen/i, /storage/i, /家居/, /收纳/, /bedding/i, /decor/i, /organizer/i, /bath/i],
  toys: [/toy/i, /kids/i, /children/i, /玩具/, /幼儿/, /baby/i, /playset/i, /game/i],
  water_sports: [/water/i, /pool/i, /float/i, /kayak/i, /paddle/i, /水上/, /游泳/, /救生/, /inflatable/i],
  garden: [/garden/i, /lawn/i, /园艺/, /户外工具/, /prun/i, /mower/i, /hose/i, /planter/i],
};

export function inferBusinessVertical(products: ChecklistProductInput[]): BusinessVertical {
  const corpus = products
    .map(product => [product.subRankCategory, product.title, product.rankCategory].filter(Boolean).join(" "))
    .join(" ");

  const ranked = (Object.entries(VERTICAL_PATTERNS) as Array<[Exclude<BusinessVertical, "general">, RegExp[]]>)
    .map(([vertical, patterns]) => ({
      vertical,
      score: patterns.reduce((sum, pattern) => sum + (pattern.test(corpus) ? 1 : 0), 0),
    }))
    .sort((a, b) => b.score - a.score);

  if (ranked[0]?.score > 0) return ranked[0].vertical;
  return "general";
}

function buildResearchContext(input: {
  products: ChecklistProductInput[];
  categoryLabel: string;
  verticalLabel: string;
  topAttention?: string;
  topNegative?: string;
  topUnmet?: string;
  topOpportunity?: string;
  topMotives?: string;
  topAudiences?: string;
  topScenarios?: string;
  targetPrice?: string;
  priceBand?: string;
  sampleSales?: string;
  dataMonth?: string;
  verdictTitle?: string;
}): LaunchChecklistResearchContext {
  const asinList = input.products.map(product => product.asin).join("、");
  const brands = input.products.map(product => product.brand).filter(Boolean).join(" / ");
  const titleHint = input.products.find(product => product.title && product.title !== "等待卖家精灵与 SIF MCP 返回商品数据")?.title;

  return {
    productName: titleHint ? titleHint.slice(0, 80) : "待填写内部编号",
    categoryNode: input.categoryLabel,
    targetSite: "Amazon US（可在基本信息中修改）",
    targetAudience: input.topAudiences ?? "待 VOC 归纳",
    coreScenarios: input.topScenarios ?? "待 VOC 归纳",
    verticalLabel: input.verticalLabel,
    productCount: input.products.length,
    brands: brands || "—",
    asinList,
    priceBand: input.priceBand ?? "待同步售价",
    sampleSales: input.sampleSales ?? "待 Sorftime 销量",
    dataMonth: input.dataMonth ?? "—",
    topAttention: input.topAttention ?? "待 VOC 同步",
    topNegative: input.topNegative ?? "待 VOC 同步",
    topUnmet: input.topUnmet ?? "待 VOC 同步",
    topOpportunity: input.topOpportunity ?? "待机会评分",
    targetPrice: input.targetPrice ?? "待毛利模型",
    topMotives: input.topMotives ?? "待 VOC 同步",
    verdictTitle: input.verdictTitle ?? "待完成 VOC 与清单确认",
  };
}

function marketDataHints(ctx: LaunchChecklistResearchContext): string[] {
  return [
    `本轮对标 ${ctx.productCount} 个 ASIN：${ctx.asinList}`,
    `品牌样本：${ctx.brands}`,
    `细分类目：${ctx.categoryNode} · 识别品类：${ctx.verticalLabel}`,
    `样本售价区间：${ctx.priceBand} · 样本月销合计：${ctx.sampleSales}（${ctx.dataMonth}）`,
    `VOC 关注 Top：${ctx.topAttention} · 差评 Top：${ctx.topNegative} · 未满足 Top：${ctx.topUnmet}`,
    `首要机会：${ctx.topOpportunity} · 建议目标价：${ctx.targetPrice}`,
  ];
}

function buildSectionGroups(ctx: LaunchChecklistResearchContext, vertical: BusinessVertical): LaunchChecklistGroup[] {
  const complianceRow =
    complianceCategoryMatrix.find(row => row.vertical === vertical) ??
    complianceCategoryMatrix.find(row => row.vertical === "outdoor")!;

  return [
    {
      id: "basic-info",
      section: "一",
      title: "立项基本信息",
      kind: "info",
      description: "适用阶段：产品调研完成后、打样或正式下单前",
      items: [
        `产品名称/内部编号：${ctx.productName}`,
        `品类/细分类目：${ctx.categoryNode}（识别为 ${ctx.verticalLabel}）`,
        `目标站点：${ctx.targetSite}`,
        `目标人群/年龄段：${ctx.targetAudience}`,
        `核心使用场景：${ctx.coreScenarios}`,
        "预计上架时间：待填写",
        "旺季起止月份：待填写",
        "产品开发负责人：待填写",
        "运营负责人：待填写",
        "供应商：待填写",
      ],
      dataHints: marketDataHints(ctx),
    },
    {
      id: "market-opportunity",
      section: "二",
      title: "市场需求与产品机会",
      kind: "checks",
      items: [
        "已明确核心关键词、细分类目节点和目标价格带",
        "已获取类目近 12～24 个月销量、销售额及旺淡季趋势",
        "已确认目标价格带的市场容量、销量占比及增长趋势",
        `已分析头部、中腰部和新品竞品，样本不少于 10 个 ASIN（当前 ${ctx.productCount} 个）`,
        "已分析竞品销量、售价、评分、评论数、上架时间、变体数量和促销情况",
        "已完成 VOC 分析：顾客关注点、好评点、差评点、未满足需求、使用人群、使用场景、购买动机",
        "已确认至少 1 个核心差异化，不是单纯改颜色、换包装或堆砌低价值功能",
        "差异化功能有明确消费者需求证据或竞品数据支持",
        "已判断产品属于常年款、季节款、节日款或事件驱动款",
        "已确认剩余销售窗口足以覆盖生产、认证、运输、上架和推广周期",
      ],
      dataHints: [
        `调研结论参考：${ctx.verdictTitle}`,
        `购买动机 Top：${ctx.topMotives}`,
      ],
    },
    {
      id: "market-conclusion",
      section: "二",
      title: "市场结论（人工判定）",
      kind: "notes",
      items: [
        "类目机会：□ 高　□ 中　□ 低",
        "产品定位：□ 引流款　□ 主销款　□ 利润款　□ 形象款　□ 配件延伸",
        "是否存在明确需求缺口：□ 是　□ 否",
        "主要需求证据：________________________________",
      ],
    },
    {
      id: "patent-scope",
      section: "三",
      title: "专利与知识产权检索（立项硬门槛）· 检索范围",
      kind: "checks",
      description: "公开检索仅用于初筛，不替代专业 FTO 意见",
      items: [
        "已按目标销售国家分别检索，不以中国专利结果代替目标市场检索",
        "已检索发明专利/实用专利：核心结构、连接方式、功能原理、控制方式等",
        "已检索外观设计：整体造型、局部特征、图案、灯体/支架/把手/底座等关键部位",
        "已检索商标、品牌词、系列名、包装图案及可能涉及的版权元素",
        "已使用产品名称、核心关键词、同义词、竞品品牌、申请人、发明人和分类号组合检索",
        `已对亚马逊头部竞品及重点品牌进行专利反查（样本：${ctx.brands}）`,
        "已核验专利法律状态、保护国家、权利要求、优先权、到期日和权利人",
        "已保留检索记录、专利号、关键图示及与拟开发产品的对比说明",
      ],
    },
    {
      id: "patent-risk",
      section: "三",
      title: "专利风险判断",
      kind: "table",
      items: [],
      table: {
        headers: ["检索对象", "结果/专利号", "相似点", "法律状态", "风险等级", "处理方案"],
        rows: [
          ["发明/功能", "", "", "", "□ 高 □ 中 □ 低", ""],
          ["外观设计", "", "", "", "□ 高 □ 中 □ 低", ""],
          ["商标/版权", "", "", "", "□ 高 □ 中 □ 低", ""],
        ],
      },
    },
    {
      id: "patent-gates",
      section: "三",
      title: "专利判定规则",
      kind: "checks",
      items: [
        "高风险专利已取得律师或专业机构出具的 FTO/侵权风险意见",
        "中风险项目已形成结构规避、外观规避或功能替代方案，并重新检索",
        "供应商声称「有专利」时，已核验权利人、授权范围及是否允许我方销售",
        "ODM/公模产品已确认同款是否涉及第三方专利投诉历史",
        "红灯：核心权利要求或整体外观高度重合且无法规避 → 暂停立项",
        "黄灯：存在局部相似或法律状态不明确 → 专业复核后再决定",
        "绿灯：未发现实质性冲突，并有完整检索记录 → 可进入下一阶段",
      ],
    },
    {
      id: "compliance-general",
      section: "四",
      title: "合规认证与产品安全 · 通用确认",
      kind: "checks",
      description: "立项筛查，不构成法律意见",
      items: [
        "已明确目标站点、产品用途、年龄分级、使用环境及监管属性",
        "已形成「国家/站点—法规—标准—测试项目—证书/报告—标签—责任人」合规矩阵",
        "已确认产品是否属于儿童用品、电器、无线设备、含电池产品、承重产品、漂浮救生用品、食品接触用品、化学品或农药/驱虫宣称产品",
        "已向合规人员或实验室确认适用标准，不能只采纳供应商口头判断",
        "已确认实验室资质、测试样品数、测试费、整改费、认证周期和证书有效期",
        "合规及认证费用已计入产品成本和利润测算",
        "已确认产品、包装和说明书的警告语、年龄等级、追踪标签、制造商/进口商信息及当地语言要求",
        "已确认电池、磁铁、小零件、绳带、尖点利边、夹伤、倾倒、承重、过热、触电、漏水等风险",
        "已确认亚马逊类目审核所需文件，并核验报告中的型号、图片、品牌和申请人信息一致",
        "已安排量产前预测试和量产后抽检，避免只测试「特制样品」",
      ],
    },
    {
      id: "compliance-vertical",
      section: "四",
      title: `七大品类触发式检查 · ${complianceRow.label}`,
      kind: "table",
      description: "按本轮调研识别品类自动匹配专项合规方向",
      items: [],
      table: {
        headers: ["品类", "必须优先排查的风险", "按产品触发的合规/测试方向", "立项时需确认"],
        rows: [[complianceRow.label, complianceRow.risks, complianceRow.compliance, complianceRow.confirmAtLaunch]],
      },
      dataHints: [
        "美国站重点：儿童玩具需逐品确认 CPSIA/CPC；复合木家具查 TSCA Title VI；储衣家具查 16 CFR Part 1261；射频产品查 FCC；PFD 走 USCG；园艺杀虫宣称查 FIFRA",
      ],
    },
    {
      id: "compliance-conclusion",
      section: "四",
      title: "合规结论（人工判定）",
      kind: "notes",
      items: [
        "合规路径：□ 明确　□ 待确认　□ 不可行",
        "预计认证费用：____________",
        "预计认证周期：____________",
        "预计整改费用：____________",
        "是否影响上架时间：□ 是　□ 否",
        "是否存在禁止销售或高召回风险：□ 是　□ 否",
      ],
    },
    {
      id: "pricing-market",
      section: "五",
      title: "售价区间与利润空间 · 市场售价确认",
      kind: "checks",
      items: [
        `已统计目标价格带内不少于 10 个竞品的日常价、券后价、大促价和过去价格波动（当前样本 ${ctx.productCount} 个）`,
        `已计算目标价格带售价分布，样本区间 ${ctx.priceBand}`,
        "已确认消费者愿意为差异化功能支付的溢价，而不是主观加价",
        "已分别测算新品期、稳定期和大促期售价",
        "已核查不同颜色、尺寸、套装和变体之间的销量及价格差异",
      ],
      dataHints: [`建议目标售价带：${ctx.targetPrice}`],
    },
    {
      id: "pricing-model",
      section: "五",
      title: "全成本利润测算",
      kind: "table",
      description:
        "平台毛利润率 =（销售收入－折扣及平台活动费用－采购成本－包装－头程及关税－平台佣金－FBA 费－仓储－广告－退货售后预留－认证/模具摊销）÷ 销售收入",
      items: [],
      table: {
        headers: ["项目", "金额", "占销售额比例"],
        rows: [
          ["含税/前台售价", "", ""],
          ["折扣、Coupon 及活动费用", "", ""],
          ["产品采购成本", "", ""],
          ["头程、关税及清关成本", "", ""],
          ["亚马逊佣金", "", ""],
          ["FBA 配送费", "", ""],
          ["仓储费及超龄库存预留", "", ""],
          ["广告费", "", ""],
          ["退货、售后及赔付预留", "", ""],
          ["专利/认证/模具摊销", "", ""],
          ["平台毛利润", "", ""],
          ["平台毛利润率", "", ""],
        ],
      },
    },
    {
      id: "pricing-stress",
      section: "五",
      title: "情景压力测试",
      kind: "table",
      items: [
        `公司立项线：基准情景平台毛利润率 ≥ ${companyLaunchMarginThresholdPct}%（低于该值且无降本方案 → 一票否决）`,
        `基准情景平台毛利润率不低于 ${companyLaunchMarginThresholdPct}%`,
        "售价下降 10% 后仍不出现严重亏损，或已有明确降本方案",
        "盈亏平衡售价不高于目标价格带 P50，避免只能依靠高价销售才能盈利",
        "广告、退货、仓储和认证摊销均已计入，未使用「产品毛利」替代「平台毛利」",
        "大件、季节性或高退货风险产品已增加额外风险预留",
      ],
      table: {
        headers: ["情景", "售价", "广告占比", "退货率", "头程变化", "平台毛利润率", "是否通过"],
        rows: [
          ["乐观", "", "", "", "", "", "□"],
          ["基准", "", "", "", "", "", "□"],
          ["保守：降价 10%", "", "", "", "", "", "□"],
          ["大促/清理", "", "", "", "", "", "□"],
        ],
      },
    },
    {
      id: "mpq-supplier",
      section: "六",
      title: "MOQ 与预估月销量匹配 · 供应商起订条件",
      kind: "table",
      description: "MOQ 按供应商最小采购数量填写，并拆分到每个 SKU",
      items: [],
      table: {
        headers: ["项目", "数值"],
        rows: [
          ["总 MOQ", ""],
          ["单 SKU 最低数量", ""],
          ["最少颜色/尺寸数量", ""],
          ["首单货值", ""],
          ["模具/定制费用", ""],
          ["生产周期", ""],
          ["补单周期", ""],
          ["是否可分批生产/交付", ""],
        ],
      },
    },
    {
      id: "mpq-forecast",
      section: "六",
      title: "月销量预测依据",
      kind: "checks",
      items: [
        "已结合 Sorftime 类目容量、核心关键词趋势、竞品月销量和季节性预测",
        `样本竞品月销参考：${ctx.sampleSales}`,
        "已区分市场容量与我方可获得销量，不能直接按头部竞品销量下单",
        "已考虑新品评分、评论数、广告预算、价格竞争力和链接承接能力",
        "已输出保守、基准、乐观三档月销量",
        "季节款已按实际上架月份和剩余旺季销售窗口测算，不使用全年平均月销量",
      ],
    },
    {
      id: "mpq-match",
      section: "六",
      title: "MOQ 匹配测算",
      kind: "table",
      description: "MOQ 可售月数 = 单 SKU MOQ ÷ 单 SKU 预估月销量；预计售罄天数 = 单 SKU MOQ ÷ 单 SKU 预估日销量",
      items: [
        "绿灯：按保守销量测算，单 SKU MOQ 可在 2 个月以内售完",
        "黄灯：按保守销量测算，需要 2～3 个月售完；必须降低 MOQ、减少 SKU 或分批交货",
        "红灯：按保守销量测算，超过 3 个月才能售完；原则上不立项",
        "季节性产品：即使库存周期不超过 3 个月，也必须确保能在旺季结束前售完",
        "定制产品：优先争取「小批量验证＋分批交货」，不得因模具或高毛利预期直接放大首单",
      ],
      table: {
        headers: ["预测情景", "预估月销量", "MOQ 可售月数", "预计售罄天数"],
        rows: [
          ["保守", "", "", ""],
          ["基准", "", "", ""],
          ["乐观", "", "", ""],
        ],
      },
    },
    {
      id: "supply-feasibility",
      section: "七",
      title: "产品方案与供应链可行性",
      kind: "checks",
      items: [
        "已完成产品规格书，明确尺寸、材料、颜色、功能、承重、配件、包装和警告语",
        "核心卖点已转换为可测量参数，不使用「更稳定、质量更好」等模糊表达",
        "已完成竞品样品拆解或实物对比",
        "已确认公模、私模、开模及模具所有权",
        "已确认 BOM、关键材料牌号和不可替代部件",
        "已评估功能增加对成本、重量、包装、运输、合规和售后的影响",
        "供应商具备同类产品经验、稳定产能及质量追溯能力",
        "已确认付款方式、交期、旺季产能、备料周期和补单周期",
        "已确认关键部件是否存在单一供应商或停产风险",
        "已完成样品测试，并形成问题清单、整改责任人和关闭日期",
      ],
      dataHints: [`差异化方向参考：${ctx.topOpportunity}`],
    },
    {
      id: "quality-logistics",
      section: "八",
      title: "质量、包装与物流",
      kind: "checks",
      items: [
        "已定义关键质量指标、检验标准、AQL 及功能测试方法",
        "已进行承重、跌落、寿命、稳定性、气密性、防水、防腐或耐候测试中的适用项目",
        "已确认包装跌落、振动、防潮、防刮及易碎件保护方案",
        "已确认单品和外箱尺寸、重量、装箱数及 FBA 尺寸分段",
        "已测算体积重、头程、FBA 配送费及仓储费，避免因包装变化导致利润失真",
        "已确认是否属于超大件、危险品、含电池、磁性、液体或运输受限产品",
        "已确认备件、说明书、安装工具和售后补发方案",
        "已预估退货率及主要退货原因，并计入利润模型",
      ],
    },
    {
      id: "veto",
      section: "九",
      title: "立项一票否决项",
      kind: "veto",
      description: `出现以下任一情况，原则上不得进入正式下单。公司立项线：基准情景平台毛利润率 ≥ ${companyLaunchMarginThresholdPct}%。`,
      items: vetoItems,
      dataHints: [
        `低于 ${companyLaunchMarginThresholdPct}% 且无明确降本方案时，无论评分多高均不得直接立项。`,
      ],
    },
    {
      id: "score",
      section: "十",
      title: "立项评分",
      kind: "score",
      description: "80 分及以上建议立项；65～79 分有条件立项；50～64 分继续调研；50 分以下暂不立项。触发一票否决时不得直接立项。",
      items: [],
      table: {
        headers: ["维度", "权重", "得分（0～100）", "加权得分"],
        rows: scoreDimensions.map(dim => [dim.label, `${dim.weight}%`, "", ""]),
      },
    },
    {
      id: "approval",
      section: "十",
      title: "部门会签",
      kind: "table",
      items: [],
      table: {
        headers: ["部门/角色", "核心确认内容", "结论", "签字/日期"],
        rows: approvalRoles.map(role => [role.role, role.scope, "□ 通过 □ 整改 □ 不通过", ""]),
      },
    },
    {
      id: "final-conclusion",
      section: "十",
      title: "最终结论",
      kind: "notes",
      items: [
        "立项结论：□ 建议立项　□ 有条件立项　□ 小批量测试　□ 继续观察　□ 不立项",
        "首单建议数量：____________",
        "预计月销量（保守/基准/乐观）：____________ / ____________ / ____________",
        `目标售价：${ctx.targetPrice}（可修订）`,
        "基准平台毛利润率：____________",
        "上架目标日期：____________",
        "立项前必须关闭的问题：________________________________",
        "责任人及完成时间：________________________________",
      ],
      dataHints: [`VOC 立项分析结论：${ctx.verdictTitle}`],
    },
  ];
}

export function buildLaunchChecklist(input: {
  products: ChecklistProductInput[];
  opportunities: Array<{ name: string }>;
  categoryLabel: string;
  topNegativeLabel?: string;
  topUnmetLabel?: string;
  topAttentionLabel?: string;
  topMotivesLabel?: string;
  topAudiencesLabel?: string;
  topScenariosLabel?: string;
  targetPrice?: string;
  priceBand?: string;
  sampleSales?: string;
  dataMonth?: string;
  verdictTitle?: string;
  hasVoc?: boolean;
  productDefinitionName?: string;
}): {
  vertical: BusinessVertical;
  verticalLabel: string;
  version: string;
  research: LaunchChecklistResearchContext;
  groups: LaunchChecklistGroup[];
} {
  const vertical = inferBusinessVertical(input.products);
  const verticalLabel = businessVerticalLabels[vertical];
  const topOpportunity = input.opportunities[0]?.name;

  const research = buildResearchContext({
    products: input.products,
    categoryLabel: input.categoryLabel,
    verticalLabel,
    topAttention: input.topAttentionLabel,
    topNegative: input.topNegativeLabel,
    topUnmet: input.topUnmetLabel,
    topOpportunity,
    topMotives: input.topMotivesLabel,
    topAudiences: input.topAudiencesLabel,
    topScenarios: input.topScenariosLabel,
    targetPrice: input.targetPrice,
    priceBand: input.priceBand,
    sampleSales: input.sampleSales,
    dataMonth: input.dataMonth,
    verdictTitle: input.verdictTitle,
  });

  const auto = buildAutoContext({
    products: input.products,
    ctx: research,
    hasVoc: Boolean(input.hasVoc),
    productDefinitionName: input.productDefinitionName,
  });

  return {
    vertical,
    verticalLabel,
    version: launchChecklistVersion,
    research,
    groups: enrichChecklistGroups(buildSectionGroups(research, vertical), research, auto),
  };
}

export const launchChecklistMeta = {
  businessVerticals: ["灯具", "户外运动", "家具", "家居", "玩具", "水上运动", "园艺"] as const,
  policy: "触发一票否决项或关键硬门槛未通过时，不得直接进入正式下单",
  version: launchChecklistVersion,
};
