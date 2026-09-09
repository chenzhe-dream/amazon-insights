import { sifListingTrafficRawByAsin, sifListingTrafficRawMeta } from "./sif-listing-traffic-raw-data";
import type { TrafficSnapshotReadResponse } from "../shared/agent-contracts";
import type { SifMonthlyTrafficSeries } from "./sif-monthly-traffic-trend-data";
import { sameTrafficDetailScope, mergeTrafficRecord, missingTrafficDetails, type TrafficDetailScope, type TrafficDetailAvailability } from "./lib/traffic-detail-view";

export type TrafficDistributionItem = {
  label: string;
  score: number;
  ratio: number;
};

export type TrafficDisplayItem = {
  label: string;
  score: number | null;
  ratio: number | null;
};

export type ChildTrafficVariant = {
  asin: string;
  label: string;
  image: string;
  totalScore: number;
  sharePct: number;
  organic: number;
  sp: number;
  spRecommend: number;
  sb: number;
  sbv: number;
};

export type SifListingTrafficOverview = {
  totalScore: number;
  naturalAd: TrafficDistributionItem[];
  adChannels: TrafficDistributionItem[];
  recommendationSources: TrafficDistributionItem[];
  children: ChildTrafficVariant[];
  updatedThrough: string | null;
  childCount?: number;
};

export type TrafficDisplayOverview = Omit<SifListingTrafficOverview, "totalScore" | "naturalAd"> & {
  totalScore: number | null;
  naturalAd: TrafficDisplayItem[];
};

function pct(ratio: number) {
  return Math.round(ratio * 1000) / 10;
}

function score(value: number) {
  return Math.round(value);
}

function extractAsin(val: string) {
  const match = val.match(/B0[A-Z0-9]{8}/i);
  return match ? match[0].toUpperCase() : val;
}

type RawOverview = {
  overview: { nf: { score: number; ratio: number }; ad: { score: number; ratio: number } };
  ad: Record<string, { name: string; score: number; ratio: number } | undefined>;
  recommend: Record<string, { name: string; score: number; ratio: number }>;
  total: number;
  data_notice: string;
};

type RawStructure = {
  chars: {
    dims: Array<{ img: string; features: string[]; sumScore: number; ratio: number; val: string }>;
    nfs: Array<{ score: number }>;
    sps: Array<{ score: number }>;
    recs: Array<{ score: number }>;
    sbs: Array<{ score: number }>;
    sbvs: Array<{ score: number }>;
  };
  data_notice: string;
};

const adChannelOrder = ["sp", "recommend", "sb", "sbv"] as const;
const adChannelFallback: Record<string, string> = {
  sp: "SP(常规)",
  recommend: "SP(推荐)",
  sb: "SB(常规)",
  sbv: "SBV",
};

function parseUpdatedThrough(notice: string) {
  const match = notice.match(/(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? null;
}

function buildOverview(raw: RawOverview, structure: RawStructure): SifListingTrafficOverview {
  const naturalAd: TrafficDistributionItem[] = [
    { label: "自然流量", score: score(raw.overview.nf.score), ratio: pct(raw.overview.nf.ratio) },
    { label: "广告流量", score: score(raw.overview.ad.score), ratio: pct(raw.overview.ad.ratio) },
  ];

  const adChannels = adChannelOrder
    .map(key => raw.ad[key])
    .filter((item): item is { name: string; score: number; ratio: number } => Boolean(item && item.score > 0))
    .map(item => ({
      label: item.name || adChannelFallback[item.name] || item.name,
      score: score(item.score),
      ratio: pct(item.ratio),
    }));

  // Prefer canonical labels when API name is present
  const labeledChannels = adChannelOrder
    .map(key => {
      const item = raw.ad[key];
      if (!item || item.score <= 0) return null;
      return { label: adChannelFallback[key], score: score(item.score), ratio: pct(item.ratio) };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  const recommendationSources = Object.values(raw.recommend)
    .filter(item => item.score > 0 && item.ratio >= 0.01)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map(item => ({ label: item.name, score: score(item.score), ratio: pct(item.ratio) }));

  const { dims, nfs, sps, recs, sbs, sbvs } = structure.chars;
  const children: ChildTrafficVariant[] = dims.map((dim, index) => ({
    asin: extractAsin(dim.val),
    label: dim.features.filter(Boolean).join(" / ") || "默认",
    image: dim.img,
    totalScore: score(dim.sumScore),
    sharePct: pct(dim.ratio),
    organic: score(nfs[index]?.score ?? 0),
    sp: score(sps[index]?.score ?? 0),
    spRecommend: score(recs[index]?.score ?? 0),
    sb: score(sbs[index]?.score ?? 0),
    sbv: score(sbvs[index]?.score ?? 0),
  }));

  return {
    totalScore: score(raw.total),
    naturalAd,
    adChannels: labeledChannels.length ? labeledChannels : adChannels,
    recommendationSources,
    children,
    updatedThrough: parseUpdatedThrough(raw.data_notice),
  };
}

const rawByAsin = sifListingTrafficRawByAsin as Record<string, { overview: RawOverview; structure: RawStructure }>;

export const sifListingTrafficOverview: Record<string, SifListingTrafficOverview | null> = Object.fromEntries(
  Object.entries(rawByAsin).map(([asin, payload]) => [asin, buildOverview(payload.overview, payload.structure)]),
);

export const sifListingTrafficMeta = {
  source: sifListingTrafficRawMeta.source,
  period: sifListingTrafficRawMeta.period,
  country: sifListingTrafficRawMeta.country,
  updatedThrough: sifListingTrafficRawMeta.updatedThrough,
  status: "ready" as const,
  emptyMessage: "SIF 当前未返回可核验数据",
};

export const childTrafficSegmentMeta = [
  { key: "organic" as const, label: "自然流量", color: "#19b66a" },
  { key: "sp" as const, label: "SP(常规)", color: "#ff7a2d" },
  { key: "spRecommend" as const, label: "SP(推荐)", color: "#f69b20" },
  { key: "sb" as const, label: "SB(常规)", color: "#f2bc24" },
  { key: "sbv" as const, label: "SBV", color: "#c9c23a" },
];

export type TrafficDisplayData = {
  overview: Record<string, TrafficDisplayOverview | null>;
  monthlyTrend: Record<string, SifMonthlyTrafficSeries>;
  meta: { source: string; period: string; country: string; updatedThrough: string | null; status: "ready"; emptyMessage: string };
  detailAvailability?: Record<string, TrafficDetailAvailability>;
};

export type ScopedTrafficDetail = Readonly<{
  scope: TrafficDetailScope;
  overview: Partial<TrafficDisplayOverview>;
}>;

export function trafficDisplayFromSnapshot(
  snapshot: TrafficSnapshotReadResponse,
  detailInput?: Readonly<{
    expectedScopeByAsin: Readonly<Record<string, TrafficDetailScope>>;
    candidateByAsin: Readonly<Record<string, ScopedTrafficDetail | undefined>>;
  }>,
): TrafficDisplayData {
  const overview: TrafficDisplayData["overview"] = {};
  const monthlyTrend: TrafficDisplayData["monthlyTrend"] = {};
  const detailAvailability: NonNullable<TrafficDisplayData["detailAvailability"]> = {};
  for (const item of snapshot.traffic.competitors) {
    const expected = detailInput?.expectedScopeByAsin[item.asin];
    const candidate = detailInput?.candidateByAsin[item.asin];
    const accepted = expected && candidate && expected.asin === item.asin && expected.marketplace === snapshot.marketplace
      && sameTrafficDetailScope(expected, candidate.scope) ? mergeTrafficRecord(candidate.overview) : null;
    const trusted = accepted?.overview;
    detailAvailability[item.asin] = accepted?.availability ?? (candidate
      ? { adChannels: "invalid", recommendationSources: "invalid", children: "invalid" } : missingTrafficDetails());
    overview[item.asin] = {
      totalScore: item.trafficVolume,
      naturalAd: [
        { label: "自然流量", score: item.naturalVolume, ratio: item.naturalShare },
        { label: "广告流量", score: item.advertisingVolume, ratio: item.advertisingShare },
      ],
      adChannels: trusted?.adChannels ?? [],
      recommendationSources: trusted?.recommendationSources ?? [],
      children: trusted?.children ?? [],
      childCount: item.childCount,
      updatedThrough: trusted ? trusted.updatedThrough : snapshot.collectedAt.slice(0, 10),
    };
    monthlyTrend[item.asin] = {
      asin: item.asin,
      points: item.monthlyTrend.map((point) => ({
        month: point.month,
        label: `${Number(point.month.slice(5, 7))}月`,
        natural: point.natural,
        ad: point.advertising,
        total: point.total,
      })),
    };
  }
  return {
    overview,
    monthlyTrend,
    detailAvailability,
    meta: {
      source: "SIF PostgreSQL dynamic snapshot",
      period: "当前 run 快照",
      country: snapshot.marketplace,
      updatedThrough: snapshot.collectedAt.slice(0, 10),
      status: "ready",
      emptyMessage: "SIF 当前 run 尚无可核验动态流量快照",
    },
  };
}

/** SIF 查流量结构 · 广告渠道字段释义（MCP wholeName + SIF 文档口径） */
export const sifAdChannelGlossary: Record<string, { en: string; meaning: string }> = {
  "SP(常规)": {
    en: "Sponsored Product",
    meaning: "来自 SP 常规广告位的商品推广流量（搜索结果/商品页等常规 SP 曝光）",
  },
  "SP(推荐)": {
    en: "Sponsored Recommend",
    meaning: "来自 SP 推荐广告位的流量（推荐场景下的 Sponsored Product 曝光）",
  },
  "SB(常规)": {
    en: "Sponsored Brand",
    meaning: "来自 SB 品牌广告的流量（品牌旗舰店头图等品牌推广曝光）",
  },
  SBV: {
    en: "Sponsored Brand Video",
    meaning: "来自 SBV 品牌视频广告的流量",
  },
};

export const sifAdChannelGlossaryList = [
  { label: "SP(常规)", ...sifAdChannelGlossary["SP(常规)"] },
  { label: "SP(推荐)", ...sifAdChannelGlossary["SP(推荐)"] },
  { label: "SB(常规)", ...sifAdChannelGlossary["SB(常规)"] },
  { label: "SBV", ...sifAdChannelGlossary.SBV },
];

export function childTrafficSegments(child: ChildTrafficVariant): SegmentLike[] {
  return childTrafficSegmentMeta
    .map(meta => ({ label: meta.label, value: child[meta.key], color: meta.color }))
    .filter(part => part.value > 0);
}

type SegmentLike = { label: string; value: number; color: string };
