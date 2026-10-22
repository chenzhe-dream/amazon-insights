import type { AlexaVocNormalizationStatus } from '../../shared/agent-contracts';

const reasons = {
  timeout: '请求超时',
  'model-output': '模型输出不符合要求',
  schema: '数据格式校验未通过',
  persistence: '结果尚未保存成功',
  authorization: '保存权限校验未通过',
  configuration: '标准化服务配置异常，原文已保存，请联系管理员修复后重试',
} as const;

/** Business-safe descriptions shared by the live page and its frozen snapshot. */
export function vocNormalizationFailureMessage(records: readonly AlexaVocNormalizationStatus[]): string | null {
  const failed = records.filter(record => record.status === 'failure');
  if (!failed.length) return null;
  return `VOC 格式规范化失败，请回到手工输入处检查或重试。${failed.map(record =>
    `${record.asin}：${record.error ? reasons[record.error] : '处理失败'}`).join('；')}。`;
}
