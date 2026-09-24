"use client";
import React, { useEffect, useState } from 'react';
import { z } from 'zod';
import { MarketThemeReportEntrySchema } from '../shared/market-module-contracts';
import { MarketThemeDetailResponseSchema, MarketThemeTextPreviewSchema } from '../shared/market-theme-detail-contracts';
import { readThemeDetails } from './lib/market-theme-browser';
import { MarketThemeEvidence } from './market-theme-evidence';
import { MarketThemeInsightPanel } from './market-theme-insight-panel';
import { themeSavedReportStatus } from './lib/market-theme-rule-status';

type Entry=z.infer<typeof MarketThemeReportEntrySchema>;
type Page=z.infer<typeof MarketThemeDetailResponseSchema>['page'];
const reasons={ 'selection-shortfall':'来源商品不足请求数量', 'no-theme-data':'未获得可用主题', 'empty-asins':'部分商品主题为空', 'source-results-missing':'部分商品采集失败或未返回',
  'model-results-missing':'部分主题的模型分析未完成', 'unknown-themes':'部分主题尚未归类', 'reconciliation-required':'跨批分类仍待确认' };
const statuses={success:'已取得',empty:'无主题',failed:'采集失败',missing:'尚未取得'};
const decisions={mapped:'已归组',unknown:'尚未归类',unavailable:'模型结果不可用'};
const num=(n:number|null)=>n===null?'未知':n.toLocaleString('zh-CN');
function Preview({value}:{value:z.infer<typeof MarketThemeTextPreviewSchema>}) {return <>{value.text}{value.truncated&&<small>（截断预览，原文长度 {value.totalLength}）</small>}</>;}

function ThemePages({entry}:{entry:Entry}) {
  const [query,setQuery]=useState<{section:Page['section'];offset:number;groupIndex?:number}>({section:'groups',offset:0});
  const [page,setPage]=useState<Page|null>(null),[error,setError]=useState<string|null>(null),[reload,setReload]=useState(0);
  const {section,offset,groupIndex}=query;
  useEffect(()=>{const owner=new AbortController();setPage(null);setError(null);
    void readThemeDetails(entry.report.moduleRunId,entry.attemptId,entry.report.reportHash,{section,offset,limit:20,groupIndex},owner.signal)
      .then(result=>{if(!owner.signal.aborted)setPage(result.page);}).catch(e=>{if(!owner.signal.aborted)setError(e instanceof Error?e.message:'读取明细失败');});
    return()=>owner.abort();
  },[entry.report.moduleRunId,entry.attemptId,entry.report.reportHash,section,offset,groupIndex,reload]);
  function move(next:typeof query){setPage(null);setError(null);setQuery(next);}
  return <section className="market-theme-details" aria-label="主题明细">
    <nav className="market-theme-actions" aria-label="明细视图">{([['groups','主题分组'],['asins','商品覆盖'],['members','原主题证据']] as const).map(([value,label])=><button className="ghost-btn" type="button" key={value} aria-pressed={section===value} onClick={()=>move({section:value,offset:0})}>{label}</button>)}</nav>
    {groupIndex!==undefined&&<p>正在查看第 {groupIndex+1} 组的证据 <button className="ghost-btn" type="button" onClick={()=>move({section:'groups',offset:0})}>返回分组</button></p>}
    {error?<p className="market-research-error" role="alert">{error} <button type="button" className="ghost-btn" onClick={()=>setReload(n=>n+1)}>重读明细</button></p>:!page?<p role="status"><span className="market-theme-spinner" aria-hidden="true"/>正在读取此版本明细…</p>:<>
      <p className="market-research-note">此版本主题提及总数：{num(page.totals?.mention??null)}；当前视图共 {page.totalItems} 项。统计分母不随翻页变化。</p>
      {section==='groups'&&<p className="market-research-note">共 {page.display.totalGroupCount} 组，展示 {page.display.displayedGroupCount} 组，省略 {page.display.omittedGroupCount} 组。</p>}
      {page.items.length===0?<p>该版本在此视图暂无可展示的明细。</p>:<ul className="market-theme-rows">{page.items.map((item,index)=><li key={`${page.offset+index}`}>
        {item.kind==='group'?<><h4>{item.labelZh??item.sourceLabel?.text??'尚未归类的主题'}</h4>{item.sourceLabel?.truncated&&<small>原主题名称为截断预览</small>}
          <p>{item.definition??'保留原主题，尚无确认分类。'} {item.labelOrigin==='batch-proposal'?(entry.report.basis==='reconciliation-evaluation'?'（模型提案，经跨批匹配归组）':'（模型批内分类提案）'):item.labelOrigin==='catalog'?'（已保存目录分类）':''}</p>
          <p>提及 {num(item.totals.mention)} · 正向 {num(item.totals.positive)} · 负向 {num(item.totals.negative)} · 原主题 {item.memberCount} 项</p>
          <p>主题提及份额：{item.topicShare.valuePct===null?'未知':`${item.topicShare.valuePct.toFixed(1)}%`}（{item.topicShare.numerator}/{item.topicShare.denominator}）</p>
          <button type="button" className="ghost-btn" onClick={()=>move({section:'members',offset:0,groupIndex:item.index})}>查看第 {item.index+1} 组原主题</button></>:
        item.kind==='asin'?<><h4>{item.asin} · {statuses[item.status]}</h4><p>提及 {num(item.totals?.mention??null)} · 主题 {num(item.totals?.themeCount??null)}</p><p>{item.reason}</p><small>来源记录：{item.sourceRecordId??'无'} · 采集时间：{item.fetchedAt??'未知'}</small></>:
        <><h4>{item.asin} · <Preview value={item.keyword}/></h4><p>{entry.report.semanticStatus==='skipped'&&item.decision.status==='unavailable'?'语义归组未启用':decisions[item.decision.status]}{entry.report.semanticStatus==='skipped'?'':item.decision.reason?` · ${item.decision.reason}`:''}</p>
          <p className="market-theme-evidence"><Preview value={item.content}/></p><p>原始提及 {item.mention} · 正向 {item.positive} · 负向 {item.negative} · 商品内份额 {item.withinAsinShare.valuePct===null?'未知':`${item.withinAsinShare.valuePct.toFixed(1)}%`}（{item.withinAsinShare.numerator}/{item.withinAsinShare.denominator}）</p>
          <small>原主题：{item.sourceThemeId}<br/>来源记录：{item.sourceRecordId} · 更新时间：{item.sourceUpdatedAt??'未知'}</small>
          <MarketThemeEvidence key={item.sourceThemeId} runId={entry.report.moduleRunId} attemptId={entry.attemptId} reportHash={entry.report.reportHash} sourceThemeId={item.sourceThemeId} semanticSkipped={entry.report.semanticStatus==='skipped'}/></>}
      </li>)}</ul>}
      <div className="market-theme-actions"><span>{page.totalItems?`${page.offset+1}–${page.offset+page.items.length} / ${page.totalItems}`:'0 项'}</span>
        <button type="button" className="ghost-btn" disabled={page.offset===0} onClick={()=>move({...query,offset:0})}>首页</button>
        <button type="button" className="ghost-btn" disabled={page.nextOffset===null} onClick={()=>{if(page.nextOffset!==null)move({...query,offset:page.nextOffset});}}>下一页</button></div>
    </>}
  </section>;
}
export function MarketThemeReport({entry}:{entry:Entry}) {
  const r=entry.report,c=r.counts,semanticSkipped=r.semanticStatus==='skipped',displayStatus=themeSavedReportStatus(r);
  return <div aria-label="已保存主题报告" style={{minWidth:0,display:'grid',gap:20}}><MarketThemeInsightPanel key={`${entry.attemptId}-${r.reportHash}`} entry={entry}/><section className="card market-research-result market-insights-workflow"><details><summary>报告统计口径与完整证据</summary>
    <div className="market-research-result-heading"><h3>{entry.current?'当前报告':'历史报告'}</h3><span>{displayStatus==='complete'?semanticSkipped?'规则数据已完整':'分析完整':displayStatus==='partial'?'部分结果':'暂无数据'}</span></div>
    <p>{r.scope.marketplace} · 类目 {r.scope.nodeIdPath} · {r.scope.fromMonth} 至 {r.scope.toMonth}</p>
    <p className="market-research-note">数据截止：{r.dataCutoffAt} · 请求 {c.requestedCount} 个商品，实际选中 {c.selectedCount} 个。样本按供应商返回顺序选择，尚未验证 BSR 排名。</p>
    {semanticSkipped&&<p className="market-research-note">本任务语义归组未启用；下方按 Customers Say 原主题展示规则统计。</p>}
    <dl className="market-research-metrics"><div><dt>取得主题的商品</dt><dd>{c.successfulCount}/{c.selectedCount}</dd></div>{semanticSkipped?<><div><dt>原主题条目</dt><dd>{c.expectedMemberCount}</dd></div><div><dt>语义归组</dt><dd>未启用</dd></div></>:<><div><dt>已校验的模型成员</dt><dd>{c.validatedMemberCount}/{c.expectedMemberCount}</dd></div><div><dt>已归组的主题</dt><dd>{c.mappedMemberCount}/{c.expectedMemberCount}</dd></div></>}</dl>
    {r.reasons.length>0&&<div className="market-research-notice"><h4>结果仍有缺口</h4><ul>{r.reasons.map(reason=><li key={reason}>{reasons[reason]}</li>)}</ul></div>}
    <p className="market-research-note">Customers Say 主题提及份额：按主题提及次数计算，不能替代评论样本发生率。未取得评论 ID，无法去重为独立评论；正负向计数不假定互斥。</p>
    <ThemePages key={entry.attemptId} entry={entry}/>
    <details className="market-research-boundaries"><summary>报告身份与版本</summary><p>报告：{entry.attemptId}</p><p>规则：{r.versions.rule}<br/>模型配置：{r.versions.configuration??'无'}<br/>映射：{r.versions.mapping}</p><p>摘要：{r.reportHash}</p></details>
  </details></section></div>;
}
