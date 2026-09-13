"use client";
import React,{useEffect,useState} from 'react';
import type {z} from 'zod';
import type {MarketOverviewReportEntrySchema,MarketOverviewDetailsResponseSchema} from '../shared/market-overview-report-contracts';
import {readOverviewDetails} from './lib/market-overview-browser';
import {MarketOverviewAnalysis} from './market-overview-analysis';
import {MarketOverviewDistributions} from './market-overview-distributions';
import {MarketOverviewSynthesis} from './market-overview-synthesis';
type Entry=z.infer<typeof MarketOverviewReportEntrySchema>;
type Details=z.infer<typeof MarketOverviewDetailsResponseSchema>;
const metricLabels:Record<string,string>={sampleProducts:'样本商品数',brands:'品牌数',sellers:'卖家数',totalUnits:'样本销量',totalRevenue:'样本销售额',avgPrice:'平均价格',avgUnits:'平均单品销量',avgRatings:'平均评分数',avgRating:'平均评分',productConcentrationRaw:'商品集中度',brandConcentrationRaw:'品牌集中度',sellerConcentrationRaw:'卖家集中度',newCount:'新品数',newAvgPrice:'新品平均价格',newAvgUnits:'新品平均销量',totalUnitsChangePct:'样本销量环比',totalRevenueChangePct:'样本销售额环比'};
const reasons:Record<string,string>={'not-collected':'尚未采集','collection-failed':'采集失败','field-absent':'来源未返回字段','invalid-source':'来源未通过校验','unit-unknown':'单位尚未确认','period-incompatible':'统计周期不兼容'};
const dimensions:Record<string,string>={'sample-scale':'样本规模','concentration':'头部集中度','brand-seller-counts':'品牌与卖家数量','new-product-summary':'新品概况','rating-price-averages':'评分与价格均值','reported-sample-sales-trend':'样本成交趋势','search-demand':'搜索需求','brand-share-distribution':'品牌份额分布','seller-share-distribution':'卖家份额分布','seller-type-distribution':'卖家类型','seller-location-distribution':'卖家所属地','content-aplus-video-distribution':'A+ 与视频配置','listing-age-distribution':'上架年龄分布','listing-trend':'上架趋势','review-count-distribution':'评价数分布','rating-distribution':'评分分布','price-distribution':'价格分布'};
const coverageLabels={available:'本次可用',partial:'部分可用',missing:'本次未取得', 'not-integrated':'尚未接入'};
function value(number:number|null,unit:{status:string;unit?:string;currency?:string}|null){if(number===null||unit?.status!=='known')return '未知';const text=new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(number);return unit.unit==='currency'?`${unit.currency??'USD'} ${text}`:unit.unit==='percent'?`${text}%`:unit.unit==='ratio'?`${text}（比例原值）`:text;}
export function MarketOverviewReport({entry}:{entry:Entry}){
  const [detail,setDetail]=useState<Details|null>(null),[error,setError]=useState<string|null>(null),[reload,setReload]=useState(0);
  useEffect(()=>{const owner=new AbortController();setDetail(null);setError(null);void readOverviewDetails(entry.report.moduleRunId,entry.attemptId,entry.report.reportHash,owner.signal).then(result=>{if(!owner.signal.aborted)setDetail(result);}).catch(e=>{if(!owner.signal.aborted)setError(e instanceof Error?e.message:'报告读取失败');});return()=>owner.abort();},[entry.attemptId,entry.report.moduleRunId,entry.report.reportHash,reload]);
  const r=entry.report,semantic=detail?.semantic?.task==='market-overview-explanation'?detail.semantic:null;
  const fact=(id:string)=>{const f=semantic?.facts.find(f=>f.factId===id);if(!f)return '对应事实尚不可显示';const refs=f.kind==='trend'?f.metricRefs.filter(id=>id.endsWith('ChangePct')):f.metricRefs;return refs.map(ref=>{const m=semantic!.metrics.find(m=>m.metricId===ref);return m?`${ref.split('/')[0]} · ${metricLabels[ref.split('/').at(-1)!]??'来源指标'}：${value(m.value,m.unit)}`:'指标未知';}).join('；');};
  const option=(id:string)=>{const o=semantic?.interpretationOptions.find(o=>o.optionId===id);if(o?.kind==='risk')return '证据缺失限制了结论，需要补充核实。';if(o?.templateId.includes('not-causal'))return '样本成交变化提供趋势线索，不能据此推断原因或整个市场变化。';return '该解释尚未提供可展示的模板。';};
  return <section className="market-research-result" aria-label="已保存总览报告">
    <div className="market-research-result-heading"><h3>{entry.current?'当前总览报告':'历史总览报告'}</h3><span>{r.dataReady?'部分结果':'暂无可用数字'}</span></div>
    <p>美国站 · 类目 {r.scope.nodeIdPath} · {r.scope.fromMonth} 至 {r.scope.toMonth}</p><p className="market-research-note">数据截止：{r.dataCutoffAt}。样本指标不代表整个市场，缺失不会当作零。</p>
    <div className="market-research-notice"><p>{r.reportVersion==='market-overview-report/v2'?'跨维综合解释已保存；来源缺口仍保留，请结合下方依据和限制解读。':r.windowStatus==='complete'?'当前输入的分析分段已执行完成；完整综合判断仍待补齐，请查看下方维度覆盖。':r.windowStatus==='pending'?'数字已保存，解释仍在处理中。':r.windowStatus==='no-input'?'暂无可供解释的有效事实，保留已取得的数字与缺口。':'解释存在失败或缺口，已保存的数字和成功部分继续保留。'}</p></div>
    {error?<p role="alert" className="market-research-error">{error} <button type="button" className="ghost-btn" onClick={()=>setReload(n=>n+1)}>重新读取报告</button></p>:!detail?<p role="status"><span className="market-theme-spinner" aria-hidden="true"/>正在读取此版本报告…</p>:<>
      {detail.numbers.months.map((m,i)=><details key={m.month} open={i===detail.numbers.months.length-1} className="market-research-boundaries"><summary>{m.month} · 已保存指标</summary>{Object.values(m.metrics).some(metric=>metric.observations.some(o=>o.scopeBasis==='request-bound'))&&<p className="market-research-note">按所选月份请求；上游响应未确认范围。以下为返回样本数字，不据此生成已验证的月度趋势。</p>}<dl className="market-research-metrics">{Object.entries(m.metrics).map(([id,metric])=><div key={id}><dt>{metricLabels[id]??id}</dt><dd>{value(metric.value,metric.unit)}</dd>{metric.reason&&<small>{reasons[metric.reason]}</small>}</div>)}</dl>
        <details><summary>此月来源与原字段</summary>{Object.entries(m.metrics).map(([id,metric])=><p key={id}>{metricLabels[id]??id}：{metric.observations.length?metric.observations.map(o=>`${o.field} · ${o.sourceRef}`).join('；'):'无有效原字段'}</p>)}</details></details>)}
      {detail.numbers.distributions&&<MarketOverviewDistributions entries={detail.numbers.distributions}/>}
      {r.reportVersion==='market-overview-report/v2'&&<MarketOverviewSynthesis synthesis={r.synthesis} semantic={semantic}/>}
      <h4>基于证据的分段分析</h4>{r.reasons.includes('distribution-synthesis-not-integrated')&&<p className="market-research-notice">分布数字已保存；分布与基础指标的综合模型分析尚未完成。下方已有解释仅覆盖其明确引用的事实。</p>}{r.modelResults.filter(m=>m.output).length===0?<p>此版本尚无成功的模型解释。</p>:r.modelResults.filter(m=>m.output).map(m=><div key={m.attemptId} className="market-overview-finding">{m.output!.analysis&&<MarketOverviewAnalysis analysis={m.output!.analysis} semantic={semantic} synthesisComplete={r.reportVersion==='market-overview-report/v2'}/>} {m.output!.findings.map(f=><div key={f.findingId}><strong>{f.mode==='observed'?'数据表现':'推断线索'}</strong>{f.mode==='inferred'&&<p>{option(f.optionId)}</p>}<ul>{f.factIds.map(id=><li key={id}>{fact(id)}</li>)}</ul></div>)}{m.output!.risks.map((risk,i)=><p key={`risk-${i}`}>风险：{option(risk.optionId)}</p>)}{m.output!.validationTasks.length>0&&<p>待验证：核对样本代表性、来源和缺失项后，再判断是否适用于整体市场。</p>}</div>)}
    </>}
    <details className="market-research-boundaries"><summary>分析维度覆盖与缺口</summary><ul>{r.coverage.map(c=><li key={c.dimension}>{dimensions[c.dimension]??c.dimension}：{coverageLabels[c.status]}{c.missingMetrics.length?`（缺 ${c.missingMetrics.map(m=>metricLabels[m.split('/').at(-1)!]??m).join('、')}）`:''}</li>)}</ul></details>
    <details className="market-research-boundaries"><summary>报告版本与来源身份</summary><p>报告：{entry.attemptId}</p><p>规则：{r.versions.rule}</p><p>来源响应：{r.sourceRefs.length} 份；报告摘要：{r.reportHash}</p></details>
  </section>;
}
