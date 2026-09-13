"use client";
import React from 'react';
import type {MarketOverviewAnalysis as Analysis} from '../shared/market-overview-analysis-contracts';
import type {MarketSemanticRecord} from '../shared/market-semantic-contracts';
type Overview=Extract<MarketSemanticRecord,{task:'market-overview-explanation'}>;
type Statement=Analysis['summary']['statement'];
const gapReasons:Record<string,string>={'not-collected':'尚未采集','collection-failed':'采集失败','field-absent':'来源未返回字段','invalid-source':'来源限制尚未解除','unit-unknown':'单位尚未确认','period-incompatible':'统计周期不兼容'};
const decisions:Record<Analysis['summary']['decision'],string>={'insufficient-evidence':'证据不足','exploratory-opportunity':'待验证的机会线索','competitive-risk':'竞争风险线索','mixed-signals':'信号不一致'};
/** Only immutable catalog values and labels fill model tokens. Source content is
 * plain React text, never HTML. A missing reference stays visible as unavailable. */
export function MarketOverviewAnalysis({analysis,semantic,synthesisComplete=false}:{analysis:Analysis;semantic:Overview|null;synthesisComplete?:boolean}){
 if(!semantic)return <p>此版本的分析依据尚不可用，已保存报告仍保留。</p>;
 const facts=new Map(semantic.facts.map(f=>[f.factId,f])),metrics=new Map(semantic.metrics.map(m=>[m.metricId,m])),gaps=new Map(semantic.gaps.map(g=>[g.gapId,g]));
 const labels=new Map(semantic.analysisBrief?.factLabels.map(f=>[f.factId,f.label])),dimensions=new Map(semantic.analysisBrief?.dimensions.map(d=>[d.id,d.label]));
 const metricText=(id:string)=>{const m=metrics.get(id);if(!m)return '引用指标不可用';const value=new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(m.value);return m.unit.unit==='percent'?value+'%':m.unit.unit==='currency'?`${m.unit.currency??'币种未确认'} ${value}`:m.unit.unit==='ratio'?value+'（比例原值）':value;};
 function renderStatement(value:Statement){
  const allowedMetrics=new Set(value.factIds.flatMap(id=>facts.get(id)?.metricRefs??[]));
  return <div className="market-overview-statement"><p>{value.parts.map((p,i)=>p.kind==='text'?<React.Fragment key={i}>{p.text}</React.Fragment>:p.kind==='fact-label'?<span key={i}>{value.factIds.includes(p.factId)?labels.get(p.factId)??'引用标签不可用':'引用标签不可用'}</span>:<span key={i} title={allowedMetrics.has(p.metricId)?String(metrics.get(p.metricId)?.value??'未知'):'未知'}>{allowedMetrics.has(p.metricId)?metricText(p.metricId):'引用指标不可用'}</span>)}</p>
   <details><summary>查看本段依据</summary><ul>{value.factIds.map(id=>{const f=facts.get(id);return <li key={id}>{labels.get(id)??'对应事实'}{!f?'：引用事实不可用':<><ul>{f.metricRefs.map(ref=>{const m=metrics.get(ref);return <li key={ref}>{metricText(ref)}<small>统计周期：{!m||m.period.kind==='unknown'?'来源未确认':m.period.kind==='calendar-months'?`${m.period.fromMonth} 至 ${m.period.toMonth}`:'以来源声明范围为准'}</small><small>指标：{ref}</small>{m?.denominatorRef&&<small>分母指标：{m.denominatorRef}</small>}</li>;})}</ul><small>来源：{f.sourceRefs.join('；')}</small></>}</li>;})}{value.gapIds.map(id=>{const g=gaps.get(id);return <li key={id}>限制：{g?gapReasons[g.reason]??g.reason:'引用缺口不可用'}<small>缺口：{id}</small>{g&&<small>来源：{g.sourceRefs.length?g.sourceRefs.join('；'):'此项尚无来源'}</small>}</li>;})}</ul></details>
  </div>;
 }
 return <section className="market-overview-analysis" aria-label="已保存分段解释">
  <p className="market-research-note">{synthesisComplete?'以下保留综合前的分段解释，仅覆盖各段引用的证据。':'以下为已保存的分段解释，仅覆盖各段引用的证据；完整综合判断仍待完成。'}</p>
  {analysis.dimensions.map(d=><section key={d.dimensionId} className="market-overview-analysis-dimension"><h5>{dimensions.get(d.dimensionId)??'分析维度不可用'}</h5><dl>
   <dt>数据表现</dt><dd>{renderStatement(d.data)}</dd><dt>数据含义</dt><dd>{renderStatement(d.meaning)}</dd><dt>结论</dt><dd>{renderStatement(d.conclusion)}</dd>
   <dt>限制</dt><dd>{d.limitations.length?d.limitations.map((s,i)=><React.Fragment key={i}>{renderStatement(s)}</React.Fragment>):<p>本段未列出额外限制；仍受本报告样本范围约束。</p>}</dd>
   <dt>待验证</dt><dd>{d.verification.map((s,i)=><React.Fragment key={i}>{renderStatement(s)}</React.Fragment>)}</dd>
  </dl></section>)}
  <div className="market-overview-analysis-summary"><strong>本段判断：{decisions[analysis.summary.decision]}</strong>{renderStatement(analysis.summary.statement)}</div>
 </section>;
}
