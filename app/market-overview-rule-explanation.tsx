import {overviewPeriodLabel} from '../shared/market-overview-period';
import React from 'react';
import type {z} from 'zod';
import type {MarketOverviewReportEntrySchema} from '../shared/market-overview-report-contracts';
import type {MarketSemanticRecord} from '../shared/market-semantic-contracts';

type Semantic=Extract<MarketSemanticRecord,{task:'market-overview-explanation'}>;
const formulas:Record<string,string>={
 'overview-response-group-share/v1':'该行数值 ÷ 同一返回分组的有效合计 × 100%。商品数、销量、销售额各用自己的分母；不同接口、全样本与新品子集不混算。',
 'overview-response-row-value/v1':'读取已保存的返回行数值及已确认单位，不把它扩展为整个类目市场规模。',
 'overview-reported-sample-month-change/v1':'（本月数值 ÷ 上月数值 − 1）× 100%。须有可比样本数量、有效数值和相同单位；上月为零时不计算。样本数量相同不证明每个商品相同。',
};

/** Explains the saved versions and references only; does not calculate new business values. */
export function MarketOverviewRuleExplanation({entry,semantic}:{entry:z.infer<typeof MarketOverviewReportEntrySchema>;semantic:Semantic|null}){
 const r=entry.report,versions=[...new Set(semantic?.metrics.map(m=>m.formulaVersion)??[])];
 return <details className="market-research-boundaries"><summary>本报告的分析规则</summary>
  <p>统计范围：{r.scope.marketplace} · 类目 {r.scope.nodeIdPath} · {overviewPeriodLabel(r.scope)}；数据截止 {r.dataCutoffAt}。</p>
  <p>规则版本：{r.versions.rule}；执行版本：{r.versions.planner}。以下说明对应已保存报告，历史读取不重新采集。</p>
  <p>来源缺失、范围冲突和单位未确认均保留缺失原因，不补零。模型只解释本报告绑定的事实，不能补造数值；模型失败时保留数字和成功结果。</p>
  {semantic?.analysisBrief&&<p>{semantic.analysisBrief.scopeStatement}</p>}
  {versions.length?<ul>{versions.map(version=><li key={version}><strong>{version}</strong>：{formulas[version]??'该公式版本的说明尚未收录，请核对下方保存的指标、来源与原字段；不套用其他版本的公式。'}</li>)}</ul>:<p>此报告尚无可展示的语义指标公式；已保存数字及原始来源仍可核对。</p>}
  {semantic?.metrics.some(m=>m.numeratorRef||m.denominatorRef)&&<details><summary>计算指标的分子与分母</summary><ul>{semantic.metrics.filter(m=>m.numeratorRef||m.denominatorRef).map(m=><li key={m.metricId}>{m.metricId}：分子 {m.numeratorRef??'未指定'}；分母 {m.denominatorRef??'未指定'}；公式 {m.formulaVersion}</li>)}</ul></details>}
 </details>;
}
