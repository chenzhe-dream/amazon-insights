import React from 'react';
import {marketSourceQuotaNotice,type QuotaStep} from './lib/market-source-quota';
export function MarketSourceQuotaNotice({run}:{run:{steps:readonly QuotaStep[]}|null}){
 const message=run?marketSourceQuotaNotice(run.steps):null;
 return message?<p role="alert" className="market-research-notice" aria-label="数据源额度提示">{message}</p>:null;
}
