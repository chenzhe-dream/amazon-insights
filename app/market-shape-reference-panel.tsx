"use client";
import {MarketAdminContent,useMarketAdminTools} from './market-admin-tools';
import {CURRENT_SHAPE_CALCULATION_VERSION} from '../shared/market-shape-calculation-version';
import {useEffect,useMemo,useRef,useState} from 'react';
import type {MarketShapeRun} from '../shared/market-shape-public-contracts';
import type {MarketShapeReferenceRevisionData} from '../shared/market-shape-reference-revision-contracts';
import {MarketShapeDraftSchema,type MarketShapeDraft,type MarketShapeDraftItem} from '../shared/market-shape-draft-contracts';
import {MarketShapeReferenceView} from './market-shape-reference/view';
import {toShapeReferenceReport} from './lib/market-shape-reference-adapter';
import {readShapeReferenceRevision,retryShapeSteps,cancelShapeRun} from './lib/market-shape-browser';
import {projectShapeDraft,readShapeDraft,restoreShapeDraftItems,saveShapeDraft,shapeDraftStorageKey} from './lib/market-shape-draft-browser';
import {readWebSession} from './lib/web-auth-session';
import {browserRequestId} from './lib/browser-request-id';
import {LaunchSection} from './launch-section';

const labels:Record<string,string>={'collect-shape-pool':'商品池','collect-product-history':'历史销量','collect-product-amount-history':'历史销售额','collect-product-image':'商品图片','collect-shape-category':'类目看板','prepare-members':'固定商品池'};
const statuses:Record<string,string>={queued:'排队',running:'采集中',succeeded:'完成',empty:'未返回数据',failed:'失败',cancelled:'已取消'};
const emptyDraft:MarketShapeDraft={version:0,items:[],catalogLabels:[],updatedAt:null};
type PendingCopy={draft:MarketShapeDraft;pending:boolean;key:string|null};
function backup(key:string,draft:MarketShapeDraft){try{localStorage.setItem(`${key}/backup/${Date.now()}`,JSON.stringify(draft));}catch{/* Best effort local copy. */}}
function persist(key:string|null,copy:PendingCopy){if(key)try{localStorage.setItem(key,JSON.stringify(copy));}catch{/* Keep draft in memory. */}}
function localCopy(key:string):PendingCopy|null{
  try{const raw=localStorage.getItem(key);if(!raw)return null;const copy=JSON.parse(raw) as Partial<PendingCopy>,parsed=MarketShapeDraftSchema.safeParse(copy.draft);return parsed.success?{draft:parsed.data,pending:copy.pending===true,key:typeof copy.key==='string'?copy.key:null}:null;}catch{return null;}
}
function latestBackup(key:string):MarketShapeDraft|null{
  try{const names=Array.from({length:localStorage.length},(_,index)=>localStorage.key(index)).filter((name):name is string=>!!name&&name.startsWith(`${key}/backup/`)).sort().reverse();
    for(const name of names){const parsed=MarketShapeDraftSchema.safeParse(JSON.parse(localStorage.getItem(name)??'null'));if(parsed.success)return parsed.data;}
  }catch{/* Ignore an unavailable local store. */}
  return null;
}
function upsert(items:MarketShapeDraftItem[],asin:string,change:Partial<MarketShapeDraftItem>){
  const previous=items.find(item=>item.asin===asin)??{asin,included:true,label:null};
  return [...items.filter(item=>item.asin!==asin),{...previous,...change}].sort((a,b)=>a.asin.localeCompare(b.asin));
}

export type ShapeReferenceSwitchState={dirty:boolean;saving:boolean;fingerprint:string};
export function MarketShapeReferencePanel({run,readError,onRefresh,starting=false,switching=false,onSwitchStateChange,onPoolSizeChange,requestedPoolSize}:{run:MarketShapeRun;readError:string|null;onRefresh:()=>void;starting?:boolean;switching?:boolean;onSwitchStateChange?:(state:ShapeReferenceSwitchState)=>void;onPoolSizeChange?:(size:number)=>void;requestedPoolSize?:number}){
  const [draft,setDraft]=useState<MarketShapeDraft>(emptyDraft),[ready,setReady]=useState(false),[sync,setSync]=useState<'saved'|'unsaved'|'pending'|'conflict'>('saved');
  const [serverConflict,setServerConflict]=useState<MarketShapeDraft|null>(null),[lastBackup,setLastBackup]=useState<MarketShapeDraft|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const [writing,setWriting]=useState(false);
  const switchState=useRef<ShapeReferenceSwitchState>({dirty:false,saving:false,fingerprint:''});
  const publishSwitchState=(next:ShapeReferenceSwitchState)=>{switchState.current=next;onSwitchStateChange?.(next);};
  useEffect(()=>{publishSwitchState({dirty:sync!=='saved',saving:writing||busy,fingerprint:JSON.stringify([draft.items,draft.catalogLabels])});},[sync,writing,busy,draft,onSwitchStateChange]);
  const current=useRef(draft),storage=useRef<string|null>(null),pending=useRef<string|null>(null),saving=useRef(false),owner=useRef<AbortController|null>(null),activeRunId=useRef(run.id);
  activeRunId.current=run.id;
  useEffect(()=>{current.current=draft;},[draft]);
  useEffect(()=>{const abort=new AbortController();owner.current=abort;return()=>abort.abort();},[]);
  const live=useMemo<MarketShapeReferenceRevisionData|null>(()=>run.source?.sorftimePool&&run.source.productHistory&&run.source.productAmountHistory&&run.categoryDashboard?{calculationVersion:CURRENT_SHAPE_CALCULATION_VERSION,scope:run.scope,pool:run.source.sorftimePool,productImages:run.source.productImages,productHistory:run.source.productHistory,productAmountHistory:run.source.productAmountHistory,categoryDashboard:run.categoryDashboard}:null,[run]);
  const currentAsins=run.source?.sorftimePool?.products.map(product=>product.asin)??[];
  useEffect(()=>{
    const abort=new AbortController();setReady(false);setError(null);setServerConflict(null);
    void (async()=>{
      let key:string|null=null,copy:PendingCopy|null=null,userId:string|null=null;
      try{const identity=await readWebSession();if(!identity)throw new Error('登录已失效');userId=identity.user.id;key=shapeDraftStorageKey(run.scope,userId);copy=localCopy(key);}
      catch{if(!abort.signal.aborted){setError('登录身份暂时无法验证；请恢复连接后刷新，原有本地草稿仍保留');setReady(false);}return;}
      if(abort.signal.aborted)return;storage.current=key;setLastBackup(key?latestBackup(key):null);
      if(copy){current.current=copy.draft;setDraft(copy.draft);pending.current=copy.key;setSync(copy.pending?'pending':'saved');}
      try{const remote=await readShapeDraft(run.id,abort.signal);if(abort.signal.aborted)return;
        if(copy?.pending){setSync('pending');setReady(true);}
        else if(remote.version===0&&run.referenceRevision?.authorId===userId){
          const legacy=await readShapeReferenceRevision(run.id,run.referenceRevision.revisionId,abort.signal);if(abort.signal.aborted)return;
          const seed={...remote,items:restoreShapeDraftItems([],legacy.data.pool.products.map(product=>product.asin),legacy.selectedAsins,legacy.assignments)};
          current.current=seed;setDraft(seed);pending.current=browserRequestId();setSync('pending');persist(key,{draft:seed,pending:true,key:pending.current});setReady(true);
        }else{current.current=remote;setDraft(remote);pending.current=null;setSync('saved');persist(key,{draft:remote,pending:false,key:null});setReady(true);}
      }catch(e){if(!abort.signal.aborted){setSync(copy?.pending?'pending':'unsaved');setError(e instanceof Error?e.message:'草稿读取失败，编辑将保留在本地');setReady(copy?.pending===true);}}
    })();return()=>abort.abort();
  },[run.id,run.scope.organizationId,run.scope.marketplace,run.scope.nodeIdPath,run.referenceRevision?.revisionId]);
  useEffect(()=>{if(switching||!ready||sync!=='pending'||serverConflict||saving.current)return;const timer=setTimeout(()=>void flush(),600);return()=>clearTimeout(timer);},[ready,sync,draft,run.id,serverConflict,switching]);
  useEffect(()=>{if(switching||!ready||sync!=='pending'||serverConflict)return;const retry=()=>void flush();window.addEventListener('online',retry);return()=>window.removeEventListener('online',retry);},[ready,sync,draft,run.id,serverConflict,switching]);
  function edit(update:(draft:MarketShapeDraft)=>MarketShapeDraft){
    if(!ready)return;
    const next=update(current.current);publishSwitchState({dirty:true,saving:saving.current||busy,fingerprint:JSON.stringify([next.items,next.catalogLabels])});current.current=next;setDraft(next);pending.current=browserRequestId();setSync('pending');setServerConflict(null);persist(storage.current,{draft:next,pending:true,key:pending.current});
  }
  async function flush(){
    if(switching||!ready||saving.current||sync==='conflict')return;
    const before=current.current,key=pending.current??browserRequestId(),runId=run.id;pending.current=key;saving.current=true;setWriting(true);publishSwitchState({...switchState.current,saving:true});setSync('pending');
    const request={expectedVersion:before.version,items:before.items,catalogLabels:before.catalogLabels};
    try{const saved=await saveShapeDraft(runId,request,key,owner.current?.signal);if(activeRunId.current!==runId)return;
      if(current.current===before){current.current=saved;setDraft(saved);pending.current=null;setSync('saved');persist(storage.current,{draft:saved,pending:false,key:null});}
      else{const newer={...current.current,version:saved.version,updatedAt:saved.updatedAt};current.current=newer;setDraft(newer);pending.current=browserRequestId();setSync('pending');persist(storage.current,{draft:newer,pending:true,key:pending.current});}setError(null);
    }catch(e){if(activeRunId.current!==runId)return;if((e as {status?:number}).status===409){try{const remote=await readShapeDraft(runId,owner.current?.signal);setServerConflict(remote);setSync('conflict');}catch{setSync('pending');}}else setSync('pending');setError(e instanceof Error?e.message:'草稿未同步，已保留本地编辑');persist(storage.current,{draft:current.current,pending:true,key:pending.current});}
    finally{saving.current=false;setWriting(false);publishSwitchState({...switchState.current,saving:busy});if(activeRunId.current!==runId)setDraft(value=>({...value}));}
  }
  function resolveConflict(useLocal:boolean){
    if(!ready||!serverConflict)return;const preserved=useLocal?serverConflict:current.current;setLastBackup(preserved);if(storage.current)backup(storage.current,preserved);
    const next=useLocal?{...current.current,version:serverConflict.version,updatedAt:serverConflict.updatedAt}:serverConflict;
    current.current=next;setDraft(next);setServerConflict(null);setError(null);pending.current=useLocal?browserRequestId():null;setSync(useLocal?'pending':'saved');persist(storage.current,{draft:next,pending:useLocal,key:pending.current});
  }
  const report=useMemo(()=>live?toShapeReferenceReport(live):null,[live]),projection=projectShapeDraft(currentAsins,draft.items);
  async function act(kind:'retry'|'cancel',step?:MarketShapeRun['steps'][number]){
    if(switching||busy||readError)return;setBusy(true);publishSwitchState({...switchState.current,saving:true});setError(null);
    try{if(kind==='retry'&&step?.latestAttemptId)await retryShapeSteps(run.id,[{stepId:step.id,failedAttemptId:step.latestAttemptId}],browserRequestId(),owner.current?.signal);else await cancelShapeRun(run.id,browserRequestId(),owner.current?.signal);onRefresh();}
    catch(e){setError(e instanceof Error?e.message:'操作失败');}finally{setBusy(false);publishSwitchState({...switchState.current,saving:saving.current});}
  }
  const admin=useMarketAdminTools();
  const running=run.steps.some(step=>step.current&&['queued','running'].includes(step.status)),failed=run.steps.filter(step=>step.current&&step.status==='failed');
  const disabled=!ready,actual=currentAsins.length,done=run.steps.filter(step=>step.current&&['succeeded','empty'].includes(step.status)).length,queued=run.steps.filter(step=>step.current&&['queued','running'].includes(step.status)).length,poolComplete=run.steps.some(step=>step.current&&step.kind==='collect-shape-pool'&&step.status==='succeeded');
  return <>
    <section className="card market-shape-controls market-reference-support" aria-label="商品形态保存与采集状态">
      <div className="shape-draft-status-row"><div><strong>商品形态自动保存</strong><span role="status" className={`shape-draft-status shape-draft-status-${sync}`}>草稿：{!ready?'读取中或身份待确认':sync==='saved'?'已保存':sync==='unsaved'?'未保存':sync==='conflict'?'保存冲突，本地和服务器草稿均已保留':'待同步'}</span></div><button className="ghost-btn shape-draft-retry" style={{visibility:sync==='pending'?'visible':'hidden'}} aria-hidden={sync!=='pending'} tabIndex={sync==='pending'?0:-1} disabled={switching||writing||sync!=='pending'||!ready} onClick={()=>void flush()}>重试同步草稿</button></div>
      <p className="shape-draft-description">编辑自动保存至数据库，刷新后可继续编辑。</p>
      <div className="shape-collection-counts"><span>目标上限{run.params.poolSize}件</span><span>来源返回{actual}件</span><span>当前纳入{projection.selectedAsins.length}件</span>{poolComplete&&!running&&actual<run.params.poolSize&&actual>0&&<span>已完成，来源返回{actual}件。</span>}{failed.length>0&&<span className="shape-collection-failure">{failed.length}项来源失败，{admin?'可在管理员工具中重试':'请联系管理员处理'}</span>}</div>
      {error&&<p role="alert" className="market-research-error">{error}</p>}
      {serverConflict&&<div role="alert"><p>服务器草稿已有其他修改。两份内容均已保留，请选择处理方式。</p><button className="ghost-btn" disabled={!ready} onClick={()=>resolveConflict(true)}>保留本地编辑并重试</button><button className="ghost-btn" disabled={!ready} onClick={()=>resolveConflict(false)}>使用服务器草稿（本地已备份）</button></div>}
      {lastBackup&&<button className="ghost-btn" disabled={!ready} onClick={()=>{if(!ready)return;edit(old=>({...old,items:lastBackup.items,catalogLabels:lastBackup.catalogLabels}));setLastBackup(null);}}>恢复上一次草稿备份</button>}
      <MarketAdminContent><details className="market-support-details"><summary>{running?'正在采集，已到达的数据实时展示':failed.length?'部分来源未完成，可重试失败项':run.status==='cancelled'?'任务已取消，草稿仍可编辑':'来源步骤详情'}</summary><p className="market-research-note">步骤完成{done}，排队/采集{queued}，失败{failed.length}。修改形态与纳入状态不重新采集。</p><ul className="market-theme-steps">{run.steps.filter(step=>step.current).map(step=><li key={step.id}>{step.asin?`${step.asin} · `:''}{labels[step.kind]??step.kind}{step.categoryMetric?` · ${step.categoryMetric}`:''}：{statuses[step.status]??step.status}{step.canRetry&&<button className="ghost-btn" disabled={switching||busy||!!readError} onClick={()=>void act('retry',step)}>重试</button>}</li>)}</ul>{running&&<button className="ghost-btn" disabled={switching||busy||!!readError} onClick={()=>void act('cancel')}>取消采集</button>}</details></MarketAdminContent></section>
    {report?<MarketShapeReferenceView report={report} assignments={projection.assignments} selectedAsins={projection.selectedAsins} catalogLabels={draft.catalogLabels} onCatalogLabels={value=>edit(old=>({...old,catalogLabels:value}))} onAssignment={(asin,label)=>edit(old=>({...old,items:upsert(old.items,asin,{label})}))} onSelected={asins=>{const selected=new Set(asins);edit(old=>({...old,items:currentAsins.reduce((items,asin)=>upsert(items,asin,{included:selected.has(asin)}),old.items)}));}} disabled={disabled} requestedPoolSize={requestedPoolSize ?? run.params.poolSize} onPoolSizeChange={onPoolSizeChange} poolSizeDisabled={running||starting}/>:<LaunchSection title="类目销量看板" description="商品形态及价格带" badge={<span className="source-badge">Sorftime</span>}><div className="pending-box"><strong>{run.status==='cancelled'?'任务已取消，保留已到达的来源':failed.length?admin?'商品来源未就绪，请在管理员工具查看失败步骤':'商品来源未就绪，请联系管理员处理':running?'正在读取商品池…':'本次未返回可用商品'}</strong><span>已保存数据继续保留，缺失数据不补零。</span></div></LaunchSection>}
  </>;
}
