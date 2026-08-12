/**
 * SIF 反查流量词 / 关键词对比矩阵 · 字段释义
 * 口径来源：SIF 反查流量词教程、SIF MCP（listingSearch / keyword_history / 商机探测器）
 */
export type SifKeywordFieldTip = {
  label: string;
  sifName?: string;
  meaning: string;
};

export const sifKeywordFieldGlossary = {
  keyword: {
    label: "关键词",
    meaning: "SIF 反查进入搜索结果前三页、且落在 ABA 月搜索排名前约 100 万（以美国站为例）的流量词。",
  },
  category: {
    label: "含义分类",
    meaning: "本看板按词义自动打的 12 类标签（人群/场景/功能等），用于横向对比需求结构；非 SIF 原始字段。",
  },
  searchVolume: {
    label: "月搜索量",
    sifName: "月搜索量",
    meaning:
      "上个自然月预估搜索量。SIF 依据 ABA 月搜索排名、时间与淡旺季等因素估算，绝对值与真实搜索量可能有偏差，相对比较更可靠。",
  },
  searchTrend: {
    label: "月搜索趋势",
    sifName: "搜索量/排名趋势",
    meaning: "近 12 个月搜索量与 ABA 排名走势。旺季时即使 ABA 排名下降，搜索量仍可能上升。",
  },
  suggestedBid: {
    label: "建议竞价",
    sifName: "建议竞价 / CPC",
    meaning: "该词 SP 精准匹配的建议竞价区间（低 / 中位 / 高），来自 SIF 商机探测器与 ABA 合并口径，用于判断投放成本区间。",
  },
  clickConversionRate: {
    label: "点击转化率",
    sifName: "点击转化率",
    meaning: "该关键词在平台层面的平均点击转化率（点击→订单），来自亚马逊商机探测器 / ABA 合并记录，反映词本身转化难度。",
  },
  abaRank: {
    label: "ABA 排名",
    sifName: "ABA 月搜索排名",
    meaning: "亚马逊品牌分析（ABA）中的月搜索热度排名，数值越小越热；常与月搜索量对照使用。",
  },
  top3Concentration: {
    label: "ABA Top3 集中度",
    sifName: "Top3 点击共享 / 转化共享",
    meaning:
      "该词下点击共享、转化共享前三名 ASIN 的合计占比。集中度越高，头部垄断越强；转化共享明显高于点击共享时，头部转化更优。",
  },
  coverage: {
    label: "共享率",
    sifName: "有效竞品数",
    meaning:
      "当前对比的竞品中，有多少个 ASIN 在该词下有流量占比（命中该词）。格式为「命中数/对比总数」；命中越多，词与当前竞品池越相关。",
  },
  trafficShare: {
    label: "流量占比",
    sifName: "流量占比",
    meaning:
      "指曝光份额而非点击/转化。SIF 综合 ASIN 在该词下的排名位置、前三页停留时长、曝光位置与搜索量估算；同一 ASIN 下各词占比之和约为 100%。",
  },
} as const satisfies Record<string, SifKeywordFieldTip>;

export type SifKeywordFieldKey = keyof typeof sifKeywordFieldGlossary;

export function sifKeywordFieldTitle(key: SifKeywordFieldKey, extra?: string) {
  const tip = sifKeywordFieldGlossary[key];
  const head = tip.sifName && tip.sifName !== tip.label ? `${tip.label}（SIF：${tip.sifName}）` : tip.label;
  return extra ? `${head}\n${tip.meaning}\n\n${extra}` : `${head}\n${tip.meaning}`;
}
