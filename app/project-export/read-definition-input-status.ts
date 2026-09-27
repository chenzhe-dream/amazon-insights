import { AlexaVocNormalizationStatusResponseSchema, type ManualAlexaVocRecord } from '../../shared/agent-contracts';
import { vocNormalizationFailureMessage } from '../lib/voc-normalization-message';
import type { ExportModuleContext, ExportModuleRead } from './export-module-context';

export type DefinitionInputStatus = Readonly<{ kind: 'failure' | 'pending'; message: string }>;

/** Read only: never polls for completion, applies a result or retries a model task. */
export async function readDefinitionInputStatus(context: ExportModuleContext, manual: readonly ManualAlexaVocRecord[], read: ExportModuleRead): Promise<DefinitionInputStatus | null> {
  if (!context.currentRunId || context.marketplace !== 'US' || !context.version || !context.asins.length) return null;
  const query = new URLSearchParams({ projectId: context.projectId, runId: context.currentRunId, marketplace: 'US' });
  context.asins.forEach(asin => query.append('asins', asin));
  async function snapshot() {
    const response = await read(`/api/alexa-voc/pending?${query}`);
    if (!response.ok) throw new Error('VOC 保存状态读取失败，请重试');
    const parsed = AlexaVocNormalizationStatusResponseSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error('VOC 保存状态响应格式无效');
    const records = parsed.data.records;
    if (records.some(record => !context.asins.includes(record.asin)) || new Set(records.map(record => record.asin)).size !== records.length)
      throw new Error('VOC 保存状态来源范围不匹配');
    return records.toSorted((a, b) => a.asin.localeCompare(b.asin));
  }
  const first = await snapshot();
  const second = await snapshot();
  if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error('VOC 保存状态在读取期间变化，请重新准备');
  const failure = vocNormalizationFailureMessage(first);
  if (failure) return { kind: 'failure', message: failure };
  const pending = first.filter(record => {
    if (record.status !== 'success') return true;
    const saved = manual.find(item => item.asin === record.asin);
    return !saved || BigInt(saved.revision) < BigInt(record.revision!);
  }).map(record => record.asin);
  return pending.length ? { kind: 'pending', message: `正在等待 ${pending.join('、')} 的 VOC 规范化或保存完成。` } : null;
}
