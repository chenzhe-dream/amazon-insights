import type { ReviewContext } from '../../shared/review-context';
import type { SellerSpriteReviewAnalysisRecord } from '../seller-sprite-review-analysis';

export function describeReviewCoverage(record?: SellerSpriteReviewAnalysisRecord, context?: ReviewContext, missingMessage?: string) {
  const page = context?.page;
  const pageNote = !page ? '商品页尚未核查；接口为空不能直接认定本地没有评论。'
    : page.status === 'not-found' ? '页面不可访问：本次显示 Page Not Found；未证明永久下架或 ASIN 填写错误。历史样本继续保留。'
    : page.status === 'unavailable' ? '商品页面可打开，但当前不可售。'
    : page.status === 'available' ? '商品页面可打开，已核对当前页 ASIN。' : '商品页面状态未核实。';
  if (record?.status === 'error' || (!record && /失败|超时|无法解析/.test(missingMessage ?? ''))) return {reason:'请求失败或结果读取失败，不能判定评论为空。',next:'检查连接器响应、权限和超时原因后定向重试。',pageNote};
  const samples = record?.sampledReviews ?? 0;
  const topics = record?.mentionTopics ?? 0;
  if (samples > 0 || topics > 0) {
    const ready = record?.blocks.filter(b => b.rows.length > 0).length ?? 0;
    return {reason: ready === 0 ? `已取得 ${samples} 条样本；${record?.statusMessage || '未提取到具体主题，待补充。'}` : `已取得 ${samples} 条评论样本${topics ? `、${topics} 个主题提及` : ''}；${ready}/6 维度有主题${ready < 6 ? '，其余维度待补' : ''}。`,next: samples > 0 && samples < 10 ? '样本少于 10 条，仅作线索参考；保留已有样本，补充同站点正文后再分析。' : '缺少主题的维度保留待补，不把未提及解释为没有需求。',pageNote};
  }
  if (page?.localReviews === 'zero') return {reason:'页面确认本地评论为 0（核查时点）；接口未返回可用本地样本。',next:'等待本地评论新增，或补充可核验的本地历史导出；国际评论仅作独立参考。',pageNote};
  if (page?.status === 'not-found') return {reason:'商品链接当前不可访问，本地评论来源待核实。',next:'核对有效同站点链接、原 ASIN 与父子体关系；不能用相似商品或其他站点样本替换。',pageNote};
  if (record?.terminalReason === 'valid-empty') return {reason:'接口返回 0 条，具体原因未核实。',next:'核对本地商品页、站点、分页与接口限制，确认后再定向补采。',pageNote};
  return {reason:missingMessage || '尚无可核验的评论结果。',next:'先读取当前项目结果，获取可核验证据后再判断缺失原因。',pageNote};
}
