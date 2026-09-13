import { z } from 'zod';
import { MarketInputRecordSchema } from '../../../shared/market-analysis-contracts';
import type { MarketStepDefinition } from '../../db/market-module-execution-repository';
import type { planMarketThemeReconciliation } from './customer-theme-reconciliation';
import { canonicalJsonSha256 as digest } from '../../runtime/model-request-accounting';
export const MARKET_THEME_RECONCILIATION_PAGE_VERSION='theme-reconciliation-page/v1';
export const MARKET_THEME_RECONCILIATION_PAGE_SIZE=8;
export const MarketThemeReconciliationPageInputSchema=z.object({task:z.literal('customer-theme-reconciliation-page'),
  initialRulesAttemptId:z.string().uuid(),priorEvaluationAttemptIds:z.array(z.string().uuid()).max(8).optional(),offset:z.number().int().nonnegative().max(200000),previousPageAttemptId:z.string().uuid().optional(),
}).strict().refine(v=>v.offset===0?!v.previousPageAttemptId:!!v.previousPageAttemptId,'Nonzero pages require the previous committed page');
const json=(v:unknown)=>MarketInputRecordSchema.shape.data.parse(v);
function invalid():never{throw new z.ZodError([{code:'custom',path:[],message:'Theme reconciliation page requires the current audited rule basis and a contiguous committed page chain'}]);}
type Plan=ReturnType<typeof planMarketThemeReconciliation>;

export function marketThemeReconciliationPageDefinition(initialRulesAttemptId:string,priors:readonly string[],next?:{offset:number;planHash:string;previousPageAttemptId:string}):MarketStepDefinition{
  const input=MarketThemeReconciliationPageInputSchema.parse({task:'customer-theme-reconciliation-page',initialRulesAttemptId,priorEvaluationAttemptIds:[...priors],
    offset:next?.offset??0,...(next?{previousPageAttemptId:next.previousPageAttemptId}:{})});
  return {stepKey:`theme-reconcile-page/${digest(next?{initialRulesAttemptId,planHash:next.planHash,offset:next.offset}:{initialRulesAttemptId,priorEvaluationAttemptIds:priors,offset:0})}`,
    kind:'reconcile',subject:{task:input.task},input:json(input),inputRefs:[{kind:'step-output',id:initialRulesAttemptId},
      ...(next?[{kind:'step-output' as const,id:next.previousPageAttemptId}]:[]),...priors.map(id=>({kind:'step-output' as const,id}))]};
}

/** Small durable pages; a page contains no model output and performs no provider
 * call. Every model child still uses the native request meter/binding/worker. */
export function marketThemeReconciliationPage(plan:Plan,offset:number){
  if(plan.status!=='needs-model'||!Number.isSafeInteger(offset)||offset<0||offset%MARKET_THEME_RECONCILIATION_PAGE_SIZE||offset>=plan.windows.length)invalid();
  const selected=plan.windows.slice(offset,offset+MARKET_THEME_RECONCILIATION_PAGE_SIZE);
  const windows=selected.map(w=>({id:w.id,inputSnapshotId:w.snapshot.snapshotId,selectionRevision:w.selectionRevision,memberIds:w.memberIds,candidateIds:w.candidateIds,
    preparationStepKey:`theme-reconcile-model/${digest({snapshotId:w.snapshot.snapshotId,selectionRevision:w.selectionRevision})}`}));
  const output={version:MARKET_THEME_RECONCILIATION_PAGE_VERSION,planHash:plan.planHash,baseHash:plan.baseHash,initialResultHash:plan.initialResultHash,
    round:plan.round,offset,nextOffset:offset+selected.length<plan.windows.length?offset+selected.length:null,totalWindows:plan.windows.length,windows};
  const inputs=selected.map(({snapshot:s})=>json({scope:s.scope,kind:s.kind,sourceVersion:s.sourceVersion,ruleVersion:s.ruleVersion,
    collectedAt:s.collectedAt,expectedRecordIds:s.expectedRecordIds,records:s.records}));
  const children:MarketStepDefinition[]=windows.map(w=>({stepKey:w.preparationStepKey,kind:'prepare-model-batches',subject:{task:'market-customer-theme-mapping'},
    input:{task:'market-customer-theme-mapping',inputSnapshotId:w.inputSnapshotId,selectionRevision:w.selectionRevision,dataCutoffAt:selected[0].snapshot.collectedAt},
    inputRefs:[{kind:'input',id:w.inputSnapshotId}]}));
  return {output,inputs,children};
}
