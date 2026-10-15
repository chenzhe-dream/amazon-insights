"use client";
import {MarketRetainedResult} from './market-retained-result';
import {rememberPreviousMarketRun} from './lib/market-retained-result';
import { browserRequestId } from "./lib/browser-request-id";
import {MarketSiteSelector} from "./market-site-selector";
import {marketSiteCurrency,type MarketSite} from "../shared/market-sites";
import React, { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { MarketModuleIdSchema, type MarketThemeRunResponse } from '../shared/market-module-contracts';
import { cancelThemeRun, queryThemeRun, readThemeRun, retryThemeSteps } from './lib/market-theme-browser';
import {themeSourceErrorText} from './lib/market-theme-source-error';
import {marketThemeSourceIssueText} from '../shared/market-theme-source-issue';
import { MarketThemeReport } from './market-theme-report';
import { themeSavedReportStatus } from './lib/market-theme-rule-status';
import { MarketThemeLaunchSection } from './market-theme-insight-panel';
import {resolveShapeNodeInput} from './lib/market-shape-browser';

type Run=MarketThemeRunResponse['run'];
const labels:Record<Run['steps'][number]['kind'],string>={'collect-product-image':'取得商品图片','collect-shape-pool':'取得Sorftime商品池','collect-product-amount-history':'取得商品历史金额','collect-product-month':'取得类目商品池','collect-shape-category':'类目历史与指标', 'collect-product-history':'取得商品历史','collect-overview-month':'取得类目月度总览','collect-keyword-page':'取得关键词','collect-keyword-aba':'取得逐词 ABA 份额','collect-keyword-trend':'取得趋势','collect-customer-themes':'取得商品主题','prepare-members':'固定样本与汇总主题','prepare-keyword-pool':'汇总关键词','prepare-model-batches':'准备模型输入',reconcile:'确认跨批分类','model-batch':'模型分析主题',rules:'核算主题指标',report:'保存报告'};
const statuses={queued:'排队中',running:'执行中',succeeded:'已完成',empty:'结果为空',failed:'失败',cancelled:'已取消'};

export function MarketThemeStepStatus({step:s}:{step:Run['steps'][number]}) {
 return <span>{labels[s.kind]}{s.asin?` · ${s.asin}`:''}：{statuses[s.status]}{s.errorCode?`（${themeSourceErrorText(s.errorCode)}）`:''}{s.status==='failed'&&s.sourceIssue&&<><br/><small>{marketThemeSourceIssueText(s.sourceIssue)}</small></>}</span>;
}
export function themeRunActive(run:Run) {return run.status!=='cancelled'&&run.steps.some(s=>s.current&&(s.status==='queued'||s.status==='running'));}
export function themeRunLabel(run:Run) {
  if(run.status==='cancelled')return '分析已取消';
  if(themeRunActive(run))return run.steps.some(s=>s.current&&s.status==='running')?'主题分析中':'等待后台执行';
  if(run.currentReport){const report=run.currentReport.report,status=themeSavedReportStatus(report);return status==='complete'?report.semanticStatus==='skipped'?'规则报告已保存':'报告已保存':status==='partial'?report.semanticStatus==='skipped'?'部分规则报告已保存':'部分报告已保存':'暂无可用主题';}
  return run.steps.some(s=>s.current&&s.status==='failed')?'分析未完成':'等待后续处理';
}
export function MarketThemePendingReport({run,runId,node,readError}:{run:Run|null;runId:string|null;node:string;readError:string|null}) {
 const failed=run?.steps.filter(s=>s.current&&s.status==='failed')??[];
 const active=!!run&&themeRunActive(run),cancelled=run?.status==='cancelled';
 const title=readError?'任务读取失败':cancelled?'分析已取消':active?themeRunLabel(run!):failed.length?'主题分析失败':run?'分析已结束，未生成报告':runId?'正在读取主题任务…':node?'等待拉取见解':'等待指定类目节点';
 const visibleSteps=readError||cancelled?[]:active?run!.steps.filter(s=>s.current&&s.status==='running'):failed;
 const detail=readError?'请刷新状态；当前任务进度尚未确认。':cancelled?'本次分析已停止，可重新拉取创建新任务。':active?(visibleSteps.length?'正在执行下列步骤，完成后自动展示报告。':'任务已排队，等待后台执行。'):failed.length?(failed.some(s=>s.canRetry)?'可在下方重试失败步骤，已保存的数据保留。':'当前失败步骤不能直接重试；修复后点击上方“重新拉取”创建新任务，原任务保留。'):run?'请查看下方任务进度，确认未生成报告的原因。':runId?'正在读取已保存状态。':'选择类目后点击“拉取见解”。';
 return <div className="pending-box market-theme-pending" role="status"><strong>{title}</strong><span>{detail}</span>{visibleSteps.length>0&&<ul className="market-theme-steps">{visibleSteps.map(s=><li key={s.id}><MarketThemeStepStatus step={s}/></li>)}</ul>}</div>;
}
export function themeRunFromUrl() {if(typeof window==='undefined')return null;const result=MarketModuleIdSchema.safeParse(new URL(window.location.href).searchParams.get('themeRun'));return result.success?result.data:null;}
function rememberRun(id:string) {const url=new URL(window.location.href);rememberPreviousMarketRun('themeRun',id,url.searchParams.get('themeRun'));url.searchParams.set('themeRun',id);url.searchParams.set('themeView','themes');window.history.replaceState(window.history.state,'',url);}

type ResearchSelection={marketplace?:MarketSite;nodeIdPath:string;fromMonth:string;toMonth:string};
export function MarketThemeSection({maxMonth,selection,onSelectionChange,onFavorite}:{maxMonth:string;onFavorite?:()=>void;selection?:ResearchSelection;onSelectionChange?:(patch:Partial<ResearchSelection>)=>void}) {
  const [localSite,setLocalSite]=useState<MarketSite>('US');
  const [localNode,setLocalNode]=useState(''),[localMonth,setLocalMonth]=useState(maxMonth),[members,setMembers]=useState(20),[pool,setPool]=useState(100);
  const node=selection?.nodeIdPath??localNode,month=selection?.toMonth??localMonth;
  const setNode=(nodeIdPath:string)=>onSelectionChange?onSelectionChange({nodeIdPath}):setLocalNode(nodeIdPath),setMonth=(toMonth:string)=>onSelectionChange?onSelectionChange({toMonth}):setLocalMonth(toMonth);
  const selectionRef=useRef({selection,onSelectionChange});selectionRef.current={selection,onSelectionChange};
  const [runId,setRunId]=useState<string|null>(null),[restoreId,setRestoreId]=useState(''),[run,setRun]=useState<Run|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[readError,setReadError]=useState<string|null>(null),[reload,setReload]=useState(0);
  const [reportChoice,setReportChoice]=useState('latest');
  const [workflowOpen,setWorkflowOpen]=useState(false);
  const [priorRuns,setPriorRuns]=useState<string[]>([]);
  const owner=useRef<AbortController|null>(null),writing=useRef(false),revision=useRef(0);
  const mutationOwner=useRef<AbortController|null>(null);
  const startCommand=useRef<{signature:string;studyKey:string;runKey:string}|null>(null);
  const refreshCommand=useRef<{runId:string;studyKey:string;runKey:string}|null>(null);
  const command=useRef<{signature:string;key:string}|null>(null);
  const [targetLoading,setTargetLoading]=useState(false),[targetError,setTargetError]=useState<string|null>(null);
  const reportWrites=useRef(new Set<string>()),[reportSaving,setReportSaving]=useState(false);
  const onReportWrite=useCallback((source:string,saving:boolean)=>{
    const wasSaving=reportWrites.current.size>0;
    if(saving)reportWrites.current.add(source);else reportWrites.current.delete(source);
    // Reads started before a writer must not accept their stale snapshot after it settles.
    revision.current++;
    const isSaving=reportWrites.current.size>0;setReportSaving(isSaving);
    if(wasSaving&&!isSaving)setReload(n=>n+1);
  },[]);
  const targetOwner=useRef<AbortController|null>(null),targetGeneration=useRef(0),pollOwner=useRef<AbortController|null>(null),pollGeneration=useRef(0);
  const queryKey=JSON.stringify([selection?.marketplace??localSite,node,selection?.fromMonth??month,month,members,pool]);
  const queryState=useRef({key:queryKey,revision:0,node});
  if(queryState.current.key!==queryKey)queryState.current.revision++;
  queryState.current={key:queryKey,revision:queryState.current.revision,node};
  const scopeRestore=useRef<{id:string;revision:number|null}|null>(null);
  function restoreQuery(next:Run,inputRevision:number){
    if(inputRevision!==queryState.current.revision)return;
    const {marketplace,nodeIdPath,fromMonth,toMonth}=next.scope;
    setLocalSite(marketplace);setLocalNode(nodeIdPath);setLocalMonth(toMonth);
    setMembers(next.params.memberCount);setPool(next.params.poolSize);
    selectionRef.current.onSelectionChange?.({marketplace,nodeIdPath,fromMonth,toMonth});
  }
  function cancelTarget(){targetOwner.current?.abort();targetOwner.current=null;targetGeneration.current++;setTargetLoading(false);}
  function invalidatePoll(){pollOwner.current?.abort();pollGeneration.current++;}
  function clearReport(){invalidatePoll();mutationOwner.current?.abort();mutationOwner.current=null;writing.current=false;revision.current++;setBusy(false);setRun(null);setRunId(null);scopeRestore.current=null;}
  useEffect(()=>{const abort=new AbortController();owner.current=abort;const restored=themeRunFromUrl();if(restored){scopeRestore.current={id:restored,revision:null};setRunId(restored);setRestoreId(restored);}return()=>{abort.abort();owner.current=null;mutationOwner.current?.abort();mutationOwner.current=null;targetOwner.current?.abort();targetGeneration.current++;invalidatePoll();};},[]);
  useEffect(()=>{
    if(!runId)return;const intent=scopeRestore.current;
    if(intent?.id===runId&&intent.revision===null){if(queryState.current.node.trim())scopeRestore.current=null;else intent.revision=queryState.current.revision;}
    const abort=new AbortController(),generation=++pollGeneration.current;pollOwner.current=abort;let timer:ReturnType<typeof setTimeout>|undefined;
    async function poll(){const version=revision.current;try{const result=await readThemeRun(runId!,abort.signal);if(abort.signal.aborted||generation!==pollGeneration.current)return;
      if(version!==revision.current||writing.current||reportWrites.current.size){timer=setTimeout(()=>void poll(),3000);return;}
      setRun(result);setReadError(null);if(scopeRestore.current===intent&&intent?.id===runId){scopeRestore.current=null;if(intent.revision!==null)restoreQuery(result,intent.revision);}if(themeRunActive(result))timer=setTimeout(()=>void poll(),3000);
    }catch(e){if(!abort.signal.aborted&&generation===pollGeneration.current){if([401,403].includes((e as {status:number}).status)){clearReport();cancelTarget();}setReadError(e instanceof Error?e.message:'读取状态失败');}}}
    void poll();return()=>{abort.abort();if(timer)clearTimeout(timer);};
  },[runId,reload]);
  function adopt(next:Run,inputRevision:number){invalidatePoll();restoreQuery(next,inputRevision);setRun(next);setRunId(next.id);setRestoreId(next.id);setReportChoice('latest');setReadError(null);rememberRun(next.id);}
  async function mutate(work:(signal:AbortSignal)=>Promise<void>){if(!owner.current||owner.current.signal.aborted||writing.current||targetOwner.current||reportWrites.current.size)return;
    // Permission cleanup aborts this operation without disabling explicit future requests.
    const current=new AbortController();mutationOwner.current=current;
    writing.current=true;revision.current++;setBusy(true);setError(null);
    try{await work(current.signal);}catch(e){if(!current.signal.aborted&&mutationOwner.current===current)setError(e instanceof Error?e.message:'提交失败');}
    finally{if(!current.signal.aborted&&mutationOwner.current===current){mutationOwner.current=null;writing.current=false;revision.current++;setBusy(false);setReload(n=>n+1);}}}
  async function submit(event:FormEvent){event.preventDefault();if(run&&themeRunActive(run))return;if(month>maxMonth||members>pool){setError('请选择完整月份，且商品池数量不得小于主题样本数量。');return;}
    const scope={marketplace:selection?.marketplace??localSite,nodeIdPath:node,fromMonth:selection?.fromMonth??month,toMonth:month,currency:marketSiteCurrency(selection?.marketplace??localSite)},params={memberCount:members,poolSize:pool,newProductMonths:6 as const};
    const signature=JSON.stringify({scope,params});if(startCommand.current?.signature!==signature)startCommand.current={signature,studyKey:browserRequestId(),runKey:browserRequestId()};
    const keys=startCommand.current,inputRevision=queryState.current.revision;await mutate(async signal=>{const nodeIdPath=await resolveShapeNodeInput(scope.marketplace,scope.nodeIdPath,signal);const result=await queryThemeRun({scope:{...scope,nodeIdPath},params,forceRefresh:false},keys.runKey,signal);if(!signal.aborted){startCommand.current=null;adopt(result,inputRevision);}});
  }
  async function recollect(){
    if(!run||busy||readError||themeRunActive(run))return;
    const previous=run,inputRevision=queryState.current.revision;
    if(refreshCommand.current?.runId!==previous.id)refreshCommand.current={runId:previous.id,studyKey:browserRequestId(),runKey:browserRequestId()};
    const keys=refreshCommand.current,{marketplace,nodeIdPath,fromMonth,toMonth,currency}=previous.scope;
    await mutate(async signal=>{
      const next=await queryThemeRun({scope:{marketplace,nodeIdPath,fromMonth,toMonth,currency},params:previous.params,forceRefresh:true},keys.runKey,signal);
      if(!signal.aborted){setPriorRuns(ids=>[previous.id,...ids.filter(id=>id!==previous.id)]);refreshCommand.current=null;adopt(next,inputRevision);}
    });
  }
  async function restore(event:FormEvent){event.preventDefault();if(writing.current||reportWrites.current.size)return;
    const parsed=MarketModuleIdSchema.safeParse(restoreId.trim());if(!parsed.success){setTargetError('请输入有效的任务 UUID。');return;}
    cancelTarget();const abort=new AbortController(),generation=targetGeneration.current,inputRevision=queryState.current.revision;
    targetOwner.current=abort;setTargetLoading(true);setTargetError(null);
    try{const next=await readThemeRun(parsed.data,abort.signal);if(abort.signal.aborted||generation!==targetGeneration.current||!owner.current||writing.current||reportWrites.current.size)return;
      invalidatePoll();revision.current++;scopeRestore.current=null;
      if(next.id===runId){setRun(next);setReadError(null);setReload(n=>n+1);}
      else{adopt(next,inputRevision);}
    }catch(e){if(!abort.signal.aborted&&generation===targetGeneration.current){const status=(e as {status?:number}).status;
      const revoked=status===401||(status===403&&parsed.data===runId);
      if(revoked)clearReport();
      setTargetError(`${run&&!revoked?'目标任务读取失败，仍显示原任务':'未读取到任务'}：${status===403?'无权读取目标任务。':e instanceof Error?e.message:'读取失败'}`);
    }}finally{if(generation===targetGeneration.current){targetOwner.current=null;setTargetLoading(false);}}
  }
  async function action(kind:'retry'|'cancel',step?:Run['steps'][number]){if(!run)return;const id=run.id;
    const steps=step?.latestAttemptId?[{stepId:step.id,failedAttemptId:step.latestAttemptId}]:[];
    const signature=JSON.stringify({id,kind,steps});if(command.current?.signature!==signature)command.current={signature,key:browserRequestId()};const key=command.current.key;
    await mutate(async signal=>{if(kind==='retry')await retryThemeSteps(id,steps,key,signal);else await cancelThemeRun(id,key,signal);
      const next=await readThemeRun(id,signal);if(!signal.aborted){setRun(next);setReadError(null);}});
  }
  const selected=run?(reportChoice==='latest'?(run.currentReport??run.latestSavedReport):run.history.find(e=>e.attemptId===reportChoice)??null):null;
  useEffect(()=>{if(run&&!selected)setWorkflowOpen(true);},[run?.id,!!selected]);
  return <div className="market-research-page market-theme-page">
    <section className="card ss-market-query ss-market-query--lilac">
      <form onSubmit={e=>void submit(e)}><fieldset disabled={busy||reportSaving} style={{minWidth:0}}><legend className="market-research-sr-only">类目主题分析条件</legend>
        <div className="ss-market-query-row"><span className="ss-market-query-label">站点</span><MarketSiteSelector value={selection?.marketplace??localSite} onChange={marketplace=>{if(onSelectionChange)onSelectionChange({marketplace,nodeIdPath:''});else{setLocalSite(marketplace);setLocalNode('')}}} disabled={busy||reportSaving}/></div>
        <div className="ss-market-query-highlight"><div className="ss-market-query-row"><span className="ss-market-query-label">选择类目</span><div className="ss-market-node-field">
          <button type="submit" className="ss-market-search-btn" disabled={reportSaving||targetLoading||!!run&&themeRunActive(run)}>{busy?'提交中…':'拉取见解'}</button><button type="button" className="ss-market-fav-btn" disabled={!onFavorite||!node} title="保存到团队共享收藏" onClick={onFavorite}>☆ 收藏</button>
          <input required aria-label="类目路径" maxLength={240} value={node} placeholder="输入类目节点 ID、完整节点路径或英文类目名" onChange={e=>setNode(e.target.value)}/>
        </div></div><p className="ss-market-cache-note">{node?`当前类目：Node ${node} · 请求 ${members} 个样本 ASIN`:'在本模块输入类目节点后点击「拉取见解」。'}{run&&<> <button type="button" className="ghost-btn" style={{padding:'0 6px',minHeight:0,height:20,lineHeight:'18px',fontSize:12}} disabled={busy||reportSaving||targetLoading||!!readError||themeRunActive(run)} title="按下方任务已保存的类目、月份与样本设置创建新任务；保留当前报告和原任务" onClick={()=>void recollect()}>重新拉取</button> 沿用下方任务已存条件新建任务，保留原报告。</>}</p></div>
        <details className="market-research-boundaries"><summary>分析月份与样本设置</summary><div className="market-research-fields"><label>完整月份<input required type="month" min="2000-01" max={maxMonth} value={month} onChange={e=>setMonth(e.target.value)}/></label>{selection&&<label>起始月份<input required type="month" min="2000-01" max={month} value={selection.fromMonth} onChange={e=>onSelectionChange?.({fromMonth:e.target.value})}/></label>}</div><div className="market-research-fields"><label>主题样本数量<input required type="number" min={1} max={20} value={members} onChange={e=>setMembers(Number(e.target.value))}/></label><label>商品池数量<input required type="number" min={members} max={100} value={pool} onChange={e=>setPool(Number(e.target.value))}/></label></div><p>样本按供应商返回顺序选择，尚未验证 BSR 排名；来源不足时保留实际数量。月份用于研究范围与选样参考；Customers Say 是采集时返回的主题，不代表该月历史评论主题。</p></details>
      </fieldset></form>
      {error&&<p className="market-research-error" role="alert">{error}</p>}
    </section>
    {readError&&<p className="market-research-error" role="alert">状态读取失败：{readError}。{run?'下方为上次取得的结果，未确认最新状态。':'未读取到任务。'}</p>}
    {run&&(run.scope.marketplace!==(selection?.marketplace??localSite)||run.scope.nodeIdPath!==node||run.scope.fromMonth!==(selection?.fromMonth??month)||run.scope.toMonth!==month||run.params.memberCount!==members||run.params.poolSize!==pool)&&<p className="market-research-notice">查询条件与下方任务不同；下方仍是类目 {run.scope.nodeIdPath}、{run.scope.fromMonth} 至 {run.scope.toMonth} 的已保存结果。</p>}
    {!run?.currentReport&&selected&&<p className="market-research-notice">当前分析尚无新报告，以下保留的历史报告不代表本轮结果。</p>}
    <MarketRetainedResult current={run} runKey="themeRun" read={readThemeRun} usable={value=>!!(value.currentReport??value.latestSavedReport)?.report.counts.successfulCount}>{saved=><MarketThemeReport entry={{...(saved.currentReport??saved.latestSavedReport)!,current:false}} writesDisabled/>}</MarketRetainedResult>
    {selected?<MarketThemeReport entry={selected} writesDisabled={targetLoading||busy} onWriteState={onReportWrite}/>:<MarketThemeLaunchSection title="类目买家评论见解" description={(selection?.marketplace??localSite)+" · 基于样本链接的 Amazon Customers Say 聚合"}><MarketThemePendingReport run={run} runId={runId} node={node} readError={readError}/></MarketThemeLaunchSection>}
    <section className="card market-insights-workflow" aria-label="主题任务与报告"><details className="market-research-boundaries" open={workflowOpen} onToggle={e=>setWorkflowOpen(e.currentTarget.open)}><summary>任务进度、重试与历史报告</summary>
      <div className="market-theme-actions"><button type="button" className="ghost-btn" disabled={!runId||busy||targetLoading} onClick={()=>setReload(n=>n+1)}>刷新状态</button>{run&&themeRunActive(run)&&<button type="button" className="ghost-btn" disabled={busy||reportSaving||targetLoading||!!readError} onClick={()=>void action('cancel')}>取消本次分析</button>}</div>
      {!run?<p role="status">{readError?'未能读取任务，请刷新状态或检查任务编号。':runId?'正在读取主题任务…':'尚未开始主题分析。可新建分析或恢复已有任务。'}</p>:<>
        <div className="market-research-job-heading"><h3>{!readError&&themeRunActive(run)&&<span className="market-theme-spinner" aria-hidden="true"/>}{readError?'最新状态待确认':themeRunLabel(run)}</h3><small>任务：{run.id}</small></div>
        <p className="market-research-note">{run.scope.marketplace} · {run.scope.nodeIdPath} · {run.scope.fromMonth} 至 {run.scope.toMonth}</p>
        <ul className="market-theme-steps">{run.steps.filter(s=>s.current).map(s=><li key={s.id}><MarketThemeStepStatus step={s}/>{s.canRetry&&<button type="button" className="ghost-btn" disabled={busy||reportSaving||targetLoading||!!readError} onClick={()=>void action('retry',s)}>重试{ s.asin?` ${s.asin}`:'此步骤'}</button>}</li>)}</ul>
        {run.history.length>0&&<label className="market-theme-version">报告版本 <select aria-label="报告版本" disabled={reportSaving||busy||targetLoading} value={reportChoice} onChange={e=>setReportChoice(e.target.value)}><option value="latest">最新可用报告</option>{run.history.map((e,i)=><option key={e.attemptId} value={e.attemptId}>{e.current?'当前':'历史'} · {e.report.dataCutoffAt} · {i+1}</option>)}</select></label>}
      </>}
      <details className="market-research-boundaries"><summary>恢复已有主题任务</summary><form className="market-theme-actions" onSubmit={e=>void restore(e)}><label>任务 UUID <input value={restoreId} onChange={e=>setRestoreId(e.target.value)} required disabled={busy||reportSaving}/></label><button type="submit" className="ghost-btn" disabled={busy||reportSaving}>{targetLoading?'读取目标中…':'读取任务'}</button>{targetLoading&&<button type="button" onClick={cancelTarget}>取消读取</button>}</form>{targetLoading&&<p role="status">正在读取目标任务，当前报告保留。</p>}{targetError&&<p className="market-research-error" role="alert">{targetError}</p>}<p>已打开的任务保存在当前地址中，刷新只读取状态和报告。</p></details>
      {priorRuns.length>0&&<p>重新拉取前的任务：{priorRuns.map(id=><a key={id} href={`?themeRun=${id}&themeView=themes`}>{id} </a>)}</p>}
    </details></section>
  </div>;
}
