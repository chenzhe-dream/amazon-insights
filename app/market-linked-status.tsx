import React from 'react';
import {linkedModules,linkedModuleLabels,type MarketLinkedBatch,type LinkedModule} from '../shared/market-linked-contracts';

export function MarketLinkedStatus({batch,error,busy,onRetry}:{batch:MarketLinkedBatch|null;error:string|null;busy:boolean;onRetry:(module?:LinkedModule)=>void}){
 if(!error&&batch?.status!=='failed')return null;
 return <div className="market-research-error" role="alert">
  {error&&<p>{error}</p>}
  {batch?.status==='failed'&&<>
   <p>{batch.message}</p>
   {linkedModules.filter(module=>batch.modules[module].status==='failed').map(module=><p key={module}>{linkedModuleLabels[module]}：{batch.modules[module].message??'启动失败'} <button type="button" className="ghost-btn" disabled={busy} onClick={()=>onRetry(module)}>恢复{linkedModuleLabels[module]}</button></p>)}
   {batch.status==='failed'&&batch.basicRetryable&&linkedModules.every(module=>batch.modules[module].status==='pending')&&<button type="button" className="ghost-btn" disabled={busy} onClick={()=>onRetry()}>重试基础采集并继续联动</button>}
  </>}
 </div>;
}
