import {MarketAdminContent} from '../market-admin-tools';
import type {SorftimeCategoryDashboardProduct} from './types';
import {referenceSalesGapReason} from './history-status';
import {getReferencePeriodCoverage,REFERENCE_PERIODS} from './rules';

const labels={last3Months:'近3个月',last6Months:'近6个月',y2025:'2025年',y2024:'2024年'};
export function ReferenceHistoryCoverage({products,calculationVersion,context}:{context?:string;products:SorftimeCategoryDashboardProduct[];calculationVersion?:string}) {
  const coverage=getReferencePeriodCoverage(products,calculationVersion);
  const marginGaps=products.filter(p=>p.grossProfitMargin===null);
  const suppliedMargins=products.filter(p=>p.marginSource?.basis==='detail').length;
  const periods=REFERENCE_PERIODS.map(period=>({period,gaps:products.flatMap(p=>{const reason=referenceSalesGapReason(p,period,calculationVersion);return reason?[{asin:p.asin,reason}]:[];})}));
  const returned=(count:number)=>{
    const pointCounts=products.map(product=>Math.min(count,product.monthlyTrend.volume.length));
    const months=products.flatMap(product=>product.monthlyTrend.volume.slice(-count).map(point=>point.month)).sort();
    return `${pointCounts.length?Math.min(...pointCounts):0}–${pointCounts.length?Math.max(...pointCounts):0}/${count}个返回点${months.length?`，范围${months[0]}～${months.at(-1)}`:''}`;
  };
  return <MarketAdminContent><details className="shape-history-coverage" aria-label="历史销量数据完整度">
    <summary>{context?`${context} · `:''}数据完整度与缺失说明</summary>
    <div className="shape-history-coverage-summary">{periods.map(({period})=><span key={period}>{labels[period]}：可计算{coverage[period].known}/{coverage[period].total}件{coverage[period].notApplicable?`，不适用${coverage[period].notApplicable}件`:''}{coverage[period].missing?`，待补${coverage[period].missing}件`:''}</span>)}</div>
    <p>近3个月：{returned(3)}；近6个月：{returned(6)}。按最近返回点计算，返回点数不代表连续自然月覆盖。</p>
    <p>毛利润率：可用{products.length-marginGaps.length}/{products.length}件，商品详情补充{suppliedMargins}件，待核实{marginGaps.length}件。优先使用商品池原值；仅在同商品、同售价时采用已保存详情的毛利润率。</p>
    {marginGaps.length>0&&<details><summary>查看毛利缺口与商品</summary><ul>{marginGaps.map(p=><li key={p.asin}>{p.asin}：{p.marginSource?.note??'来源未返回可用毛利润率'}</li>)}</ul></details>}
    {(calculationVersion===undefined||calculationVersion==='shape-all-links/3')&&<p>单链月均按全部链接计算；该周期存在缺失时不计算月均。销量缺失时显示已知小计，占比仅以同周期已知销量为分母，不代表完整样本份额。</p>}
    {periods.some(p=>p.gaps.length>0)&&<><p>缺失会影响所在分组的合计及全样本占比；已有数据继续展示，缺失不补零。上市前年份按不适用处理。</p>
      <details><summary>查看缺失原因与商品</summary>{periods.filter(p=>p.gaps.length>0).map(({period,gaps})=><div key={period}><strong>{labels[period]} · {gaps.length} 条待补</strong><ul>{gaps.map(gap=><li key={gap.asin}>{gap.asin}：{gap.reason}</li>)}</ul></div>)}</details></>}
  </details></MarketAdminContent>;
}
