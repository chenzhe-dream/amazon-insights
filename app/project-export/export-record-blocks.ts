import type { ExportBlock, ExportCell } from './export-contracts';

export function valueText(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(valueText).join('\n');
  if (typeof value === 'object') return Object.entries(value).map(([key, item]) => `${key}：${valueText(item)}`).join('\n');
  throw new Error('已保存结果包含不支持的字段');
}

export function exportTable(title: string, columns: readonly string[], rows: readonly (readonly unknown[])[]): ExportBlock {
  return { kind: 'table', title, columns, rows: rows.map(row => row.map(value => ({ text: valueText(value) } satisfies ExportCell))) };
}

/** A readable field table for persisted shapes without a dedicated page table. All leaves remain intact. */
export function exportFields(title: string, value: unknown): ExportBlock {
  const rows: [string, string][] = [];
  function visit(node: unknown, path: string) {
    if (Array.isArray(node)) {
      if (!node.length) rows.push([path, '—']);
      else node.forEach((item, index) => visit(item, `${path} · ${index + 1}`));
    } else if (node && typeof node === 'object') {
      const entries = Object.entries(node);
      if (!entries.length) rows.push([path, '—']);
      else entries.forEach(([key, item]) => visit(item, path ? `${path} · ${key}` : key));
    } else rows.push([path, valueText(node)]);
  }
  visit(value, '');
  return exportTable(title, ['字段 / 条目', '已保存内容'], rows);
}
