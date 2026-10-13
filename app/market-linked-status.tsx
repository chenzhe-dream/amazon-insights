import React from 'react';
import {linkedModules,linkedModuleLabels,type MarketLinkedBatch,type LinkedModule} from '../shared/market-linked-contracts';

export function MarketLinkedStatus({batch,error,busy,onOpen,onRetry}:{batch:MarketLinkedBatch|null;error:string|null;busy:boolean;onOpen:(module:LinkedModule)=>void;onRetry:(module?:LinkedModule)=>void}){
 if(!batch&&!error)return null;
 return <section className="card market-linked-panel" aria-label="四模块联动分析">
  <strong>四模块联动分析</strong>
  {batch&&<>
   <p>{batch.request.scope.marketplace} · {batch.categoryName??batch.request.scope.nodeQuery} · {batch.request.fromMonth} 至 {batch.request.scope.month}</p>
   <p role="status">{batch.message}</p>
   <ul>{linkedModules.map(module=>{
    const state=batch.modules[module];
    return <li key={module}>
     <div className="market-linked-copy"><strong>{linkedModuleLabels[module]}</strong><span>{state.status==='started'?'已启动，进入模块查看进度':state.status==='failed'?'启动失败':'等待类目基础数据'}</span>{state.message&&<span>{state.message}</span>}</div>
     <div className="market-linked-actions">{state.runId&&<button type="button" className="ghost-btn" onClick={()=>onOpen(module)}>查看</button>}{state.status==='failed'&&<button type="button" className="ghost-btn" disabled={busy} onClick={()=>onRetry(module)}>恢复{linkedModuleLabels[module]}</button>}</div>
    </li>;
   })}</ul>
   {batch.status==='failed'&&batch.basicRetryable&&linkedModules.every(module=>batch.modules[module].status==='pending')&&<button type="button" className="ghost-btn" disabled={busy} onClick={()=>onRetry()}>重试基础采集并继续联动</button>}
  </>}
  {error&&<p role="alert">{error}</p>}
 </section>;
}
