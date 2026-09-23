"use client";
import { browserRequestId } from "./lib/browser-request-id";
import {marketSiteCurrency} from "../shared/market-sites";
import React,{useEffect,useImperativeHandle,useRef,useState,type FormEvent} from 'react';
import {MarketModuleIdSchema} from '../shared/market-module-contracts';
import type {MarketResearchScope} from '../shared/market-research-contracts';
import type {MarketOverviewRunResponse} from '../shared/market-overview-report-contracts';
import {createOverviewStudy,startOverviewRun,readOverviewRun,retryOverviewSteps,cancelOverviewRun} from './lib/market-overview-browser';
import {MarketOverviewReport} from './market-overview-report';
import {overviewSourceLabels} from './market-overview-distributions';
import {overviewReportStartMonth} from './lib/market-overview-period';
type Run=MarketOverviewRunResponse['run'];
const active=(run:Run)=>run.status!=='cancelled'&&run.steps.some(s=>s.current&&['queued','running'].includes(s.status));
const labels:Partial<Record<Run['steps'][number]['kind'],string>>={'collect-overview-month':'采集月度来源',rules:'整理数字','prepare-members':'规划分析分段','prepare-model-batches':'准备分析输入','model-batch':'解释证据',report:'保存报告'};
const statuses={queued:'排队中',running:'执行中',succeeded:'已完成',empty:'结果为空',failed:'失败',cancelled:'已取消'};
const errors:Record<string,string>={timeout:'处理超时',governance:'模型配置或额度不可用','invalid-data':'结果未通过校验',authentication:'来源认证失败','upstream-temporary':'来源暂不可用',interrupted:'执行中断','scope-mismatch':'来源范围不符',internal:'内部处理失败',cancelled:'已取消'};
function remember(id:string){const url=new URL(window.location.href);url.searchParams.set('overviewRun',id);url.searchParams.set('themeView','overview');window.history.replaceState(window.history.state,'',url);}
export type MarketOverviewController = { openReport: (scope: MarketResearchScope) => void };
export function MarketOverviewSection({scope,fromMonth,onFromMonth,onRestoreScope,controller,onExpandedChange}:{scope:MarketResearchScope;fromMonth:string;onFromMonth:(value:string)=>void;onRestoreScope:(run:Run)=>void;controller?:React.Ref<MarketOverviewController>;onExpandedChange?:(open:boolean)=>void}){
  const [expanded,setExpanded]=useState(false);
  const [runId,setRunId]=useState<string|null>(null),[run,setRun]=useState<Run|null>(null),[restoreId,setRestoreId]=useState(''),[choice,setChoice]=useState('latest'),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[readError,setReadError]=useState<string|null>(null),[reload,setReload]=useState(0);
  const owner=useRef<AbortController|null>(null),writing=useRef(false),revision=useRef(0),props=useRef({scope,onRestoreScope});props.current={scope,onRestoreScope};
  const startKeys=useRef<{signature:string;study:string;run:string}|null>(null),actionKey=useRef<{signature:string;key:string}|null>(null);
  useEffect(()=>{const abort=new AbortController();owner.current=abort;const restored=MarketModuleIdSchema.safeParse(new URL(window.location.href).searchParams.get('overviewRun'));if(restored.success){setRunId(restored.data);setRestoreId(restored.data);setExpanded(true);}return()=>{abort.abort();owner.current=null;};},[]);
  function show(open:boolean){setExpanded(open);onExpandedChange?.(open);}
  useImperativeHandle(controller,()=>({openReport(requestScope){
    if(runId&&!run){show(true);if(readError)setReload(n=>n+1);return;}
    const startMonth=overviewReportStartMonth(requestScope.month,fromMonth);
    const matches=run&&run.scope.marketplace===requestScope.marketplace&&run.scope.nodeIdPath===requestScope.nodeQuery&&run.scope.fromMonth===startMonth&&run.scope.toMonth===requestScope.month&&run.params.headTopN===requestScope.headTopN&&run.params.newProductMonths===requestScope.newProductMonths;
    if(matches){show(!expanded);return;}
    onFromMonth(startMonth);show(true);void start(requestScope,startMonth);
  }}));
  useEffect(()=>{if(!runId)return;const abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    const poll=async()=>{const version=revision.current;try{const next=await readOverviewRun(runId,abort.signal);if(abort.signal.aborted)return;if(writing.current||version!==revision.current){timer=setTimeout(()=>void poll(),3000);return;}
      setRun(next);setReadError(null);if(!props.current.scope.nodeQuery)props.current.onRestoreScope(next);if(active(next))timer=setTimeout(()=>void poll(),3000);
    }catch(e){if(!abort.signal.aborted)setReadError(e instanceof Error?e.message:'读取状态失败');}};void poll();return()=>{abort.abort();if(timer)clearTimeout(timer);};
  },[runId,reload]);
  async function mutate(work:(signal:AbortSignal)=>Promise<void>){const current=owner.current;if(!current||current.signal.aborted||writing.current)return;writing.current=true;revision.current++;setBusy(true);setError(null);
    try{await work(current.signal);}catch(e){if(!current.signal.aborted)setError(e instanceof Error?e.message:'提交失败');}finally{if(!current.signal.aborted){writing.current=false;revision.current++;setBusy(false);setReload(n=>n+1);}}}
  async function start(requestScope=scope,startMonth=fromMonth){if(!/^\d+(?::\d+)*$/.test(requestScope.nodeQuery)||startMonth>requestScope.month){setError('请先选择有效类目和完整分析周期。');return;}
    show(true);
    const research={marketplace:requestScope.marketplace,currency:marketSiteCurrency(requestScope.marketplace),nodeIdPath:requestScope.nodeQuery,fromMonth:startMonth,toMonth:requestScope.month},params={headTopN:requestScope.headTopN,newProductMonths:requestScope.newProductMonths},signature=JSON.stringify({research,params});
    await mutate(async signal=>{if(startKeys.current?.signature!==signature)startKeys.current={signature,study:browserRequestId(),run:browserRequestId()};const keys=startKeys.current;const study=await createOverviewStudy(research,keys.study,signal),next=await startOverviewRun(study.id,params,keys.run,signal);if(!signal.aborted){setRun(next);setRunId(next.id);setRestoreId(next.id);setChoice('latest');setReadError(null);remember(next.id);}});
  }
  async function action(kind:'retry'|'cancel',step?:Run['steps'][number]){if(!run)return;const id=run.id,steps=step?.latestAttemptId?[{stepId:step.id,failedAttemptId:step.latestAttemptId}]:[],signature=JSON.stringify({id,kind,steps});if(actionKey.current?.signature!==signature)actionKey.current={signature,key:browserRequestId()};const key=actionKey.current.key;
    await mutate(async signal=>{if(kind==='retry')await retryOverviewSteps(id,steps,key,signal);else await cancelOverviewRun(id,key,signal);const next=await readOverviewRun(id,signal);if(!signal.aborted){setRun(next);setReadError(null);}});}
  function restore(event:FormEvent){event.preventDefault();const parsed=MarketModuleIdSchema.safeParse(restoreId.trim());if(!parsed.success){setError('请输入有效任务编号。');return;}show(true);setRun(null);setChoice('latest');setRunId(parsed.data);setReadError(null);remember(parsed.data);setReload(n=>n+1);}
  const selected=run?(choice==='latest'?run.currentReport??run.latestSavedReport:run.history.find(r=>r.attemptId===choice)??null):null;
  const currentSteps=run?.steps.filter(step=>step.current)??[];
  const isActive=run?active(run):false;
  const failedStep=currentSteps.find(step=>step.status==='failed');
  const runningStep=currentSteps.find(step=>step.status==='running')??currentSteps.find(step=>step.status==='queued');
  const processedSteps=currentSteps.filter(step=>['succeeded','empty','failed'].includes(step.status)).length;
  const pendingTitle=busy?'正在拉取市场分析报告':readError?'未能读取任务，请刷新状态或检查任务编号。':!run?runId?'正在读取总览任务…':'报告尚未生成':isActive?`正在${labels[runningStep?.kind??'rules']??'处理任务'} · 已处理 ${processedSteps}/${currentSteps.length} 步`:failedStep?`${labels[failedStep.kind]??'总览分析'}失败：${errors[failedStep.errorCode??'internal']??'请查看任务进度'}`:run.status==='cancelled'?'分析已取消':'报告尚未生成，请刷新状态';
  const different=run&&(run.scope.marketplace!==scope.marketplace||run.scope.nodeIdPath!==scope.nodeQuery||run.scope.toMonth!==scope.month||run.scope.fromMonth!==fromMonth||run.params.headTopN!==scope.headTopN||run.params.newProductMonths!==scope.newProductMonths);
  return <section className="market-overview-native market-reference-overview" aria-label="总览分析任务">
    <details className="market-reference-tools"><summary>分析设置与任务管理</summary>
    <form onSubmit={e=>{e.preventDefault();void start();}} className="market-theme-actions"><label>分析起始月 <input required type="month" min="2000-01" max={scope.month} value={fromMonth} disabled={busy} onChange={e=>onFromMonth(e.target.value)}/></label><span>至 {scope.month} · 类目 {scope.nodeQuery||'尚未选择'}</span><button className="primary-btn" type="submit" disabled={busy||!scope.nodeQuery}>{busy?'提交中…':'开始总览分析'}</button></form>
    <details className="market-research-boundaries"><summary>恢复已有总览任务</summary><form onSubmit={restore} className="market-theme-actions"><label>总览任务编号 <input value={restoreId} onChange={e=>setRestoreId(e.target.value)} disabled={busy} required/></label><button type="submit" className="ghost-btn" disabled={busy}>读取总览任务</button></form><p>任务地址可用于刷新恢复；恢复只读取，不会再次采集。</p></details>
    <div className="market-theme-actions"><button className="ghost-btn" type="button" disabled={!runId||busy} onClick={()=>setReload(n=>n+1)}>刷新总览状态</button>{run&&active(run)&&<button className="ghost-btn" type="button" disabled={busy||!!readError} onClick={()=>void action('cancel')}>取消总览分析</button>}</div>
    {run&&<>
      <ul className="market-theme-steps">{run.steps.filter(s=>s.current).map(s=><li key={s.id}><span>{s.source?`${s.source.month} · ${overviewSourceLabels[s.source.operation]}`:labels[s.kind]??'后台步骤'}：{statuses[s.status]}{s.errorCode?`（${errors[s.errorCode]}）`:''}</span>{s.canRetry&&<button className="ghost-btn" type="button" disabled={busy||!!readError} onClick={()=>void action('retry',s)}>{s.source?'补抓此来源':'重试此分段'}</button>}</li>)}</ul>
      {run.history.length>0&&<label className="market-theme-version">总览报告版本 <select aria-label="总览报告版本" value={choice} onChange={e=>{setChoice(e.target.value);show(true);}}><option value="latest">最新可用报告</option>{run.history.map((e,i)=><option key={e.attemptId} value={e.attemptId}>{e.current?'当前':'历史'} · {e.report.phase==='numeric'?'数字报告':'分段分析'} · {i+1}</option>)}</select></label>}
    </>}
    </details>
    {!expanded&&runId&&<button type="button" className="ghost-btn" onClick={()=>show(true)}>展开已保存报告</button>}
    {error&&<p className="market-research-error" role="alert">{error}</p>}
    {readError&&<p role="alert" className="market-research-error">状态读取失败：{readError}。保留下方上次读取的结果，最新状态尚未确认。</p>}
    {expanded&&<div className="ss-market-report-panel">
      <div className="market-reference-report-heading"><h2>总览分析与报告</h2><button type="button" className="ghost-btn" onClick={()=>show(false)}>收起报告</button></div>
      {different&&<div className="market-research-notice"><strong>查询条件已改变</strong><p>下方保留的是类目 {run.scope.nodeIdPath}、{run.scope.fromMonth} 至 {run.scope.toMonth} 的任务报告，不代表新条件的结果。</p></div>}
      {run&&<h3 className="market-reference-run-status">{!readError&&active(run)&&<span className="market-theme-spinner" aria-hidden="true"/>}{readError?'最新状态待确认':run.status==='cancelled'?'分析已取消':active(run)?'总览分析进行中':run.currentReport?'部分报告已保存':failedStep?'总览分析失败，可重试':'分析尚未完成'}</h3>}
      {run&&!run.currentReport&&selected&&<p className="market-research-notice">本轮尚无新报告，以下为之前保存的版本。</p>}
      {selected?<MarketOverviewReport key={selected.attemptId} entry={selected} headTopN={run?.params.headTopN} newProductMonths={run?.params.newProductMonths}/>:<div className="pending-box" role="status"><strong>{pendingTitle}</strong><span>{failedStep&&!isActive?'已采集的数据保留，可直接重试失败步骤。':'已保存输入保留，任务进度与重试见「分析设置与任务管理」。'}</span>{failedStep?.canRetry&&!readError&&!isActive&&<button className="ghost-btn" type="button" disabled={busy} onClick={()=>void action('retry',failedStep)}>重试{labels[failedStep.kind]??'失败步骤'}</button>}</div>}
    </div>}
  </section>;
}
