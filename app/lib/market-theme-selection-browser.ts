import { MarketModuleIdSchema } from '../../shared/market-module-contracts';
import { MarketThemeSelectionRequestSchema, MarketThemeSelectionResponseSchema, MarketThemeSelectionRevisionIdSchema } from '../../shared/market-theme-selection-contracts';
import type { z } from 'zod';
import { localAgentFetch, localAgentErrorMessage } from './local-agent-browser';
export async function requestThemeSelection(runId:string,attemptId:string,reportHash:string,options:{revisionId?:string;command?:{key:string;request:z.input<typeof MarketThemeSelectionRequestSchema>};signal?:AbortSignal}={}){
 const run=MarketModuleIdSchema.parse(runId),attempt=MarketModuleIdSchema.parse(attemptId),suffix=options.revisionId?`/${encodeURIComponent(MarketThemeSelectionRevisionIdSchema.parse(options.revisionId))}`:'';
 const command=options.command;options.signal?.throwIfAborted();
 const response=await localAgentFetch(`/v1/market-analysis/runs/${run}/reports/${attempt}/theme-selection${suffix}`,{method:command?'POST':'GET',cache:'no-store',signal:options.signal,...(command?{headers:{'idempotency-key':MarketModuleIdSchema.parse(command.key)},body:JSON.stringify(MarketThemeSelectionRequestSchema.parse(command.request))}:{})});
 const value=await response.json().catch(()=>null);options.signal?.throwIfAborted();if(!response.ok)throw new Error(localAgentErrorMessage(value,'样本版本操作失败，请重新读取后重试。'));
 const parsed=MarketThemeSelectionResponseSchema.parse(value);
 if(parsed.base.attemptId!==attempt||parsed.base.report.moduleRunId!==run||parsed.base.report.reportHash!==reportHash||(options.revisionId&&parsed.revision?.revisionId!==options.revisionId))throw new Error('样本版本与报告身份不一致，未加载该结果。');
 return parsed;
}
