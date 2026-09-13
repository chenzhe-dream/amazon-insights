import { z } from 'zod';
import { MarketInputRecordSchema, type MarketAnalysisScope } from '../../../shared/market-analysis-contracts';
import type { planMarketThemeReconciliation, MarketThemeReconciliationRound } from './customer-theme-reconciliation';
import { createMarketInputSnapshot } from './snapshot';
import { canonicalJsonSha256 as digest } from '../../runtime/model-request-accounting';

export const MARKET_THEME_EVALUATION_VERSION='theme-reconciliation-evaluation/v1';
export const MarketThemeEvaluationInputSchema=z.object({task:z.literal('customer-theme-reconciliation-evaluate'),initialRulesAttemptId:z.string().uuid(),
  lastPageAttemptId:z.string().uuid(),priorEvaluationAttemptIds:z.array(z.string().uuid()).max(8).optional(),frontierHash:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
type Plan=ReturnType<typeof planMarketThemeReconciliation>;
export type MarketThemeRoundFrontier={stepId:string;attemptId:string|null;status:string;inputHash:string};
export type MarketThemeRoundAuditRef={agentRunId:string;attemptId:string;bindingId:string;executionFingerprint:string};
type Common={plan:Plan;frontier:MarketThemeRoundFrontier[];frontierHash:string;pendingStepIds:string[];auditRefs:MarketThemeRoundAuditRef[]};
export type MarketThemeRoundRead=Common&({status:'waiting';receipt:null;result:null}|{status:'settled';receipt:MarketThemeReconciliationRound;result:Plan});
const json=(v:unknown)=>MarketInputRecordSchema.shape.data.parse(v);

/** Immutable, bounded chunks. Round audit records refer to existing model audits;
 * no raw provider response is duplicated. Final aggregate retains every member. */
export function createMarketThemeEvaluationArtifact(scope:MarketAnalysisScope,sourceVersion:string,collectedAt:string,inputValue:unknown,round:MarketThemeRoundRead){
  const input=MarketThemeEvaluationInputSchema.parse(inputValue);
  if(round.status!=='settled'||input.frontierHash!==round.frontierHash||digest(round.frontier)!==round.frontierHash)throw new TypeError('Evaluation needs a settled matching frontier');
  if(round.receipt.planHash!==round.plan.planHash||round.result.history.length!==round.plan.round+1)throw new TypeError('Evaluation round differs');
  const audit=round.result.history[round.plan.round],final=round.result.result;
  if(audit.planHash!==round.plan.planHash)throw new TypeError('Evaluation audit differs');
  const finalParts=final?(({aggregation,decisions,groups,rounds:_rounds,...summary})=>({aggregation,decisions,groups,summary}))(final):null;
  const aggregateParts=finalParts?(({groups,perAsin,mappings,...summary})=>({groups,perAsin,mappings,summary}))(finalParts.aggregation):null;
  const rows=[{id:'summary',scope,data:json({version:MARKET_THEME_EVALUATION_VERSION,input,frontierHash:round.frontierHash,
    completedRound:round.plan.round,beforePlanHash:round.plan.planHash,afterPlanHash:round.result.planHash,status:round.result.status,
    initialResultHash:round.result.initialResultHash,baseHash:round.result.baseHash,nextWindowCount:round.result.windows.length,
    result:finalParts?.summary??null,aggregation:aggregateParts?.summary??null})}];
  const chunk=(kind:string,items:readonly unknown[],size=128)=>{for(let i=0;i<items.length;i+=size)rows.push({id:`${kind}:${i/size}`,scope,data:json({kind,items:items.slice(i,i+size)})});};
  chunk('frontier',round.frontier);chunk('audits',round.auditRefs);chunk('batches',audit.batches);chunk('missing',audit.missing);
  if(finalParts&&aggregateParts){chunk('decisions',finalParts.decisions);chunk('labels',finalParts.groups);chunk('groups',aggregateParts.groups,32);
    chunk('mappings',aggregateParts.mappings);for(const asin of aggregateParts.perAsin)rows.push({id:`asin:${asin.asin}`,scope,data:json(asin)});}
  const factory={scope,kind:'customer-themes' as const,sourceVersion,ruleVersion:MARKET_THEME_EVALUATION_VERSION,collectedAt,expectedRecordIds:rows.map(r=>r.id),records:rows};
  const snapshot=createMarketInputSnapshot(factory);
  const output={version:MARKET_THEME_EVALUATION_VERSION,inputSnapshotId:snapshot.snapshotId,evaluationHash:snapshot.contentHash,completedRound:round.plan.round,
    initialRulesAttemptId:input.initialRulesAttemptId,frontierHash:round.frontierHash,status:round.result.status,planHash:round.result.planHash,resultHash:final?.resultHash??null};
  return {factory,snapshot,output};
}
