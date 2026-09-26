import { ManualAlexaVocListResponseSchema, type ManualAlexaVocRecord } from '../../shared/agent-contracts';
import { buildKeywordDemandAnalysis } from '../keyword-demand-analysis';
import type { LaunchProductInput, ProductLaunchRuntimeSources } from '../product-launch-analysis';
import type { ExportModuleContext, ExportModuleRead } from './export-module-context';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('已保存报告格式无效');
  return value as Record<string, unknown>;
}

async function json(read: ExportModuleRead, path: string, label: string): Promise<unknown> {
  const response = await read(path);
  if (!response.ok) throw new Error(`${label}读取失败（${response.status}）`);
  try { return await response.json(); } catch { throw new Error(`${label}响应格式无效`); }
}

function memo<T>(context: ExportModuleContext, key: string, read: () => Promise<T>): Promise<T> {
  const cache = (context as ExportModuleContext & { sharedReads?: Map<string, Promise<unknown>> }).sharedReads;
  if (!cache) return read();
  const existing = cache.get(key);
  if (existing) return existing as Promise<T>;
  const pending = read();
  cache.set(key, pending);
  return pending;
}

export function readManualVocRecords(context: ExportModuleContext, read: ExportModuleRead): Promise<ManualAlexaVocRecord[]> {
  return memo(context, 'manual-voc', async () => {
  if (context.marketplace !== 'US' || context.asins.length === 0) return [];
  const query = new URLSearchParams({ projectId: context.projectId, marketplace: 'US' });
  context.asins.forEach(asin => query.append('asins', asin));
  const path = `/api/alexa-voc?${query.toString()}`;
  async function snapshot() {
    const parsed = ManualAlexaVocListResponseSchema.safeParse(await json(read, path, 'Manual Alexa VOC'));
    if (!parsed.success) throw new Error('Manual Alexa VOC 响应格式无效');
    const records = parsed.data.records;
    if (records.some(record => record.marketplace !== context.marketplace || !context.asins.includes(record.asin)
      || record.normalizedRecord.asin !== record.asin)
      || new Set(records.map(record => record.asin)).size !== records.length) throw new Error('Manual Alexa VOC 来源范围不匹配');
    return records;
  }
  const first = await snapshot();
  const second = await snapshot();
  if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error('Manual Alexa VOC 在读取期间变化，请重新准备');
  return first;
  });
}

function dataMap(context: ExportModuleContext, stage: 'keywords' | 'reviews', key: string): Record<string, unknown> {
  const output = context.version?.stageOutputs[stage];
  if (!output || !('data' in output)) return {};
  const body = object(output.data);
  const value = body[key];
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${stage} 来源数据格式无效`);
  return value as Record<string, unknown>;
}

function scopedAsinRecords(context: ExportModuleContext, data: Record<string, unknown>, label: string): Record<string, unknown> {
  return Object.fromEntries(context.asins.flatMap(asin => {
    if (data[asin] === undefined) return [];
    const item = object(data[asin]);
    if (item.asin !== asin || item.marketplace !== context.marketplace) throw new Error(`${label}来源 ASIN 或站点不匹配`);
    return [[asin, item]];
  }));
}

export function publishedReviewRecords(context: ExportModuleContext): Record<string, unknown> {
  return scopedAsinRecords(context, dataMap(context, 'reviews', 'analysisByAsin'), '智能评论');
}

export function catalogGapNote(context: ExportModuleContext): string[] {
  const missing = context.version ? context.asins.filter(asin => !context.version!.catalog.some(item =>
    item && typeof item === 'object' && 'asin' in item && item.asin === asin)) : [];
  return missing.length ? [`商品资料缺失：${missing.join('、')}。保留已有 VOC 和报告内容；价格、销量和产品结构按未知处理，不套用特定类目的规则。`] : [];
}

export type CurrentPageAnalysisInputs = Readonly<{ products: LaunchProductInput[]; sources: ProductLaunchRuntimeSources }>;

/** Same explicit sources as the page; review candidates do not opt in to rule analysis. */
export function buildCurrentPageAnalysisInputs(context: ExportModuleContext, manual: readonly ManualAlexaVocRecord[]): CurrentPageAnalysisInputs | null {
  if (!context.version || context.marketplace !== 'US' || context.asins.length === 0) return null;
  const products: LaunchProductInput[] = context.asins.map(asin => {
    const matches = context.version!.catalog.filter(item => item && typeof item === 'object' && 'asin' in item && item.asin === asin);
    if (matches.length > 1) throw new Error('商品目录来源重复');
    const item = matches[0];
    // Match the page's missing-product behavior without importing global catalog data or zero-filled metrics.
    const p = (item ?? {}) as Record<string, unknown>;
    const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
    return { asin, brand: typeof p.brand === 'string' ? p.brand : '', title: typeof p.title === 'string' ? p.title : undefined,
      features: Array.isArray(p.features) && p.features.every(feature => typeof feature === 'string') ? p.features as string[] : undefined,
      price: number(p.price), sales: number(p.sales), rating: number(p.rating), reviews: number(p.reviews),
      launch: typeof p.launch === 'string' ? p.launch : null, subRankCategory: typeof p.subRankCategory === 'string' ? p.subRankCategory : undefined,
      rankCategory: typeof p.rankCategory === 'string' ? p.rankCategory : undefined,
      productFamily: p.productFamily === 'scooter' || p.productFamily === 'lighting' ? p.productFamily : 'generic',
    };
  });
  const keywordAnalysisByAsin = scopedAsinRecords(context, dataMap(context, 'keywords', 'analysisByAsin'), '关键词');
  const referencedKeywords = new Set<string>();
  for (const raw of Object.values(keywordAnalysisByAsin)) {
    const item = object(raw);
    if (!Array.isArray(item.keywords)) throw new Error('关键词记录格式无效');
    for (const rawKeyword of item.keywords) {
      const keyword = object(rawKeyword).keyword;
      if (typeof keyword !== 'string' || !keyword.trim()) throw new Error('关键词记录格式无效');
      referencedKeywords.add(keyword.trim().toLowerCase());
    }
  }
  const enrichmentByKeyword = Object.fromEntries(Object.entries(dataMap(context, 'keywords', 'enrichmentByKeyword')).flatMap(([key, raw]) => {
    if (!referencedKeywords.has(key.trim().toLowerCase())) return [];
    const item = object(raw);
    if (typeof item.keyword !== 'string' || item.keyword.trim().toLowerCase() !== key.trim().toLowerCase()
      || (item.marketplace !== undefined && item.marketplace !== context.marketplace)) throw new Error('关键词补充数据来源不匹配');
    return [[key, item]];
  }));
  const keywordSources = { analysisByAsin: keywordAnalysisByAsin, enrichmentByKeyword };
  const reviewAnalysisByAsin = publishedReviewRecords(context);
  const manualVocByAsin = Object.fromEntries(manual.map(item => [item.asin, item.normalizedRecord]));
  const sources: ProductLaunchRuntimeSources = {
    analysisScope: { organizationId: context.organizationId, projectId: context.projectId, marketplace: context.marketplace, asins: [...context.asins] },
    manualVocByAsin,
    reviewFallbackCandidates: reviewAnalysisByAsin as ProductLaunchRuntimeSources['reviewFallbackCandidates'],
    keywordSources: keywordSources as ProductLaunchRuntimeSources['keywordSources'],
    keywordDemand: buildKeywordDemandAnalysis(products, keywordSources as ProductLaunchRuntimeSources['keywordSources']),
  };
  return {products, sources};
}
