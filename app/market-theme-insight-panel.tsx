"use client";
import {marketThemeLanguage} from '../shared/market-theme-translation-contracts';
import React, { useEffect, useId, useRef, useState } from 'react';
import { z } from 'zod';
import { MarketThemeReportEntrySchema } from '../shared/market-module-contracts';
import { MarketThemeDetailResponseSchema } from '../shared/market-theme-detail-contracts';
import type { MarketThemeSelectionResponse } from '../shared/market-theme-selection-contracts';
import { readThemeDetails,readThemeTranslations,startThemeTranslations } from './lib/market-theme-browser';
import { requestThemeSelection } from './lib/market-theme-selection-browser';
import {isOriginalThemeFlow} from '../shared/market-theme-original-rules';
import { themeSavedReportStatus } from './lib/market-theme-rule-status';
import {MarketThemeLaunchSection,MarketThemeTopicTable,MarketThemeSampleTable,selectThemeSentiment,type Group,type Member,type Asin,type Evidence,type ThemeTranslationView} from './market-theme-result-view';
export {MarketThemeLaunchSection,MarketThemeTopicTable,MarketThemeSampleTable,selectThemeSentiment} from './market-theme-result-view';
import type {ThemeWriteBoundary} from './market-theme-report';
type Entry=z.infer<typeof MarketThemeReportEntrySchema>;
type Page=z.infer<typeof MarketThemeDetailResponseSchema>['page'];
type DisplayResult={status:'complete'|'partial'|'no-data';selectedAsins:readonly string[];baseSelectionShortfall:boolean;asins:readonly {status:'success'|'empty'|'failed'|'missing';quarantine?:{rejected:readonly unknown[]}}[]};
export function themePresentationStatus(entry:Entry,result:DisplayResult|null){
 if(entry.report.semanticStatus!=='skipped'||!result)return result?.status??themeSavedReportStatus(entry.report);
 if(!result.selectedAsins.length||!result.asins.some(asin=>asin.status==='success'))return 'no-data';
 return result.baseSelectionShortfall||result.asins.some(asin=>asin.status!=='success'||!!asin.quarantine?.rejected.length)?'partial':'complete';
}
async function readAll(identity:{moduleRunId:string;attemptId:string;reportHash:string},section:Page['section'],signal:AbortSignal,groupIndex?:number) {
 const items:Page['items']=[];let offset=0;let last:Page|null=null;
 for(let n=0;n<200;n++){
  const result=await readThemeDetails(identity.moduleRunId,identity.attemptId,identity.reportHash,{section,offset,limit:50,groupIndex},signal);
  last=result.page;items.push(...last.items);if(last.nextOffset===null)return {...last,items};
  if(last.nextOffset<=offset)throw new Error('明细分页没有前进，请重读明细。');offset=last.nextOffset;
 }
 throw new Error('此报告明细超过单次展示上限，请使用下方分页证据视图。');
}
export function MarketThemeInsightPanel({entry,writesDisabled,onWriteState}:{entry:Entry}&ThemeWriteBoundary) {
 const writeOwner=useId();
 const runId=entry.report.moduleRunId,attemptId=entry.attemptId,reportHash=entry.report.reportHash;
 const semanticSkipped=entry.report.semanticStatus==='skipped',original=isOriginalThemeFlow(entry.report.versions.planner);
 const [tab,setTab]=useState<'positive'|'negative'>('positive'),[groups,setGroups]=useState<Group[]|null>(null),[asins,setAsins]=useState<Asin[]|null>(null);
 const [evidence,setEvidence]=useState<Record<number,Evidence>>({}),[error,setError]=useState<string|null>(null),[sampleError,setSampleError]=useState<string|null>(null),[reload,setReload]=useState(0),[display,setDisplay]=useState<Page['display']|null>(null);
 const [loadedSelection,setSelection]=useState<MarketThemeSelectionResponse|null>(null),[selectionError,setSelectionError]=useState<string|null>(null),[busy,setBusy]=useState(false),[translations,setTranslations]=useState<ThemeTranslationView>({}),[translationError,setTranslationError]=useState<string|null>(null),[translationBusy,setTranslationBusy]=useState(false);
 const selection=loadedSelection?.base.attemptId===entry.attemptId&&loadedSelection.base.report.reportHash===entry.report.reportHash?loadedSelection:null;
 useEffect(()=>()=>{onWriteState?.(writeOwner+'-insight-selection',false);onWriteState?.(writeOwner+'-insight-translation',false);},[onWriteState,writeOwner]);
 const operation=useRef<AbortController|null>(null),generation=useRef(0),pending=useRef<{body:string;key:string}|null>(null);
 useEffect(()=>{const abort=new AbortController();const token=++generation.current;operation.current?.abort();setSelection(null);setSelectionError(null);setBusy(false);pending.current=null;setGroups(null);setAsins(null);setEvidence({});setError(null);setSampleError(null);
  void requestThemeSelection(runId,attemptId,reportHash,{signal:abort.signal}).then(value=>{if(!abort.signal.aborted&&generation.current===token)setSelection(value);}).catch(e=>{if(!abort.signal.aborted&&generation.current===token)setSelectionError(e instanceof Error?e.message:'样本版本读取失败');});
  void readAll({moduleRunId:runId,attemptId,reportHash},'groups',abort.signal).then(page=>{if(!abort.signal.aborted){setGroups(page.items.filter((g):g is Group=>g.kind==='group'));setDisplay(page.display);}}).catch(e=>{if(!abort.signal.aborted)setError(e instanceof Error?e.message:'主题读取失败');});
  void readAll({moduleRunId:runId,attemptId,reportHash},'asins',abort.signal).then(page=>{if(!abort.signal.aborted)setAsins(page.items.filter((g):g is Asin=>g.kind==='asin'));}).catch(e=>{if(!abort.signal.aborted)setSampleError(e instanceof Error?e.message:'样本读取失败');});
  void readThemeTranslations(runId,attemptId,reportHash,abort.signal).then(value=>{if(!abort.signal.aborted){setTranslations(Object.fromEntries(value.items.map(item=>[item.itemId,{translated:item.translated,state:item.state}])));setTranslationError(null);}}).catch(e=>{if(!abort.signal.aborted)setTranslationError(e instanceof Error?e.message:'翻译状态读取失败');});
  return()=>{abort.abort();operation.current?.abort();};
 },[runId,attemptId,reportHash,reload]);
 async function translate(){if(writesDisabled||translationBusy)return;onWriteState?.(writeOwner+'-insight-translation',true);setTranslationBusy(true);try{const value=await startThemeTranslations(runId,attemptId,reportHash,undefined);setTranslations(Object.fromEntries(value.items.map(item=>[item.itemId,{translated:item.translated,state:item.state}])));setTranslationError(null);}catch(e){setTranslationError(e instanceof Error?e.message:'翻译启动失败');}finally{setTranslationBusy(false);onWriteState?.(writeOwner+'-insight-translation',false);}}
 useEffect(()=>{if(!Object.values(translations).some(item=>item.state==='pending'))return;const timer=window.setTimeout(()=>setReload(n=>n+1),1200);return()=>window.clearTimeout(timer);},[translations]);
 const result=selection?(selection.revision?.result??selection.baseline):null;
 const presentationStatus=themePresentationStatus(entry,result);
 const quarantinedCount=result?result.asins.reduce((n,a)=>n+(a.quarantine?.rejected.length??0),0):(entry.report.counts.quarantinedThemeCount??0);
 const shownGroups=result?.groups??groups,shownAsins=result?.asins??asins,shownDisplay=result?.display??display;
 const shownEvidence=result?Object.fromEntries(result.evidence.map(e=>[e.index,{members:e.members,topAsins:e.topAsins}])):evidence;
 const active=selectThemeSentiment(shownGroups??[],tab,original),visible=active.slice(0,12);
 const readOnly=!!selection?.latestRevisionId&&selection.revision?.revisionId!==selection.latestRevisionId;
 useEffect(()=>{if(!groups||selection)return;const abort=new AbortController();const shown=selectThemeSentiment(groups,tab,original).slice(0,12);let cursor=0;
  async function worker(){while(cursor<shown.length&&!abort.signal.aborted){const group=shown[cursor++];try{const page=await readAll({moduleRunId:runId,attemptId,reportHash},'members',abort.signal,group.index);if(!abort.signal.aborted)setEvidence(old=>({...old,[group.index]:{members:page.items.filter((item):item is Member=>item.kind==='member')}}));}catch(e){if(!abort.signal.aborted)setEvidence(old=>({...old,[group.index]:{members:[],error:e instanceof Error?e.message:'摘要读取失败'}}));}}}
  void Promise.all([worker(),worker(),worker()]);return()=>abort.abort();
 },[groups,selection,tab,runId,attemptId,reportHash,original]);
 async function change(excludedAsins:string[]){
  if(!selection||busy||readOnly||writesDisabled)return;const controller=new AbortController();operation.current?.abort();operation.current=controller;const token=++generation.current;
  const request={baseReportHash:entry.report.reportHash,expectedParentRevisionId:selection.latestRevisionId,excludedAsins};const body=JSON.stringify(request);
  if(pending.current?.body!==body)pending.current={body,key:crypto.randomUUID()};const key=pending.current.key;onWriteState?.(writeOwner+'-insight-selection',true);setBusy(true);setSelectionError(null);
  try{const value=await requestThemeSelection(runId,attemptId,reportHash,{command:{key,request},signal:controller.signal});if(!controller.signal.aborted&&generation.current===token){setSelection(value);pending.current=null;}}
  catch(e){if(!controller.signal.aborted&&generation.current===token)setSelectionError(e instanceof Error?e.message:'样本版本保存失败');}
  finally{if(!controller.signal.aborted&&generation.current===token)setBusy(false);onWriteState?.(writeOwner+'-insight-selection',false);}
 }
 async function choose(id:string){
  if(!selection||busy)return;operation.current?.abort();generation.current++;pending.current=null;
  if(id==='base'){setSelection({...selection,revision:null});setSelectionError(null);return;}
  const controller=new AbortController();operation.current=controller;const token=generation.current;setBusy(true);setSelectionError(null);
  try{const value=await requestThemeSelection(runId,attemptId,reportHash,{revisionId:id,signal:controller.signal});if(!controller.signal.aborted&&generation.current===token)setSelection(value);}
  catch(e){if(!controller.signal.aborted&&generation.current===token)setSelectionError(e instanceof Error?e.message:'历史样本版本读取失败');}
  finally{if(!controller.signal.aborted&&generation.current===token)setBusy(false);}
 }
 return <>
  <MarketThemeLaunchSection title="买家评论见解" description={`基于 ${result?.selectedAsins.length??entry.report.counts.selectedCount} 个样本链接的 Amazon Customers Say 聚合 · ${entry.report.categoryName??entry.report.scope.nodeIdPath}`} badge={<span className="source-badge">Customers Say · 已保存来源</span>} toolbar={<div className="category-cs-actions"><button type="button" className={tab==='positive'?'active':''} aria-pressed={tab==='positive'} onClick={()=>setTab('positive')}>正面见解</button><button type="button" className={tab==='negative'?'active':''} aria-pressed={tab==='negative'} onClick={()=>setTab('negative')}>负面/分歧见解</button><button type="button" disabled={busy||translationBusy} onClick={()=>setReload(n=>n+1)}>重读已存见解</button><button type="button" disabled={writesDisabled||translationBusy} onClick={()=>void translate()}>{translationBusy?'正在翻译…':`统一为${marketThemeLanguage(entry.report.scope.marketplace).name}`}</button></div>}>
   <p className="category-cs-note">Customers Say 主题提及份额不代表独立评论发生率。正负向计数不假定互斥；{original?'主题按 1.2 倍阈值分栏，分歧主题进入负面/分歧栏。':'同一主题可以出现在两种见解中。'}更新 {entry.report.dataCutoffAt.slice(0,10)} · {entry.current?'当前报告':'历史报告'} · {presentationStatus==='complete'?semanticSkipped?'规则数据已完整':'分析完整':presentationStatus==='partial'?'部分结果':'暂无数据'} · 已取得主题 {result?result.asins.filter(a=>a.status==='success').length:entry.report.counts.successfulCount}/{result?.selectedAsins.length??entry.report.counts.selectedCount} 个商品。</p>
   {(result?result.asins.filter(a=>a.status==='empty').length:entry.report.counts.emptyCount)>0&&<p className="market-research-note">来源已响应，但 {result?result.asins.filter(a=>a.status==='empty').length:entry.report.counts.emptyCount} 个商品未返回 Customers Say 主题{result?`（${result.asins.filter(a=>a.status==='empty').map(a=>a.asin).join('、')}）`:''}。这不代表商品没有评论；当前没有可恢复的主题内容，保留已取得结果。</p>}
   {quarantinedCount>0&&<p className="market-research-notice" role="status">已隔离 {quarantinedCount} 条异常主题；有效主题继续参与分析，份额仅按有效主题提及数计算。本报告为部分数据，异常原文已保留。</p>}
   {translationError&&<p className="market-research-note">{translationError}</p>}
   {!result&&error?<div className="pending-box" role="alert"><strong>读取失败</strong><span>{error}</span></div>:!shownGroups?<div className="pending-box" role="status"><strong>正在读取 Customers Say…</strong><span>读取此版本已保存主题和摘要。</span></div>:visible.length?<MarketThemeTopicTable groups={visible} entry={entry} evidence={shownEvidence} translations={translations}/>:<div className="pending-box"><span>{result&&result.sentimentGroupCounts[tab]>0?'当前标签有 '+result.sentimentGroupCounts[tab]+' 个主题，本次受'+(result.display.omittedGroupCount>0?'报告展示上限'+(result.previewOmittedGroupCount>0?'或预览预算':''):'预览预算')+'限制未展示；完整事实和统计仍保留。':tab==='positive'?'暂无显著正面主题':'暂无显著负面/分歧主题'}</span></div>}
   {shownGroups&&<details className="market-insights-topic-notes"><summary>主题展示范围与正负向划分</summary><p className="category-cs-note">当前标签展示 {visible.length}/{result?.sentimentGroupCounts[tab]??active.length} 个主题；{original?'正向提及数大于负向的 1.2 倍进入正面栏；负向大于正向的 1.2 倍为负面，其余为分歧，统一进入负面/分歧栏。':'按已保存正向 / 负向计数是否大于零分别筛选。不执行原版 1.2 倍阈值分类；零正负计数的主题保留在完整证据中。'}展示上限 12 不改变分母。{result&&result.previewOmittedGroupCount>0?`此次预览未展示 ${result.previewOmittedGroupCount} 组，完整事实仍用于分母计算。`:null}主题份额分母为当前保留且成功取得有效主题的 ASIN 的全部主题提及数；失败、空结果和缺失样本不补零。{original?'分栏不代表来源正负计数互斥，不进行逐条评论去重。':'正负集合可重叠，不进行逐条评论去重。'}{shownDisplay&&shownDisplay.omittedGroupCount>0?`报告还省略 ${shownDisplay.omittedGroupCount} 组；完整来源范围见下方证据。`:''}</p>{selection&&<p className="category-cs-note">样本版本{selection.revision?` #${selection.revision.ordinal}`:'：基准'} · {selection.revision?.revisionId??entry.report.reportHash}。基准 {entry.attemptId} / {entry.report.reportHash}。{semanticSkipped?(original?'按原主题名称去首尾空格并忽略大小写归并；仅用冻结来源中保留的 ASIN 重算，不调用模型、不重新采集。':'仅按冻结来源中保留的 ASIN 重算；本任务未启用语义归组，也不重新采集。'):'继承基准映射，仅按保留 ASIN 重算；不重跑模型、不重新采集。未知和不可用映射保留原状态。'}{result?.baseSelectionShortfall?'基准来源返回的选样数量不足，修订不补位且保留此限制。':null}{!semanticSkipped&&result?.reconciliationRequired?'基准仍需主题 reconciliation，修订不代表其已完成。':''}</p>}</details>}
  </MarketThemeLaunchSection>
  <MarketThemeLaunchSection title={`样本 ASIN（${result?.selectedAsins.length??entry.report.counts.selectedCount}）`} description="以下链接属于本次保存的样本；可点开 Amazon 查看详情页 Customers Say" toolbar={selection?<div className="category-cs-actions"><label>样本版本 <select aria-label="样本版本" disabled={busy} value={selection.revision?.revisionId??'base'} onChange={e=>void choose(e.target.value)}><option value="base">基准样本</option>{selection.history.map(r=><option key={r.revisionId} value={r.revisionId}>版本 {r.ordinal}{r.revisionId===selection.latestRevisionId?'（最新）':''}</option>)}</select></label>{!!result?.excludedAsins.length&&<button type="button" disabled={writesDisabled||busy||readOnly} onClick={()=>void change([])}>恢复全部移出链接（{result.excludedAsins.length}）</button>}</div>:undefined}>
   <p className="category-cs-note">按供应商返回顺序选中，尚未验证 BSR 排名。标题、来源排名和总览摘要仅使用冻结证据；图片仅显示此报告保存的来源地址，缺失或加载失败保留占位。移除或恢复会保存新版本，保留基准和历史，不补入其他商品。{readOnly?'当前为历史样本版本，只读；请切换最新版本后操作。':''}{busy?'正在保存或读取样本版本…':''}</p>
   {selectionError&&<p role="alert">{selectionError} <button type="button" onClick={()=>setReload(n=>n+1)}>重读样本版本</button></p>}
   {!result&&sampleError?<div className="pending-box" role="alert"><strong>样本读取失败</strong><span>{sampleError}</span></div>:!shownAsins?<div className="pending-box" role="status">正在读取样本…</div>:shownAsins.length?<MarketThemeSampleTable asins={shownAsins} samples={selection?.samples} translations={translations} marketplace={entry.report.scope.marketplace} busy={busy||writesDisabled} onRemove={selection&&!readOnly?asin=>void change([...(result?.excludedAsins??[]),asin]):undefined}/>:<div className="pending-box">暂无可展示的样本。</div>}
   {result&&result.excludedAsins.length>0&&<details><summary>已移出样本（{result.excludedAsins.length}）</summary><p>{result.excludedAsins.join('、')}</p></details>}
  </MarketThemeLaunchSection>
 </>;
}
