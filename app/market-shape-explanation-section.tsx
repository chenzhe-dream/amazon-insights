'use client';
import {useEffect,useState,useRef} from 'react';
import type {z} from 'zod';
import type {MarketShapeExplanationLinkSchema} from '../shared/market-shape-public-contracts';
import type {MarketShapeExplanationRunResponseSchema} from '../shared/market-shape-explanation-public-contracts';
import {readShapeRevisionAnalysis,readShapeExplanation,retryShapeSteps,cancelShapeRun} from './lib/market-shape-browser';
import {MarketShapeExplanationReport} from './market-shape-explanation-report';

type Link=z.infer<typeof MarketShapeExplanationLinkSchema>;
type Run=z.infer<typeof MarketShapeExplanationRunResponseSchema>['run'];
const statusNames:Record<string,string>={queued:'排队中',running:'分析中',partial:'尚未完成',succeeded:'分析完成',failed:'分析失败',cancelled:'已取消'};
const errors:Record<string,string>={timeout:'分析超时',governance:'额度、输入大小或调用策略限制',interrupted:'任务中断','invalid-data':'分析结果未通过校验','upstream-temporary':'模型服务暂不可用',authentication:'模型服务认证失败',internal:'后台处理失败'};
const active=(run:Run)=>run.status!=='cancelled'&&run.steps.some(s=>s.current&&['queued','running'].includes(s.status));

/** Parent/revision changes remount this owner; old responses cannot populate a
 * different revision. Reading this region never starts or retries an analysis. */
export function MarketShapeExplanationSection({parentRunId,revisionId,paused=false,unavailableReason=null}:{parentRunId:string;revisionId:string;paused?:boolean;unavailableReason?:string|null}){
 const [links,setLinks]=useState<Link[]|null>(null),[selected,setSelected]=useState(''),[readError,setReadError]=useState<string|null>(null),[reload,setReload]=useState(0);
 useEffect(()=>{if(paused)return;const abort=new AbortController();void readShapeRevisionAnalysis(parentRunId,revisionId,abort.signal).then(result=>{
  if(abort.signal.aborted)return;const next=result.explanations??[];setLinks(next);setSelected(current=>next.some(l=>l.moduleRunId===current)?current:next[0]?.moduleRunId??'');setReadError(null);
 },e=>{if(!abort.signal.aborted)setReadError(e instanceof Error?e.message:'读取分析记录失败')});return()=>abort.abort()},[parentRunId,revisionId,reload,paused]);
 const refresh=()=>setReload(n=>n+1);
 return <section className="card market-shape-report" role="region" aria-label="形态解释分析状态" style={{overflowWrap:'anywhere'}}>
  <h3>形态结构解释</h3>
  {paused&&<p className="market-research-error">形态任务读取异常，已保留当前版本内容，分析操作暂停。</p>}
  {readError&&<p role="alert" className="market-research-error">{readError}；已保留当前版本内容，分析操作暂停。</p>}
  <div className="market-theme-actions">{links&&links.length>1&&<label>分析记录 <select aria-label="形态解释分析记录" value={selected} onChange={e=>setSelected(e.target.value)}>{links.map(l=><option key={l.moduleRunId} value={l.moduleRunId}>{l.createdAt.replace('T',' ').replace(/\.\d+Z$|Z$/,' UTC')}</option>)}</select></label>}<button className="ghost-btn" onClick={refresh} disabled={paused}>刷新解释状态</button></div>
  {!links&&!readError&&<p role="status">正在读取此版本的分析记录…</p>}
  {links?.length===0&&<p>{unavailableReason??'此版本尚未创建解释分析，已保存统计仍可查看。'}</p>}
  {selected&&<ExplanationRun key={`${parentRunId}/${revisionId}/${selected}`} id={selected} revisionId={revisionId} reload={reload} paused={paused||!!readError}/>}
 </section>;
}

function ExplanationRun({id,revisionId,reload,paused}:{id:string;revisionId:string;reload:number;paused:boolean}){
 const [run,setRun]=useState<Run|null>(null),[readError,setReadError]=useState<string|null>(null),[actionError,setActionError]=useState<string|null>(null),[busy,setBusy]=useState(false),[refresh,setRefresh]=useState(0);
 const owner=useRef<AbortController|null>(null);
 useEffect(()=>{const abort=new AbortController();owner.current=abort;return()=>{abort.abort();owner.current=null}},[]);
 useEffect(()=>{if(paused)return;const abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  async function read(){try{const next=await readShapeExplanation(id,revisionId,abort.signal);if(abort.signal.aborted)return;setRun(next);setReadError(null);if(active(next))timer=setTimeout(()=>void read(),4000)}catch(e){if(!abort.signal.aborted)setReadError(e instanceof Error?e.message:'读取分析状态失败')}}
  void read();return()=>{abort.abort();if(timer)clearTimeout(timer)};
 },[id,revisionId,reload,refresh,paused]);
 async function action(kind:'retry'|'cancel',step?:Run['steps'][number]){const signal=owner.current?.signal;if(!signal||busy||readError||paused)return;setBusy(true);setActionError(null);
  try{if(kind==='retry'&&step?.latestAttemptId)await retryShapeSteps(id,[{stepId:step.id,failedAttemptId:step.latestAttemptId}],crypto.randomUUID(),signal);else if(kind==='cancel')await cancelShapeRun(id,crypto.randomUUID(),signal);
   signal.throwIfAborted();setRefresh(n=>n+1);
  }catch(e){if(!signal.aborted)setActionError(e instanceof Error?e.message:'操作失败，已保存数据保留')}
  finally{if(!signal.aborted)setBusy(false)}
 }
 const running=run&&active(run),failed=run?.steps.some(s=>s.current&&s.status==='failed');
 const phase=!run?'正在读取分析状态…':run.status==='cancelled'?'已取消':failed?'分析失败':running?(run.steps.some(s=>s.current&&s.kind==='report'&&['queued','running'].includes(s.status))?'正在保存解释报告':run.progress.totalWindows===0?'正在准备解释输入':run.progress.completedWindows===run.progress.totalWindows?'正在综合六维解释':'正在分析六维分片'):statusNames[run.status];
 return <div aria-busy={!!running&&!readError&&!paused}>
  <p role="status">{running&&!readError&&!paused&&<span className="market-theme-spinner" aria-hidden="true"/>}{phase}</p>
  {run&&<p>已完成分片 {run.progress.completedWindows} / {run.progress.totalWindows}</p>}
  {readError&&<p role="alert" className="market-research-error">{readError}；已保留上次读取的本版本内容，状态更新与操作暂停。</p>}
  {actionError&&<p role="alert" className="market-research-error">{actionError}</p>}
  {run?.steps.filter(s=>s.current&&s.status==='failed').map(s=><p key={s.id}>{errors[s.errorCode??'']??'分析步骤失败'} {s.canRetry&&<button className="ghost-btn" disabled={busy||!!readError||paused} onClick={()=>void action('retry',s)}>重试此分析步骤</button>}</p>)}
  {running&&<button className="ghost-btn" disabled={busy||!!readError||paused} onClick={()=>void action('cancel')}>取消解释分析</button>}
  {run?.presentation?<MarketShapeExplanationReport presentation={run.presentation}/>:<p className="market-research-note">{run?.report?'已保存报告暂未提供可展示正文，请刷新状态；统计结果保留。':'完整解释尚未生成，已保存统计和人工修订保留。'}</p>}
 </div>;
}
