import type {SorftimeCategoryDashboardProduct} from './types';
import {referenceSalesGapReason} from './history-status';
import {getReferencePeriodCoverage,REFERENCE_PERIODS} from './rules';

const labels={last3Months:'近3个月',last6Months:'近6个月',y2025:'2025年',y2024:'2024年'};
export function ReferenceHistoryCoverage({products}:{products:SorftimeCategoryDashboardProduct[]}) {
  const coverage=getReferencePeriodCoverage(products);
  const periods=REFERENCE_PERIODS.map(period=>({period,gaps:products.flatMap(p=>{const reason=referenceSalesGapReason(p,period);return reason?[{asin:p.asin,reason}]:[];})}));
  const returned=(count:number)=>{
    const pointCounts=products.map(product=>Math.min(count,product.monthlyTrend.volume.length));
    const months=products.flatMap(product=>product.monthlyTrend.volume.slice(-count).map(point=>point.month)).sort();
    return `${pointCounts.length?Math.min(...pointCounts):0}–${pointCounts.length?Math.max(...pointCounts):0}/${count}个返回点${months.length?`，范围${months[0]}～${months.at(-1)}`:''}`;
  };
  return <div className="shape-history-coverage" aria-label="历史销量数据完整度">
    <div className="shape-history-coverage-summary">{periods.map(({period})=><span key={period}>{labels[period]}：可计算{coverage[period].known}/{coverage[period].total}件{coverage[period].notApplicable?`，不适用${coverage[period].notApplicable}件`:''}{coverage[period].missing?`，待补${coverage[period].missing}件`:''}</span>)}</div>
    <p>近3个月：{returned(3)}；近6个月：{returned(6)}。按最近返回点计算，返回点数不代表连续自然月覆盖。</p>
    {periods.some(p=>p.gaps.length>0)&&<><p>缺失会影响所在分组的合计及全样本占比；已有数据继续展示，缺失不补零。上市前年份按不适用处理。</p>
      <details><summary>查看缺失原因与商品</summary>{periods.filter(p=>p.gaps.length>0).map(({period,gaps})=><div key={period}><strong>{labels[period]} · {gaps.length} 条待补</strong><ul>{gaps.map(gap=><li key={gap.asin}>{gap.asin}：{gap.reason}</li>)}</ul></div>)}</details></>}
  </div>;
}
