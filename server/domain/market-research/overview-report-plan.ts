import {z} from 'zod';
import type {MarketModuleRunView,MarketStepDefinition} from '../../db/market-module-execution-repository';
import {canonicalJsonSha256 as digest} from '../../runtime/model-request-accounting';
export const MarketOverviewReportInputSchema=z.object({task:z.literal('overview-report'),catalogAttemptId:z.string().uuid(),
  phase:z.enum(['numeric','window-results']),windowAttemptId:z.string().uuid().nullable(),preparationAttemptIds:z.array(z.string().uuid()).max(2000),modelAttemptIds:z.array(z.string().uuid()).max(2000),
  numericInputSnapshotId:z.string().regex(/^market-input:[a-f0-9]{64}$/)}).strict();
export type MarketOverviewReportInput=z.infer<typeof MarketOverviewReportInputSchema>;
export function marketOverviewReportDefinition(view:MarketModuleRunView,input:MarketOverviewReportInput):MarketStepDefinition{
  input=MarketOverviewReportInputSchema.parse(input);
  const attempts=[input.catalogAttemptId,...(input.windowAttemptId?[input.windowAttemptId]:[]),...input.preparationAttemptIds,...input.modelAttemptIds];
  if(new Set(attempts).size!==attempts.length||input.phase==='numeric'&&(input.windowAttemptId!==null||input.preparationAttemptIds.length||input.modelAttemptIds.length)||input.phase==='window-results'&&!input.windowAttemptId)throw new TypeError('Invalid overview report basis');
  const accepted=attempts.map(id=>{const a=view.attempts.find(a=>a.id===id);if(!a||!['succeeded','empty','failed','interrupted'].includes(a.status))throw new TypeError('Report basis is not terminal');return a;});
  return {stepKey:`overview-report/${digest(input)}`,kind:'report',subject:{task:'overview-report'},input,
    inputRefs:[{kind:'input',id:input.numericInputSnapshotId},...accepted.filter(a=>['succeeded','empty'].includes(a.status)).map(a=>({kind:'step-output' as const,id:a.id}))]};
}
