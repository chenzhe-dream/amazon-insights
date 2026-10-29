import {newMarketAcquisitionPolicy} from '../../shared/market-acquisition-policy';
import {useCallback,useEffect,useRef,useState} from 'react';
import {MarketModuleIdSchema} from '../../shared/market-module-contracts';
import {MarketLinkedRequestSchema,type MarketLinkedBatch,type MarketLinkedRequest,type LinkedModule} from '../../shared/market-linked-contracts';
import {readLinkedBatch,startLinkedBatch,retryLinkedBatch} from './market-linked-browser';
import {browserRequestId} from './browser-request-id';

export function useMarketLinkedAnalysis(sessionIdentity:string,onBatch:(batch:MarketLinkedBatch,apply:boolean)=>void){
 const [id,setId]=useState<string|null>(null),[batch,setBatch]=useState<MarketLinkedBatch|null>(null),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false),[readVersion,setReadVersion]=useState(0);
 const callback=useRef(onBatch);callback.current=onBatch;
 const submitting=useRef(false),generation=useRef(0),pending=useRef<{key:string;request:string}|null>(null);
 const submissionError=useRef<string|null>(null);
 const owner=useRef<AbortController|null>(null),storageKey=`market-linked-pending:${sessionIdentity}`;
 useEffect(()=>{const controller=new AbortController();owner.current=controller;return()=>{controller.abort();owner.current=null;generation.current++;};},[sessionIdentity]);
 const rejectAuthorization=(cause:unknown)=>{const status=(cause as {status?:number})?.status;if(status!==401&&status!==403)return false;owner.current?.abort();generation.current++;pending.current=null;submitting.current=false;setBusy(false);setBatch(null);setId(null);setError('登录或访问权限已失效，请重新登录后读取联动任务。');try{sessionStorage.removeItem(storageKey);}catch{}return true;};
 useEffect(()=>{const value=new URLSearchParams(window.location.search).get('linkedBatch');if(MarketModuleIdSchema.safeParse(value).success)setId(value);},[]);
 const accept=useCallback((value:MarketLinkedBatch)=>{
  setBatch(value);setError(null);submissionError.current=null;
  const url=new URL(window.location.href),apply=url.searchParams.get('linkedApply')==='1';
  callback.current(value,apply);
  if(value.status!=='pending'){const current=new URL(window.location.href);current.searchParams.delete('linkedApply');window.history.replaceState(window.history.state,'',current);}
 },[]);
 useEffect(()=>{
  if(!id)return;const abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const poll=async()=>{if(submitting.current){timer=setTimeout(()=>void poll(),3000);return;}const version=generation.current;try{const value=await readLinkedBatch(id,abort.signal);if(abort.signal.aborted||owner.current?.signal.aborted)return;if(version===generation.current){accept(value);if(value.status!=='pending')return;}}catch(cause){if(abort.signal.aborted)return;if(version===generation.current){if(rejectAuthorization(cause))return;setError(submissionError.current??(cause instanceof Error?cause.message:'联动状态读取失败'));}}timer=setTimeout(()=>void poll(),3000);};
  void poll();return()=>{abort.abort();if(timer)clearTimeout(timer);};
 },[id,readVersion,accept]);
 const start=async(input:MarketLinkedRequest)=>{
  const controller=owner.current;if(submitting.current||!controller||controller.signal.aborted)return;
  const parsed=MarketLinkedRequestSchema.safeParse({...newMarketAcquisitionPolicy,...input});if(!parsed.success){setError('四模块联动请选择完整自然月；最近30天可在总览分析设置中单独使用。');throw new Error('四模块联动需要完整自然月');}
  const serialized=JSON.stringify(parsed.data),url=new URL(window.location.href);
  let saved:{key:string;request:string}|null=null;try{saved=JSON.parse(sessionStorage.getItem(storageKey)??'null');}catch{}
  const command=pending.current?.request===serialized?pending.current:saved?.request===serialized&&MarketModuleIdSchema.safeParse(saved.key).success?saved:{key:browserRequestId(),request:serialized};
  pending.current=command;try{sessionStorage.setItem(storageKey,JSON.stringify(command));}catch{}
  url.searchParams.set('linkedBatch',command.key);url.searchParams.set('linkedApply','1');window.history.replaceState(window.history.state,'',url);
  submitting.current=true;submissionError.current=null;setBusy(true);setError(null);setBatch(null);setId(command.key);const version=++generation.current;
  try{const value=await startLinkedBatch(parsed.data,command.key,controller.signal);if(version!==generation.current||controller.signal.aborted||owner.current!==controller)return;accept(value);pending.current=null;try{sessionStorage.removeItem(storageKey);}catch{}setReadVersion(v=>v+1);}
  catch(cause){if(version!==generation.current||controller.signal.aborted||owner.current!==controller)return;if(rejectAuthorization(cause))return;submissionError.current=cause instanceof Error?`${cause.message} 再次点击“筛选市场”可恢复同一提交。`:'提交未确认，请恢复同一提交。';setError(submissionError.current);throw cause;}
  finally{if(version===generation.current&&owner.current===controller&&!controller.signal.aborted){submitting.current=false;setBusy(false);}}
 };
 const retry=async(module?:LinkedModule)=>{const controller=owner.current;if(!id||submitting.current||!controller||controller.signal.aborted)return;const version=++generation.current;submitting.current=true;setBusy(true);try{const url=new URL(window.location.href);url.searchParams.set('linkedApply','1');window.history.replaceState(window.history.state,'',url);const value=await retryLinkedBatch(id,module?{modules:[module]}:{basic:true,modules:[]},controller.signal);if(version!==generation.current||owner.current!==controller||controller.signal.aborted)return;accept(value);setReadVersion(v=>v+1);}catch(cause){if(version!==generation.current||owner.current!==controller||controller.signal.aborted)return;if(!rejectAuthorization(cause))setError(cause instanceof Error?cause.message:'恢复失败');}finally{if(version===generation.current&&owner.current===controller&&!controller.signal.aborted){submitting.current=false;setBusy(false);}}};
 return {batch,error,busy,start,retry};
}
