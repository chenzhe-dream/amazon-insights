"use client";
import { browserRequestId } from "./lib/browser-request-id";
import {useEffect,useRef,useState} from "react";
import {MarketFavoriteListResponseSchema,MarketFavoriteCreateResponseSchema,type MarketFavorite} from "../shared/market-favorites-contracts";
import {localAgentFetch,localAgentErrorMessage} from "./lib/local-agent-browser";
import {marketNavigation,type MarketView} from "./lib/market-navigation";

export type KeywordFavoriteInput={seeds:string;categoryContext:string;pageCount:number;maxMembers:number};
const runKeys={overview:"overviewRun",shapes:"shapeRun",keywords:"keywordRun",themes:"themeRun"} as const;
export function MarketSharedFavorites({view,query,keywordInput,onRestore,saveRequest=0}:{view:MarketView;query:Record<string,string>;keywordInput?:KeywordFavoriteInput;onRestore:(favorite:MarketFavorite)=>void;saveRequest?:number}){
 const [open,setOpen]=useState(false),[title,setTitle]=useState(""),[mode,setMode]=useState("query"),[search,setSearch]=useState(""),[q,setQ]=useState(""),[page,setPage]=useState(1),[revision,setRevision]=useState(0);
 const [data,setData]=useState<ReturnType<typeof MarketFavoriteListResponseSchema.parse>|null>(null),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(""),[message,setMessage]=useState("");
 const lifetime=useRef<AbortController|null>(null),writing=useRef(false),pending=useRef<{body:string;id:string}|null>(null);
 useEffect(()=>{const controller=new AbortController();lifetime.current=controller;return()=>controller.abort()},[]);
 const label=marketNavigation.find(item=>item.view===view)!.label;
 useEffect(()=>{setPage(1);setMode("query");setTitle("");setMessage("")},[view]);
 useEffect(()=>{if(saveRequest){setOpen(true);setMode("query");setTitle("")}},[saveRequest]);
 useEffect(()=>{if(!open)return;const controller=new AbortController();setLoading(true);setError("");setData(null);
  void localAgentFetch("/v1/market-research/favorites?"+new URLSearchParams({module:view,q,page:String(page)}),{signal:controller.signal,cache:"no-store"})
   .then(async response=>{const payload=await response.json();if(!response.ok)throw Error(localAgentErrorMessage(payload,"读取共享收藏失败"));return MarketFavoriteListResponseSchema.parse(payload)})
   .then(value=>{if(!controller.signal.aborted){setData(value);setPage(value.page)}}).catch(cause=>{if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:"读取失败")}).finally(()=>{if(!controller.signal.aborted)setLoading(false)});
  return()=>controller.abort();
 },[open,view,q,page,revision]);
 const runId=typeof window==="undefined"?null:new URLSearchParams(window.location.search).get(runKeys[view]);
 async function save(){
  const owner=lifetime.current;if(!owner||writing.current)return;
  const currentRun=new URLSearchParams(window.location.search).get(runKeys[view]);
  const selectedQuery=mode==="report"&&currentRun?{[runKeys[view]]:currentRun}:query;
  const payload={title:title.trim()||label+" · "+(query.marketNode||keywordInput?.seeds.split("\n")[0]||"查询"),module:view,query:selectedQuery,...(mode==="query"&&view==="keywords"&&keywordInput?{keywordInput}: {})};
  const body=JSON.stringify(payload);if(pending.current?.body!==body)pending.current={body,id:browserRequestId()};
  writing.current=true;setBusy(true);setError("");setMessage("");
  try{const response=await localAgentFetch("/v1/market-research/favorites",{method:"POST",signal:owner.signal,body:JSON.stringify({...payload,id:pending.current.id})});
   const result=await response.json();if(!response.ok)throw Error(localAgentErrorMessage(result,"保存共享收藏失败"));MarketFavoriteCreateResponseSchema.parse(result);
   if(owner.signal.aborted)return;pending.current=null;setMessage("已保存到团队共享收藏");setPage(1);setQ("");setSearch("");setRevision(value=>value+1);
  }catch(cause){if(!owner.signal.aborted)setError(cause instanceof Error?cause.message:"保存失败，输入已保留")}finally{writing.current=false;if(!owner.signal.aborted)setBusy(false)}
 }
 async function remove(item:MarketFavorite){
  const owner=lifetime.current;if(!owner||writing.current)return;writing.current=true;setBusy(true);setError("");
  try{const response=await localAgentFetch("/v1/market-research/favorites/"+item.id,{method:"DELETE",signal:owner.signal});if(!response.ok)throw Error(localAgentErrorMessage(await response.json(),"删除失败"));
   if(!owner.signal.aborted){setMessage("已删除收藏");if(data?.items.length===1&&page>1)setPage(value=>value-1);else setRevision(value=>value+1)}
  }catch(cause){if(!owner.signal.aborted)setError(cause instanceof Error?cause.message:"删除失败")}finally{writing.current=false;if(!owner.signal.aborted)setBusy(false)}
 }
 return <section className={open?"card market-reference-favorites":"market-reference-favorites"} aria-label="团队共享收藏" style={{padding:open?16:0,minWidth:0}}>
  <button type="button" className="ghost-btn" aria-expanded={open} onClick={()=>setOpen(value=>!value)}>{open?"收起团队共享收藏":"☆ 团队共享收藏"}</button>
  {open&&<><p className="market-research-note">同组织人员共享。打开收藏只恢复查询或读取已有报告，不自动发起采集；作者和管理员可删除。</p>
   <div className="market-theme-actions"><input aria-label="收藏名称" placeholder={label+" · 收藏名称"} maxLength={120} value={title} onChange={event=>setTitle(event.target.value)} disabled={busy}/><select aria-label="收藏内容" value={mode} disabled={busy} onChange={event=>setMode(event.target.value)}><option value="query">当前查询条件</option><option value="report" disabled={!runId}>当前报告链接</option></select><button className="primary-btn" disabled={busy||mode==="query"&&!query.marketNode} onClick={()=>void save()}>{busy?"处理中…":"保存到团队"}</button></div>
   <form className="market-theme-actions" onSubmit={event=>{event.preventDefault();setQ(search.trim());setPage(1);setRevision(value=>value+1)}}><input type="search" aria-label="搜索共享收藏" placeholder="搜索收藏名称" maxLength={120} value={search} onChange={event=>setSearch(event.target.value)}/><button className="ghost-btn" disabled={loading}>搜索</button><button type="button" className="ghost-btn" disabled={loading} onClick={()=>setRevision(value=>value+1)}>刷新收藏</button></form>
   {error&&<p role="alert" className="market-research-error">{error}</p>}{message&&<p role="status">{message}</p>}
   {loading?<p role="status">读取共享收藏…</p>:data?.items.length?<ul style={{padding:0,listStyle:"none"}}>{data.items.map(item=><li key={item.id} style={{display:"flex",gap:12,flexWrap:"wrap",alignItems:"center",padding:"10px 0",borderBottom:"1px solid #e5e7eb"}}><button type="button" className="ghost-btn" disabled={busy} onClick={()=>onRestore(item)}>{item.title}</button><small>{item.creatorName} · {Object.keys(item.query).some(key=>key.endsWith("Run"))?"报告链接":"查询条件"}</small>{item.canDelete&&<button type="button" className="ghost-btn" disabled={busy} onClick={()=>void remove(item)}>删除收藏</button>}</li>)}</ul>:!error&&<p>当前模块暂无共享收藏。</p>}
   <nav className="market-theme-actions" aria-label="共享收藏分页"><span>共 {data?.total??0} 条 · 每页 10 条</span><button className="ghost-btn" disabled={loading||page<=1} onClick={()=>setPage(value=>value-1)}>上一页</button><span>{page} / {Math.max(1,Math.ceil((data?.total??0)/10))}</span><button className="ghost-btn" disabled={loading||!data||page*10>=data.total} onClick={()=>setPage(value=>value+1)}>下一页</button></nav>
  </>}
 </section>;
}
