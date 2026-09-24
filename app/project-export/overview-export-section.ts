import { marketSites } from '../../shared/market-sites';
import type { CurrentProjectDisplayVersion } from '../lib/project-display-version-browser';
import { resolveOverviewPrice, resolveOverviewRank } from '../lib/competitor-overview-fallback';
import { resolveFbaMetric, resolvePriceMetric, resolveRatingMetric } from '../lib/competitor-metric-resolution';
import type { SorftimeSalesTrendRecord } from '../sorftime-sales-trend-data';
import type { ExportBlock, ExportCell, ExportSection } from './export-contracts';

type RecordValue = Record<string, unknown>;
type Point = { month: string; value: number | null };
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const text = (value: unknown): string => typeof value === 'string' && value.trim() ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : '—';
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const cell = (value: unknown): ExportCell => ({ text: text(value) });
const money = (value: number | null) => value === null ? '—' : `$${value}`;

function points(value: unknown): Point[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('概览趋势数据格式无效');
  return value.map(raw => {
    const item = record(raw);
    if (typeof item.month !== 'string' || !item.month || (item.value !== null && number(item.value) === null)) throw new Error('概览趋势数据格式无效');
    return { month: item.month, value: number(item.value) };
  });
}

function scopedRecord(value: unknown, version: CurrentProjectDisplayVersion, asin?: string): RecordValue {
  if (value != null && (typeof value !== 'object' || Array.isArray(value))) throw new Error('概览数据格式无效');
  const item = record(value);
  if ((item.marketplace !== undefined && item.marketplace !== version.marketplace)
    || (asin && item.asin !== undefined && item.asin !== asin)) throw new Error('概览数据来源范围不匹配');
  return item;
}

function stageMap(version: CurrentProjectDisplayVersion, stage: keyof CurrentProjectDisplayVersion['stageOutputs'], key: string): RecordValue {
  const output = version.stageOutputs[stage];
  return output && 'data' in output ? record(record(output.data)[key]) : {};
}

function chart(title: string, data: { label: string; points: Point[] }[], allLabels?: string[]): ExportBlock {
  const labels = allLabels ?? [...new Set(data.flatMap(item => item.points.map(point => point.month)))].sort();
  return { kind: 'chart', title, labels, series: data.map(item => {
    const values = new Map(item.points.map(point => [point.month, point.value]));
    return { label: item.label, values: labels.map(label => values.get(label) ?? null) };
  }) };
}

function table(title: string, columns: string[], rows: unknown[][]): ExportBlock {
  return { kind: 'table', title, columns, rows: rows.map(row => row.map(cell)) };
}

function theme(product: RecordValue): string {
  const source = [text(product.format), ...(Array.isArray(product.variantDetails) ? product.variantDetails.map(item => text(record(item).name)) : [])].join(' ');
  return [[/color|颜色/i, '颜色'], [/size|尺寸/i, '尺寸'], [/style|款式/i, '款式'], [/configuration|配置/i, '配置']]
    .filter(([pattern]) => (pattern as RegExp).test(source)).map(([, label]) => label).join('、') || '暂无数据';
}

/** Only reads the already authorized immutable version. No generated fallback imports or network calls. */
export function buildOverviewExportSection(version: CurrentProjectDisplayVersion): ExportSection {
  const blocks: ExportBlock[] = [];
  const catalog = version.asins.map(asin => {
    const matches = version.catalog.filter(item => record(item).asin === asin);
    if (matches.length > 1) throw new Error('概览商品目录来源重复');
    return scopedRecord(matches[0], version, asin);
  });
  const trends = stageMap(version, 'sales_trend', 'trendByAsin');
  const ratings = stageMap(version, 'reviews', 'ratingByAsin');
  const fees = stageMap(version, 'fba', 'feeByAsin');
  const strategies = stageMap(version, 'price_strategy', 'strategyByAsin');
  const listing = stageMap(version, 'listing', 'contentByAsin');
  const children = stageMap(version, 'child_sales', 'rowsByAsin');
  const categories = stageMap(version, 'category', 'trendByNode');
  let hasResult = catalog.some(item => Object.keys(item).length > 0);

  if (version.catalogEvidence) blocks.push({ kind: 'text', text: `目录来源更新时间：${version.catalogEvidence.sourceUpdatedAt}；目录捕获时间：${version.catalogEvidence.capturedAt}。` });
  else blocks.push({ kind: 'text', text: '目录来源待核验：已发布版本未提供目录来源证据。' });
  for (const gap of version.gaps) if (version.asins.includes(gap.asin) && /^(catalog|category|sales_trend|reviews|fba|listing|child_sales|price_strategy)(\.|$)/.test(gap.field)) {
    blocks.push({ kind: 'text', text: `${gap.asin} · ${gap.field}：${gap.reasonCode}` });
  }
  for (const stage of ['category', 'sales_trend', 'reviews', 'fba', 'listing', 'child_sales', 'price_strategy'] as const) {
    const output = version.stageOutputs[stage];
    if (!output || output.stageStatus === 'missing-output') blocks.push({ kind: 'text', text: `${stage}：暂无已生成结果（OUTPUT_UNAVAILABLE）` });
    else if ('gap' in output) {
      blocks.push({ kind: 'text', text: `${stage}：${output.stageStatus} · ${output.gap.reasonCode}` });
      for (const item of output.gap.items ?? []) if (version.asins.includes(item.asin)) blocks.push({ kind: 'text', text: `${item.asin} · ${item.causeCode}${item.operation ? ` · ${item.operation}` : ''}` });
    }
  }

  const productViews = version.asins.map((asin, index) => {
    const product = catalog[index];
    const trend = scopedRecord(trends[asin], version, asin);
    const rating = scopedRecord(ratings[asin], version, asin);
    const fee = scopedRecord(fees[asin], version, asin);
    const strategy = scopedRecord(strategies[asin], version, asin);
    const content = scopedRecord(listing[asin], version, asin);
    for (const source of [trend, rating, fee, strategy, content]) if (Object.keys(source).length) hasResult = true;
    const series = Object.fromEntries(['volume', 'amount', 'price', 'rank'].map(key => [key, trend.status === 'ready' ? points(trend[key]) : []])) as Record<'volume'|'amount'|'price'|'rank', Point[]>;
    const helperTrend = { ...trend, price: series.price.filter(p => p.value !== null), rank: series.rank.filter(p => p.value !== null) } as SorftimeSalesTrendRecord;
    const price = resolveOverviewPrice(number(product.price), helperTrend);
    const rank = resolveOverviewRank(number(product.rank), number(product.subRank), helperTrend);
    const ratingMetric = resolveRatingMetric({ status: text(rating.status), rating: number(rating.rating), reviewCount: number(rating.reviewCount) }, { rating: number(product.rating), reviews: number(product.reviews) });
    const feeMetric = resolveFbaMetric({ status: text(fee.status), fbaFee: fee.fbaFee });
    const strategyMetric = resolvePriceMetric(Object.keys(strategy).length ? { status: text(strategy.status), currentPrice: strategy.currentPrice } : undefined, product.price);
    const latestSales = [...series.volume].filter(point => point.value !== null && point.value > 0).sort((a, b) => a.month.localeCompare(b.month)).at(-1)?.value ?? number(product.sales);
    const original = strings(product.listingBullets).length ? strings(product.listingBullets) : strings(product.sellingPoints);
    const values = [
      money(price.value), latestSales === null ? '—' : `${latestSales}+`,
      ratingMetric.value ? `${text(ratingMetric.value.rating)} / ${text(ratingMetric.value.reviewCount)}${ratingMetric.label ? `（${ratingMetric.label}）` : ''}` : ratingMetric.label,
      rank.value === null ? '—' : rank.source === 'sellerSprite' ? `#${rank.value} in ${text(product.rankCategory)}${number(product.subRank) !== null ? `；#${product.subRank} in ${text(product.subRankCategory)}` : ''}` : `#${rank.value}（类目：卖家精灵未返回）`,
      product.catalogSource === 'sorftime-fallback' || !product.synced ? 'SellerSprite 暂不可用' : product.buyBoxSeller,
      product.catalogSource === 'sorftime-fallback' || !product.synced ? 'SellerSprite 暂不可用' : product.fulfillment,
      `${text(product.packageSize)}；${text(product.packageWeight)}`,
      feeMetric.value === null ? feeMetric.label : `${money(feeMetric.value)}；${fee.source === 'keepa' ? 'Keepa · 配送费' : 'Sorftime · FBA 费用估算'}；${text(fee.packageSize)}；${text(fee.packageWeight)}；${text(fee.note)}`,
      strings(product.specifications).join('\n') || '—', product.launch, theme(product), product.variants,
      strategyMetric.source === 'sorftime' ? `定价锚点：${text(strategy.anchor)}\n促销手法：${text(strategy.promotion)}\n折扣心理：${text(strategy.psychology)}\n依据：${text(strategy.evidence)}` : strategyMetric.label,
      original.join('\n') || '暂无已保存卖点原文',
    ];
    const rawChildren = children[asin];
    if (rawChildren !== undefined && !Array.isArray(rawChildren)) throw new Error('概览子体销量格式无效');
    if (Array.isArray(rawChildren) && rawChildren.length) {
      hasResult = true;
      blocks.push(table(`${asin} 近期披露子体销量`, ['子体 ASIN', '属性', '披露销量', '观察时间'], rawChildren.map(item => {
        const row = record(item); return [row.asin, row.variant, row.sales, row.observedAt];
      })));
    } else blocks.push({ kind: 'text', text: `${asin}：暂无已生成的近期披露子体销量。` });
    if (trend.status && trend.status !== 'ready') blocks.push({ kind: 'text', text: `${asin} 历史趋势：${text(trend.status)} · ${text(trend.statusMessage)}` });
    return { asin, product, content, values, series };
  });

  const columns = ['指标', ...version.asins];
  const domain = marketSites.find(site => site.code === version.marketplace)?.amazonDomain;
  const rows: ExportCell[][] = [
    [cell('ASIN'), ...version.asins.map(asin => ({ text: asin, ...(domain ? { href: "https://www." + domain + "/dp/" + encodeURIComponent(asin) } : {}) }))],
    [cell('品牌 / 标题'), ...productViews.map(({ product }) => cell(`${text(product.brand)}\n${text(product.title)}`))],
    [cell('产品图片'), ...productViews.map(({ product, content }) => {
      const url = typeof content.mainImage === 'string' ? content.mainImage : product.image;
      return { text: `${text(product.brand)} ${text(product.title)}`, ...(typeof url === 'string' && url ? { imageUrl: url } : {}) };
    })],
  ];
  ['当前售价', '30天销量', '评分 / 评论', 'Best Seller Rank', '购物车卖家', '配送方式', '产品包装', 'FBA 费用', '产品规格', '上架时间', '变体主题', '变体数量', '价格策略分析', '主要卖点原文'].forEach((label, index) => rows.push([cell(label), ...productViews.map(view => cell(view.values[index]))]));
  blocks.push({ kind: 'table', title: '竞品参数总览', columns, rows });
  blocks.push({ kind: 'text', text: '近期披露子体销量为页面披露口径，统计周期未提供；保留来源全部已有记录，不等同于全部变体订单或近30天完整销量。' });
  blocks.push({ kind: 'text', text: '销量、销售额、历史价格和大类 BSR 来自已发布 Sorftime 阶段结果。空白数值代表未返回，不按零处理。金额口径沿用来源 USD。' });
  for (const [key, label] of [['volume', '月销量'], ['amount', '月销售额（USD）'], ['price', '历史价格（USD）'], ['rank', '大类 BSR（越低越优）']] as const) {
    const data = productViews.map(view => ({ label: view.asin, points: view.series[key] }));
    blocks.push(chart(`竞品历史数据追踪 · ${label}`, data));
  }

  for (const [node, raw] of Object.entries(categories)) {
    const category = scopedRecord(raw, version);
    const asins = strings(category.asins);
    if (!asins.some(asin => version.asins.includes(asin)) && !catalog.some(product => typeof product.subRankCategory === 'string' && product.subRankCategory === category.categoryName)) continue;
    hasResult = true;
    const name = `${text(category.categoryName)} · Node ${text(category.nodeId ?? node)}`;
    blocks.push({ kind: 'text', text: `BSR 小类市场趋势：${text(category.topCategory)} › ${name}；Top100 统计口径；Top3 Listing / 品牌 / 卖家销售额占比。更新：${text(category.fetchedAt)}；${text(category.note)}` });
    if (category.status !== 'ready') {
      blocks.push({ kind: 'text', text: `${name}：${text(category.status)} · ${text(category.statusMessage)}` }); continue;
    }
    const volume = points(category.volume), amount = points(category.amount);
    const labels = [...new Set([...volume, ...amount].map(point => point.month))].sort();
    blocks.push(chart(`${name} · 类目月销量`, [{ label: '销量（件）', points: volume }], labels));
    blocks.push(chart(`${name} · 类目月销售额`, [{ label: '销售额（USD）', points: amount }], labels));
    const monopoly = [['listingMonopoly', 'Listing'], ['brandMonopoly', '品牌'], ['sellerMonopoly', '卖家']].map(([key, label]) => ({ label: `${label} 垄断系数（%）`, points: points(category[key]) }));
    blocks.push(chart(`${name} · 垄断系数趋势（Top3）`, monopoly));
    const last = volume.at(-1), prior = volume.at(-2);
    const latest = last?.value != null && prior?.value != null && last.value < prior.value * 0.25 ? prior : last;
    const previous = latest ? volume[Math.max(0, volume.indexOf(latest) - 1)] : undefined;
    const amountMap = new Map(amount.map(point => [point.month, point.value]));
    const currentAmount = latest ? amountMap.get(latest.month) ?? null : null;
    const previousAmount = previous ? amountMap.get(previous.month) ?? null : null;
    const change = (current: number | null | undefined, prev: number | null | undefined) => current != null && prev ? `${((current - prev) / prev * 100).toFixed(1)}%` : '—';
    blocks.push(table(`${name} · 市场指标`, ['指标', '数值', '说明'], [
      ['最近月销量', latest?.value, `${text(latest?.month)}；环比 ${change(latest?.value, previous?.value)}`],
      ['最近月销售额', money(currentAmount), `环比 ${change(currentAmount, previousAmount)}`],
      ...monopoly.map(item => [item.label, item.points.at(-1)?.value, text(item.points.at(-1)?.month)]),
      ['样本 / 竞品', `${volume.length} 月 / ${asins.filter(asin => version.asins.includes(asin)).length} 个对标`, '若最新月销量不足前月25%，最近月指标沿用前月；历史图仍保留全部点。'],
    ]));
  }
  if (!hasResult) blocks.unshift({ kind: 'text', text: '竞品概览：暂无已生成结果。' });
  return { id: 'competitor-overview', title: '竞品参数总览', status: hasResult ? 'ready' : 'missing', blocks };
}
