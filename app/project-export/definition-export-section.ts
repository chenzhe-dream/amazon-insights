import { ProductDefinitionOutputSchema } from '../../shared/product-definition-output';
import { buildFinalProductDefinition } from '../final-product-definition';
import type { ExportBlock, ExportSection } from './export-contracts';
import type { ExportModuleContext, ExportModuleRead } from './export-module-context';
import { exportFields, exportTable } from './export-record-blocks';
import { buildExportRuleTrace } from './export-rule-trace';
import { buildCurrentPageAnalysis, readLocalRuleReportsForExport, readManualVocRecords, readRunReportsForExport, selectedReport } from './read-voc-definition-export';

export async function readDefinitionExportSection(context: ExportModuleContext, read: ExportModuleRead): Promise<ExportSection> {
  const [localReports, reports, manual] = await Promise.all([readLocalRuleReportsForExport(context, read), readRunReportsForExport(context, read), readManualVocRecords(context, read)]);
  const local = localReports[0];
  const saved = selectedReport(reports, 'product-definition');
  const blocks: ExportBlock[] = [];
  const pageAnalysis = buildCurrentPageAnalysis(context, manual);
  const pagePriceBand = pageAnalysis?.marketRows.find(row => row.metric.includes('价格'))?.data ?? pageAnalysis?.productDefinition.targetPrice ?? '待验证';
  const pageReport = pageAnalysis ? buildFinalProductDefinition({
    categoryLabel: pageAnalysis.meta.categoryLabel, productCount: pageAnalysis.meta.productCount,
    dataMonth: pageAnalysis.meta.dataMonth, vocPositioning: pageAnalysis.vocPositioning,
    keyword: pageAnalysis.keywordConclusions, priceBand: pagePriceBand, hasVocData: true,
  }) : null;
  for (const { report, historical } of [
    ...(pageReport ? [{ report: pageReport, historical: false }] : []),
    ...(local ? [{ report: local.finalDefinition, historical: true }] : []),
  ]) {
    if (!report.hasData) throw new Error('已保存的本地产品定义报告缺少结果');
    blocks.push({ kind: 'text', text: historical
      ? `历史已保存规则结果 ${local!.id} · ${local!.createdAt} · ${local!.ruleSetVersion}。${local!.inputSourceNote} ${local!.sourceAvailability?.message ?? ''} 此结果保留为历史版本，不代表当前页面规则结果。`
      : `当前页面本地规则产品定义 · 从当前项目已读取的数据按页面相同的纯规则生成；分析时间 ${report.meta.analyzedAt}。` });
    blocks.push({ kind: 'text', text: `类目：${report.meta.categoryLabel}；竞品：${report.meta.productCount}；数据月：${report.meta.dataMonth}；分析时间：${report.meta.analyzedAt}；来源：${report.meta.sources.join('、')}。` });
    blocks.push({ kind: 'text', text: `完整产品定位：${report.oneLiner}` });
    blocks.push(exportTable('定位要点卡片', ['要点', '内容'], report.oneLinerCards.map(item => [item.label, item.value])));
    blocks.push(exportTable('方向依据', ['依据', '重点', '原文'], report.rationale.map(item => [item.label, item.highlight, item.value])));
    blocks.push(exportTable('机会等级与决策', ['机会等级', '最终判断', '需求依据', '进入方式', '主要风险', '说明'], [[
      report.opportunity.gradeLabel, report.opportunity.judgment, report.opportunity.demandBasis,
      report.opportunity.entryPath, report.opportunity.mainRisks, report.opportunity.note,
    ]]));
    blocks.push(exportTable('VOC 与关键词交叉验证', ['需求主题', 'VOC 证据', '关键词证据', '市场需求', '用户价值', '竞争供给', '综合判断', '产品角色', '优先级', '规则引用'], report.crossRows.map(row => [
      row.theme, row.vocEvidence, row.keywordEvidence, row.marketDemand, row.userValue, row.competition,
      row.judgment, row.role, row.priority, row.ruleDecisionIds?.join('、'),
    ])));
    blocks.push(exportTable('最终产品定义', ['维度', '结论', 'VOC 依据', '关键词依据', '产品动作', '优先级', '待验证', '规则引用'], report.definitionRows.map(row => [
      row.dimension, row.conclusion, row.vocBasis, row.keywordBasis, row.action, row.priority, row.pending, row.ruleDecisionIds?.join('、'),
    ])));
    for (const [key, title] of [
      ['mustHave', '基础版必须具备'], ['differentiation', '核心差异化'], ['optional', '可选配置 / 变体'],
      ['notInV1', '首版暂不开发'], ['p0Avoid', 'P0 避坑与验收方向'],
    ] as const) blocks.push(exportTable(`功能与配置分层 · ${title}`, ['项目', '证据', '规则引用'], report.featureLayers[key].map(row => [row.item, row.evidence, row.ruleDecisionIds?.join('、')])));
    blocks.push(exportTable('关键词承接方案', ['词群类型', '关键词', '产品功能', '页面卖点角度', '适用 SKU', '规则引用'], report.keywordGroups.map(row => [row.type, row.keywords, row.productLink, row.listingAngle, row.skuHint, row.ruleDecisionIds?.join('、')])));
    blocks.push(exportTable('产品方案优先级', ['优先级', '产品方向', '数据证据', '商业影响', '产品动作', '验收方向', '规则引用'], report.priorityRows.map(row => [row.priority, row.direction, row.evidence, row.businessImpact, row.action, row.acceptance, row.ruleDecisionIds?.join('、')])));
    blocks.push(exportTable('风险与下一步验证', ['主要风险', '下一步验证'], Array.from({ length: Math.max(report.risks.length, report.nextValidations.length) }, (_, index) => [report.risks[index], report.nextValidations[index]])));
    blocks.push({ kind: 'text', text: `数据边界：${report.dataBoundary}` });
    if (historical && local?.sourceBindings) blocks.push(exportFields('历史本地报告来源绑定', local.sourceBindings));
    blocks.push(...buildExportRuleTrace(report.ruleTrace ?? (historical ? local?.analysis.ruleTrace : pageAnalysis?.ruleTrace)));
  }
  if (saved) {
    const parsed = ProductDefinitionOutputSchema.safeParse(saved.result);
    if (!parsed.success) throw new Error('已保存新品定义报告格式无效');
    const result = parsed.data;
    blocks.push({ kind: 'text', text: `已保存新品定义报告 ${saved.id} · v${saved.version} · ${saved.status} · ${saved.skill.id}@${saved.skill.version} · 数据截止 ${saved.dataCutoffAt}。` });
    blocks.push(exportFields('分析报告来源证据', saved.evidence));
    blocks.push(exportFields('来源身份与机会等级', { identity: result.identity, opportunity: result.opportunity, evidenceSelection: result.evidenceSelection }));
    blocks.push(exportTable('VOC 与关键词证据交叉验证', ['VOC 主题', '关键词组', 'VOC 证据', '关键词证据', '判断', '产品角色', '优先级'], result.evidenceMatrix.map(row => [row.themeKey, row.keywordGroupId, row.vocEvidenceIds.join('、'), row.keywordEvidenceIds.join('、'), row.judgment, row.productRole, row.priority])));
    blocks.push(exportTable('最终产品定义', ['维度', '结论', 'VOC 证据', '关键词证据', '产品动作', '优先级', '验证状态'], result.finalDefinition.map(row => [row.dimension, row.conclusion, row.vocEvidenceIds.join('、'), row.keywordEvidenceIds.join('、'), row.action, row.priority, row.validationStatus])));
    for (const [key, title] of [
      ['mustHave', '基础版必须具备'], ['differentiation', '核心差异化'], ['optional', '可选配置 / 变体'],
      ['notInV1', '首版暂不开发'], ['p0Avoid', 'P0 避坑'],
    ] as const) blocks.push(exportTable(`功能与配置分层 · ${title}`, ['项目', '证据'], result.configurationLayers[key].map(item => [item.item, item.evidenceIds.join('、')])));
    blocks.push(exportTable('关键词承接方案', ['关键词组', '角色', '产品承接', '页面角度', '适用 SKU', '证据'], result.keywordLanding.map(row => [row.groupId, row.role, row.productLink, row.listingAngle, row.skuHint, row.evidenceIds.join('、')])));
    blocks.push(exportTable('产品方案优先级', ['优先级', '方向', '证据', '动作', '验收方向'], result.priorities.map(row => [row.priority, row.direction, row.evidenceIds.join('、'), row.action, row.acceptance])));
    blocks.push(exportTable('风险与商业验证', ['领域', '状态', '下一步'], result.risks.map(row => [row.area, row.status, row.nextStep])));
    blocks.push(exportFields('商业验证状态', result.commercialValidation));
    blocks.push({ kind: 'text', text: `数据边界：${result.dataBoundary}` });
  }
  if (!pageReport && local) blocks.unshift({ kind: 'text', text: '当前页面暂无可生成的产品定义；以下仅为历史已保存规则结果。' });
  if (!pageReport && !local && !saved) blocks.push({ kind: 'text', text: '暂无与当前项目及完整 ASIN 范围一致的新品定义来源；导出不会启动模型分析。' });
  return { id: 'definition', title: '新品定义', status: pageReport || local || saved ? 'ready' : 'missing', blocks };
}
