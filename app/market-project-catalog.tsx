"use client";
import React,{useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {ProjectCatalogSchema,ProjectHistorySchema,type ProjectCatalog,type ProjectHistory,type ProjectCategory} from '../shared/market-project-catalog-contracts';
import {projectModules,type ProjectModule,type ProjectFavoriteList} from '../shared/market-project-favorites-contracts';
import {marketSites} from '../shared/market-sites';
import {localAgentFetch,localAgentErrorMessage} from './lib/local-agent-browser';
import {projectModuleHref} from './lib/market-project-favorites';
const base='/v1/market-research/project-favorites';
const labels={overview:'市场总览',shapes:'商品形态及价格带',keywords:'类目关键词洞察',themes:'类目买家评论见解'};
const states={ready:'报告已生成',partial:'待补充',running:'分析中',conditions:'仅保存条件',unavailable:'报告不可用'};
const date=(v:string)=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(v));

// Component-local read cache is cleared on refresh. A response belongs to its exact query key.
function useCatalogRead<T>(path:string|null,schema:z.ZodType<T>,revision:number){
 const cache=useRef(new Map<string,T>());
 const [state,setState]=useState<{key:string|null;data?:T;loading:boolean;error:string}>({key:null,loading:false,error:''});
 const [retry,setRetry]=useState(0);
 const generation=useRef(revision);
 useEffect(()=>{
  if(generation.current!==revision){cache.current.clear();generation.current=revision}
  if(!path)return;
  const controller=new AbortController();let timeout=false;
  setState({key:path,data:cache.current.get(path),loading:true,error:''});
  const timer=setTimeout(()=>{timeout=true;controller.abort()},15000);
  void localAgentFetch(path,{signal:controller.signal,cache:'no-store'}).then(async res=>{
   const body=await res.json();if(!res.ok)throw new Error(localAgentErrorMessage(body,'收藏读取失败'));
   const data=schema.parse(body);if(controller.signal.aborted)return;
   if(cache.current.size>=30)cache.current.delete(cache.current.keys().next().value!);
   cache.current.set(path,data);setState({key:path,data,loading:false,error:''});
  }).catch(error=>{
   if(controller.signal.aborted&&!timeout)return;
   setState(s=>s.key===path?{...s,loading:false,error:timeout?'读取超时，请重试。':error instanceof z.ZodError?'返回数据格式异常，请刷新重试。':error instanceof Error?error.message:'读取失败，请重试。'}:s);
  }).finally(()=>clearTimeout(timer));
  return()=>{clearTimeout(timer);controller.abort()};
 },[path,schema,revision,retry]);
 return {...(state.key===path?state:{data:undefined,loading:!!path,error:''}),retry:()=>setRetry(v=>v+1)};
}

export function CategoryDirectoryEntry({category,selected,onSelect}:{category:ProjectCategory;selected:boolean;onSelect:()=>void}){
 const sites=category.sites.map(code=>marketSites.find(site=>site.code===code)).filter(site=>site!==undefined);
 const name=category.displayName?.trim();
 return <div className={'mpf-category-entry'+(selected?' active':'')}>
  <button type="button" className="mpf-category-select" aria-label={`查看${name?name+' · ':''}类目 ${category.categoryId} 的报告`} aria-pressed={selected} onClick={onSelect}/>
  <div className="mpf-category-entry-content">
   {name&&<strong className="mpf-category-name">{name}</strong>}
   {sites[0]?<a className="mpf-category-amazon" href={`https://www.${sites[0].amazonDomain}/b?node=${encodeURIComponent(category.categoryId)}`} target="_blank" rel="noopener noreferrer" title={`在新标签打开亚马逊${sites[0].label}类目 ${category.categoryId}`}><strong>{category.categoryId} ↗</strong></a>:<strong>{category.categoryId}</strong>}
   <small>{category.sites.join(' / ')} · {category.reports} 份报告</small>
   {sites.length>1&&<div className="mpf-category-site-links">{sites.slice(1).map(site=><span key={site.code}>{site.label} <a href={`https://www.${site.amazonDomain}/b?node=${encodeURIComponent(category.categoryId)}`} target="_blank" rel="noopener noreferrer" title={`在新标签打开亚马逊${site.label}类目 ${category.categoryId}`}>{category.categoryId} ↗</a></span>)}</div>}
  </div>
 </div>;
}
export function CategoryModuleCards({category,selected,onSelect}:{category:ProjectCategory;selected:ProjectModule;onSelect:(module:ProjectModule)=>void}){
 return <div className="mpf-category-modules" aria-label="类目四个分析模块">{projectModules.map(module=>{const s=category.modules[module];return <button type="button" key={module} aria-pressed={module===selected} className={module===selected?'active':''} onClick={()=>onSelect(module)}><strong>{labels[module]}</strong><span>{s.reports?`${s.reports} 份历史报告`:'暂无报告'}{s.conditions?` · ${s.conditions} 条保存条件`:''}</span><small>{s.running?`${s.running} 份分析中`:`${s.ready} 份完整报告`}</small></button>})}</div>;
}
export function CategoryHistoryRows({items,module,onDetail}:{items:ProjectHistory['items'];module:ProjectModule;onDetail:(id:string)=>void}){
 return <div className="mpf-table-wrap"><table><thead><tr>{['站点 / 研究月份','状态','收藏人 / 更新时间（北京）','操作'].map(h=><th key={h}>{h}</th>)}</tr></thead><tbody>{items.map(row=>{const scope=row.context[module]!;return <tr key={row.favoriteId+':'+module}><td><strong>{scope.marketplace} · {scope.overviewPeriod==='last30'?'最近30天':`${scope.fromMonth} 至 ${scope.toMonth}`}</strong><small>{scope.runId?`任务 ${scope.runId.slice(0,8)}`:'仅保存查询条件'}{module==='overview'&&row.context.headTopN?` · Top ${row.context.headTopN}`:''}</small></td><td><span className={'mpf-status '+row.status}>{states[row.status]}</span></td><td>{row.creatorName}<small>{date(row.updatedAt)}</small></td><td><div className="mpf-actions"><button type="button" className="mpf-link" onClick={()=>onDetail(row.favoriteId)}>查看详情</button><a className="mpf-link" href={projectModuleHref(row.context,module)+'&marketFavorite='+row.favoriteId}>{scope.runId?'预览报告 ↗':'查看条件'}</a></div></td></tr>})}</tbody></table></div>;
}
function ReadError({message,retry}:{message:string;retry:()=>void}){return message?<div role="alert" className="mpf-error">{message} <button type="button" className="mpf-link" onClick={retry}>重试</button></div>:null}
export function MarketProjectCatalog({revision,onDetail,onGroups,onNewGroup,saveButton}:{revision:number;onDetail:(id:string)=>void;onGroups:(groups:ProjectFavoriteList['groups'])=>void;onNewGroup:()=>void;saveButton:React.ReactNode}){
 const [site,setSite]=useState(''),[search,setSearch]=useState(''),[q,setQ]=useState(''),[status,setStatus]=useState(''),[group,setGroup]=useState(''),[mine,setMine]=useState(false);
 const [page,setPage]=useState(1),[historyPage,setHistoryPage]=useState(1),[categoryId,setCategoryId]=useState(''),[module,setModule]=useState<ProjectModule>('overview'),[refresh,setRefresh]=useState(0),[exporting,setExporting]=useState(false),[exportError,setExportError]=useState('');
 const exportController=useRef<AbortController|null>(null);
 useEffect(()=>()=>exportController.current?.abort(),[]);
 useEffect(()=>{const p=new URLSearchParams(window.location.search);setCategoryId(p.get('favoriteCategory')??'');const m=p.get('favoriteModule');if(projectModules.includes(m as ProjectModule))setModule(m as ProjectModule);const n=Number(p.get('favoritePage'));if(Number.isInteger(n)&&n>0&&n<100001)setPage(n)},[]);
 const filter=new URLSearchParams({q,mine:String(mine),...(site?{site}:{}),...(status?{status}:{}),...(group?{groupId:group}:{})});
 const catalog=useCatalogRead(base+'/catalog?'+filter+'&page='+page,ProjectCatalogSchema,revision+refresh);
 const data=catalog.data;
 useEffect(()=>{if(data){onGroups(data.groups);if(data.page!==page)setPage(data.page)}},[data,onGroups,page]);
 const category=data?.items.find(c=>c.categoryId===categoryId)??data?.items[0];
 const selected=category?.categoryId;
 useEffect(()=>{if(!selected)return;const url=new URL(window.location.href);url.searchParams.set('favoriteCategory',selected);url.searchParams.set('favoriteModule',module);url.searchParams.set('favoritePage',String(page));window.history.replaceState(window.history.state,'',url)},[selected,module,page]);
 const historyCount=category?category.modules[module].reports+category.modules[module].conditions:0;
 const historyKey=selected?base+'/history?'+filter+'&categoryId='+selected+'&module='+module+'&page='+historyPage:null;
 const history=useCatalogRead(historyKey,ProjectHistorySchema,revision+refresh);
 useEffect(()=>{if(history.data&&history.data.page!==historyPage)setHistoryPage(history.data.page)},[history.data,historyPage]);
 function resetPages(){setPage(1);setHistoryPage(1);setCategoryId('')}
 function reset(){setSite('');setQ('');setSearch('');setStatus('');setGroup('');setMine(false);resetPages()}
 async function exportHistory(){
  if(!selected||exporting)return;setExporting(true);setExportError('');const c=new AbortController();exportController.current=c;const timer=setTimeout(()=>c.abort(),60000);
  try{
   const rows:ProjectHistory['items']=[];let n=1,total=0;
   do {const res=await localAgentFetch(base+'/history?'+filter+'&categoryId='+selected+'&module='+module+'&page='+n,{signal:c.signal});const body=await res.json();if(!res.ok)throw new Error(localAgentErrorMessage(body,'导出失败'));const result=ProjectHistorySchema.parse(body);total=result.total;if(total>10000)throw new Error('记录超过一万条，请缩小筛选范围');rows.push(...result.items);if(!result.items.length||result.page!==n)break;n++}while(rows.length<total);
   const cell=(v:string)=>'"'+(/^[=+@\-\t\r]/.test(v)?"'":'')+v.replaceAll('"','""')+'"';
   const lines=[['类目','模块','站点','起始月','截止月','周期','任务','状态','创建人'],...rows.map(r=>{const s=r.context[module]!;return[selected,labels[module],s.marketplace,s.fromMonth,s.toMonth,s.overviewPeriod??'calendar',s.runId??'',states[r.status],r.creatorName]})];
   if(c.signal.aborted)return;const url=URL.createObjectURL(new Blob(['\ufeff'+lines.map(r=>r.map(cell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=`类目${selected}-${labels[module]}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }catch(e){if(exportController.current===c)setExportError(c.signal.aborted?'导出超时，请缩小范围后重试。':e instanceof Error?e.message:'导出失败')}
  finally{clearTimeout(timer);if(exportController.current===c)setExporting(false)}
 }
 return <div className="market-ui-reference mpf-library">
  <div className="mpf-heading"><div><h2>调研收藏夹</h2><p>按类目查看四个分析模块，保留各站点、各月份的历史报告。</p></div><div className="mpf-actions"><button type="button" className="ghost-btn" disabled={!selected||exporting} onClick={()=>void exportHistory()}>{exporting?'导出中…':'导出当前模块'}</button>{saveButton}</div></div>
  <section className="card mpf-query"><div className="mpf-sites"><b>选择站点</b>{[{code:'',label:'全部站点'},...marketSites].map(s=><button type="button" key={s.code} className={site===s.code?'active':''} onClick={()=>{setSite(s.code);resetPages()}}>{s.label}</button>)}</div><form onSubmit={e=>{e.preventDefault();setQ(search);resetPages()}}><b>筛选类目</b><input aria-label="搜索调研收藏" placeholder="类目 ID / 收藏名称 / 标签" value={search} maxLength={120} onChange={e=>setSearch(e.target.value)}/><select aria-label="历史报告状态" value={status} onChange={e=>{setStatus(e.target.value);resetPages()}}><option value="">全部报告状态</option>{Object.entries(states).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select><select aria-label="收藏分组" value={group} onChange={e=>{setGroup(e.target.value);resetPages()}}><option value="">全部分组</option><option value="ungrouped">未分组</option>{data?.groups.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</select><button className="primary-btn">搜索</button><button type="button" className="ghost-btn" onClick={reset}>重置</button></form></section>
  <section className="card mpf-stats" aria-label="类目收藏统计">{[['收藏类目',data?.stats.categories],['历史报告',data?.stats.reports],['四模块齐全类目',data?.stats.complete],['覆盖站点',data?.stats.sites]].map(([label,count])=><div key={label}><span>{label}</span><b>{count??'—'}</b></div>)}</section>
  <div className="mpf-catalog-tools"><p className="mpf-muted">“四模块齐全”按同站点、同月份范围判断。仅保存条件 {data?.stats.conditions??'—'} 条。</p><div className="mpf-actions"><button type="button" className={'ghost-btn '+(!mine?'active':'')} onClick={()=>{setMine(false);resetPages()}}>全部共享</button><button type="button" className={'ghost-btn '+(mine?'active':'')} onClick={()=>{setMine(true);resetPages()}}>我创建的</button><button type="button" className="ghost-btn" onClick={onNewGroup}>＋ 新建分组</button><button type="button" className="ghost-btn" disabled={catalog.loading||history.loading} onClick={()=>setRefresh(v=>v+1)}>刷新</button></div></div>
  <ReadError message={catalog.error} retry={catalog.retry}/>{exportError&&<p role="alert" className="mpf-error">{exportError}</p>}
  <div className="mpf-workspace mpf-category-workspace"><aside className="card mpf-groups"><h3>类目目录 · {data?.total??'—'}</h3>{catalog.loading&&<p role="status" className="mpf-muted">{data?'正在更新目录…':'正在读取类目…'}</p>}{data?.items.map(c=><CategoryDirectoryEntry key={c.categoryId} category={c} selected={selected===c.categoryId} onSelect={()=>{setCategoryId(c.categoryId);setHistoryPage(1)}}/>)}{data?.total===0&&<p className="mpf-muted">暂无符合条件的类目</p>}<div className="mpf-category-pages"><button type="button" disabled={catalog.loading||page<=1} onClick={()=>{setPage(p=>p-1);setHistoryPage(1)}}>上一页</button><span>{data?.page??page} / {Math.max(1,Math.ceil((data?.total??0)/10))}</span><button type="button" disabled={catalog.loading||!data||page*10>=data.total} onClick={()=>{setPage(p=>p+1);setHistoryPage(1)}}>下一页</button></div></aside>
  <section className="card mpf-panel" aria-label="类目模块及历史报告">{category?<><header><div><b>{category.displayName||`类目 ${selected}`}</b>{category.displayName&&<small>类目 {selected}</small>}<small>{category.sites.join(' / ')}</small></div><span className="mpf-muted">{category.reports} 份历史报告 · {category.conditions} 条保存条件</span></header><CategoryModuleCards category={category} selected={module} onSelect={m=>{setModule(m);setHistoryPage(1)}}/><header><b>{labels[module]}<small>{history.data?.total??historyCount} 条历史记录</small></b>{history.loading&&<span role="status" className="mpf-muted">{history.data?'正在更新…':'正在读取模块历史…'}</span>}</header><ReadError message={history.error} retry={history.retry}/>{history.data?.items.length?<CategoryHistoryRows items={history.data.items} module={module} onDetail={onDetail}/>:!history.loading&&!history.error?<p className="mpf-empty">该模块暂无符合条件的历史报告或保存条件。</p>:null}<footer><span>每页 10 条 · 保留各次分析记录</span><div className="mpf-actions"><button disabled={history.loading||historyPage<=1} onClick={()=>setHistoryPage(p=>p-1)}>上一页</button><span>{history.data?.page??historyPage} / {Math.max(1,Math.ceil((history.data?.total??historyCount)/10))}</span><button disabled={history.loading||!history.data||historyPage*10>=history.data.total} onClick={()=>setHistoryPage(p=>p+1)}>下一页</button></div></footer></>:<p className="mpf-empty">{catalog.loading?'正在读取类目目录…':catalog.error?'类目读取失败，请重试。':'暂无符合条件的调研收藏。'}</p>}</section></div>
 </div>;
}
