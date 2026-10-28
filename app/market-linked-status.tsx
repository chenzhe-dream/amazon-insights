import React from 'react';
import {linkedModules,linkedModuleLabels,type MarketLinkedBatch,type LinkedModule} from '../shared/market-linked-contracts';

export function MarketLinkedStatus({batch,error,busy,onRetry}:{batch:MarketLinkedBatch|null;error:string|null;busy:boolean;onRetry:(module?:LinkedModule)=>void}){
 if(!error&&!batch&&!busy)return null;
 const labels={pending:'等待前置数据',started:'已启动，可查看任务进度',blocked:'待补数据',failed:'启动失败'};
 return <div className={error||batch?.status==='failed'?'market-research-error':'market-research-notice'} role={error||batch?.status==='failed'?'alert':'status'} aria-label="联动进度" aria-live="polite">
  {error&&<p>{error}</p>}
  {busy&&!batch&&<p>正在提交联动任务，请稍候；确认后显示各模块进度。</p>}
  {batch&&<>
   <p>{batch.message}</p>
   {batch.basicMessage&&<p>基础类目采集：{batch.basicMessage}</p>}
   {linkedModules.map(module=><p key={module}>{linkedModuleLabels[module]}：{labels[batch.modules[module].status]}{batch.modules[module].message&&` · ${batch.modules[module].message}`}{batch.modules[module].status==='failed'&&<> <button type="button" className="ghost-btn" disabled={busy} onClick={()=>onRetry(module)}>恢复{linkedModuleLabels[module]}</button></>}</p>)}
   {batch.basicRetryable&&<button type="button" className="ghost-btn" disabled={busy} onClick={()=>onRetry()}>重试基础采集并继续联动</button>}
   <p>已启动不等于分析完成；切换原模块查看实际进度，缺失数据继续保留待补。</p>
  </>}
 </div>;
}
