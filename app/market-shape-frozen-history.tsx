"use client";
import React,{useEffect,useRef,useState,type ReactNode} from 'react';
import type {MarketShapeRun} from '../shared/market-shape-public-contracts';
import type {MarketShapeReferenceRevision} from '../shared/market-shape-reference-revision-contracts';
import {readShapeReferenceRevision,saveShapeReferenceRevision} from './lib/market-shape-browser';
import {toShapeReferenceReport} from './lib/market-shape-reference-adapter';
import {MarketShapeReferenceView} from './market-shape-reference/view';
import {browserRequestId} from './lib/browser-request-id';
import {assertShapeHistoryScope} from './lib/market-shape-history-scope';

/** Viewing a frozen version never writes or restores the working draft. */
export function MarketShapeFrozenHistory({run,selectedAsins,assignments,disabled,onRefresh,children}:{run:MarketShapeRun;selectedAsins:string[];assignments:Record<string,string>;disabled:boolean;onRefresh:()=>void;children:ReactNode}){
 const [choice,setChoice]=useState('working'),[frozen,setFrozen]=useState<MarketShapeReferenceRevision|null>(null),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false);
 const [added,setAdded]=useState<MarketShapeReferenceRevision[]>([]),[note,setNote]=useState('');
 const owner=useRef<AbortController|null>(null),saving=useRef(false);
 useEffect(()=>{const abort=new AbortController();owner.current=abort;return()=>abort.abort();},[]);
 const history=[...added,...(run.referenceHistory??[])].filter((v,i,all)=>all.findIndex(other=>other.revisionId===v.revisionId)===i).sort((a,b)=>b.ordinal-a.ordinal);
 useEffect(()=>{
  setFrozen(null);setError(null);if(choice==='working')return;
  const abort=new AbortController();
  void readShapeReferenceRevision(run.id,choice,abort.signal).then(revision=>{if(abort.signal.aborted)return;assertShapeHistoryScope(run.scope,revision.data.scope);setFrozen(revision);}).catch(e=>{if(!abort.signal.aborted)setError(e instanceof Error?e.message:'历史版本读取失败');});
  return()=>abort.abort();
 },[run.id,choice]);
 async function save(){
  if(disabled||saving.current||choice!=='working'||!selectedAsins.length)return;
  saving.current=true;setBusy(true);setError(null);
  try{
   const revision=await saveShapeReferenceRevision(run.id,{expectedParentRevisionId:history[0]?.revisionId??run.referenceRevision?.revisionId??null,selectedAsins,assignments:Object.entries(assignments).map(([asin,label])=>({asin,label:label.trim()||null})),note},browserRequestId(),owner.current?.signal);
   if(owner.current?.signal.aborted)return;
   assertShapeHistoryScope(run.scope,revision.data.scope);setAdded(old=>[revision,...old]);setNote('');setChoice(revision.revisionId);onRefresh();
  }catch(e){if(!owner.current?.signal.aborted)setError(e instanceof Error?e.message:'冻结保存失败；当前草稿仍保留');}
  finally{saving.current=false;if(!owner.current?.signal.aborted)setBusy(false);}
 }
 return <>
  <section className="card market-shape-controls">
   <label>形态报告版本 <select aria-label="形态报告版本" value={choice} disabled={busy} onChange={e=>setChoice(e.target.value)}><option value="working">当前工作草稿</option>{history.map(item=><option key={item.revisionId} value={item.revisionId}>冻结版本 {item.ordinal} · {item.createdAt}</option>)}</select></label>
   {choice==='working'?<><input aria-label="冻结版本备注" placeholder="版本备注（可选）" value={note} maxLength={500} disabled={busy} onChange={e=>setNote(e.target.value)}/><button className="ghost-btn" disabled={disabled||busy||!selectedAsins.length} onClick={()=>void save()}>保存冻结报告</button><p className="market-research-note">冻结保存本次来源、纳入商品、人工形态和计算版本；自动保存的工作草稿单独保留。</p></>:<p role="status" className="market-research-note">正在查看只读冻结版本；不使用当前草稿，不覆盖工作中的人工修改。</p>}
   {error&&<p role="alert">{error}</p>}
  </section>
  {choice==='working'?<fieldset disabled={busy} style={{border:0,padding:0,margin:0,minWidth:0}}>{children}</fieldset>:frozen?.revisionId===choice?<><p className="market-research-note">版本 {frozen.ordinal} · {frozen.createdAt} · {frozen.note||'无备注'} · 计算版本 {frozen.data.calculationVersion??'shape-reference/1'}</p><MarketShapeReferenceView key={frozen.revisionId} report={toShapeReferenceReport(frozen.data)} assignments={Object.fromEntries(frozen.assignments.map(a=>[a.asin,a.label??'']))} selectedAsins={frozen.selectedAsins} onAssignment={()=>{}} onSelected={()=>{}} disabled poolSizeDisabled/></>:<div className="pending-box">{error?'未加载该历史版本，当前草稿仍保留。':'正在读取冻结报告…'}</div>}
 </>;
}
