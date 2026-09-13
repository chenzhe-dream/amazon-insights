'use client';
import React,{useState} from 'react';
import type {MarketKeywordRuleReport} from '../shared/market-keyword-rule-report-contracts';

const number=(value:number|null)=>value===null?'未知':value.toLocaleString('zh-CN',{maximumFractionDigits:2});
const percent=(value:number|null)=>value===null?'未知':`${(value*100).toFixed(1)}%`;
const components={S1:'规模',S2:'增长',S3:'竞争',S4:'执行成本',S5:'价值空间'};
const fields={threeMonthGrowth:'较3个月前增长',supplyDemandRatio:'供需比',abaTop3Share:'ABA 前三份额',spr:'SPR',suggestedBid:'同币种推荐竞价',averagePrice:'关联商品均价'};
function reason(value:string|null){
 if(!value)return '';
 if(value.includes('zero-baseline'))return '基期为零，不能计算增长率';
 if(value.includes('baseline'))return '缺少可比基期';
 if(value.includes('current'))return '缺少完整参考月数据';
 if(value.includes('conflict'))return '来源存在冲突，待核对';
 if(value.includes('currency'))return '来源币种未确认';
 return '当前来源不足，待补充验证';
}
function Pages<T>({items,label,render}:{items:readonly T[];label:string;render:(rows:readonly T[])=>React.ReactNode}){
 const [page,setPage]=useState(0),last=Math.max(0,Math.ceil(items.length/20)-1),current=Math.min(page,last),start=current*20;
 return <section aria-label={label}>{items.length?render(items.slice(start,start+20)):<p>暂无可计算的需求簇；原词趋势仍保留。</p>}<div className="market-theme-actions"><span>{items.length?`${start+1}–${Math.min(start+20,items.length)} / ${items.length}`:'0 项'}</span><button type="button" className="ghost-btn" disabled={current===0} onClick={()=>setPage(current-1)} aria-label={`${label}上一页`}>上一页</button><button type="button" className="ghost-btn" disabled={current===last} onClick={()=>setPage(current+1)} aria-label={`${label}下一页`}>下一页</button></div></section>;
}
/** Only service-verified, version-bound rules are rendered. No scoring is run in the browser. */
export function MarketKeywordRulesReport({report}:{report:MarketKeywordRuleReport}){
 return <section aria-label="关键词 W5 与 PVS 规则报告" className="market-research-result"><h4>W5 需求变化与 PVS 评分</h4>
  <p>{report.classification.kind==='manual'?'使用本次保存的人工分类':report.classification.kind==='global'?'使用当前跨批归并分类':'尚无可用分类，先显示原词趋势'} · 参考月 {report.referenceMonth}。所有原词参与分母计算，分页不改变统计范围。</p>
  <p>“较3个月前”比较参考月与3个月前的完整月搜索量，与环比不同。季节性、生命周期仍缺少诊断依据；负增长本身不等于结构性衰退。</p>
  <details><summary>查看 W5 原词趋势与来源</summary><Pages key={report.reportId} items={report.keywords} label="W5 原词趋势" render={rows=><div className="market-shape-table" role="region" aria-label="W5 原词趋势表" tabIndex={0}><table><thead><tr><th>关键词</th><th>参考月搜索量</th><th>同比</th><th>环比</th><th>较3个月前</th><th>来源与基期</th></tr></thead><tbody>{rows.map(row=><tr key={row.keywordId}><th>{row.keyword}</th>{(['searchVolume','yoyGrowth','recentGrowth','threeMonthGrowth'] as const).map(field=>{const m=row.w5[field];return <td key={field}>{field==='searchVolume'?number(m.value):percent(m.value)}{m.value===null&&<small> · {reason(m.reason)}</small>}</td>;})}<td><details><summary>计算依据</summary>{(['yoyGrowth','recentGrowth','threeMonthGrowth'] as const).map(field=>{const m=row.w5[field];return <p key={field}>{field==='yoyGrowth'?'同比':field==='recentGrowth'?'环比':'较3个月前'}：{m.referenceMonth}（{number(m.currentValue)}） / {m.baselineMonth}（{number(m.baselineValue)}）；{m.formulaVersion}</p>;})}<p>趋势采集时间：{row.w5.searchVolume.source?.fetchedAt??'未知'}</p><p>来源：{row.w5.searchVolume.source?.sourceRef??'缺失'}</p><p>实际 CPC 未知；推荐竞价不能代替实际 CPC。</p></details></td></tr>)}</tbody></table></div>}/></details>
  <p>已知参考月搜索量小计 {number(report.aggregation.pool.knownSearchVolume)}；完整词池分母 {number(report.aggregation.pool.totalSearchVolume)}；未分组 {report.aggregation.unassigned.memberCount} 词。PVS 是经验排序，售价分项不等于毛利，分数不代表成功概率。</p>
  <Pages key={`scores:${report.reportId}`} items={report.clusters} label="PVS 需求簇评分" render={rows=><div className="market-shape-table" role="region" aria-label="PVS 需求簇评分表" tabIndex={0}><table><thead><tr><th>需求簇</th>{Object.entries(components).map(([id,label])=><th key={id}>{id} {label}</th>)}<th>PVS</th><th>依据与缺口</th></tr></thead><tbody>{rows.map(row=><tr key={row.clusterId}><th>{row.label}</th>{(Object.keys(components) as Array<keyof typeof components>).map(field=><td key={field}>{number(row.score.scores[field])}</td>)}<td>{row.score.pvs===null?'待验证':number(row.score.pvs)}</td><td><p>{row.score.missingComponents.length?`缺少分项：${row.score.missingComponents.map(k=>components[k]).join('、')}`:'五项分数已计算'}</p><details><summary>评分依据</summary><p>较3个月前增长：{percent(row.threeMonthGrowth.metric.value)}；已知 {row.threeMonthGrowth.coverage.knownValueCount} 词，未知 {row.threeMonthGrowth.coverage.unknownValueCount} 词；实际加权 {row.threeMonthGrowth.coverage.weightedMemberCount} 词。</p>{(Object.keys(fields) as Array<keyof typeof fields>).map(field=><p key={field}>{fields[field]}：{row.metrics[field].value===null?reason(row.metrics[field].missingReason):(field==='threeMonthGrowth'||field==='abaTop3Share'?percent(row.metrics[field].value):number(row.metrics[field].value))}</p>)}<p>相同数值或单个样本无法形成有效区分；部分来源的增长分数仅供参考，缺少分项时不补分、不放大剩余权重。</p></details></td></tr>)}</tbody></table></div>}/>
  <details className="market-research-boundaries"><summary>规则与报告版本</summary><p>评分规则：{report.ruleVersion}<br/>事实基线：{report.factsId}<br/>分类版本：{report.classification.identity??'尚未分类'}<br/>报告版本：{report.reportId}</p></details>
 </section>;
}
