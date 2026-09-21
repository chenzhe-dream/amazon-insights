"use client";
import React from 'react';
import type {z} from 'zod';
import type {MarketOverviewSavedSynthesisSchema} from '../shared/market-overview-report-contracts';
import type {MarketOverviewSynthesisStatement} from '../shared/market-overview-reduction-contracts';
import type {MarketSemanticRecord} from '../shared/market-semantic-contracts';

type Overview=Extract<MarketSemanticRecord,{task:'market-overview-explanation'}>;
type Synthesis=z.infer<typeof MarketOverviewSavedSynthesisSchema>;
const decisions={'insufficient-evidence':'证据不足','exploratory-opportunity':'待验证的机会线索','competitive-risk':'竞争风险线索','mixed-signals':'信号不一致'};
const gapReasons:Record<string,string>={'not-collected':'尚未采集','collection-failed':'采集失败','field-absent':'来源未返回字段','invalid-source':'来源限制尚未解除','unit-unknown':'单位尚未确认','period-incompatible':'统计周期不兼容'};

/** Saved source values fill model references. Prose and source labels remain text. */
export function MarketOverviewSynthesis({synthesis,semantic,dimensionPrefix}:{synthesis:Synthesis;semantic:Overview|null;dimensionPrefix?:string}){
 if(!semantic)return <p>此版本的综合依据尚不可用，已保存报告仍保留。</p>;
 const facts=new Map(semantic.facts.map(f=>[f.factId,f])),metrics=new Map(semantic.metrics.map(m=>[m.metricId,m]));
 const labels=new Map(semantic.analysisBrief?.factLabels.map(f=>[f.factId,f.label])),dimensions=new Map(semantic.analysisBrief?.dimensions.map(d=>[d.id,d.label]));
 const groups=new Map(synthesis.gapGroups.map(g=>[g.gapGroupId,g]));
 const metricText=(id:string)=>{const m=metrics.get(id);if(!m)return '引用指标不可用';const text=new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(m.value);return m.unit.unit==='currency'?`${m.unit.currency??'币种未确认'} ${text}`:m.unit.unit==='percent'?`${text}%`:m.unit.unit==='ratio'?`${text}（比例原值）`:text;};
 function renderStatement(value:MarketOverviewSynthesisStatement){
  const allowed=new Set<string>();const include=(id:string)=>{if(allowed.has(id))return;allowed.add(id);const m=metrics.get(id);for(const dependency of [m?.numeratorRef,m?.denominatorRef])if(dependency)include(dependency);};
  value.factIds.forEach(id=>facts.get(id)?.metricRefs.forEach(include));
  return <div className="market-overview-statement"><p>{value.parts.map((part,i)=>part.kind==='text'?<React.Fragment key={i}>{part.text}</React.Fragment>:part.kind==='fact-label'?<span key={i}>{value.factIds.includes(part.factId)?labels.get(part.factId)??'引用标签不可用':'引用标签不可用'}</span>:<span key={i} title={allowed.has(part.metricId)?String(metrics.get(part.metricId)?.value??'未知'):'未知'}>{allowed.has(part.metricId)?metricText(part.metricId):'引用指标不可用'}</span>)}</p>
   <details><summary>查看综合依据</summary><ul>{value.factIds.map(id=>{const fact=facts.get(id);return <li key={id}>{labels.get(id)??'对应事实'}{!fact?'：引用事实不可用':<><ul>{fact.metricRefs.map(ref=>{const metric=metrics.get(ref);return <li key={ref}>{metricText(ref)}<small>指标：{ref}</small><small>统计周期：{!metric||metric.period.kind==='unknown'?'来源未确认':metric.period.kind==='calendar-months'?`${metric.period.fromMonth} 至 ${metric.period.toMonth}`:'以来源声明范围为准'}</small>{metric?.denominatorRef&&<small>分母指标：{metric.denominatorRef}</small>}</li>;})}</ul><small>来源：{fact.sourceRefs.join('；')}</small></>}</li>;})}
    {value.gapGroupIds.map(id=>{const group=groups.get(id);return <li key={id}>限制：{group?gapReasons[group.reason]??group.reason:'引用缺口不可用'}{group&&<><small>范围：{group.scopeKey}</small><small>缺口：{group.originalGapIds.join('；')}</small><small>来源：{group.sourceRefs.length?group.sourceRefs.join('；'):'此项尚无来源'}</small></>}</li>;})}</ul></details>
  </div>;
 }
 const renderChild=(child:Synthesis['dimensionChildren'][number])=><section key={child.childId}><h5>{dimensions.get(child.section.dimensionId)??child.section.dimensionId}</h5><dl><dt>数据表现</dt><dd>{renderStatement(child.section.data)}</dd><dt>数据含义</dt><dd>{renderStatement(child.section.meaning)}</dd><dt>结论</dt><dd>{renderStatement(child.section.conclusion)}</dd><dt>限制</dt><dd>{child.section.limitations.map((value,i)=><React.Fragment key={i}>{renderStatement(value)}</React.Fragment>)}</dd><dt>待验证</dt><dd>{child.section.verification.map((value,i)=><React.Fragment key={i}>{renderStatement(value)}</React.Fragment>)}</dd></dl></section>;
 if(dimensionPrefix){const children=synthesis.dimensionChildren.filter(child=>child.section.dimensionId===dimensionPrefix||child.section.dimensionId.startsWith(dimensionPrefix+':'));return children.length?<div className="ss-report-analysis" aria-label="本节已保存分析">{children.map(renderChild)}</div>:null;}
 const result=synthesis.result;
 return <section className="market-overview-analysis" aria-label="已保存综合解释"><h4>跨维综合判断</h4><p className="market-research-note">综合解释已保存；来源缺口和样本范围限制继续适用。</p>
  <strong>{decisions[result.summary.decision]}</strong>{renderStatement(result.summary.statement)}
  <dl><dt>矛盾信号</dt><dd>{result.conflicts.length?result.conflicts.map((value,i)=><React.Fragment key={i}>{renderStatement(value)}</React.Fragment>):<p>本次综合未列出明确矛盾，仍需结合下方限制解读。</p>}</dd>
   <dt>限制</dt><dd>{result.limitations.map((value,i)=><React.Fragment key={i}>{renderStatement(value)}</React.Fragment>)}</dd><dt>待验证</dt><dd>{result.verification.map((value,i)=><React.Fragment key={i}>{renderStatement(value)}</React.Fragment>)}</dd></dl>
  <details className="market-research-boundaries"><summary>各维度综合依据</summary>{synthesis.dimensionChildren.map(renderChild)}</details>
 </section>;
}
