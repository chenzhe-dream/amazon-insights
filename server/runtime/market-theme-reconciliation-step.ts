import { z } from 'zod';
import { MarketInputRecordSchema } from '../../shared/market-analysis-contracts';
import { PostgresQueryContext } from '../db/postgres/query-context';
import { readMarketThemeReconciliationPlan } from './market-theme-reconciliation-round';
import { loadMarketThemeRuleInputs } from './market-theme-rule-inputs';
import type { MarketStepHandler } from './market-module-step-worker';
import { canonicalJsonSha256 as digest } from './model-request-accounting';

import { marketThemeReconciliationPage, marketThemeReconciliationPageDefinition, MarketThemeReconciliationPageInputSchema, MARKET_THEME_RECONCILIATION_PAGE_SIZE } from '../domain/market-research/customer-theme-reconciliation-pages';
export { marketThemeReconciliationPage, MarketThemeReconciliationPageInputSchema, MARKET_THEME_RECONCILIATION_PAGE_SIZE, MARKET_THEME_RECONCILIATION_PAGE_VERSION } from '../domain/market-research/customer-theme-reconciliation-pages';
const json=(v:unknown)=>MarketInputRecordSchema.shape.data.parse(v);
function invalid():never{throw new z.ZodError([{code:'custom',path:[],message:'Theme reconciliation page has conflicting lineage'}]);}
const same=(a:unknown,b:unknown)=>{if(digest(a)!==digest(b))invalid();};
/** Native handler; the runtime's claim filter admits only versioned theme flows.
 * Arbitrary legacy reconcile jobs remain outside this consumer. */
export function createMarketThemeReconciliationStep(context:PostgresQueryContext):MarketStepHandler{
  return async({claim,signal})=>{
    const input=MarketThemeReconciliationPageInputSchema.parse(claim.step.input);
    const loaded=await loadMarketThemeRuleInputs(context,claim,signal,input.initialRulesAttemptId);
    const priorEvaluationAttemptIds=input.priorEvaluationAttemptIds??[];
    for(const id of priorEvaluationAttemptIds)if(!claim.step.inputRefs.some(r=>r.kind==='step-output'&&r.id===id))invalid();
    const plan=await readMarketThemeReconciliationPlan(context,{actor:{organizationId:claim.organizationId,userId:claim.createdBy},moduleRunId:claim.moduleRunId,
      initialRulesAttemptId:input.initialRulesAttemptId,priorEvaluationAttemptIds},signal);
    const page=marketThemeReconciliationPage(plan,input.offset);
    let previousId=input.previousPageAttemptId,offset=input.offset;
    const visited=new Set<string>();
    let declaring=claim.step;
    while(previousId){
      signal.throwIfAborted();if(visited.has(previousId)||!declaring.inputRefs.some(r=>r.kind==='step-output'&&r.id===previousId))invalid();visited.add(previousId);
      const attempt=loaded.view.attempts.find(a=>a.id===previousId),step=loaded.view.steps.find(s=>s.latestAttemptId===previousId);
      if(!attempt||!step||step.kind!=='reconcile'||attempt.stepId!==step.id||attempt.status!=='succeeded'||step.status!=='succeeded')invalid();
      const previous=MarketThemeReconciliationPageInputSchema.parse(step.input);
      same(previous.initialRulesAttemptId,input.initialRulesAttemptId);
      same(previous.priorEvaluationAttemptIds??[],priorEvaluationAttemptIds);
      if(previous.offset!==offset-MARKET_THEME_RECONCILIATION_PAGE_SIZE||!step.inputRefs.some(r=>r.kind==='step-output'&&r.id===input.initialRulesAttemptId))invalid();
      same(attempt.output,marketThemeReconciliationPage(plan,previous.offset).output);
      offset=previous.offset;previousId=previous.previousPageAttemptId;declaring=step;
    }
    if(offset!==0)invalid();
    if(page.output.nextOffset!==null){
      page.children.push(marketThemeReconciliationPageDefinition(input.initialRulesAttemptId,priorEvaluationAttemptIds,{offset:page.output.nextOffset,planHash:plan.planHash,previousPageAttemptId:claim.attemptId}));
    }
    signal.throwIfAborted();return {kind:'settlement',value:{inputs:page.inputs,children:page.children,outcome:{status:'succeeded',output:json(page.output)}}};
  };
}
