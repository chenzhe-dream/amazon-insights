import type {SorftimeCategoryDashboardProduct} from './types';
import {referenceSalesGapReason} from './history-status';
import {REFERENCE_PERIODS} from './rules';

const labels={last3Months:'近3个月',last6Months:'近6个月',y2025:'2025年',y2024:'2024年'};
export function ReferenceHistoryCoverage({products}:{products:SorftimeCategoryDashboardProduct[]}) {
  const periods=REFERENCE_PERIODS.map(period=>({period,gaps:products.flatMap(p=>{const reason=referenceSalesGapReason(p,period);return reason?[{asin:p.asin,reason}]:[];})}));
  return <div className="shape-history-coverage" aria-label="历史销量数据完整度">
    <div className="shape-history-coverage-summary">{periods.map(({period,gaps})=><span key={period}>{labels[period]}：{products.length-gaps.length}/{products.length} 可计算</span>)}</div>
    {periods.some(p=>p.gaps.length>0)&&<><p>缺失会影响所在分组的合计及全样本占比；已有数据继续展示，缺失不补零。上市前年份按不适用处理。</p>
      <details><summary>查看缺失原因与商品</summary>{periods.filter(p=>p.gaps.length>0).map(({period,gaps})=><div key={period}><strong>{labels[period]} · {gaps.length} 条待补</strong><ul>{gaps.map(gap=><li key={gap.asin}>{gap.asin}：{gap.reason}</li>)}</ul></div>)}</details></>}
  </div>;
}
