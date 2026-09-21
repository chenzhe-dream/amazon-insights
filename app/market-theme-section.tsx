"use client";
import { browserRequestId } from "./lib/browser-request-id";
import {MarketSiteSelector} from "./market-site-selector";
import {marketSiteCurrency,type MarketSite} from "../shared/market-sites";
import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import { MarketModuleIdSchema, type MarketThemeRunResponse } from '../shared/market-module-contracts';
import { cancelThemeRun, createThemeStudy, readThemeRun, retryThemeSteps, startThemeRun } from './lib/market-theme-browser';
import { MarketThemeReport } from './market-theme-report';
import { MarketThemeLaunchSection } from './market-theme-insight-panel';

type Run=MarketThemeRunResponse['run'];
const labels:Record<Run['steps'][number]['kind'],string>={'collect-product-month':'取得类目商品池','collect-overview-month':'取得类目月度总览','collect-keyword-page':'取得关键词','collect-keyword-aba':'取得逐词 ABA 份额','collect-keyword-trend':'取得趋势','collect-customer-themes':'取得商品主题','prepare-members':'固定样本与汇总主题','prepare-keyword-pool':'汇总关键词','prepare-model-batches':'准备模型输入',reconcile:'确认跨批分类','model-batch':'模型分析主题',rules:'核算主题指标',report:'保存报告'};
const statuses={queued:'排队中',running:'执行中',succeeded:'已完成',empty:'结果为空',failed:'失败',cancelled:'已取消'};
const errors:Record<string,string>={ 'unsupported-marketplace':'此站点暂无该补充数据', 'upstream-temporary':'上游暂时不可用',timeout:'处理超时',interrupted:'执行中断',authentication:'来源认证失败',governance:'调用受到额度或治理限制','invalid-data':'返回数据未通过校验','scope-mismatch':'返回范围不匹配',cancelled:'已取消',internal:'内部处理失败'};
export function themeRunActive(run:Run) {return run.status!=='cancelled'&&run.steps.some(s=>s.current&&(s.status==='queued'||s.status==='running'));}
export function themeRunLabel(run:Run) {
  if(run.status==='cancelled')return '分析已取消';
  if(themeRunActive(run))return run.steps.some(s=>s.current&&s.status==='running')?'主题分析中':'等待后台执行';
  if(run.currentReport)return run.currentReport.report.status==='complete'?'报告已保存':run.currentReport.report.status==='partial'?'部分报告已保存':'暂无可用主题';
  return run.steps.some(s=>s.current&&s.status==='failed')?'分析未完成':'等待后续处理';
}
export function themeRunFromUrl() {if(typeof window==='undefined')return null;const result=MarketModuleIdSchema.safeParse(new URL(window.location.href).searchParams.get('themeRun'));return result.success?result.data:null;}
function rememberRun(id:string) {const url=new URL(window.location.href);url.searchParams.set('themeRun',id);url.searchParams.set('themeView','themes');window.history.replaceState(window.history.state,'',url);}

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
  const owner=useRef<AbortController|null>(null),writing=useRef(false),revision=useRef(0);
  const startCommand=useRef<{signature:string;studyKey:string;runKey:string}|null>(null);
  const command=useRef<{signature:string;key:string}|null>(null);
  useEffect(()=>{const abort=new AbortController();owner.current=abort;const restored=themeRunFromUrl();if(restored){setRunId(restored);setRestoreId(restored);}return()=>{abort.abort();owner.current=null;};},[]);
  useEffect(()=>{
    if(!runId)return;const abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    async function poll(){const version=revision.current;try{const result=await readThemeRun(runId!,abort.signal);if(abort.signal.aborted)return;
      if(version!==revision.current||writing.current){timer=setTimeout(()=>void poll(),3000);return;}
      setRun(result);setReadError(null);if(selectionRef.current.selection&&!selectionRef.current.selection.nodeIdPath)selectionRef.current.onSelectionChange?.({marketplace:result.scope.marketplace,nodeIdPath:result.scope.nodeIdPath,fromMonth:result.scope.fromMonth,toMonth:result.scope.toMonth});if(themeRunActive(result))timer=setTimeout(()=>void poll(),3000);
    }catch(e){if(!abort.signal.aborted){setReadError(e instanceof Error?e.message:'读取状态失败');}}}
    void poll();return()=>{abort.abort();if(timer)clearTimeout(timer);};
  },[runId,reload]);
  function adopt(next:Run){setRun(next);setRunId(next.id);setRestoreId(next.id);setReportChoice('latest');setReadError(null);rememberRun(next.id);}
  async function mutate(work:(signal:AbortSignal)=>Promise<void>){const current=owner.current;if(!current||current.signal.aborted||writing.current)return;
    writing.current=true;revision.current++;setBusy(true);setError(null);
    try{await work(current.signal);}catch(e){if(!current.signal.aborted)setError(e instanceof Error?e.message:'提交失败');}
    finally{if(!current.signal.aborted){writing.current=false;revision.current++;setBusy(false);setReload(n=>n+1);}}}
  async function submit(event:FormEvent){event.preventDefault();if(month>maxMonth||members>pool){setError('请选择完整月份，且商品池数量不得小于主题样本数量。');return;}
    const scope={marketplace:selection?.marketplace??localSite,nodeIdPath:node,fromMonth:selection?.fromMonth??month,toMonth:month,currency:marketSiteCurrency(selection?.marketplace??localSite)},params={memberCount:members,poolSize:pool,newProductMonths:6 as const};
    const signature=JSON.stringify({scope,params});if(startCommand.current?.signature!==signature)startCommand.current={signature,studyKey:browserRequestId(),runKey:browserRequestId()};
    const keys=startCommand.current;await mutate(async signal=>{const study=await createThemeStudy(scope,keys.studyKey,signal);const result=await startThemeRun(study.id,params,keys.runKey,signal);if(!signal.aborted)adopt(result);});
  }
  function restore(event:FormEvent){event.preventDefault();const parsed=MarketModuleIdSchema.safeParse(restoreId.trim());if(!parsed.success){setError('请输入有效的任务 UUID。');return;}
    setError(null);setReadError(null);setRun(null);setRunId(parsed.data);setReportChoice('latest');rememberRun(parsed.data);setReload(n=>n+1);}
  async function action(kind:'retry'|'cancel',step?:Run['steps'][number]){if(!run)return;const id=run.id;
    const steps=step?.latestAttemptId?[{stepId:step.id,failedAttemptId:step.latestAttemptId}]:[];
    const signature=JSON.stringify({id,kind,steps});if(command.current?.signature!==signature)command.current={signature,key:browserRequestId()};const key=command.current.key;
    await mutate(async signal=>{if(kind==='retry')await retryThemeSteps(id,steps,key,signal);else await cancelThemeRun(id,key,signal);
      const next=await readThemeRun(id,signal);if(!signal.aborted){setRun(next);setReadError(null);}});
  }
  const selected=run?(reportChoice==='latest'?(run.currentReport??run.latestSavedReport):run.history.find(e=>e.attemptId===reportChoice)??null):null;
  return <div className="market-research-page market-theme-page">
    <section className="card ss-market-query ss-market-query--lilac">
      <form onSubmit={e=>void submit(e)}><fieldset disabled={busy} style={{minWidth:0}}><legend className="market-research-sr-only">类目主题分析条件</legend>
        <div className="ss-market-query-row"><span className="ss-market-query-label">站点</span><MarketSiteSelector value={selection?.marketplace??localSite} onChange={marketplace=>{if(onSelectionChange)onSelectionChange({marketplace,nodeIdPath:''});else{setLocalSite(marketplace);setLocalNode('')}}} disabled={busy}/></div>
        <div className="ss-market-query-highlight"><div className="ss-market-query-row"><span className="ss-market-query-label">选择类目</span><div className="ss-market-node-field">
          <button type="submit" className="ss-market-search-btn">{busy?'提交中…':'拉取见解'}</button><button type="button" className="ss-market-fav-btn" disabled={!onFavorite||!node} title="保存到团队共享收藏" onClick={onFavorite}>☆ 收藏</button>
          <input required aria-label="类目路径" pattern="[0-9]+(:[0-9]+)*" maxLength={240} value={node} placeholder="输入类目节点 ID 或完整节点路径，例如 13280971" onChange={e=>setNode(e.target.value.trim())}/>
        </div></div><p className="ss-market-cache-note">{node?`当前类目：Node ${node} · 请求 ${members} 个样本 ASIN`:'输入类目节点后点击「拉取见解」，或在「市场总览」先筛选类目后自动带入。'}</p></div>
        <details className="market-research-boundaries"><summary>分析月份与样本设置</summary><div className="market-research-fields"><label>完整月份<input required type="month" min="2000-01" max={maxMonth} value={month} onChange={e=>setMonth(e.target.value)}/></label>{selection&&<label>起始月份<input required type="month" min="2000-01" max={month} value={selection.fromMonth} onChange={e=>onSelectionChange?.({fromMonth:e.target.value})}/></label>}</div><div className="market-research-fields"><label>主题样本数量<input required type="number" min={1} max={20} value={members} onChange={e=>setMembers(Number(e.target.value))}/></label><label>商品池数量<input required type="number" min={members} max={100} value={pool} onChange={e=>setPool(Number(e.target.value))}/></label></div><p>样本按供应商返回顺序选择，尚未验证 BSR 排名；来源不足时保留实际数量。</p></details>
      </fieldset></form>
      {error&&<p className="market-research-error" role="alert">{error}</p>}
    </section>
    {readError&&<p className="market-research-error" role="alert">状态读取失败：{readError}。下方为上次取得的结果，未确认最新状态。</p>}
    {run&&selection&&(run.scope.nodeIdPath!==node||run.scope.fromMonth!==selection.fromMonth||run.scope.toMonth!==month)&&<p className="market-research-notice">查询条件与下方任务不同；下方仍是类目 {run.scope.nodeIdPath}、{run.scope.fromMonth} 至 {run.scope.toMonth} 的已保存结果。</p>}
    {!run?.currentReport&&selected&&<p className="market-research-notice">当前分析尚无新报告，以下保留的历史报告不代表本轮结果。</p>}
    {selected?<MarketThemeReport entry={selected}/>:<MarketThemeLaunchSection title="类目买家评论见解" description={(selection?.marketplace??localSite)+" · 基于样本链接的 Amazon Customers Say 聚合"}><div className="pending-box" role="status"><strong>{readError?'任务读取失败':runId?'主题报告尚未生成':node?'等待拉取见解':'等待指定类目节点'}</strong><span>{readError?'请在下方刷新状态或检查任务编号。':run?.steps.some(s=>s.current&&s.status==='failed')?'部分步骤失败。已保存输入保留，可在下方重试对应步骤。':runId?'后台正在处理，真实阶段和缺口见下方任务进度。':'与市场总览 / 商品形态看板共用类目上下文；也可直接输入 Node ID。Customers Say 按主题提及次数计算份额。'}</span></div></MarketThemeLaunchSection>}
    <section className="card market-insights-workflow" aria-label="主题任务与报告"><details className="market-research-boundaries"><summary>任务进度、重试与历史报告</summary>
      <div className="market-theme-actions"><button type="button" className="ghost-btn" disabled={!runId||busy} onClick={()=>setReload(n=>n+1)}>刷新状态</button>{run&&themeRunActive(run)&&<button type="button" className="ghost-btn" disabled={busy||!!readError} onClick={()=>void action('cancel')}>取消本次分析</button>}</div>
      {!run?<p role="status">{readError?'未能读取任务，请刷新状态或检查任务编号。':runId?'正在读取主题任务…':'尚未开始主题分析。可新建分析或恢复已有任务。'}</p>:<>
        <div className="market-research-job-heading"><h3>{!readError&&themeRunActive(run)&&<span className="market-theme-spinner" aria-hidden="true"/>}{readError?'最新状态待确认':themeRunLabel(run)}</h3><small>任务：{run.id}</small></div>
        <p className="market-research-note">{run.scope.marketplace} · {run.scope.nodeIdPath} · {run.scope.fromMonth} 至 {run.scope.toMonth}</p>
        <ul className="market-theme-steps">{run.steps.filter(s=>s.current).map(s=><li key={s.id}><span>{labels[s.kind]}{s.asin?` · ${s.asin}`:''}：{statuses[s.status]}{s.errorCode?`（${errors[s.errorCode]}）`:''}</span>{s.canRetry&&<button type="button" className="ghost-btn" disabled={busy||!!readError} onClick={()=>void action('retry',s)}>重试{ s.asin?` ${s.asin}`:'此步骤'}</button>}</li>)}</ul>
        {run.history.length>0&&<label className="market-theme-version">报告版本 <select aria-label="报告版本" value={reportChoice} onChange={e=>setReportChoice(e.target.value)}><option value="latest">最新可用报告</option>{run.history.map((e,i)=><option key={e.attemptId} value={e.attemptId}>{e.current?'当前':'历史'} · {e.report.dataCutoffAt} · {i+1}</option>)}</select></label>}
      </>}
      <details className="market-research-boundaries"><summary>恢复已有主题任务</summary><form className="market-theme-actions" onSubmit={restore}><label>任务 UUID <input value={restoreId} onChange={e=>setRestoreId(e.target.value)} required disabled={busy}/></label><button type="submit" className="ghost-btn" disabled={busy}>读取任务</button></form><p>已打开的任务保存在当前地址中，刷新只读取状态和报告。</p></details>
    </details></section>
  </div>;
}
