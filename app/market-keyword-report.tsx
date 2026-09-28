"use client";
import type {MarketKeywordOriginalEstimate} from '../shared/market-keyword-original-estimate-contracts';
import {MarketKeywordOriginalEstimateReport} from './market-keyword-original-estimate-report';
import React, {useState} from 'react';
import type {MarketKeywordFacts,MarketKeywordRunResponse} from '../shared/market-keyword-public-contracts';
import type {MarketKeywordRevisionCatalog} from '../shared/market-keyword-revision-contracts';
import type {MarketTextSpanRef} from '../shared/market-semantic-contracts';
import type {MarketKeywordReconciliationReport} from '../shared/market-keyword-reconciliation-contracts';
import type {MarketKeywordRuleReport} from '../shared/market-keyword-rule-report-contracts';
import {MarketKeywordDemandSummary} from './market-keyword-demand-summary';
import {MarketKeywordTable} from './market-keyword-table';
import type {MarketKeywordScoreInputAudit} from '../shared/market-keyword-score-input-audit-contracts';
import {MarketKeywordRulesReport} from './market-keyword-rule-report';
import type {MarketKeywordOriginalClassification} from '../shared/market-keyword-original-contracts';
import {MarketKeywordTaxonomyView} from './market-keyword-taxonomy-view';

const dimensions=['W1','W2','W3','W4'] as const;
const dimensionNames={W1:'W1 产品',W2:'W2 人群',W3:'W3 场景',W4:'W4 功能属性'};
const number=(value:number|null)=>value===null?'未知':value.toLocaleString('zh-CN',{maximumFractionDigits:2});
const percent=(value:number|null)=>value===null?'未知':`${(value*100).toFixed(1)}%`;
const share=(value:number|null)=>value===null?'未知':`${value.toFixed(1)}%`;
const trendStates={pending:'趋势待采集',failed:'趋势采集失败',cancelled:'趋势已取消',ready:'趋势已取得',partial:'趋势部分缺失',empty:'趋势为空'};
const semanticStates={unavailable:'语义分析不可用',pending:'语义分析等待中',partial:'部分语义协议通过',validated:'语义协议通过'};
const unknownReasons={'missing-source':'缺少来源','insufficient-evidence':'证据不足',ambiguous:'含义不明确',contradictory:'证据冲突','outside-taxonomy':'现有目录未覆盖'};
const metricReasons={missing:'来源缺失','incomplete-month':'月份未完整','missing-current':'本月数值缺失','missing-baseline':'基期数值缺失','zero-baseline':'基期为零，不能计算增长率'};
type SourceCatalog=MarketKeywordRunResponse['run']['params']['catalog'];

function Pages<T>({items,label,render}:{items:readonly T[];label:string;render:(page:readonly T[],offset:number)=>React.ReactNode}){
 const [page,setPage]=useState(0),size=20,last=Math.max(0,Math.ceil(items.length/size)-1),current=Math.min(page,last),offset=current*size;
 return <section aria-label={label}>{items.length===0?<p>暂无{label}。</p>:render(items.slice(offset,offset+size),offset)}
  <div className="market-theme-actions"><span>{items.length?`${offset+1}–${Math.min(offset+size,items.length)} / ${items.length}`:'0 项'}</span>
   <button className="ghost-btn" type="button" disabled={current===0} onClick={()=>setPage(0)} aria-label={`${label}首页`}>首页</button>
   <button className="ghost-btn" type="button" disabled={current===0} onClick={()=>setPage(current-1)} aria-label={`${label}上一页`}>上一页</button>
   <button className="ghost-btn" type="button" disabled={current===last} onClick={()=>setPage(current+1)} aria-label={`${label}下一页`}>下一页</button>
  </div></section>;
}
function Evidence({spans}:{spans:readonly MarketTextSpanRef[]}){
 return spans.length?<ul>{spans.map((s,i)=><li key={i}><q>{s.quote}</q><details><summary>证据位置</summary><small>字段 {s.refId} · 字符 {s.start}–{s.end}</small></details></li>)}</ul>:<span>无原文证据</span>;
}
function Scope({facts}:{facts:MarketKeywordFacts}){
 return <p>{facts.scope.marketplace} · 类目 {facts.scope.nodeIdPath} · {facts.scope.fromMonth} 至 {facts.scope.toMonth} · 参考月 {facts.referenceMonth}</p>;
}
function Boundaries({facts}:{facts:MarketKeywordFacts}){
 const pool=facts.pool;
 return <div className="market-research-notice"><p>词池不是全市场，也不代表全类目总搜索量。按指定种子词和页码采集，按来源顺序去重保留首次观察。</p>
  <p>已取得 {pool.receivedPageCount}/{pool.plannedPageCount} 页 · 观察到 {pool.uniqueObservedMemberCount} 个去重词 · 保留 {facts.members.length} 个词 · 重复观察 {pool.duplicateMemberCount} 次。</p>
  <p>缺页 {pool.missingPages.length} 页 · 空页 {pool.emptyPages.length} 页 · 满页 {pool.fullPages.length} 页（可能仍有后续结果）。{pool.collectionCoverage==='complete'?'指定页面已收齐。':pool.collectionCoverage==='none'?'尚无可用来源页。':'来源页面尚不完整。'}</p>
  <p>截断：{pool.memberLimitReached?'已达到词池上限':'未达到词池上限'}；省略 {pool.omittedMemberIds.length} 个词。冲突：{pool.conflictingMemberIds.length} 个词有不同来源观察。</p>
  {(pool.missingPages.length>0||pool.emptyPages.length>0)&&<details><summary>缺页与空页位置</summary><ul>{pool.missingPages.map(p=><li key={`missing:${p.seed}:${p.page}`}>缺页：{p.seed} · 第 {p.page} 页</li>)}{pool.emptyPages.map(p=><li key={`empty:${p.seed}:${p.page}`}>空页：{p.seed} · 第 {p.page} 页</li>)}</ul></details>}
 </div>;
}
function MemberDetails({member}:{member:MarketKeywordFacts['members'][number]}){
 return <details><summary>月份、来源指标与证据</summary>
  <p>{trendStates[member.trend.status]}。趋势推荐竞价的币种未知；推荐竞价非实际 CPC。</p>
  <div className="market-shape-table"><table><caption>明确月份趋势</caption><thead><tr><th>月份</th><th>搜索量</th><th>搜索排名</th><th>推荐竞价（币种未知）</th><th>同比</th><th>环比</th></tr></thead><tbody>{member.trend.months.map(m=><tr key={m.month}><th>{m.month}</th>
   {(['searchVolume','searchRank','recommendedBid'] as const).map(k=><td key={k}>{number(m[k].value)}{m[k].reason&&<small>（{metricReasons[m[k].reason]}）</small>}</td>)}
   {(['yoyGrowth','recentGrowth'] as const).map(k=><td key={k}>{percent(m[k].value)}{m[k].reason&&<small>（{metricReasons[m[k].reason]}）</small>}<small> · 基期 {m[k].baselineMonth}：{number(m[k].baselineValue)}</small></td>)}</tr>)}</tbody></table></div>
  {!member.trend.months.length&&<p>尚无明确月份的趋势数据；来源页数值不能补作参考月指标。</p>}
  {member.aba&&<section aria-label="逐词 ABA 份额"><h5>ABA · {member.aba.referenceMonth}</h5>
   <p>{({pending:'等待采集',failed:'采集失败，可在任务步骤中重试',cancelled:'采集已取消',ready:'本批数据已取得',partial:'本批部分数据缺失',empty:'本批无可用数据',unsupported:'此站点暂无已验证的 ABA 补充'})[member.aba.status]}。SIF 单词全站数据，未限定当前类目；与趋势来源的搜索量分别保留。</p>
   {member.aba.member&&<><p>SIF 月搜索量：{number(member.aba.member.searchVolume.value)} · 前三商品点击份额：{percent(member.aba.member.top3ClickShare.value)} · 前三商品转化份额：{percent(member.aba.member.top3ConversionShare.value)}</p>
    <ul>{(['searchVolume','top3ClickShare','top3ConversionShare'] as const).filter(k=>member.aba!.member![k].reason!==null).map(k=><li key={k}>{({searchVolume:'月搜索量',top3ClickShare:'点击份额',top3ConversionShare:'转化份额'})[k]}：{({'missing-keyword':'未返回此词','missing-reference-month':'未返回参考月','missing-value':'该字段缺失'})[member.aba!.member![k].reason!]}</li>)}</ul></>}
   <details><summary>ABA 来源依据</summary><p>采集时间：{member.aba.fetchedAt??'尚未取得'}<br/>来源：{member.aba.sourceRef??'无'}<br/>快照：{member.aba.inputSnapshotId??'无'}</p>
    {member.aba.member&&<p>点击份额字段：{JSON.stringify(member.aba.member.top3ClickShare.path)}<br/>转化份额字段：{JSON.stringify(member.aba.member.top3ConversionShare.path)}</p>}</details>
  </section>}
  <h5>来源未注明月份的指标</h5><p>来源报告月搜索量 {number(member.pageMetrics.monthlySearchVolume.value)} · 周搜索量 {number(member.pageMetrics.weeklySearchVolume.value)} · 周搜索排名 {number(member.pageMetrics.weeklySearchRank.value)}</p>
  <p>来源页推荐竞价（USD）：{number(member.pageMetrics.recommendedCpcUsd.value)}。时间窗口未注明，非实际 CPC。</p>
  <details><summary>来源快照与采集时间</summary><p>趋势采集时间：{member.trend.fetchedAt??'未知'}<br/>趋势快照：{member.trend.inputSnapshotId??'无'}<br/>关键词来源：{member.sourceRef}</p>
   <ul>{member.occurrences.map((o,i)=><li key={i}>种子词 {o.seed} · 第 {o.page} 页 · 来源第 {o.sourceIndex+1} 行<br/><small>快照 {o.inputSnapshotId} · 来源 {o.sourceRef}</small></li>)}</ul>
  </details></details>;
}
function SemanticBatches({facts,catalog}:{facts:MarketKeywordFacts;catalog?:SourceCatalog}){
 const names=new Map(facts.members.map(m=>[m.keywordId,m.keyword]));
 return <section aria-label="关键词模型建议"><h4>模型原始建议</h4>
  <p>{semanticStates[facts.semantics.status]}；语义协议通过不等于质量已验，也不代表跨批归并完成。</p>
  <p>未知维度 {facts.semantics.unknownDimensionCount} 项 · 未知需求簇 {facts.semantics.unknownClusterCount} 项 · 无可用语义结果 {facts.semantics.unavailableKeywordIds.length} 个词。未知维度数只统计已有语义结果，不能把未分析词视为已确认。</p>
  <p>{dimensions.map(d=>dimensionNames[d]).join(' · ')}。批内提案保持独立身份，同名或同编号不自动合并。</p>
  <Pages key={facts.factsId} items={facts.semantics.batches} label="模型批次" render={(batches,offset)=><ul className="market-theme-rows">{batches.map((batch,i)=><li key={`${batch.stepId}:${batch.attemptId}`}><h4>模型批次 {offset+i+1}</h4>
   <details><summary>批次身份与审计</summary><p>批次 {batch.output.batchId}<br/>步骤 {batch.stepId} · 尝试 {batch.attemptId}<br/>模型运行 {batch.agentRunId} · 绑定 {batch.bindingId}</p></details>
   {batch.output.labelProposals?.map(p=><div key={`${batch.output.batchId}:${p.dimension}:${p.labelId}`}><h5>{dimensionNames[p.dimension]} · {p.label}（此批标签提案）</h5><p>{p.definition}</p><Evidence spans={p.evidence}/></div>)}
   {batch.output.proposals.map(p=><div key={`${batch.output.batchId}:${p.proposalId}`}><h5>{p.labelZh}（此批提案 {p.proposalId}）</h5><p>{p.definition}</p><Evidence spans={p.evidence}/></div>)}
   {batch.output.keywords.map(k=><details key={k.keywordId}><summary>{names.get(k.keywordId)??k.keywordId} · W1–W4 与需求簇证据</summary>
    {dimensions.map(d=>{const decision=k[d],labels=new Map([...(catalog?.dimensionLabels[d]??[]),...(batch.output.labelProposals?.filter(p=>p.dimension===d)??[])].map(l=>[l.labelId,l.label]));return <div key={d}><p><strong>{dimensionNames[d]}：</strong>{decision.status==='unknown'?`未知（${unknownReasons[decision.reason]}）`:`建议标签：${decision.labelIds.map(id=>labels.get(id)??'目录名称未取得').join('、')}（待人工确认）`}</p>{decision.status==='supported'&&<details><summary>标签引用</summary><p>{decision.labelIds.join('、')}（任务固定目录或此批标签提案）</p></details>}<Evidence spans={decision.evidence}/></div>;})}
    <p>需求簇：{k.cluster.status==='unknown'?`未知（${unknownReasons[k.cluster.reason]}）`:k.cluster.status==='existing'?`目录簇：${new Map(catalog?.clusterCatalog.map(c=>[c.clusterId,c.label])).get(k.cluster.clusterId)??'目录名称未取得'}（待人工确认）`:`此批提案 ${new Map(batch.output.proposals.map(p=>[p.proposalId,p.labelZh])).get(k.cluster.proposalId)??'未命名提案'}（${k.cluster.proposalId}）`}</p>{k.cluster.status==='existing'&&<details><summary>目录需求簇引用</summary><p>{k.cluster.clusterId}</p></details>}<Evidence spans={k.cluster.evidence}/>
   </details>)}
   {batch.output.synonymRelations.length>0&&<details><summary>批内词义关系建议</summary>{batch.output.synonymRelations.map((r,j)=><div key={j}><p>{names.get(r.leftKeywordId)??r.leftKeywordId} 与 {names.get(r.rightKeywordId)??r.rightKeywordId}：{r.relation==='equivalent'?'等义候选':'相关候选'}</p><Evidence spans={r.evidence}/></div>)}</details>}
  </li>)}</ul>}/>
 </section>;
}
function GlobalSemantics({facts,result}:{facts:MarketKeywordFacts;result:MarketKeywordReconciliationReport}){
 const status={pending:'跨批归并中',failed:'跨批归并失败',cancelled:'跨批归并已停止',unavailable:'归并模型不可用',empty:'词池为空，暂无可归并关键词','waiting-initial-models':'初始分析尚未完整，需补齐失败批次',ready:'跨批归并已完成',partial:'跨批归并已完成，部分维度未知或不可用'};
 const reasons:Record<string,string>={...unknownReasons,'no-candidates':'尚无候选标签','model-result-unavailable':'归并模型结果未取得'};
 const labels=new Map(result.catalog.map(c=>[c.candidateId,c])),words=new Map(facts.members.map(m=>[m.keywordId,m.keyword]));
 return <section aria-label="关键词跨批归并"><h3>跨批标签与需求簇</h3><p role="status">{status[result.status]} · 已完成 {result.completedRounds} 轮</p>
  <p>按原词证据比较各批候选标签；人工保存的分类版本保留不变。未知维度不补成确定结论。</p>
  <Pages items={result.decisions} label="跨批归并明细" render={rows=><ul className="market-theme-rows">{rows.map(row=><li key={row.keywordId}><h4>{words.get(row.keywordId)??row.keywordId}</h4>{([...dimensions,'cluster'] as const).map(d=>{const cell=row[d];return <div key={d}><p><strong>{d==='cluster'?'需求簇':dimensionNames[d]}：</strong>{cell.status==='supported'?cell.candidateIds.map(id=>labels.get(id)?.label??'标签名称缺失').join('、'):`${cell.status==='unknown'?'未知':'不可用'}（${reasons[cell.reason??'']??'待验证'}）`}</p><details><summary>定义与原词证据</summary>{cell.candidateIds.map(id=><p key={id}>{labels.get(id)?.definition}</p>)}<Evidence spans={cell.evidence}/></details></div>;})}</li>)}</ul>}/>
 </section>;
}
export function MarketKeywordFactsReport({emptyReason,facts,catalog,reconciliation,ruleReport,scoreInputAudit,originalEstimate,queryName,semanticSkipped=false,automaticClassification}:{emptyReason?:string;automaticClassification?:MarketKeywordOriginalClassification;queryName?:string;facts:MarketKeywordFacts;catalog?:SourceCatalog;reconciliation?:MarketKeywordReconciliationReport;ruleReport?:MarketKeywordRuleReport;scoreInputAudit?:MarketKeywordScoreInputAudit;originalEstimate?:MarketKeywordOriginalEstimate;semanticSkipped?:boolean}){
 const estimate=originalEstimate?.factsId===facts.factsId&&originalEstimate.classificationId===null?originalEstimate:undefined;
 return <section className="market-research-result market-keyword-report-stack" aria-label="关键词来源事实报告"><h3 className="market-research-sr-only">关键词来源事实</h3>
  {emptyReason&&<p role="status" className="market-research-notice">{emptyReason}</p>}
  <MarketKeywordTable automaticClassification={automaticClassification} queryName={queryName} facts={facts} catalog={catalog} reconciliation={semanticSkipped?undefined:reconciliation} semanticSkipped={semanticSkipped} details={m=><MemberDetails member={m}/>}/>
  <>{estimate?<MarketKeywordOriginalEstimateReport estimate={estimate}/>:<MarketKeywordDemandSummary emptyReason={emptyReason} automaticClassification={automaticClassification} queryName={queryName} facts={facts} reconciliation={semanticSkipped?undefined:reconciliation} ruleReport={ruleReport} semanticSkipped={semanticSkipped}/>}</>
  <details className="card market-insights-evidence"><summary>{semanticSkipped?'来源范围与覆盖':'来源范围、覆盖与原始模型证据'}</summary><Scope facts={facts}/><Boundaries facts={facts}/>  <p className="market-research-note">参考月搜索量只采用 {facts.referenceMonth} 明确月份数据。同比比较去年同月，环比比较上月；原始增长比例按百分比展示。来源未注明月份的指标独立保留，不能补齐参考月。推荐竞价非实际 CPC，实际 CPC 未知。</p>
  <p>固定词池共 {facts.members.length} 个词，分页不改变统计分母。</p>
{semanticSkipped?<p>语义分析未启用；本报告展示本地规则与已保存来源。</p>:<SemanticBatches facts={facts} catalog={catalog}/>}</details>
  {!semanticSkipped&&reconciliation&&<details className="card market-insights-evidence"><summary>跨批标签与需求簇明细</summary><GlobalSemantics facts={facts} result={reconciliation}/></details>}
  {ruleReport&&(estimate?<details className="card market-insights-evidence"><summary>严格数据核对（不采用估算占位分）</summary><MarketKeywordRulesReport report={ruleReport} scoreInputAudit={scoreInputAudit}/></details>:<MarketKeywordRulesReport report={ruleReport} scoreInputAudit={scoreInputAudit}/>)}
  <MarketKeywordTaxonomyView automaticClassification={automaticClassification} catalog={catalog} reconciliation={semanticSkipped?undefined:reconciliation} semanticSkipped={semanticSkipped}/>
  <p className="market-research-note">{estimate?'业务报告按原版有效样本和估算规则展示；来源缺失单独保留，人工校对与历史报告仍可使用。':semanticSkipped?automaticClassification?'W1–W4 与需求簇按原版规则自动分类，可在下方人工校对；W5 / PVS 缺少输入保持待验证。':'W5 / PVS 按本次已保存规则报告展示；W1–W4 未分类时保持未知，缺少输入保持待验证。':'标签提案保留原词证据；跨批归并和 W5 / PVS 按本次已保存报告展示，语义质量仍需独立校对，缺少输入保持待验证。'}</p>
  <details className="market-research-boundaries"><summary>事实版本与来源截止时间</summary><p>数据截止：{facts.pool.dataCutoffAt}<br/>事实版本：{facts.factsId}<br/>原始词池快照：{facts.pool.rawInputSnapshotId}<br/>语义快照：{facts.pool.semanticInputSnapshotId}</p></details>
 </section>;
}
export function MarketKeywordRevisionReport({catalog,ruleReport,scoreInputAudit,originalEstimate,semanticSkipped=false}:{catalog:MarketKeywordRevisionCatalog;ruleReport?:MarketKeywordRuleReport;scoreInputAudit?:MarketKeywordScoreInputAudit;originalEstimate?:MarketKeywordOriginalEstimate;semanticSkipped?:boolean}){
 const {facts,classification,aggregation,revision}=catalog,names=new Map(facts.members.map(m=>[m.keywordId,m.keyword]));
 const estimate=originalEstimate?.factsId===facts.factsId&&originalEstimate.classificationId===revision.revisionId?originalEstimate:undefined;
 const clusters=new Map(classification.clusters.map(c=>[c.clusterId,c]));
 const summaries=[...aggregation.clusters,aggregation.unassigned];
 const missing=Object.fromEntries(dimensions.map(d=>[d,classification.assignments.filter(a=>!a[d].length).length]));
 return <section className="market-research-result" aria-label="关键词人工修订报告"><h3>已保存的人工关键词修订</h3><Scope facts={facts}/>
  <p>作者：{revision.authorId} · 保存时间：{revision.createdAt}</p><p>修订备注：{revision.note||'未填写'}</p>
  <p>{semanticSkipped?'人工分类与规则统计独立保存；本报告使用该版本固定事实，分页不改变统计分母。':'人工分类与模型原始建议独立保存；本报告使用该版本固定事实，分页不改变统计分母。'}</p>
  <dl className="market-research-metrics"><div><dt>固定词池成员</dt><dd>{aggregation.pool.memberCount}</dd></div><div><dt>词池分母（参考月总搜索量）</dt><dd>{number(aggregation.pool.totalSearchVolume)}</dd></div><div><dt>已知搜索量小计</dt><dd>{number(aggregation.pool.knownSearchVolume)}</dd></div></dl>
  <p>已知搜索量 {aggregation.pool.knownSearchVolumeCount} 个词 · 搜索量未知 {aggregation.pool.unknownSearchVolumeCount} 个词。未知不等于 0；有未知成员时，总量和需求簇份额保留未知，已知小计不能代替完整分母。</p>
  <p>人工未归类：{dimensions.map(d=>`${dimensionNames[d]} ${missing[d]} 个词`).join(' · ')}；未分组 {aggregation.unassigned.memberCount} 个词。</p>
  <Boundaries facts={facts}/>
  <h4>需求簇统计</h4><p>簇搜索量份额以完整词池的参考月总搜索量为分母。同比、环比按已知正搜索量加权；可用数值数与加权词数分别保留。推荐竞价不代替实际 CPC。</p>
  <Pages key={revision.revisionId} items={summaries} label="人工需求簇统计" render={rows=><div className="market-shape-table" role="region" aria-label="人工需求簇指标" tabIndex={0}><table><thead><tr><th>需求簇</th><th>成员</th><th>参考月搜索量</th><th>簇搜索量份额</th><th>同比</th><th>环比</th><th>实际 CPC</th></tr></thead><tbody>{rows.map(row=><tr key={row.clusterId??'unassigned'}><th>{row.clusterId===null?'未分组':clusters.get(row.clusterId)?.label??row.clusterId}{row.clusterId!==null&&<small> · {clusters.get(row.clusterId)?.definition}</small>}</th><td>{row.memberCount}</td><td>{number(row.totalSearchVolume)}<small> · 已知小计 {number(row.knownSearchVolume)}，未知 {row.unknownSearchVolumeCount} 词</small></td><td>{share(row.searchVolumeSharePercent)}<small>（{number(row.totalSearchVolume)} / {number(row.searchVolumeShareDenominator)}）</small></td>
   {(['yoyGrowth','recentGrowth','cpc'] as const).map(k=><td key={k}>{k==='cpc'?number(row[k].value):percent(row[k].value)}<small> · 已知 {row[k].knownValueCount} 词，未知 {row[k].unknownValueCount} 词；加权 {row[k].weightedMemberCount} 词，权重搜索量 {number(row[k].weightSum)}</small></td>)}</tr>)}</tbody></table></div>}/>
  <h4>人工词标签与需求簇归属</h4>
  <Pages key={`assignments:${revision.revisionId}`} items={classification.assignments} label="人工关键词归属" render={rows=><div className="market-shape-table" role="region" aria-label="人工关键词归属表" tabIndex={0}><table><thead><tr><th>关键词</th>{dimensions.map(d=><th key={d}>{dimensionNames[d]}</th>)}<th>需求簇</th></tr></thead><tbody>{rows.map(a=><tr key={a.keywordId}><th>{names.get(a.keywordId)??a.keywordId}</th>{dimensions.map(d=><td key={d}>{a[d].length?a[d].map(id=>classification.labels[d].find(l=>l.labelId===id)?.label??id).join('、'):'未知（未归类）'}</td>)}<td>{a.clusterId===null?'未分组':clusters.get(a.clusterId)?.label??a.clusterId}</td></tr>)}</tbody></table></div>}/>
  <details><summary>人工标签定义</summary>{dimensions.map(d=><div key={d}><h5>{dimensionNames[d]}</h5>{classification.labels[d].length?<ul>{classification.labels[d].map(l=><li key={l.labelId}>{l.label}：{l.definition}</li>)}</ul>:<p>尚未定义标签。</p>}</div>)}</details>
  {ruleReport&&(estimate?<details className="card market-insights-evidence"><summary>严格数据核对（不采用估算占位分）</summary><MarketKeywordRulesReport report={ruleReport} scoreInputAudit={scoreInputAudit}/></details>:<MarketKeywordRulesReport report={ruleReport} scoreInputAudit={scoreInputAudit}/>)}
  {estimate&&<MarketKeywordOriginalEstimateReport estimate={estimate} manual/>}<p className="market-research-note">人工修订确认已指定的标签与归属，并按原词重算。W5 诊断与 PVS 是否可用取决于来源覆盖，语义质量仍待独立验证。</p>
  <details className="market-research-boundaries"><summary>人工版本与事实基线</summary><p>版本：{revision.revisionId}<br/>父版本：{revision.parentRevisionId??'首个版本'}<br/>事实基线：{facts.factsId}<br/>数据截止：{facts.pool.dataCutoffAt}</p></details>
 </section>;
}
