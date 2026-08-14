import { sellerSpriteVariantData } from "./variant-data";
import { variant12mTrendData, variant12mTrendMeta } from "./variant-12m-trend-data";

export type VariantConclusionItem = {
  name: string;
  rank: number;
  sales: number;
  reviews: number;
  reviewSharePct: number;
  linkCount: number;
  avgLaunch: string | null;
  launchSpanDays: number;
  sales12m: number | null;
  avg12m: number | null;
};

export type StockingRatioItem = {
  name: string;
  role: "must" | "add" | "watch";
  ratioPct: number;
  reason: string;
};

export type VariantAnalysisConclusion = {
  title: string;
  headline: string;
  methodNote: string;
  launchInconsistent: boolean;
  launchSpanDays: number;
  used12mCalibration: boolean;
  topReviewShare: VariantConclusionItem[];
  topChildSales: VariantConclusionItem[];
  standout12m: VariantConclusionItem[];
  stockingRatios: StockingRatioItem[];
  addRecommendations: string[];
  evidenceNote: string;
};

type AggRow = {
  name: string;
  sales: number;
  reviews: number;
  linkCount: number;
  asins: string[];
  launches: string[];
};

function normalizeName(attribute: string) {
  return attribute
    .replace(/^颜色[:：]\s*/i, "")
    .replace(/^Color[:：]\s*/i, "")
    .trim();
}

function parseLaunch(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysBetween(a: Date, b: Date) {
  return Math.abs(a.getTime() - b.getTime()) / (24 * 60 * 60 * 1000);
}

function roundRatios(weights: number[], total = 100) {
  if (!weights.length) return [];
  const sum = weights.reduce((acc, value) => acc + value, 0) || 1;
  const raw = weights.map(value => (value / sum) * total);
  const floors = raw.map(value => Math.floor(value));
  let remain = total - floors.reduce((acc, value) => acc + value, 0);
  const order = raw
    .map((value, index) => ({ index, frac: value - floors[index] }))
    .sort((a, b) => b.frac - a.frac);
  const result = [...floors];
  for (let i = 0; i < remain; i += 1) result[order[i % order.length].index] += 1;
  return result;
}

function aggregateVariants(products: Array<{ asin: string }>): AggRow[] {
  const map = new Map<string, AggRow>();
  for (const product of products) {
    const items = sellerSpriteVariantData[product.asin] ?? [];
    for (const item of items) {
      const name = normalizeName(item.attribute);
      if (!name) continue;
      const row = map.get(name) ?? {
        name,
        sales: 0,
        reviews: 0,
        linkCount: 0,
        asins: [],
        launches: [],
      };
      if (item.childSales != null) row.sales += item.childSales;
      if (item.reviews != null) row.reviews += item.reviews;
      row.linkCount += 1;
      row.asins.push(item.asin);
      if (item.launch) row.launches.push(item.launch);
      map.set(name, row);
    }
  }
  return [...map.values()];
}

function toConclusionItem(row: AggRow, rank: number, reviewTotal: number): VariantConclusionItem {
  const launches = row.launches.map(parseLaunch).filter((d): d is Date => Boolean(d)).sort((a, b) => a.getTime() - b.getTime());
  const launchSpanDays =
    launches.length >= 2 ? Math.round(daysBetween(launches[0], launches[launches.length - 1])) : 0;
  const avgLaunch =
    launches.length === 0
      ? null
      : new Date(launches.reduce((sum, d) => sum + d.getTime(), 0) / launches.length).toISOString().slice(0, 10);

  let sales12m: number | null = null;
  let avg12m: number | null = null;
  const readyTrends = row.asins
    .map(asin => variant12mTrendData[asin])
    .filter(record => record?.status === "ready");
  if (readyTrends.length) {
    sales12m = readyTrends.reduce((sum, record) => sum + record.total12m, 0);
    avg12m = Math.round(readyTrends.reduce((sum, record) => sum + record.avg12m, 0) / readyTrends.length);
  }

  return {
    name: row.name,
    rank,
    sales: row.sales,
    reviews: row.reviews,
    reviewSharePct: reviewTotal ? Math.round((row.reviews / reviewTotal) * 1000) / 10 : 0,
    linkCount: row.linkCount,
    avgLaunch,
    launchSpanDays,
    sales12m,
    avg12m,
  };
}

export function buildVariantAnalysisConclusion(products: Array<{ asin: string }>): VariantAnalysisConclusion {
  const rows = aggregateVariants(products);
  const reviewTotal = rows.reduce((sum, row) => sum + row.reviews, 0);
  const salesTotal = rows.reduce((sum, row) => sum + row.sales, 0);
  const allItems = products.flatMap(product => sellerSpriteVariantData[product.asin] ?? []);
  const knownSales = allItems.filter(item => item.childSales != null).length;
  const knownReviews = allItems.filter(item => item.reviews != null).length;

  const topChildSales = [...rows]
    .filter(row => row.sales > 0)
    .sort((a, b) => b.sales - a.sales || b.reviews - a.reviews)
    .slice(0, 5)
    .map((row, index) => toConclusionItem(row, index + 1, reviewTotal));

  const topReviewShare = [...rows]
    .filter(row => row.reviews > 0)
    .sort((a, b) => b.reviews - a.reviews || b.sales - a.sales)
    .slice(0, 5)
    .map((row, index) => toConclusionItem(row, index + 1, reviewTotal));

  const candidateNames = new Set([
    ...topChildSales.map(item => item.name),
    ...topReviewShare.map(item => item.name),
  ]);
  const candidateRows = rows.filter(row => candidateNames.has(row.name));
  const allLaunches = candidateRows
    .flatMap(row => row.launches)
    .map(parseLaunch)
    .filter((d): d is Date => Boolean(d))
    .sort((a, b) => a.getTime() - b.getTime());
  const launchSpanDays =
    allLaunches.length >= 2 ? Math.round(daysBetween(allLaunches[0], allLaunches[allLaunches.length - 1])) : 0;
  const launchInconsistent = launchSpanDays > 365;

  const has12m = candidateRows.some(row =>
    row.asins.some(asin => variant12mTrendData[asin]?.status === "ready"),
  );
  const used12mCalibration = launchInconsistent && has12m;

  const standout12m = used12mCalibration
    ? [...candidateRows]
        .map(row => toConclusionItem(row, 0, reviewTotal))
        .filter(item => (item.sales12m ?? 0) > 0)
        .sort((a, b) => (b.sales12m ?? 0) - (a.sales12m ?? 0) || (b.avg12m ?? 0) - (a.avg12m ?? 0))
        .slice(0, 5)
        .map((item, index) => ({ ...item, rank: index + 1 }))
    : [];

  const must = topChildSales
    .map(item => item.name)
    .filter(name => topReviewShare.some(item => item.name === name));
  const addOnlySales = topChildSales.map(item => item.name).filter(name => !must.includes(name));
  const addOnlyReviews = topReviewShare.map(item => item.name).filter(name => !must.includes(name) && !addOnlySales.includes(name));

  // Prefer 12m-calibrated order when available for stocking weights
  const scoreMap = new Map<string, number>();
  for (const item of topChildSales) {
    const salesShare = salesTotal ? item.sales / salesTotal : 0;
    const reviewShare = reviewTotal ? item.reviews / reviewTotal : 0;
    const twelveShare =
      used12mCalibration && standout12m.length
        ? (standout12m.find(row => row.name === item.name)?.sales12m ?? 0) /
          Math.max(
            1,
            standout12m.reduce((sum, row) => sum + (row.sales12m ?? 0), 0),
          )
        : 0;
    const score = used12mCalibration
      ? salesShare * 0.35 + reviewShare * 0.25 + twelveShare * 0.4
      : salesShare * 0.6 + reviewShare * 0.4;
    scoreMap.set(item.name, score);
  }
  for (const name of [...addOnlyReviews]) {
    const row = rows.find(item => item.name === name);
    if (!row) continue;
    const reviewShare = reviewTotal ? row.reviews / reviewTotal : 0;
    scoreMap.set(name, (scoreMap.get(name) ?? 0) + reviewShare * 0.35);
  }

  const recommendedOrder = [...must, ...addOnlySales, ...addOnlyReviews].filter(
    (name, index, list) => list.indexOf(name) === index,
  );
  const weights = recommendedOrder.map(name => Math.max(scoreMap.get(name) ?? 0.01, 0.01));
  const ratios = roundRatios(weights, 100);
  const stockingRatios: StockingRatioItem[] = recommendedOrder
    .map((name, index) => {
      const inMust = must.includes(name);
      const inSales = topChildSales.some(item => item.name === name);
      const inReviews = topReviewShare.some(item => item.name === name);
      const role: StockingRatioItem["role"] = inMust ? "must" : inSales || inReviews ? "add" : "watch";
      const reason = inMust
        ? "销量 TOP5 ∩ 评论占比 TOP5"
        : inSales
          ? "子销量 TOP5"
          : "评论占比 TOP5";
      return { name, role, ratioPct: ratios[index] ?? 0, reason };
    })
    .sort((a, b) => b.ratioPct - a.ratioPct || a.name.localeCompare(b.name));

  const primary = must.slice(0, 3);
  const secondary = recommendedOrder.filter(name => !primary.includes(name)).slice(0, 3);
  const headline = recommendedOrder.length
    ? `立项建议优先做 ${primary.join("、") || recommendedOrder.slice(0, 3).join("、")}${
        secondary.length ? `；第二梯队补 ${secondary.join("、")}` : ""
      }，备货按右表比例分配`
    : "暂无足够变体数据形成立项结论";

  const addRecommendations = [
    must.length
      ? `必上变体：${must.join("、")}（同时进入评论占比 TOP5 与子销量 TOP5）`
      : "必上变体：当前双榜交集不足，先以销量 TOP3 为主色",
    addOnlySales.length ? `销量驱动加色：${addOnlySales.join("、")}` : "",
    addOnlyReviews.length ? `评论沉淀加色：${addOnlyReviews.join("、")}（转化验证后再放大备货）` : "",
    used12mCalibration
      ? `因上架时间跨度约 ${Math.round(launchSpanDays / 30)} 个月，已用近12个月子体销量校准；近12月更突出：${standout12m
          .slice(0, 3)
          .map(item => item.name)
          .join("、")}`
      : launchInconsistent
        ? `上架时间跨度约 ${Math.round(launchSpanDays / 30)} 个月，建议运行 ${variant12mTrendMeta.syncCommand} 拉取近12个月子体趋势后再定最终比例`
        : "各主推变体上架时间相对接近，可直接用当期子销量 + 评论占比定比例",
  ].filter(Boolean);

  return {
    title: "竞品变体分析结论",
    headline,
    methodNote: `基于全竞品 ${allItems.length} 个子体：评论数占比 TOP5 + 子销量 TOP5${
      used12mCalibration ? "，并用近12个月子体销量校准上架时间不一致样本" : ""
    }。当前变体维度以颜色为主。`,
    launchInconsistent,
    launchSpanDays,
    used12mCalibration,
    topReviewShare,
    topChildSales,
    standout12m,
    stockingRatios,
    addRecommendations,
    evidenceNote: `可核验子销量 ${knownSales}/${allItems.length} · 可核验评论 ${knownReviews}/${allItems.length}${
      used12mCalibration ? ` · 12个月校准源 ${variant12mTrendMeta.source}` : ""
    }`,
  };
}
