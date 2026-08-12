/** SIF MCP · ops_get_asin_traffic_trend · Listing 聚合 · 近6个月父ASIN自然/广告流量 */

export type MonthlyTrafficPoint = {
  month: string;
  label: string;
  natural: number;
  ad: number;
  total: number;
};

export type SifMonthlyTrafficSeries = {
  asin: string;
  points: MonthlyTrafficPoint[];
};

function monthLabel(ym: string) {
  const month = Number(ym.slice(5, 7));
  return `${month}月`;
}

function round(value: number) {
  return Math.round(value);
}

function buildSeries(
  asin: string,
  dates: string[],
  nf: Array<{ score: number } | null>,
  ad: Array<{ score: number } | null>,
): SifMonthlyTrafficSeries {
  return {
    asin,
    points: dates.map((date, index) => {
      const natural = round(nf[index]?.score ?? 0);
      const adScore = round(ad[index]?.score ?? 0);
      return {
        month: date,
        label: monthLabel(date),
        natural,
        ad: adScore,
        total: natural + adScore,
      };
    }),
  };
}

export const sifMonthlyTrafficMonths = ["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"] as const;

export const sifMonthlyTrafficTrend: Record<string, SifMonthlyTrafficSeries> = {
  B07VY9Q95Q: buildSeries(
    "B07VY9Q95Q",
    [...sifMonthlyTrafficMonths],
    [
      { score: 113121.52211318562 },
      { score: 155677.61091881152 },
      { score: 159390.35411288647 },
      { score: 180516.3941057797 },
      { score: 183753.0056190885 },
      { score: 44155.83913108752 },
    ],
    [
      { score: 137305.9937543282 },
      { score: 142391.57388412053 },
      { score: 57261.28731667098 },
      { score: 100910.68038734881 },
      { score: 100352.0928140339 },
      { score: 19558.582401145963 },
    ],
  ),
  B0BPXRVWYK: buildSeries(
    "B0BPXRVWYK",
    [...sifMonthlyTrafficMonths],
    [
      { score: 170421.31821985092 },
      { score: 139616.27962989116 },
      { score: 126877.90165071657 },
      { score: 150255.1005427467 },
      { score: 117063.95064748754 },
      { score: 28654.10546467471 },
    ],
    [
      { score: 55686.14790917341 },
      { score: 92959.8369186836 },
      { score: 86879.1601197196 },
      { score: 69612.06412234764 },
      { score: 63408.80797956469 },
      { score: 12221.877526050463 },
    ],
  ),
  B07DYG1C9B: buildSeries(
    "B07DYG1C9B",
    [...sifMonthlyTrafficMonths],
    [
      { score: 51992.398581793444 },
      { score: 58620.388634924006 },
      { score: 91531.85680744995 },
      { score: 90755.084094315 },
      { score: 73494.19809171896 },
      { score: 20175.04328929974 },
    ],
    [
      { score: 31412.089424087848 },
      { score: 41934.45698359151 },
      { score: 49508.46011021808 },
      { score: 54903.94466615424 },
      { score: 35052.449703190236 },
      { score: 11434.172599835902 },
    ],
  ),
  B07S64PYMM: buildSeries(
    "B07S64PYMM",
    [...sifMonthlyTrafficMonths],
    [
      { score: 73542.04573201353 },
      { score: 66383.02633975963 },
      { score: 53886.05346629585 },
      { score: 41824.393982977264 },
      { score: 24393.256043245136 },
      { score: 6742.30991900162 },
    ],
    [
      { score: 32073.07900131202 },
      { score: 38169.75619110133 },
      { score: 28079.695994787304 },
      { score: 16659.55405381484 },
      { score: 10491.51788987658 },
      { score: 1850.8817782507963 },
    ],
  ),
  B08HJ96QJ9: buildSeries(
    "B08HJ96QJ9",
    [...sifMonthlyTrafficMonths],
    [
      { score: 16045.79407205965 },
      { score: 22465.583009999693 },
      { score: 28032.313573797688 },
      { score: 28751.683853512914 },
      { score: 21935.04630407193 },
      { score: 5672.9396268212895 },
    ],
    [
      { score: 16482.370887118213 },
      { score: 26270.37445862709 },
      { score: 22531.217158608917 },
      { score: 22536.292357020116 },
      { score: 12539.124530329678 },
      { score: 2830.5406553834546 },
    ],
  ),
  B08T8RY9VK: buildSeries(
    "B08T8RY9VK",
    [...sifMonthlyTrafficMonths],
    [
      { score: 54568.08498624046 },
      { score: 59015.83480494507 },
      { score: 54098.62125467745 },
      { score: 61889.96671056094 },
      { score: 41765.43544510087 },
      { score: 9809.568074525661 },
    ],
    [
      { score: 65202.16608512558 },
      { score: 80854.8039704396 },
      { score: 44563.513352219525 },
      { score: 55860.40860864084 },
      { score: 42829.77319536227 },
      { score: 9626.751859749249 },
    ],
  ),
  B09V5RW2VK: buildSeries(
    "B09V5RW2VK",
    [...sifMonthlyTrafficMonths],
    [
      { score: 98346.64308318708 },
      { score: 78812.7610530831 },
      { score: 74423.02291730355 },
      { score: 75151.53961985851 },
      { score: 52417.3599265575 },
      { score: 12102.528046465108 },
    ],
    [
      { score: 902.4834823502395 },
      { score: 4746.824564472657 },
      { score: 8094.024660148845 },
      { score: 5284.8176256952775 },
      { score: 3560.3388997394773 },
      { score: 432.9391973639823 },
    ],
  ),
};

export const sifMonthlyTrafficMeta = {
  source: "SIF MCP · 查流量结构 / 流量趋势",
  period: "近6个月",
  country: "US",
  listingSearch: true,
  updatedThrough: "2026-08-09",
  months: sifMonthlyTrafficMonths.map(monthLabel),
  naturalColor: "#55BB6A",
  adColor: "#FFB03B",
  note: "父 ASIN Listing 聚合口径；8月为当月未完结数据",
};
