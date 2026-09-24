import { checklistSourceLabels, parseTableCellOptions, type LaunchChecklistEntry, type LaunchChecklistStructuredTable } from '../launch-checklist';
import type { ExportBlock, ExportSection } from './export-contracts';
import type { ExportModuleContext, ExportModuleRead } from './export-module-context';
import { exportTable } from './export-record-blocks';
import { buildExportRuleTrace } from './export-rule-trace';
import { buildCurrentPageAnalysis, catalogGapNote, readManualVocRecords } from './read-voc-definition-export';

function table(title: string, input: LaunchChecklistStructuredTable): ExportBlock {
  return exportTable(title, input.headers, input.rows.map(row => row.map(cell =>
    cell.source === 'auto' ? cell.text || '—' : parseTableCellOptions(cell.text) ? '待人工确认（未保存）' : cell.text || '待人工填写（未保存）')));
}

export async function readChecklistExportSection(context: ExportModuleContext, read: ExportModuleRead): Promise<ExportSection> {
  const manual = await readManualVocRecords(context, read);
  const blocks: ExportBlock[] = catalogGapNote(context).map(text => ({ kind: 'text', text }));
  const analysis = buildCurrentPageAnalysis(context, manual);
  if (!analysis) {
    blocks.push({ kind: 'text', text: '暂无与当前项目范围一致的立项清单系统来源；导出不会启动分析。' });
    return { id: 'checklist', title: '立项前确认清单', status: 'missing', blocks };
  }
  if (!Array.isArray(analysis.checklist) || !analysis.checklistMeta || !analysis.checklistResearch) throw new Error('当前立项清单格式无效');
  blocks.push({ kind: 'text', text: `产品立项前确认清单 ${analysis.checklistMeta.version} · 按页面相同的本地规则从当前项目已读取的数据生成系统回填；规则分析时间 ${analysis.meta.analyzedAt}。` });
  blocks.push({ kind: 'text', text: '以下为按当前项目来源及页面规则生成的系统回填值和检查项。页面中的人工勾选、手填文字及表格编辑仅保存在当前组件内，未写入项目结果，因此本次导出不包含这些未保存编辑；“待人工确认/填写”不代表已验证。' });
  blocks.push(exportTable('调研数据回填 · 当前页面系统值', ['字段', '内容'], Object.entries(analysis.checklistResearch).map(([key, value]) => [key, value])));
  blocks.push(exportTable('清单范围与政策', ['字段', '内容'], Object.entries(analysis.checklistMeta).map(([key, value]) => [key, value])));
  const sectionOrder = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  const ordered = [...analysis.checklist].sort((a, b) => sectionOrder.indexOf(a.section) - sectionOrder.indexOf(b.section));
  for (const group of ordered) {
    const title = `第${group.section}部分 · ${group.title}`;
    blocks.push({ kind: 'text', text: `${title}${group.description ? `；${group.description}` : ''}` });
    if (group.competitorTable) blocks.push(table(`${title} · 竞品快照（系统抓取）`, group.competitorTable));
    if (group.structuredTable) blocks.push(table(`${title} · 结构化检查表`, group.structuredTable));
    const entries: LaunchChecklistEntry[] = group.entries ?? group.items.map((label, index) => ({ id: `${group.id}-${index}`, label, source: 'manual' as const }));
    blocks.push(exportTable(`${title} · 逐项确认`, ['来源', '检查项', '当前页面系统值', '人工状态'], entries.map(entry => [
      checklistSourceLabels[entry.source], entry.label, entry.autoValue || '—', entry.source === 'auto' ? '系统抓取' : '待人工确认（未保存）',
    ])));
  }
  blocks.push(...buildExportRuleTrace(analysis.ruleTrace));
  return { id: 'checklist', title: '立项前确认清单', status: 'ready', blocks };
}
