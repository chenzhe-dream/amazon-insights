"use client";
import React,{useEffect,useRef,useState,type FormEvent} from 'react';
import {MarketModuleIdSchema} from '../shared/market-module-contracts';
import type {MarketResearchScope} from '../shared/market-research-contracts';
import type {MarketOverviewRunResponse} from '../shared/market-overview-report-contracts';
import {createOverviewStudy,startOverviewRun,readOverviewRun,retryOverviewSteps,cancelOverviewRun} from './lib/market-overview-browser';
import {MarketOverviewReport} from './market-overview-report';
import {overviewSourceLabels} from './market-overview-distributions';
type Run=MarketOverviewRunResponse['run'];
const active=(run:Run)=>run.status!=='cancelled'&&run.steps.some(s=>s.current&&['queued','running'].includes(s.status));
const labels:Partial<Record<Run['steps'][number]['kind'],string>>={'collect-overview-month':'采集月度来源',rules:'整理数字','prepare-members':'规划分析分段','prepare-model-batches':'准备分析输入','model-batch':'解释证据',report:'保存报告'};
const statuses={queued:'排队中',running:'执行中',succeeded:'已完成',empty:'结果为空',failed:'失败',cancelled:'已取消'};
const errors:Record<string,string>={timeout:'处理超时',governance:'模型配置或额度不可用','invalid-data':'结果未通过校验',authentication:'来源认证失败','upstream-temporary':'来源暂不可用',interrupted:'执行中断','scope-mismatch':'来源范围不符',internal:'内部处理失败',cancelled:'已取消'};
function remember(id:string){const url=new URL(window.location.href);url.searchParams.set('overviewRun',id);url.searchParams.set('themeView','overview');window.history.replaceState(window.history.state,'',url);}
export function MarketOverviewSection({scope,fromMonth,onFromMonth,onRestoreScope}:{scope:MarketResearchScope;fromMonth:string;onFromMonth:(value:string)=>void;onRestoreScope:(run:Run)=>void}){
  const [runId,setRunId]=useState<string|null>(null),[run,setRun]=useState<Run|null>(null),[restoreId,setRestoreId]=useState(''),[choice,setChoice]=useState('latest'),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[readError,setReadError]=useState<string|null>(null),[reload,setReload]=useState(0);
  const owner=useRef<AbortController|null>(null),writing=useRef(false),revision=useRef(0),props=useRef({scope,onRestoreScope});props.current={scope,onRestoreScope};
  const startKeys=useRef<{signature:string;study:string;run:string}|null>(null),actionKey=useRef<{signature:string;key:string}|null>(null);
  useEffect(()=>{const abort=new AbortController();owner.current=abort;const restored=MarketModuleIdSchema.safeParse(new URL(window.location.href).searchParams.get('overviewRun'));if(restored.success){setRunId(restored.data);setRestoreId(restored.data);}return()=>{abort.abort();owner.current=null;};},[]);
  useEffect(()=>{if(!runId)return;const abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    const poll=async()=>{const version=revision.current;try{const next=await readOverviewRun(runId,abort.signal);if(abort.signal.aborted)return;if(writing.current||version!==revision.current){timer=setTimeout(()=>void poll(),3000);return;}
      setRun(next);setReadError(null);if(!props.current.scope.nodeQuery)props.current.onRestoreScope(next);if(active(next))timer=setTimeout(()=>void poll(),3000);
    }catch(e){if(!abort.signal.aborted)setReadError(e instanceof Error?e.message:'读取状态失败');}};void poll();return()=>{abort.abort();if(timer)clearTimeout(timer);};
  },[runId,reload]);
  async function mutate(work:(signal:AbortSignal)=>Promise<void>){const current=owner.current;if(!current||current.signal.aborted||writing.current)return;writing.current=true;revision.current++;setBusy(true);setError(null);
    try{await work(current.signal);}catch(e){if(!current.signal.aborted)setError(e instanceof Error?e.message:'提交失败');}finally{if(!current.signal.aborted){writing.current=false;revision.current++;setBusy(false);setReload(n=>n+1);}}}
  async function start(event:FormEvent){event.preventDefault();if(!/^\d+(?::\d+)*$/.test(scope.nodeQuery)||fromMonth>scope.month){setError('请先选择有效类目和完整分析周期。');return;}
    const research={marketplace:'US' as const,currency:'USD' as const,nodeIdPath:scope.nodeQuery,fromMonth,toMonth:scope.month},params={headTopN:scope.headTopN,newProductMonths:scope.newProductMonths},signature=JSON.stringify({research,params});
    if(startKeys.current?.signature!==signature)startKeys.current={signature,study:crypto.randomUUID(),run:crypto.randomUUID()};const keys=startKeys.current;
    await mutate(async signal=>{const study=await createOverviewStudy(research,keys.study,signal),next=await startOverviewRun(study.id,params,keys.run,signal);if(!signal.aborted){setRun(next);setRunId(next.id);setRestoreId(next.id);setChoice('latest');setReadError(null);remember(next.id);}});
  }
  async function action(kind:'retry'|'cancel',step?:Run['steps'][number]){if(!run)return;const id=run.id,steps=step?.latestAttemptId?[{stepId:step.id,failedAttemptId:step.latestAttemptId}]:[],signature=JSON.stringify({id,kind,steps});if(actionKey.current?.signature!==signature)actionKey.current={signature,key:crypto.randomUUID()};const key=actionKey.current.key;
    await mutate(async signal=>{if(kind==='retry')await retryOverviewSteps(id,steps,key,signal);else await cancelOverviewRun(id,key,signal);const next=await readOverviewRun(id,signal);if(!signal.aborted){setRun(next);setReadError(null);}});}
  function restore(event:FormEvent){event.preventDefault();const parsed=MarketModuleIdSchema.safeParse(restoreId.trim());if(!parsed.success){setError('请输入有效任务编号。');return;}setRun(null);setChoice('latest');setRunId(parsed.data);setReadError(null);remember(parsed.data);setReload(n=>n+1);}
  const selected=run?(choice==='latest'?run.currentReport??run.latestSavedReport:run.history.find(r=>r.attemptId===choice)??null):null;
  const different=run&&(run.scope.nodeIdPath!==scope.nodeQuery||run.scope.toMonth!==scope.month||run.scope.fromMonth!==fromMonth||run.params.headTopN!==scope.headTopN||run.params.newProductMonths!==scope.newProductMonths);
  return <section className="card market-overview-native" aria-label="总览分析任务"><h2>总览分析与报告</h2>
    <p className="market-research-note">使用上方所选类目、头部数量和新品定义。数字先保存，解释按分段执行。</p>
    <form onSubmit={e=>void start(e)} className="market-theme-actions"><label>分析起始月 <input required type="month" min="2000-01" max={scope.month} value={fromMonth} disabled={busy} onChange={e=>onFromMonth(e.target.value)}/></label><span>至 {scope.month} · 类目 {scope.nodeQuery||'尚未选择'}</span><button className="primary-btn" type="submit" disabled={busy||!scope.nodeQuery}>{busy?'提交中…':'开始总览分析'}</button></form>
    {error&&<p className="market-research-error" role="alert">{error}</p>}
    <details className="market-research-boundaries"><summary>恢复已有总览任务</summary><form onSubmit={restore} className="market-theme-actions"><label>总览任务编号 <input value={restoreId} onChange={e=>setRestoreId(e.target.value)} disabled={busy} required/></label><button type="submit" className="ghost-btn" disabled={busy}>读取总览任务</button></form><p>任务地址可用于刷新恢复；恢复只读取，不会再次采集。</p></details>
    <div className="market-theme-actions"><button className="ghost-btn" type="button" disabled={!runId||busy} onClick={()=>setReload(n=>n+1)}>刷新总览状态</button>{run&&active(run)&&<button className="ghost-btn" type="button" disabled={busy||!!readError} onClick={()=>void action('cancel')}>取消总览分析</button>}</div>
    {readError&&<p role="alert" className="market-research-error">状态读取失败：{readError}。保留下方上次读取的结果，最新状态尚未确认。</p>}
    {different&&<div className="market-research-notice"><strong>查询条件已改变</strong><p>下方保留的是类目 {run.scope.nodeIdPath}、{run.scope.fromMonth} 至 {run.scope.toMonth} 的任务报告，不代表新条件的结果。</p></div>}
    {run?<><h3>{!readError&&active(run)&&<span className="market-theme-spinner" aria-hidden="true"/>}{readError?'最新状态待确认':run.status==='cancelled'?'分析已取消':active(run)?'总览分析进行中':run.currentReport?'部分报告已保存':'分析尚未完成'}</h3>
      <ul className="market-theme-steps">{run.steps.filter(s=>s.current).map(s=><li key={s.id}><span>{s.source?`${s.source.month} · ${overviewSourceLabels[s.source.operation]}`:labels[s.kind]??'后台步骤'}：{statuses[s.status]}{s.errorCode?`（${errors[s.errorCode]}）`:''}</span>{s.canRetry&&<button className="ghost-btn" type="button" disabled={busy||!!readError} onClick={()=>void action('retry',s)}>{s.source?'补抓此来源':'重试此分段'}</button>}</li>)}</ul>
      {run.history.length>0&&<label className="market-theme-version">总览报告版本 <select aria-label="总览报告版本" value={choice} onChange={e=>setChoice(e.target.value)}><option value="latest">最新可用报告</option>{run.history.map((e,i)=><option key={e.attemptId} value={e.attemptId}>{e.current?'当前':'历史'} · {e.report.phase==='numeric'?'数字报告':'分段分析'} · {i+1}</option>)}</select></label>}
      {!run.currentReport&&selected&&<p className="market-research-notice">本轮尚无新报告，以下为之前保存的版本。</p>}
      {selected?<MarketOverviewReport key={selected.attemptId} entry={selected}/>:<div className="market-research-empty"><h3>总览报告</h3><p>报告尚未生成，已保存输入保留，当前阶段与原因见上方。</p></div>}</>:<div className="market-research-empty"><h3>总览报告</h3><p>{readError?'未能读取任务，请刷新状态或检查任务编号。':runId?'正在读取总览任务…':'选择类目后开始分析，或恢复已有任务。'}</p></div>}
  </section>;
}
