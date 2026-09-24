import { manualVocDimensions, manualVocDisplayMeta, formatManualVocMatrixText, manualVocSourceBadge } from '../voc-display-schema';
import { buildVocDevelopmentSummary } from '../voc-development-summary';
import type { ExportSection } from './export-contracts';
import type { ExportModuleContext, ExportModuleRead } from './export-module-context';
import { exportFields, exportTable, valueText } from './export-record-blocks';
import { buildExportRuleTrace } from './export-rule-trace';
import { buildCurrentPageAnalysis, publishedReviewRecords, readLocalRuleReportsForExport, readManualVocRecords, readRunReportsForExport, selectedReport } from './read-voc-definition-export';

function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

export async function readVocExportSection(context: ExportModuleContext, read: ExportModuleRead): Promise<ExportSection> {
  const [manual, ruleReports, analysisReports] = await Promise.all([
    readManualVocRecords(context, read), readLocalRuleReportsForExport(context, read), readRunReportsForExport(context, read),
  ]);
  const blocks: ExportSection['blocks'][number][] = [];
  const selected = selectedReport(analysisReports, 'voc-positioning');
  const saved = ruleReports[0];
  const scopedReviews = publishedReviewRecords(context);
  const hasResult = Boolean(manual.length || Object.keys(scopedReviews).length || selected || saved);
  blocks.push({ kind: 'text', text: `来源：${manualVocDisplayMeta.source}；${manualVocDisplayMeta.scope}；提问：${manualVocDisplayMeta.prompt}。读取时间：${context.capturedAt}。` });
  if (manual.length) {
    blocks.push(exportTable('Manual Alexa VOC 来源与完整报告', ['ASIN', '版本与来源', '采集时间', '标题', '评分 / 评论', '星级分布', '完整结论', '采集说明'], manual.map(item => [
      item.asin, manualVocSourceBadge(item), item.capturedAt, item.normalizedRecord.alexaReport.title,
      `${item.normalizedRecord.alexaReport.rating} / ${item.normalizedRecord.alexaReport.reviewCount}`,
      item.normalizedRecord.alexaReport.starBreakdown, item.normalizedRecord.alexaReport.overallConclusion,
      item.normalizedRecord.alexaReport.captureNote,
    ])));
    blocks.push(exportTable('Manual Alexa VOC 七维原始条目', ['维度', ...context.asins], manualVocDimensions.map(dimension => [
      `${dimension.label} · ${dimension.description}`,
      ...context.asins.map(asin => manual.find(item => item.asin === asin)?.normalizedRecord[dimension.key]
        .map(line => formatManualVocMatrixText(line, dimension.key)).join('\n') ?? '该 ASIN 尚未录入 Manual Alexa VOC'),
    ])));
  } else blocks.push({ kind: 'text', text: context.marketplace === 'US' ? '暂无已保存的 Manual Alexa VOC。' : 'Manual Alexa VOC 当前仅支持美国站。' });
  for (const asin of context.asins) {
    if (scopedReviews[asin] !== undefined) blocks.push(exportFields(`${asin} · 已发布 Sorftime 智能评论分析`, scopedReviews[asin]));
    else blocks.push({ kind: 'text', text: `${asin}：暂无已发布 Sorftime 智能评论分析。` });
  }
  if (manual.length || Object.keys(scopedReviews).length) {
    const products = context.asins.map(asin => {
      const product = context.version?.catalog.find(item => record(item).asin === asin);
      return { asin, brand: typeof record(product).brand === 'string' ? record(product).brand as string : '', productFamily: record(product).productFamily as 'scooter' | 'lighting' | 'generic' | undefined };
    });
    const manualMap = Object.fromEntries(manual.map(item => [item.asin, item.normalizedRecord]));
    const summary = buildVocDevelopmentSummary(products, manualMap, scopedReviews as Parameters<typeof buildVocDevelopmentSummary>[2]);
    blocks.push(exportTable('VOC 七维综合分析 · 页面归纳主题', ['维度', '主题', '占比', '来源'], summary.flatMap(dimension => dimension.themes.map(theme => [dimension.label, theme.label, `${theme.mentionPct}%`, valueText(theme)]))));
  } else blocks.push({ kind: 'text', text: 'VOC 七维综合分析：暂无已保存的 VOC 或智能评论来源。' });
  const current = buildCurrentPageAnalysis(context, manual);
  if (current) {
    blocks.push({ kind: 'text', text: `当前页面本地规则 VOC 结论 · 分析时间 ${current.meta.analyzedAt}。以下按当前项目来源和页面规则生成。` });
    for (const [title, rows] of [
      ['VOC 洞察汇总', current.vocInsightRows], ['买家喜爱优先级', current.positivePriorityRows],
      ['差评问题优先级', current.negativePriorityRows], ['未满足需求机会', current.unmetOpportunityRows],
    ] as const) blocks.push(exportFields(`当前页面 · ${title}`, rows));
    blocks.push(exportFields('当前页面 · VOC 产品定位结论', current.vocPositioning));
    blocks.push(...buildExportRuleTrace(current.ruleTrace));
  }
  if (saved) {
    const analysis = saved.analysis;
    blocks.push({ kind: 'text', text: `历史已保存本地规则 VOC 结果 ${saved.id} · ${saved.createdAt} · ${saved.ruleSetVersion}。${saved.inputSourceNote} ${saved.sourceAvailability?.message ?? ''} 此结果不代表当前页面规则结论。` });
    for (const [title, rows] of [
      ['VOC 洞察汇总', analysis.vocInsightRows], ['买家喜爱优先级', analysis.positivePriorityRows],
      ['差评问题优先级', analysis.negativePriorityRows], ['未满足需求机会', analysis.unmetOpportunityRows],
    ] as const) blocks.push(exportFields(title, rows));
    blocks.push(exportFields('VOC 产品定位结论', analysis.vocPositioning));
    blocks.push(exportFields('VOC 分析来源绑定', saved.sourceBindings ?? {}));
  }
  if (selected) {
    blocks.push({ kind: 'text', text: `已保存 VOC 分析报告 ${selected.id} · v${selected.version} · ${selected.status} · ${selected.skill.id}@${selected.skill.version} · 数据截止 ${selected.dataCutoffAt}` });
    blocks.push(exportFields('已保存 VOC 报告证据来源', selected.evidence));
    const result = record(selected.result);
    const insight = record(result.insight);
    if (typeof insight.summary !== 'string' || !Array.isArray(insight.sevenDimensions)) throw new Error('已保存 VOC 分析报告格式无效');
    blocks.push({ kind: 'text', text: `VOC 总结：${insight.summary}` });
    blocks.push(exportTable('已保存 VOC 七维分析', ['维度', '反馈与证据'], insight.sevenDimensions.flatMap(raw => {
      const dimension = record(raw);
      if (typeof dimension.dimension !== 'string' || !Array.isArray(dimension.rows)) throw new Error('已保存 VOC 七维结果格式无效');
      return dimension.rows.map(row => [dimension.dimension, valueText(row)]);
    })));
    for (const [title, value] of [
      ['差评问题优先级', insight.negativePriorities], ['未满足机会', insight.unmetOpportunities],
      ['产品方向', insight.productDirections], ['机会评分', insight.scoredOpportunities],
      ['最终判断', insight.finalDecision], ['VOC 定位投影', result.positioningProjection],
    ] as const) blocks.push(exportFields(`已保存 VOC 报告 · ${title}`, value));
  }
  if (!hasResult) blocks.push({ kind: 'text', text: '暂无已保存的 VOC 分析结果；导出不会启动分析。' });
  return { id: 'voc', title: 'VOC 分析', status: hasResult ? 'ready' : 'missing', blocks };
}
