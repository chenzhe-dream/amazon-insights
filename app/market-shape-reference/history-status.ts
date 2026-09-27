import type {SorftimeCategoryDashboardProduct} from './types';
import {hasReferencePeriodDateConflict,referencePeriodContribution,type ReferencePeriod} from './rules';

const errors:Record<string,string>={timeout:'等待上游超时',authentication:'来源认证失败',governance:'额度或调用策略限制','upstream-temporary':'上游暂不可用','upstream-permanent':'上游拒绝请求','invalid-data':'数据校验未通过','scope-mismatch':'来源范围不匹配',interrupted:'请求中断',internal:'处理失败'};

/** Explain missing values from persisted request state; never infer a failed connection from null. */
export function referenceSalesGapReason(product:SorftimeCategoryDashboardProduct,period:ReferencePeriod):string|null {
  if(hasReferencePeriodDateConflict(product,period))return '上市日期与历史销量冲突';
  if(referencePeriodContribution(product,period)!==null)return null;
  const history=product.salesHistory;
  if(!history)return '缺少历史销量，原因尚未确认';
  if(history.status==='queued')return '历史销量排队中';
  if(history.status==='running')return '历史销量采集中';
  if(history.status==='failed')return `历史销量请求失败（${errors[history.errorCode??'']??'请查看采集步骤'}）`;
  if(history.status==='cancelled')return '历史销量采集已取消';
  const points=product.monthlyTrend.volume;
  const relevant=period==='last3Months'?points.slice(-3):period==='last6Months'?points.slice(-6):points.filter(p=>p.month.startsWith(period.slice(1)+'-'));
  if(relevant.some(p=>p.value===null))return '返回数据缺失或校验未通过';
  return '来源未返回该期间的历史销量';
}
