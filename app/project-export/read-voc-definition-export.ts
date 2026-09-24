import { GetRunResponseSchema, ListReportsResponseSchema, ManualAlexaVocListResponseSchema, type AnalysisReport, type ManualAlexaVocRecord } from '../../shared/agent-contracts';
import type { LocalRuleReport } from '../../shared/local-rule-report';
import { VocEvidenceManifestSchema, type VocEvidenceManifest } from '../../shared/voc-evidence-contracts';
import { buildKeywordDemandAnalysis } from '../keyword-demand-analysis';
import { buildProductLaunchAnalysis, hasProductLaunchAnalysis, type LaunchProductInput, type ProductLaunchAnalysis, type ProductLaunchRuntimeSources } from '../product-launch-analysis';
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

function sameAsins(left: readonly string[], right: readonly string[]): boolean {
  const sortedRight = [...right].sort();
  return left.length === sortedRight.length && [...left].sort().every((asin, index) => asin === sortedRight[index]);
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
    if (records.some(record => record.marketplace !== context.marketplace || !context.asins.includes(record.asin))
      || new Set(records.map(record => record.asin)).size !== records.length) throw new Error('Manual Alexa VOC 来源范围不匹配');
    return records;
  }
  const first = await snapshot();
  const second = await snapshot();
  if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error('Manual Alexa VOC 在读取期间变化，请重新准备');
  return first;
  });
}

function validLocalReport(value: unknown, context: ExportModuleContext): LocalRuleReport {
  const report = object(value);
  const scope = object(report.inputScope);
  if (report.schemaVersion !== 'local-rule-report/v1' || typeof report.id !== 'string' || typeof report.createdAt !== 'string'
    || scope.organizationId !== context.organizationId || scope.projectId !== context.projectId
    || scope.marketplace !== context.marketplace || !Array.isArray(scope.asins)
    || !sameAsins(scope.asins as string[], context.asins)) throw new Error('已保存规则报告来源范围不匹配');
  if (!Array.isArray(report.products) || !sameAsins(report.products.map(item => object(item).asin as string), context.asins))
    throw new Error('已保存规则报告商品范围不匹配');
  const analysis = object(report.analysis);
  const finalDefinition = object(report.finalDefinition);
  if (report.sourceBindings !== undefined) {
    const bindings = object(report.sourceBindings);
    if (!Array.isArray(bindings.manualVoc) || bindings.manualVoc.some(raw => !context.asins.includes(object(raw).asin as string)))
      throw new Error('已保存规则报告 VOC 来源 ASIN 不匹配');
  }
  function sameScope(raw: unknown): boolean {
    const nested = object(raw);
    return nested.organizationId === context.organizationId && nested.projectId === context.projectId
      && nested.marketplace === context.marketplace && nested.inputRevision === scope.inputRevision
      && Array.isArray(nested.asins) && sameAsins(nested.asins as string[], context.asins);
  }
  function validateSource(raw: unknown) {
    const source = object(raw);
    if ((source.scope === 'asin' && !context.asins.includes(source.asin as string))
      || (source.scope !== 'asin' && source.scope !== 'project')
      || (source.asin !== undefined && !context.asins.includes(source.asin as string))
      || (source.inputScope !== undefined && !sameScope(source.inputScope))) {
      throw new Error('已保存规则判定来源范围不匹配');
    }
  }
  function validateTrace(raw: unknown) {
    if (raw === undefined) return;
    const trace = object(raw);
    if (!sameScope(trace.inputScope) || !Array.isArray(trace.decisions) || !Array.isArray(trace.sources))
      throw new Error('已保存规则判定范围不匹配');
    trace.sources.forEach(validateSource);
    for (const rawDecision of trace.decisions) {
      const decision = object(rawDecision);
      if (!context.asins.includes(decision.asin as string) || !sameScope(decision.inputScope))
        throw new Error('已保存规则判定 ASIN 或范围不匹配');
    }
    if (trace.contexts !== undefined) {
      if (!Array.isArray(trace.contexts)) throw new Error('已保存规则上下文格式无效');
      for (const rawContext of trace.contexts) {
        const item = object(rawContext);
        if (!context.asins.includes(item.asin as string) || !sameScope(item.inputScope))
          throw new Error('已保存规则上下文范围不匹配');
        for (const key of ['evidence', 'needs']) {
          if (!Array.isArray(item[key])) throw new Error('已保存规则上下文格式无效');
          item[key].forEach(validateSource);
        }
      }
    }
  }
  validateTrace(analysis.ruleTrace);
  validateTrace(finalDefinition.ruleTrace);
  return value as LocalRuleReport;
}

export function readLocalRuleReportsForExport(context: ExportModuleContext, read: ExportModuleRead): Promise<LocalRuleReport[]> {
  return memo(context, 'local-rule-reports', async () => {
  if (context.asins.length === 0 || context.marketplace !== 'US') return [];
  const query = new URLSearchParams({ projectId: context.projectId, asins: [...context.asins].sort().join(',') });
  const path = `/api/local-rule-reports?${query.toString()}`;
  async function snapshot() {
    const body = object(await json(read, path, '已保存规则报告'));
    if (!Array.isArray(body.reports)) throw new Error('已保存规则报告响应格式无效');
    return body.reports.map(item => validLocalReport(item, context));
  }
  const first = await snapshot();
  const second = await snapshot();
  if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error('已保存规则报告在读取期间变化，请重新准备');
  return first.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id));
  });
}

export function readRunReportsForExport(context: ExportModuleContext, read: ExportModuleRead): Promise<AnalysisReport[]> {
  return memo(context, 'run-reports', async () => {
  if (!context.currentRunId) return [];
  const runId = context.currentRunId;
  const run = GetRunResponseSchema.safeParse(await json(read, `/v1/runs/${encodeURIComponent(runId)}`, '分析运行'));
  if (!run.success || run.data.run.id !== runId || run.data.run.projectId !== context.projectId)
    throw new Error('分析运行与项目来源不匹配');
  const selection = run.data.evidenceSelection;
  if (!selection && !sameAsins(context.asins, context.sourceAsins)) return [];
  if (selection && (selection.organizationId !== context.organizationId || selection.projectId !== context.projectId
    || !sameAsins(selection.selectedAsins, context.asins))) return [];
  async function snapshot() {
    const parsed = ListReportsResponseSchema.safeParse(await json(read, `/v1/runs/${encodeURIComponent(runId)}/reports`, '已保存分析报告'));
    if (!parsed.success || parsed.data.reports.some(report => report.runId !== runId)) throw new Error('已保存分析报告来源不匹配');
    for (const report of parsed.data.reports) {
      const result = object(report.result);
      if (result.evidenceSelection === undefined) continue;
      const nested = VocEvidenceManifestSchema.safeParse(result.evidenceSelection);
      if (!nested.success) throw new Error('已保存分析报告证据范围无效');
      assertManifestScope(nested.data, context, selection);
      const identity = result.identity;
      if (identity && typeof identity === 'object' && !Array.isArray(identity)
        && 'inputFingerprint' in identity && identity.inputFingerprint !== nested.data.fingerprint) {
        throw new Error('已保存分析报告输入指纹不匹配');
      }
    }
    return parsed.data.reports;
  }
  const first = await snapshot();
  const second = await snapshot();
  if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error('已保存分析报告在读取期间变化，请重新准备');
  return first;
  });
}

function assertManifestScope(manifest: VocEvidenceManifest, context: ExportModuleContext, runSelection?: VocEvidenceManifest): void {
  if (manifest.organizationId !== context.organizationId || manifest.projectId !== context.projectId
    || manifest.marketplace !== context.marketplace || !sameAsins(manifest.selectedAsins, context.asins)
    || (context.version && manifest.baseSyncRunId !== context.version.runId)) throw new Error('已保存分析报告证据范围不匹配');
  if (runSelection && (manifest.fingerprint !== runSelection.fingerprint
    || manifest.baseSyncRunId !== runSelection.baseSyncRunId || manifest.sourcePolicy !== runSelection.sourcePolicy
    || manifest.sourceMode !== runSelection.sourceMode)) throw new Error('已保存分析报告证据指纹与运行不匹配');
}

export function selectedReport(reports: readonly AnalysisReport[], stage: AnalysisReport['stage']): AnalysisReport | null {
  return [...reports].filter(report => report.stage === stage && report.status === 'complete')
    .sort((a, b) => b.version - a.version || Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null;
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

/** Replays the page's existing pure display builder only on explicitly scoped, already read sources. */
export function buildCurrentPageAnalysis(context: ExportModuleContext, manual: readonly ManualAlexaVocRecord[]): ProductLaunchAnalysis | null {
  if (!context.version || context.marketplace !== 'US' || context.asins.length === 0) return null;
  const products: LaunchProductInput[] = context.asins.map(asin => {
    const matches = context.version!.catalog.filter(item => item && typeof item === 'object' && 'asin' in item && item.asin === asin);
    if (matches.length > 1) throw new Error('商品目录来源重复');
    const item = matches[0];
    if (!item || typeof item !== 'object') throw new Error(`${asin} 缺少已发布商品资料，无法还原页面清单`);
    const p = item as Record<string, unknown>;
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
  return hasProductLaunchAnalysis(products, sources) ? buildProductLaunchAnalysis(products, sources) : null;
}
