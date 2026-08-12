export type TrafficDistributionItem = {
  label: string;
  score: number;
  ratio: number;
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
    .filter((item): item is TrafficDistributionItem => Boolean(item));

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

/** Raw SIF MCP payloads · US · latelyDay 30 · updated through 2026-08-09 */
const rawByAsin: Record<string, { overview: RawOverview; structure: RawStructure }> = {
  B07VY9Q95Q: {
    overview: {
      overview: {
        ad: { score: 72690.50113225, ratio: 0.29323009 },
        nf: { score: 175205.27537287, ratio: 0.70676991 },
      },
      ad: {
        sp: { name: "SP(常规)", score: 46508.96079716, ratio: 0.63982171 },
        recommend: { name: "SP(推荐)", score: 24445.7335073, ratio: 0.33629887 },
        sb: { name: "SB(常规)", score: 49.38780102, ratio: 0.00067943 },
        sbv: { name: "SBV", score: 1686.41902677, ratio: 0.02319999 },
      },
      recommend: {
        "Recently bought and rated": { name: "Recently bought and rated", score: 8481.99558906, ratio: 0.34697243 },
        "Customers frequently viewed": { name: "Customers frequently viewed", score: 10143.81345311, ratio: 0.4149523 },
        "Picks from Amazon Influencers": { name: "Picks from Amazon Influencers", score: 908.10565546, ratio: 0.03714782 },
        "Seen on social media": { name: "Seen on social media", score: 2169.59762569, ratio: 0.08875159 },
        "Trending now": { name: "Trending now", score: 2393.27195933, ratio: 0.09790142 },
        "4 stars and above": { name: "4 stars and above", score: 346.41199718, ratio: 0.01417065 },
      },
      total: 247895.77650511873,
      data_notice: "Data updated through 2026-08-09 (refreshes daily, 1-day delay)",
    },
    structure: {
      chars: {
        dims: [
          { img: "https://m.media-amazon.com/images/I/81sHDISn2bL._AC_UL320_.jpg", features: ["Pink"], sumScore: 122401.13017331, ratio: 0.49376045, val: "B07VY9Q95Q" },
          { img: "https://m.media-amazon.com/images/I/812Gd2MqI2L._AC_UL320_.jpg", features: ["Blue"], sumScore: 46899.56605932, ratio: 0.18919066, val: "B07VXB5ZMN" },
          { img: "https://m.media-amazon.com/images/I/81PF+16KPDL._AC_UL320_.jpg", features: ["Purple"], sumScore: 25514.73893718, ratio: 0.10292527, val: "B088TY63YB" },
          { img: "https://m.media-amazon.com/images/I/71fPQOpbFnL._AC_UL320_.jpg", features: ["Camouflage"], sumScore: 15400.6463242, ratio: 0.06212549, val: "B08BDG1V5R" },
          { img: "https://m.media-amazon.com/images/I/813-oqzKWfL._AC_UL320_.jpg", features: ["Red"], sumScore: 12697.70662392, ratio: 0.05122196, val: "B088VKFJ8P" },
          { img: "https://m.media-amazon.com/images/I/61gRY5D8UDL._AC_UL320_.jpg", features: ["Watermelon"], sumScore: 8718.41322582, ratio: 0.03516967, val: "B0924N78N7" },
          { img: "https://m.media-amazon.com/images/I/810mKamb0-L._AC_UL320_.jpg", features: ["Yellow"], sumScore: 6065.8912432, ratio: 0.02446952, val: "B088VHD4KH" },
          { img: "https://m.media-amazon.com/images/I/81EoCDQ23JS._AC_UL320_.jpg", features: ["Teal"], sumScore: 4106.15919968, ratio: 0.01656405, val: "B0924QGCDW" },
          { img: "https://m.media-amazon.com/images/I/71I7mZ+wqyL._AC_UL320_.jpg", features: ["Black"], sumScore: 2876.73441823, ratio: 0.01160461, val: "B097F8F88B" },
          { img: "https://m.media-amazon.com/images/I/81lBU+M2LyL._AC_UL320_.jpg", features: ["Green"], sumScore: 2850.56961574, ratio: 0.01149906, val: "B088VF6C17" },
          { img: "https://m.media-amazon.com/images/I/71ZGBqfXEZL._AC_UL320_.jpg", features: ["Real Tree"], sumScore: 364.22068453, ratio: 0.00146925, val: "B0924NDPKV" },
        ],
        nfs: [
          { score: 107896.02704503 }, { score: 34345.19946534 }, { score: 13964.73212241 }, { score: 687.12959768 },
          { score: 8443.52114419 }, { score: 2983.23924003 }, { score: 475.93752597 }, { score: 1291.92300683 },
          { score: 2816.16934984 }, { score: 2173.82651061 }, { score: 127.57036494 },
        ],
        sps: [
          { score: 11682.66714271 }, { score: 5733.97363858 }, { score: 8421.76032914 }, { score: 8100.66733518 },
          { score: 1980.4756453 }, { score: 4775.039082 }, { score: 3646.74772704 }, { score: 1504.45538364 },
          { score: 11.24883711 }, { score: 561.92333659 }, { score: 90.00233988 },
        ],
        recs: [
          { score: 2690.61201431 }, { score: 6068.8171559 }, { score: 2892.58857067 }, { score: 6596.38679101 },
          { score: 1813.0612493 }, { score: 823.452668 }, { score: 1943.2059902 }, { score: 1309.78080921 },
          { score: 46.36051046 }, { score: 114.81976854 }, { score: 146.64797971 },
        ],
        sbs: [
          { score: 0 }, { score: 16.46260034 }, { score: 0 }, { score: 16.46260034 }, { score: 16.46260034 },
          { score: 0 }, { score: 0 }, { score: 0 }, { score: 0 }, { score: 0 }, { score: 0 },
        ],
        sbvs: [
          { score: 131.82397125 }, { score: 735.11319916 }, { score: 235.65791496 }, { score: 0 },
          { score: 444.18598479 }, { score: 136.68223578 }, { score: 0 }, { score: 0 },
          { score: 2.95572083 }, { score: 0 }, { score: 0 },
        ],
      },
      data_notice: "Data updated through 2026-08-09 (refreshes daily, 1-day delay)",
    },
  },
  B0BPXRVWYK: {
    overview: {
      overview: {
        ad: { score: 67976.90950048, ratio: 0.36979967 },
        nf: { score: 115843.99214759, ratio: 0.63020033 },
      },
      ad: {
        sp: { name: "SP(常规)", score: 19147.49044704, ratio: 0.28167639 },
        recommend: { name: "SP(推荐)", score: 7253.71065108, ratio: 0.10670845 },
        sbv: { name: "SBV", score: 41575.70840236, ratio: 0.61161516 },
      },
      recommend: {
        "Recently bought and rated": { name: "Recently bought and rated", score: 1248.36641308, ratio: 0.17210039 },
        "Customers frequently viewed": { name: "Customers frequently viewed", score: 4975.85087428, ratio: 0.68597317 },
        "Picks from Amazon Influencers": { name: "Picks from Amazon Influencers", score: 102.37692972, ratio: 0.01411373 },
        "Seen on social media": { name: "Seen on social media", score: 415.24447748, ratio: 0.0572458 },
        "Trending now": { name: "Trending now", score: 479.13099107, ratio: 0.06605323 },
      },
      total: 183820.901648071,
      data_notice: "Data updated through 2026-08-09 (refreshes daily, 1-day delay)",
    },
    structure: {
      chars: {
        dims: [
          { img: "https://m.media-amazon.com/images/I/712PF4pUZ9L._AC_UL320_.jpg", features: ["Blue"], sumScore: 165310.27520456, ratio: 0.89930075, val: "B0BPXRVWYK" },
          { img: "https://m.media-amazon.com/images/I/71o902vAxLL._AC_UL320_.jpg", features: ["Green"], sumScore: 14878.03803486, ratio: 0.08093768, val: "B08BFFLN5B" },
          { img: "https://m.media-amazon.com/images/I/7125I3CjgNL._AC_UL320_.jpg", features: ["Dark Blue"], sumScore: 1549.73792182, ratio: 0.00843069, val: "B0DDC8NHY7" },
          { img: "https://m.media-amazon.com/images/I/71-3zUHsXYL._AC_UL320_.jpg", features: ["Pink"], sumScore: 1394.86139415, ratio: 0.00758815, val: "B08BFDQ1CL" },
          { img: "https://m.media-amazon.com/images/I/71os3qljxjL._AC_UL320_.jpg", features: ["Black"], sumScore: 293.45409575, ratio: 0.00159641, val: "B0BPXR6G2Q" },
          { img: "https://m.media-amazon.com/images/I/61QBm-nYlHL._AC_UL320_.jpg", features: ["Yellow"], sumScore: 211.78532228, ratio: 0.00115213, val: "B0DKJJL2NR" },
          { img: "https://m.media-amazon.com/images/I/61a+AsiUwdL._AC_UL320_.jpg", features: ["Light Pink"], sumScore: 81.98678667, ratio: 0.00044601, val: "B0BPXQG2N4" },
          { img: "https://m.media-amazon.com/images/I/71+UM4tIRsL._AC_UL320_.jpg", features: ["Light Blue"], sumScore: 56.19395035, ratio: 0.0003057, val: "B0C5QQPNTD" },
          { img: "https://m.media-amazon.com/images/I/71eQY0NqsPL._AC_UL320_.jpg", features: ["Light Green"], sumScore: 22.17321564, ratio: 0.00012062, val: "B0DDC8DRWW" },
          { img: "https://m.media-amazon.com/images/I/61M0wLCeabL._AC_UL320_.jpg", features: ["Dark Green"], sumScore: 16.01717339, ratio: 0.00008713, val: "B0DKJFCFHB" },
          { img: "https://m.media-amazon.com/images/I/61o8UFzvXRL._AC_UL320_.jpg", features: ["Red"], sumScore: 6.3785486, ratio: 0.0000347, val: "B0DKJ4N5NY" },
        ],
        nfs: [
          { score: 102280.0136276 }, { score: 9931.39011133 }, { score: 1549.73792182 }, { score: 1394.86139415 },
          { score: 293.45409575 }, { score: 211.78532228 }, { score: 81.98678667 }, { score: 56.19395035 },
          { score: 22.17321564 }, { score: 16.01717339 }, { score: 6.3785486 },
        ],
        sps: [
          { score: 19146.47935061 }, { score: 1.01109643 }, { score: 0 }, { score: 0 }, { score: 0 },
          { score: 0 }, { score: 0 }, { score: 0 }, { score: 0 }, { score: 0 }, { score: 0 },
        ],
        recs: [
          { score: 7245.91707471 }, { score: 7.79357637 }, { score: 0 }, { score: 0 }, { score: 0 },
          { score: 0 }, { score: 0 }, { score: 0 }, { score: 0 }, { score: 0 }, { score: 0 },
        ],
        sbs: [
          { score: 0 }, { score: 0 }, { score: 0 }, { score: 0 }, { score: 0 },
          { score: 0 }, { score: 0 }, { score: 0 }, { score: 0 }, { score: 0 }, { score: 0 },
        ],
        sbvs: [
          { score: 36637.86515163 }, { score: 4937.84325072 }, { score: 0 }, { score: 0 }, { score: 0 },
          { score: 0 }, { score: 0 }, { score: 0 }, { score: 0 }, { score: 0 }, { score: 0 },
        ],
      },
      data_notice: "Data updated through 2026-08-09 (refreshes daily, 1-day delay)",
    },
  },
  B07DYG1C9B: {
    overview: {
      overview: {
        ad: { score: 37634.491149, ratio: 0.3390177 },
        nf: { score: 73375.9093675, ratio: 0.6609823 },
      },
      ad: {
        sp: { name: "SP(常规)", score: 32320.20567247, ratio: 0.85879215 },
        recommend: { name: "SP(推荐)", score: 5314.28547653, ratio: 0.14120785 },
      },
      recommend: {
        "Recently bought and rated": { name: "Recently bought and rated", score: 2558.5984549, ratio: 0.48145672 },
        "Customers frequently viewed": { name: "Customers frequently viewed", score: 2219.14751588, ratio: 0.41758154 },
        "Seen on social media": { name: "Seen on social media", score: 99.12744168, ratio: 0.01865301 },
        "Trending now": { name: "Trending now", score: 132.06689143, ratio: 0.0248513 },
        "4 stars and above": { name: "4 stars and above", score: 229.13789717, ratio: 0.04311735 },
      },
      total: 111010.400516506,
      data_notice: "Data updated through 2026-08-09 (refreshes daily, 1-day delay)",
    },
    structure: {
      chars: {
        dims: [
          { img: "https://m.media-amazon.com/images/I/61xgPsdbh9L._AC_UL320_.jpg", features: ["Purple"], sumScore: 35042.5672753, ratio: 0.31566923, val: "B07DYG1C9B" },
          { img: "https://m.media-amazon.com/images/I/61VN3vrfexL._AC_UL320_.jpg", features: ["Green"], sumScore: 25566.27759862, ratio: 0.23030525, val: "B0CBPNSRNJ" },
          { img: "https://m.media-amazon.com/images/I/61OaPsp9DYL._AC_UL320_.jpg", features: ["All Black"], sumScore: 25506.78413198, ratio: 0.22976932, val: "B0CWPCQCT2" },
          { img: "https://m.media-amazon.com/images/I/61wrMcfgWXL._AC_UL320_.jpg", features: ["Rose Red"], sumScore: 5853.8486376, ratio: 0.05273243, val: "B0B3MJFRT1" },
          { img: "https://m.media-amazon.com/images/I/51eISRIO7VL._AC_UL320_.jpg", features: ["Lake Blue"], sumScore: 3964.16197924, ratio: 0.03570983, val: "B0B3MKSH1B" },
          { img: "https://m.media-amazon.com/images/I/71CzDgu1o4L._AC_UL320_.jpg", features: ["Beige"], sumScore: 3587.51389511, ratio: 0.03231692, val: "B0FL2BN1GJ" },
          { img: "https://m.media-amazon.com/images/I/6133eGrbHHL._AC_UL320_.jpg", features: ["Red"], sumScore: 2954.42317516, ratio: 0.02661393, val: "B0D9473YYH" },
          { img: "https://m.media-amazon.com/images/I/61wZiSIQdTL._AC_UL320_.jpg", features: ["Pink"], sumScore: 1903.32364335, ratio: 0.01714545, val: "B07FDYHJVM" },
          { img: "https://m.media-amazon.com/images/I/61DZ9XZrIxL._AC_UL320_.jpg", features: ["Black"], sumScore: 1524.15800324, ratio: 0.01372987, val: "B07YBFC2MH" },
          { img: "https://m.media-amazon.com/images/I/61ilOxUeeuL._AC_UL320_.jpg", features: ["Orange"], sumScore: 1347.95870755, ratio: 0.01214263, val: "B0DD7JQNNJ" },
          { img: "https://m.media-amazon.com/images/I/61COHxmNaNL._AC_UL320_.jpg", features: ["Blue"], sumScore: 1223.48577605, ratio: 0.01102136, val: "B07DYL3ZX7" },
          { img: "https://m.media-amazon.com/images/I/61U4eVQF0uL._AC_UL320_.jpg", features: ["Mineral Blue"], sumScore: 1187.49517248, ratio: 0.01069715, val: "B0D1DFKPVK" },
          { img: "https://m.media-amazon.com/images/I/61i8gh50ADL._AC_UL320_.jpg", features: ["Grape"], sumScore: 1052.77067184, ratio: 0.00948353, val: "B0CWPDQ82W" },
          { img: "https://m.media-amazon.com/images/I/61b7RWdLjuL._AC_UL320_.jpg", features: ["Rose Pink"], sumScore: 147.29626128, ratio: 0.00132687, val: "B0DD7KQ24D" },
          { img: "https://m.media-amazon.com/images/I/61CJGCTheyL._AC_UL320_.jpg", features: ["Yellow"], sumScore: 94.30728723, ratio: 0.00084954, val: "B07X1Q7J2S" },
          { img: "https://m.media-amazon.com/images/I/61ynCy9LQqL._AC_UL320_.jpg", features: ["Grey"], sumScore: 41.45598307, ratio: 0.00037344, val: "B0FL2B91HG" },
          { img: "https://m.media-amazon.com/images/I/61FtHjsCIxL._AC_UL320_.jpg", features: ["ALL BLUE"], sumScore: 12.5723174, ratio: 0.00011325, val: "B0D946QJGP" },
        ],
        nfs: [
          { score: 26795.67878506 }, { score: 16211.77537 }, { score: 19472.3944214 }, { score: 953.99360638 },
          { score: 164.46039994 }, { score: 3587.51389511 }, { score: 889.21233984 }, { score: 1620.64835366 },
          { score: 717.09423775 }, { score: 692.62101014 }, { score: 1148.34201116 }, { score: 246.14860114 },
          { score: 580.39448694 }, { score: 147.29626128 }, { score: 94.30728723 }, { score: 41.45598307 }, { score: 12.5723174 },
        ],
        sps: [
          { score: 7449.51907347 }, { score: 8092.29751107 }, { score: 5000.59160501 }, { score: 4658.32585722 },
          { score: 2384.91121058 }, { score: 0 }, { score: 2046.4324678 }, { score: 241.81528683 },
          { score: 449.03402769 }, { score: 652.3382536 }, { score: 6.14648673 }, { score: 873.51929544 },
          { score: 465.27459704 }, { score: 0 }, { score: 0 }, { score: 0 }, { score: 0 },
        ],
        recs: [
          { score: 797.36941676 }, { score: 1262.20471756 }, { score: 1033.79810557 }, { score: 241.529174 },
          { score: 1414.79036872 }, { score: 0 }, { score: 18.77836752 }, { score: 40.86000286 },
          { score: 358.0297378 }, { score: 2.99944381 }, { score: 68.99727816 }, { score: 67.82727591 },
          { score: 7.10158786 }, { score: 0 }, { score: 0 }, { score: 0 }, { score: 0 },
        ],
        sbs: Array.from({ length: 17 }, () => ({ score: 0 })),
        sbvs: Array.from({ length: 17 }, () => ({ score: 0 })),
      },
      data_notice: "Data updated through 2026-08-09 (refreshes daily, 1-day delay)",
    },
  },
  B07S64PYMM: {
    overview: {
      overview: {
        ad: { score: 11218.55600419, ratio: 0.31661715 },
        nf: { score: 24214.00338533, ratio: 0.68338285 },
      },
      ad: {
        sp: { name: "SP(常规)", score: 6143.74520651, ratio: 0.54764135 },
        recommend: { name: "SP(推荐)", score: 5074.81079769, ratio: 0.45235865 },
      },
      recommend: {
        "Recently bought and rated": { name: "Recently bought and rated", score: 1177.37431843, ratio: 0.23200359 },
        "Customers frequently viewed": { name: "Customers frequently viewed", score: 2875.00041198, ratio: 0.56652366 },
        "Picks from Amazon Influencers": { name: "Picks from Amazon Influencers", score: 105.42833678, ratio: 0.02077483 },
        "Seen on social media": { name: "Seen on social media", score: 662.0124979, ratio: 0.13045068 },
        "Trending now": { name: "Trending now", score: 141.92530657, ratio: 0.02796662 },
        "4 stars and above": { name: "4 stars and above", score: 111.87758249, ratio: 0.02204567 },
      },
      total: 35432.55938952336,
      data_notice: "Data updated through 2026-08-09 (refreshes daily, 1-day delay)",
    },
    structure: {
      chars: {
        dims: [
          { img: "https://m.media-amazon.com/images/I/61JxQyUrkGL._AC_UL320_.jpg", features: ["Black"], sumScore: 21306.79057179, ratio: 0.60133366, val: "B07S64PYMM" },
          { img: "https://m.media-amazon.com/images/I/61Z8swiOuqL._AC_UL320_.jpg", features: ["Rose Pink"], sumScore: 9511.3476226, ratio: 0.26843524, val: "B07C7F9JPN" },
          { img: "https://m.media-amazon.com/images/I/61m9nYV5GIL._AC_UL320_.jpg", features: ["Aqua Blue"], sumScore: 2788.08947147, ratio: 0.07868722, val: "B07CGP363T" },
          { img: "https://m.media-amazon.com/images/I/61LpfcxOtjL._AC_UL320_.jpg", features: ["Purple"], sumScore: 1267.86776639, ratio: 0.03578256, val: "B07FTZM449" },
          { img: "https://m.media-amazon.com/images/I/61wL3ocZu0L._AC_UL320_.jpg", features: ["Red"], sumScore: 558.46395727, ratio: 0.01576132, val: "B07C7RH2DQ" },
        ],
        nfs: [
          { score: 14340.79658138 }, { score: 7176.8052641 }, { score: 1664.55653502 },
          { score: 595.37397779 }, { score: 436.47102704 },
        ],
        sps: [
          { score: 3406.51098843 }, { score: 1355.89575543 }, { score: 892.97528018 },
          { score: 392.91176497 }, { score: 95.45141749 },
        ],
        recs: [
          { score: 3559.48300198 }, { score: 978.64660307 }, { score: 230.55765627 },
          { score: 279.58202363 }, { score: 26.54151274 },
        ],
        sbs: [{ score: 0 }, { score: 0 }, { score: 0 }, { score: 0 }, { score: 0 }],
        sbvs: [{ score: 0 }, { score: 0 }, { score: 0 }, { score: 0 }, { score: 0 }],
      },
      data_notice: "Data updated through 2026-08-09 (refreshes daily, 1-day delay)",
    },
  },
  B08HJ96QJ9: {
    overview: {
      overview: {
        ad: { score: 399.10811301, ratio: 0.11133303 },
        nf: { score: 3185.70499404, ratio: 0.88866697 },
      },
      ad: {
        sp: { name: "SP(常规)", score: 363.38861986, ratio: 0.91050171 },
        recommend: { name: "SP(推荐)", score: 35.71949315, ratio: 0.08949829 },
      },
      recommend: {
        "Recently bought and rated": { name: "Recently bought and rated", score: 18.61175439, ratio: 0.52105315 },
        "Picks from Amazon Influencers": { name: "Picks from Amazon Influencers", score: 4.04830622, ratio: 0.11333605 },
        "Seen on social media": { name: "Seen on social media", score: 7.4403856, ratio: 0.20830043 },
        "4 stars and above": { name: "4 stars and above", score: 5.45731079, ratio: 0.15278243 },
      },
      total: 3584.8131070499767,
      data_notice: "Data updated through 2026-08-09 (refreshes daily, 1-day delay)",
    },
    structure: {
      chars: {
        dims: [
          { img: "https://m.media-amazon.com/images/I/61QCXX5BbWL._AC_UL320_.jpg", features: [], sumScore: 3584.81310705, ratio: 1, val: "B08HJ96QJ9" },
        ],
        nfs: [{ score: 3185.70499404 }],
        sps: [{ score: 363.38861986 }],
        recs: [{ score: 35.71949315 }],
        sbs: [{ score: 0 }],
        sbvs: [{ score: 0 }],
      },
      data_notice: "Data updated through 2026-08-09 (refreshes daily, 1-day delay)",
    },
  },
  B08T8RY9VK: {
    overview: {
      overview: {
        ad: { score: 43137.22048721, ratio: 0.51210984 },
        nf: { score: 41097.09197779, ratio: 0.48789016 },
      },
      ad: {
        sp: { name: "SP(常规)", score: 18936.82680751, ratio: 0.43899043 },
        recommend: { name: "SP(推荐)", score: 3894.5790526, ratio: 0.0902835 },
        sb: { name: "SB(常规)", score: 13471.79463141, ratio: 0.31230094 },
        sbv: { name: "SBV", score: 6834.01999569, ratio: 0.15842514 },
      },
      recommend: {
        "Recently bought and rated": { name: "Recently bought and rated", score: 1118.32204703, ratio: 0.28714838 },
        "Customers frequently viewed": { name: "Customers frequently viewed", score: 1823.09409426, ratio: 0.46811069 },
        "Picks from Amazon Influencers": { name: "Picks from Amazon Influencers", score: 127.887525, ratio: 0.03283732 },
        "Seen on social media": { name: "Seen on social media", score: 405.76616823, ratio: 0.10418743 },
        "Today's deals": { name: "Today's deals", score: 42.45344953, ratio: 0.01090065 },
        "Trending now": { name: "Trending now", score: 329.0708725, ratio: 0.08449459 },
        "4 stars and above": { name: "4 stars and above", score: 47.98489606, ratio: 0.01232095 },
      },
      total: 84234.3124649987,
      data_notice: "Data updated through 2026-08-09 (refreshes daily, 1-day delay)",
    },
    structure: {
      chars: {
        dims: [
          { img: "https://m.media-amazon.com/images/I/51iDYJJ1JvL._AC_UL320_.jpg", features: ["Blue"], sumScore: 81951.12302774, ratio: 0.97289478, val: "B08T8RY9VK" },
          { img: "https://m.media-amazon.com/images/I/61Mdw4l9MNL._AC_UL320_.jpg", features: ["Green"], sumScore: 1035.37978378, ratio: 0.01229166, val: "B0BYMSKG3G" },
          { img: "https://m.media-amazon.com/images/I/61EnVTrmzqL._AC_UL320_.jpg", features: ["Red"], sumScore: 664.89985866, ratio: 0.00789346, val: "B08T8THMNM" },
          { img: "https://m.media-amazon.com/images/I/61sbXU-ECQL._AC_UL320_.jpg", features: ["Pink"], sumScore: 329.82663116, ratio: 0.00391559, val: "B0BYMSG6N3" },
          { img: "https://m.media-amazon.com/images/I/61+GK9P+3CL._AC_UL320_.jpg", features: ["Yellow"], sumScore: 247.84765689, ratio: 0.00294236, val: "B08DKCLPS7" },
          { img: "https://m.media-amazon.com/images/I/61HxjL060DL._AC_UL320_.jpg", features: ["Purple"], sumScore: 5.23550677, ratio: 0.00006215, val: "B0BYMP6R4Q" },
        ],
        nfs: [
          { score: 39244.61346066 }, { score: 630.0951867 }, { score: 653.26893222 },
          { score: 319.62645922 }, { score: 244.59573897 }, { score: 4.89220001 },
        ],
        sps: [
          { score: 18689.10217964 }, { score: 232.63157924 }, { score: 5.55954587 },
          { score: 7.88874576 }, { score: 1.644757 }, { score: 0 },
        ],
        recs: [
          { score: 3716.65284362 }, { score: 170.1229762 }, { score: 3.54133894 },
          { score: 2.31142618 }, { score: 1.60716092 }, { score: 0.34330675 },
        ],
        sbs: [
          { score: 13466.73454814 }, { score: 2.53004164 }, { score: 2.53004164 },
          { score: 0 }, { score: 0 }, { score: 0 },
        ],
        sbvs: [
          { score: 6834.01999569 }, { score: 0 }, { score: 0 }, { score: 0 }, { score: 0 }, { score: 0 },
        ],
      },
      data_notice: "Data updated through 2026-08-09 (refreshes daily, 1-day delay)",
    },
  },
  B09V5RW2VK:   {
      "overview": {
          "overview": {
              "ad": {
                  "score": 391.54793513,
                  "ratio": 0.03505816
              },
              "nf": {
                  "score": 10776.97803505,
                  "ratio": 0.96494184
              }
          },
          "ad": {
              "sp": {
                  "name": "SP(常规)",
                  "score": 308.1992857,
                  "ratio": 0.78713041
              },
              "recommend": {
                  "name": "SP(推荐)",
                  "score": 83.34864944,
                  "ratio": 0.21286959
              }
          },
          "recommend": {
              "Customers frequently viewed": {
                  "name": "Customers frequently viewed",
                  "score": 22.31061408,
                  "ratio": 0.26767817
              },
              "Picks from Amazon Influencers": {
                  "name": "Picks from Amazon Influencers",
                  "score": 0.76223281,
                  "ratio": 0.00914511
              },
              "Seen on social media": {
                  "name": "Seen on social media",
                  "score": 1.60885725,
                  "ratio": 0.01930274
              },
              "Trending now": {
                  "name": "Trending now",
                  "score": 9.90471112,
                  "ratio": 0.11883469
              },
              "From frequently shopped brands": {
                  "name": "From frequently shopped brands",
                  "score": 47.37929298,
                  "ratio": 0.56844704
              },
              "4 stars and above": {
                  "name": "4 stars and above",
                  "score": 1.38294119,
                  "ratio": 0.01659224
              }
          },
          "total": 11168.525970186905,
          "data_notice": "Data updated through 2026-08-09 (refreshes daily, 1-day delay)"
      },
      "structure": {
          "chars": {
              "dims": [
                  {
                      "img": "https://m.media-amazon.com/images/I/51ko3ZmX4XL._AC_UL320_.jpg",
                      "features": [
                          "3-Wheel",
                          "Princess Pink"
                      ],
                      "sumScore": 4540.30110541,
                      "ratio": 0.40652644,
                      "val": "B0C6FNQ6DC"
                  },
                  {
                      "img": "https://m.media-amazon.com/images/I/51u8OlMll9L._AC_UL320_.jpg",
                      "features": [
                          "3-Wheel",
                          "Frozen II"
                      ],
                      "sumScore": 3575.16447425,
                      "ratio": 0.32011068,
                      "val": "B09V5RW2VK"
                  },
                  {
                      "img": "https://m.media-amazon.com/images/I/51cw7OKZGaL._AC_UL320_.jpg",
                      "features": [
                          "3-Wheel",
                          "Little Mermaid"
                      ],
                      "sumScore": 2189.129217,
                      "ratio": 0.19600879,
                      "val": "B0BSHGV2SG"
                  },
                  {
                      "img": "https://m.media-amazon.com/images/I/51cL7QWW75L._AC_UL320_.jpg",
                      "features": [
                          "3-Wheel",
                          "Sonic"
                      ],
                      "sumScore": 272.84232013,
                      "ratio": 0.02442957,
                      "val": "B0CVNPN6KV"
                  },
                  {
                      "img": "https://m.media-amazon.com/images/I/61bdsjc7UtL._AC_UL320_.jpg",
                      "features": [
                          "3-Wheel",
                          "Blue"
                      ],
                      "sumScore": 238.19914488,
                      "ratio": 0.02132772,
                      "val": "B0CVNMVKQX"
                  },
                  {
                      "img": "https://m.media-amazon.com/images/I/51GS2GyAHfL._AC_UL320_.jpg",
                      "features": [
                          "2-Wheel",
                          "Princess"
                      ],
                      "sumScore": 156.7094993,
                      "ratio": 0.01403135,
                      "val": "B09V5RQCJK"
                  },
                  {
                      "img": "https://m.media-amazon.com/images/I/61cnPz7rUeL._AC_UL320_.jpg",
                      "features": [
                          "3-Wheel",
                          "Mickey"
                      ],
                      "sumScore": 117.48651028,
                      "ratio": 0.01051943,
                      "val": "B0C6FMLG3L"
                  },
                  {
                      "img": "https://m.media-amazon.com/images/I/51cIT4Mm5CL._AC_UL320_.jpg",
                      "features": [
                          "2-Wheel",
                          "Frozen"
                      ],
                      "sumScore": 78.69369894,
                      "ratio": 0.00704602,
                      "val": "B0B2P3BSWS"
                  }
              ],
              "nfs": [
                  {
                      "score": 4540.30110541
                  },
                  {
                      "score": 3183.61653912
                  },
                  {
                      "score": 2189.129217
                  },
                  {
                      "score": 272.84232013
                  },
                  {
                      "score": 238.19914488
                  },
                  {
                      "score": 156.7094993
                  },
                  {
                      "score": 117.48651028
                  },
                  {
                      "score": 78.69369894
                  }
              ],
              "sps": [
                  {
                      "score": 308.1992857
                  },
                  {
                      "score": 0
                  },
                  {
                      "score": 0
                  },
                  {
                      "score": 0
                  },
                  {
                      "score": 0
                  },
                  {
                      "score": 0
                  },
                  {
                      "score": 0
                  },
                  {
                      "score": 0
                  }
              ],
              "recs": [
                  {
                      "score": 0
                  },
                  {
                      "score": 83.34864944
                  },
                  {
                      "score": 0
                  },
                  {
                      "score": 0
                  },
                  {
                      "score": 0
                  },
                  {
                      "score": 0
                  },
                  {
                      "score": 0
                  },
                  {
                      "score": 0
                  }
              ],
              "sbs": [
                  {
                      "score": 0
                  },
                  {
                      "score": 0
                  },
                  {
                      "score": 0
                  },
                  {
                      "score": 0
                  },
                  {
                      "score": 0
                  },
                  {
                      "score": 0
                  },
                  {
                      "score": 0
                  },
                  {
                      "score": 0
                  }
              ],
              "sbvs": [
                  {
                      "score": 0
                  },
                  {
                      "score": 0
                  },
                  {
                      "score": 0
                  },
                  {
                      "score": 0
                  },
                  {
                      "score": 0
                  },
                  {
                      "score": 0
                  },
                  {
                      "score": 0
                  },
                  {
                      "score": 0
                  }
              ]
          },
          "data_notice": "Data updated through 2026-08-09 (refreshes daily, 1-day delay)"
      }
  },
};

export const sifListingTrafficOverview: Record<string, SifListingTrafficOverview | null> = Object.fromEntries(
  Object.entries(rawByAsin).map(([asin, payload]) => [asin, buildOverview(payload.overview, payload.structure)]),
);

export const sifListingTrafficMeta = {
  source: "SIF MCP · 查流量结构",
  period: "近30天",
  country: "US",
  updatedThrough: "2026-08-09",
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
