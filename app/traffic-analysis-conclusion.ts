import {
  sifListingTrafficMeta,
  sifListingTrafficOverview,
  type ChildTrafficVariant,
  type SifListingTrafficOverview,
  type TrafficDistributionItem,
} from "./sif-listing-traffic-data";

export type TrafficGrade = "强" | "中强" | "中" | "中弱" | "弱";
export type TrafficHealth = "健康" | "基本健康" | "需观察" | "风险较高";

export type TrafficCompetitorConclusion = {
  asin: string;
  brand: string;
  totalScore: number;
  naturalScore: number;
  naturalRatio: number;
  adScore: number;
  adRatio: number;
  naturalAdLabel: string;
  pullGrade: TrafficGrade;
  naturalGrade: TrafficGrade;
  adPlayGrade: TrafficGrade;
  recommendGrade: TrafficGrade;
  variantGrade: TrafficGrade;
  health: TrafficHealth;
  typeLabel: string;
  typeSubLabel: string | null;
  adPlaySummary: string;
  variantSummary: string;
  strengths: string;
  risks: string;
  copyable: string;
  confidence: "高" | "中" | "低";
  confidenceReason: string;
  top1Share: number;
  top3Share: number;
  effectiveChildren: number;
  childCount: number;
  recommendScore: number;
  maxAdChannel: string;
  maxAdChannelRatio: number;
  effectiveAdChannels: number;
};

export type TrafficAnalysisConclusion = {
  title: string;
  headline: string;
  corePoints: string[];
  overview: TrafficCompetitorConclusion[];
  implications: string[];
  dataBoundary: string;
  methodNote: string;
  updatedThrough: string;
};

type ProductLike = { asin: string; brand: string };

function itemScore(items: TrafficDistributionItem[], label: string) {
  return items.find(item => item.label === label)?.score ?? 0;
}

function itemRatio(items: TrafficDistributionItem[], label: string) {
  return items.find(item => item.label === label)?.ratio ?? 0;
}

function formatScore(value: number) {
  if (value >= 10000) return `${(value / 10000).toFixed(1)}万`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}千`;
  return value.toLocaleString();
}

function percentileRank(value: number, sortedAsc: number[]) {
  if (sortedAsc.length <= 1) return 0.5;
  const below = sortedAsc.filter(item => item < value).length;
  return below / (sortedAsc.length - 1);
}

function scaleFromPercentile(p: number): TrafficGrade {
  if (p >= 0.8) return "强";
  if (p >= 0.6) return "中强";
  if (p >= 0.4) return "中";
  if (p >= 0.2) return "中弱";
  return "弱";
}

function adIntensityLabel(adRatio: number) {
  if (adRatio < 15) return "低广告介入";
  if (adRatio < 30) return "适度广告维护";
  if (adRatio < 45) return "积极推广";
  if (adRatio <= 60) return "广告强推";
  return "高度广告依赖";
}

function naturalStructureLabel(nfRatio: number) {
  if (nfRatio >= 75) return "自然沉淀突出";
  if (nfRatio >= 65) return "结构健康";
  if (nfRatio >= 55) return "自然与广告相对均衡";
  if (nfRatio >= 45) return "广告依赖偏高";
  return "广告依赖明显";
}

function variantStructureLabel(top1: number) {
  if (top1 >= 90) return "极端单爆款型";
  if (top1 >= 80) return "单爆款驱动型";
  if (top1 >= 60) return "主力子体主导型";
  if (top1 >= 40) return "主力＋辅助子体型";
  return "多子体均衡型";
}

function analyzeChildren(children: ChildTrafficVariant[]) {
  const sorted = [...children].sort((a, b) => b.totalScore - a.totalScore);
  const top1Share = sorted[0]?.sharePct ?? 0;
  const top3Share = sorted.slice(0, 3).reduce((sum, item) => sum + item.sharePct, 0);
  const effectiveChildren = sorted.filter(item => item.sharePct >= 5).length;
  return { sorted, top1Share, top3Share, effectiveChildren, childCount: sorted.length };
}

function analyzeAdChannels(channels: TrafficDistributionItem[]) {
  const sorted = [...channels].sort((a, b) => b.score - a.score);
  const effective = sorted.filter(item => item.ratio >= 5);
  const max = sorted[0];
  return {
    sorted,
    effectiveCount: effective.length,
    maxLabel: max?.label ?? "—",
    maxRatio: max?.ratio ?? 0,
  };
}

function recommendTotal(sources: TrafficDistributionItem[]) {
  return sources.reduce((sum, item) => sum + item.score, 0);
}

function gradeNatural(nfScore: number, nfRatio: number, totalP: number): TrafficGrade {
  let grade: TrafficGrade =
    nfRatio >= 75 ? "强" :
    nfRatio >= 65 ? "中强" :
    nfRatio >= 55 ? "中" :
    nfRatio >= 45 ? "中弱" : "弱";

  if (totalP < 0.2) {
    if (grade === "强" || grade === "中强") grade = "中弱";
    else if (grade === "中") grade = "弱";
  } else if (totalP < 0.1) {
    grade = "弱";
  }

  if (nfScore > 0 && totalP >= 0.8 && nfRatio >= 65) grade = "强";
  else if (totalP >= 0.6 && nfRatio >= 60 && grade === "中") grade = "中强";

  return grade;
}

function gradeAdPlay(adScore: number, adP: number, effectiveChannels: number, maxRatio: number): TrafficGrade {
  let grade = scaleFromPercentile(adP);
  if (adScore < 5000) {
    if (grade === "强" || grade === "中强") grade = "中弱";
  }
  if (effectiveChannels >= 3 && adP >= 0.4) {
    if (grade === "中") grade = "中强";
  }
  if (maxRatio >= 80) {
    if (grade === "强") grade = "中强";
    else if (grade === "中强") grade = "中";
  }
  return grade;
}

function gradeRecommend(recScore: number, recP: number, effectiveSources: number, maxSourceRatio: number): TrafficGrade {
  let grade = scaleFromPercentile(recP);
  if (recScore < 1000) grade = "弱";
  else if (recScore < 4000 && (grade === "强" || grade === "中强")) grade = "中弱";
  if (effectiveSources >= 3 && recP >= 0.6) {
    if (grade === "中") grade = "中强";
  }
  if (maxSourceRatio >= 70 && grade === "强") grade = "中强";
  return grade;
}

function gradeVariant(top1: number, effectiveChildren: number, childCount: number): TrafficGrade {
  if (effectiveChildren >= 4 && top1 < 40) return "强";
  if (effectiveChildren >= 3 && top1 < 60) return "中强";
  if (effectiveChildren >= 2 && top1 < 80) return "中";
  if (effectiveChildren <= 1 || top1 >= 90) return "弱";
  if (childCount >= 8 && effectiveChildren <= 2) return "弱";
  if (top1 >= 80) return "中弱";
  return "中弱";
}

function pickTypeLabels(input: {
  totalP: number;
  nfRatio: number;
  adRatio: number;
  maxAdLabel: string;
  maxAdRatio: number;
  sbvRatio: number;
  sbRatio: number;
  top1: number;
  effectiveChildren: number;
  childCount: number;
}): { primary: string; secondary: string | null } {
  const {
    totalP, nfRatio, adRatio, maxAdLabel, maxAdRatio, sbvRatio, sbRatio,
    top1, effectiveChildren, childCount,
  } = input;

  let primary = "小规模稳态型";
  let secondary: string | null = null;

  if (totalP < 0.2 && nfRatio >= 75) {
    primary = "低量自然型";
  } else if (top1 >= 90) {
    primary = "极端单爆款型";
  } else if (top1 >= 80) {
    primary = "单爆款驱动型";
  } else if (effectiveChildren >= 4 && top1 < 40) {
    primary = "多子体矩阵型";
  } else if (top1 >= 40 && top1 < 60 && effectiveChildren >= 3) {
    primary = "主力＋辅助型";
  } else if (top1 >= 60 && top1 < 80 && effectiveChildren >= 2) {
    primary = "主力子体主导型";
  } else if (totalP >= 0.8 && nfRatio >= 65 && effectiveChildren >= 3 && maxAdRatio < 80) {
    primary = "成熟复合型";
  } else if (totalP < 0.4 && nfRatio >= 65 && adRatio < 35) {
    primary = "小规模稳态型";
  } else if (adRatio > 60) {
    primary = "高度广告依赖型";
  } else if (adRatio >= 30 && adRatio <= 60) {
    primary = "广告进攻型";
  } else if (totalP < 0.4 && nfRatio >= 65 && adRatio < 35) {
    primary = "小规模稳态型";
  }

  if (sbvRatio >= 10) {
    if (primary === "单爆款驱动型" || primary === "极端单爆款型" || primary === "广告进攻型") {
      secondary = "视频拓量型";
    } else {
      secondary = secondary ?? "视频拓量型";
    }
  }
  if (maxAdLabel.includes("SP(常规)") && maxAdRatio >= 70) {
    secondary = secondary ?? "SP关键词驱动型";
  }
  if (sbRatio >= 40 || (maxAdLabel.includes("SB") && !maxAdLabel.includes("SBV") && maxAdRatio >= 40)) {
    secondary = secondary ?? "SB品牌拉量型";
  }
  if (childCount >= 8 && effectiveChildren <= 2) {
    secondary = secondary ?? "变体虚胖";
  }

  if (totalP >= 0.8 && nfRatio >= 65 && effectiveChildren >= 3 && maxAdRatio < 80 && top1 < 60) {
    primary = "成熟复合型";
    secondary = top1 >= 40 ? "主力＋辅助型" : secondary;
  }

  return { primary, secondary };
}

function healthOf(input: {
  nfRatio: number;
  adRatio: number;
  top1: number;
  effectiveChildren: number;
  childCount: number;
  maxAdRatio: number;
  maxRecRatio: number;
  totalP: number;
}): { health: TrafficHealth; triggers: string[] } {
  const triggers: string[] = [];
  let risk = 0;
  let healthy = 0;

  if (input.nfRatio >= 65 && input.totalP >= 0.4) healthy += 1;
  if (input.effectiveChildren >= 3) healthy += 1;
  if (input.maxAdRatio < 80) healthy += 1;

  if (input.adRatio > 50) {
    risk += 1;
    triggers.push(`广告占比 ${input.adRatio.toFixed(1)}%`);
  }
  if (input.top1 >= 90) {
    risk += 2;
    triggers.push(`TOP1 ${input.top1.toFixed(1)}% 极端单爆款`);
  } else if (input.top1 >= 80) {
    risk += 1;
    triggers.push(`TOP1 ${input.top1.toFixed(1)}% 单爆款`);
  }
  if (input.maxAdRatio >= 80) {
    risk += 1;
    triggers.push(`单渠道占广告 ${input.maxAdRatio.toFixed(1)}%`);
  }
  if (input.totalP < 0.2 && input.nfRatio >= 75) {
    risk += 1;
    triggers.push("低量高自然占比（比例假强）");
  }
  if (input.childCount >= 8 && input.effectiveChildren <= 2) {
    risk += 1;
    triggers.push(`子体 ${input.childCount} 个但有效仅 ${input.effectiveChildren} 个`);
  }
  if (input.maxRecRatio >= 70) {
    risk += 1;
    triggers.push(`推荐来源集中 ${input.maxRecRatio.toFixed(1)}%`);
  }

  if (risk >= 2) return { health: "风险较高", triggers };
  if (risk >= 1) return { health: "需观察", triggers };
  if (healthy >= 2) return { health: "健康", triggers: ["自然量与占比兼顾", "变体/渠道无明显单点风险"] };
  return { health: "基本健康", triggers: triggers.length ? triggers : ["结构尚可，规模或渠道仍有短板"] };
}

function buildOne(
  product: ProductLike,
  data: SifListingTrafficOverview,
  totalsAsc: number[],
  adAsc: number[],
  recAsc: number[],
): TrafficCompetitorConclusion {
  const nfScore = itemScore(data.naturalAd, "自然流量");
  const adScore = itemScore(data.naturalAd, "广告流量");
  const nfRatio = itemRatio(data.naturalAd, "自然流量");
  const adRatio = itemRatio(data.naturalAd, "广告流量");
  const children = analyzeChildren(data.children);
  const ad = analyzeAdChannels(data.adChannels);
  const recScore = recommendTotal(data.recommendationSources);
  const effectiveRec = data.recommendationSources.filter(item => item.ratio >= 5).length;
  const maxRecRatio = [...data.recommendationSources].sort((a, b) => b.ratio - a.ratio)[0]?.ratio ?? 0;

  const totalP = percentileRank(data.totalScore, totalsAsc);
  const adP = percentileRank(adScore, adAsc);
  const recP = percentileRank(recScore, recAsc);

  const sbvRatio = data.adChannels.find(item => item.label === "SBV")?.ratio ?? 0;
  const sbRatio = data.adChannels.find(item => item.label === "SB(常规)")?.ratio ?? 0;

  const pullGrade = scaleFromPercentile(totalP);
  const naturalGrade = gradeNatural(nfScore, nfRatio, totalP);
  const adPlayGrade = gradeAdPlay(adScore, adP, ad.effectiveCount, ad.maxRatio);
  const recommendGrade = gradeRecommend(recScore, recP, effectiveRec, maxRecRatio);
  const variantGrade = gradeVariant(children.top1Share, children.effectiveChildren, children.childCount);
  const health = healthOf({
    nfRatio,
    adRatio,
    top1: children.top1Share,
    effectiveChildren: children.effectiveChildren,
    childCount: children.childCount,
    maxAdRatio: ad.maxRatio,
    maxRecRatio,
    totalP,
  });
  const types = pickTypeLabels({
    totalP,
    nfRatio,
    adRatio,
    maxAdLabel: ad.maxLabel,
    maxAdRatio: ad.maxRatio,
    sbvRatio,
    sbRatio,
    top1: children.top1Share,
    effectiveChildren: children.effectiveChildren,
    childCount: children.childCount,
  });

  const channelText = ad.sorted
    .filter(item => item.ratio >= 5)
    .map(item => `${item.label} ${item.ratio.toFixed(1)}%`)
    .join(" · ") || "无有效广告渠道";

  return {
    asin: product.asin,
    brand: product.brand,
    totalScore: data.totalScore,
    naturalScore: nfScore,
    naturalRatio: nfRatio,
    adScore,
    adRatio,
    naturalAdLabel: `${formatScore(nfScore)} / ${formatScore(adScore)}（${nfRatio.toFixed(1)}% / ${adRatio.toFixed(1)}%）`,
    pullGrade,
    naturalGrade,
    adPlayGrade,
    recommendGrade,
    variantGrade,
    health: health.health,
    typeLabel: types.primary,
    typeSubLabel: types.secondary,
    adPlaySummary: `以 ${ad.maxLabel} 为主（占广告 ${ad.maxRatio.toFixed(1)}%），有效渠道 ${ad.effectiveCount} 个：${channelText}；整体属${adIntensityLabel(adRatio)}。`,
    variantSummary: `TOP1 ${children.top1Share.toFixed(1)}%，TOP3 ${children.top3Share.toFixed(1)}%，有效子体 ${children.effectiveChildren}/${children.childCount}，属${variantStructureLabel(children.top1Share)}。`,
    strengths: [
      `总流量 ${formatScore(data.totalScore)}（同组分位约 P${Math.round(totalP * 100)}）`,
      `自然 ${formatScore(nfScore)} / ${nfRatio.toFixed(1)}%（${naturalStructureLabel(nfRatio)}）`,
    ].join("；") + "。",
    risks: health.triggers.slice(0, 3).join("；") + (health.triggers.length ? "。" : "未见突出单点风险。"),
    copyable: [
      types.primary === "成熟复合型" || children.effectiveChildren >= 4
        ? "主推色建立自然沉淀后，再向 2～3 个辅助色分流广告"
        : "避免只堆单色广告，先验证辅助子体是否能承接自然流量",
      sbvRatio >= 10
        ? "可参考视频广告作为增量入口，但需同步监控单爆款依赖"
        : "SP 常规 + SP 推荐双通道维护，控制广告占比不过半",
      effectiveRec >= 3
        ? "维持多推荐专栏曝光，避免单一推荐入口占比过高"
        : "补齐推荐专栏覆盖，提高关联推荐入口广度",
    ].join("；") + "。",
    confidence: data.children.length && data.adChannels.length ? "高" : "中",
    confidenceReason: "同站 US、近30天 Listing 口径、父子结构齐全；缺 CTR/CVR/ACOS，不作效率判断。",
    top1Share: children.top1Share,
    top3Share: children.top3Share,
    effectiveChildren: children.effectiveChildren,
    childCount: children.childCount,
    recommendScore: recScore,
    maxAdChannel: ad.maxLabel,
    maxAdChannelRatio: ad.maxRatio,
    effectiveAdChannels: ad.effectiveCount,
  };
}

function pickLeader(
  rows: TrafficCompetitorConclusion[],
  scoreFn: (row: TrafficCompetitorConclusion) => number,
) {
  return [...rows].sort((a, b) => scoreFn(b) - scoreFn(a))[0];
}

export function buildTrafficAnalysisConclusion(products: ProductLike[]): TrafficAnalysisConclusion {
  const available = products
    .map(product => {
      const data = sifListingTrafficOverview[product.asin];
      return data ? { product, data } : null;
    })
    .filter((item): item is { product: ProductLike; data: SifListingTrafficOverview } => Boolean(item));

  const totalsAsc = available.map(item => item.data.totalScore).sort((a, b) => a - b);
  const adAsc = available.map(item => itemScore(item.data.naturalAd, "广告流量")).sort((a, b) => a - b);
  const recAsc = available.map(item => recommendTotal(item.data.recommendationSources)).sort((a, b) => a - b);

  const overview = available
    .map(({ product, data }) => buildOne(product, data, totalsAsc, adAsc, recAsc))
    .sort((a, b) => b.totalScore - a.totalScore);

  if (!overview.length) {
    return {
      title: "竞品流量推广能力结论",
      headline: "当前对比 ASIN 暂无 SIF 流量结构数据，无法形成推广能力结论。",
      corePoints: [],
      overview: [],
      implications: ["请先同步 SIF「查流量结构」父/子体数据后再分析。"],
      dataBoundary: "当前结论反映竞品获取和运营流量的能力，不等同于广告转化效率或盈利能力；需结合 CTR、CVR、ACOS、CPC、订单、销售额与利润数据进一步验证。",
      methodNote: sifListingTrafficMeta.emptyMessage,
      updatedThrough: sifListingTrafficMeta.updatedThrough,
    };
  }

  const bestOverall = pickLeader(overview, row => {
    const map: Record<TrafficGrade, number> = { 强: 5, 中强: 4, 中: 3, 中弱: 2, 弱: 1 };
    return map[row.pullGrade] * 0.3
      + map[row.naturalGrade] * 0.25
      + map[row.adPlayGrade] * 0.15
      + map[row.recommendGrade] * 0.15
      + map[row.variantGrade] * 0.15;
  });
  const bestPaid = pickLeader(overview, row => row.adScore * 0.55 + row.adRatio * 800);
  const bestNatural = pickLeader(overview, row => row.naturalScore * 0.7 + row.naturalRatio * 600);
  const bestVariant = pickLeader(overview, row => {
    const map: Record<TrafficGrade, number> = { 强: 5, 中强: 4, 中: 3, 中弱: 2, 弱: 1 };
    return map[row.variantGrade] * 10 + row.effectiveChildren - row.top1Share / 20;
  });
  const highestRisk = pickLeader(overview, row => {
    let score = 0;
    if (row.health === "风险较高") score += 50;
    if (row.health === "需观察") score += 20;
    if (row.top1Share >= 90) score += 40;
    else if (row.top1Share >= 80) score += 25;
    if (row.adRatio > 50) score += 20;
    if (row.maxAdChannelRatio >= 80) score += 15;
    if (row.childCount >= 8 && row.effectiveChildren <= 2) score += 15;
    return score;
  });

  return {
    title: "竞品流量推广能力结论",
    headline: `${bestOverall.brand} 综合流量运营最强；${bestPaid.brand} 付费拉量更激进；${highestRisk.brand} 单爆款/广告依赖风险最突出。`,
    corePoints: [
      `综合流量运营能力最强：${bestOverall.brand}，总流量 ${formatScore(bestOverall.totalScore)}，自然 ${formatScore(bestOverall.naturalScore)}（${bestOverall.naturalRatio.toFixed(1)}%），有效子体 ${bestOverall.effectiveChildren} 个。`,
      `付费拉量最激进：${bestPaid.brand}，广告 ${formatScore(bestPaid.adScore)} / ${bestPaid.adRatio.toFixed(1)}%，主渠道 ${bestPaid.maxAdChannel} ${bestPaid.maxAdChannelRatio.toFixed(1)}%。`,
      `自然沉淀最好：${bestNatural.brand}，自然流量 ${formatScore(bestNatural.naturalScore)}（${bestNatural.naturalRatio.toFixed(1)}%）。`,
      `变体矩阵最好：${bestVariant.brand}，TOP1 ${bestVariant.top1Share.toFixed(1)}%，有效子体 ${bestVariant.effectiveChildren}/${bestVariant.childCount}。`,
      `风险最高：${highestRisk.brand}，${highestRisk.risks}`,
    ],
    overview,
    implications: [
      "值得复制：头部竞品的「主力色自然沉淀 + 辅助色分流」与 SP 常规/推荐双通道，而不是只堆单一广告入口。",
      "不宜照搬：极端单爆款（TOP1≥90%）叠加广告占比过半的打法，父体抗波动能力弱。",
      "主推/辅助分配：先确保主推子体自然占比稳定在较高水平，再把 20%～35% 广告预算试投次主力色；有效子体目标至少 3 个。",
      "渠道组合：默认 SP 常规为主、SP 推荐为辅；仅在有素材与品牌入口时再加 SB/SBV，且 SBV 需防单色吸量。",
      "下一步补充：CTR、CVR、ACOS/TACOS、广告订单与利润，才能判断推广效率与是否可加投。",
    ],
    dataBoundary: "当前结论反映竞品获取和运营流量的能力，不等同于广告转化效率或盈利能力；需结合 CTR、CVR、ACOS、CPC、订单、销售额与利润数据进一步验证。",
    methodNote: `口径：SIF Listing 聚合 · ${sifListingTrafficMeta.period} · 更新至 ${sifListingTrafficMeta.updatedThrough} · 有效子体=父体内流量占比≥5% · 广告渠道占比分母为广告总流量。`,
    updatedThrough: sifListingTrafficMeta.updatedThrough,
  };
}
