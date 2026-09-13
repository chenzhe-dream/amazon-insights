import { z } from 'zod';
import { MarketInputRecordSchema } from '../../../shared/market-analysis-contracts';
import type { MarketStepDefinition } from '../../db/market-module-execution-repository';
import type { planMarketKeywordReconciliation } from './keyword-reconciliation';
import { canonicalJsonSha256 as digest } from '../../runtime/model-request-accounting';

export const MARKET_KEYWORD_RECONCILIATION_PAGE_VERSION = 'keyword-reconciliation-page/v1';
export const MARKET_KEYWORD_RECONCILIATION_EVALUATION_VERSION = 'keyword-reconciliation-evaluation/v1';
export const MARKET_KEYWORD_RECONCILIATION_PAGE_SIZE = 4;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const inputId = z.string().regex(/^market-input:[a-f0-9]{64}$/);
export const MarketKeywordReconciliationAnchorSchema = z.object({
  poolAttemptId: z.string().uuid(), preparationAttemptId: z.string().uuid(), modelAttemptIds: z.array(z.string().uuid()).max(2000),
}).strict().refine(a => a.modelAttemptIds.every((id, i) => i === 0 || a.modelAttemptIds[i - 1] < id), 'Initial model attempts must be sorted and unique');
export type MarketKeywordReconciliationAnchor = z.infer<typeof MarketKeywordReconciliationAnchorSchema>;
const priors = z.array(z.string().uuid()).max(64).refine(ids => new Set(ids).size === ids.length, 'Duplicate prior evaluations');
export const MarketKeywordReconciliationPageInputSchema = z.object({
  task: z.literal('keyword-reconciliation-page'), anchor: MarketKeywordReconciliationAnchorSchema, priorEvaluationAttemptIds: priors,
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), previousPageAttemptId: z.string().uuid().optional(),
}).strict().refine(v => v.offset % MARKET_KEYWORD_RECONCILIATION_PAGE_SIZE === 0 && (v.offset === 0 ? !v.previousPageAttemptId : !!v.previousPageAttemptId), 'A page must continue the committed chain');
export type MarketKeywordReconciliationPageInput = z.infer<typeof MarketKeywordReconciliationPageInputSchema>;
export const MarketKeywordReconciliationEvaluationInputSchema = z.object({
  task: z.literal('keyword-reconciliation-evaluate'), anchor: MarketKeywordReconciliationAnchorSchema, priorEvaluationAttemptIds: priors,
  lastPageAttemptId: z.string().uuid(), frontierHash: hash,
}).strict();
export type MarketKeywordReconciliationEvaluationInput = z.infer<typeof MarketKeywordReconciliationEvaluationInputSchema>;
export const MarketKeywordReconciliationPageOutputSchema = z.object({
  version: z.literal(MARKET_KEYWORD_RECONCILIATION_PAGE_VERSION), status: z.enum(['needs-model', 'waiting-initial-models', 'ready', 'partial']),
  planHash: hash, baseHash: hash, initialResultHash: hash, round: z.number().int().nonnegative().max(64),
  offset: z.number().int().nonnegative(), nextOffset: z.number().int().positive().nullable(), totalWindows: z.number().int().nonnegative(), resultHash: hash.nullable(),
  windows: z.array(z.object({id: z.string().min(1), dimension: z.enum(['W1','W2','W3','W4','cluster']), inputSnapshotId: inputId,
    selectionRevision: z.string().min(1), memberIds: z.array(z.string()).min(1).max(20), candidateIds: z.array(z.string()).min(1).max(4),
    preparationStepKey: z.string().min(1), dataCutoffAt: z.string().datetime(),
  }).strict()).max(MARKET_KEYWORD_RECONCILIATION_PAGE_SIZE),
}).strict().superRefine((p,ctx) => {
  const needs = p.status === 'needs-model';
  if (needs ? !p.windows.length || !p.totalWindows || p.resultHash !== null : p.windows.length !== 0 || p.totalWindows !== 0 || p.offset !== 0 || p.nextOffset !== null || (p.status === 'waiting-initial-models' ? p.resultHash !== null : p.resultHash === null))
    ctx.addIssue({code:'custom',message:'Page status differs from its content'});
});
export type MarketKeywordReconciliationPageOutput = z.infer<typeof MarketKeywordReconciliationPageOutputSchema>;
const json = (v: unknown) => MarketInputRecordSchema.shape.data.parse(v);
export function marketKeywordReconciliationAnchorRefs(anchor: MarketKeywordReconciliationAnchor) {
  // Model attempts remain bound in the full input/key anchor. The preparation
  // manifest links them indirectly; the locked native reader audits each current
  // attempt, keeping direct refs bounded even at the 2000-model capacity.
  return [anchor.poolAttemptId, anchor.preparationAttemptId].map(id => ({kind:'step-output' as const,id}));
}
export function marketKeywordReconciliationPageDefinition(anchor: MarketKeywordReconciliationAnchor, priorEvaluationAttemptIds: readonly string[], next?: {offset:number;planHash:string;previousPageAttemptId:string}): MarketStepDefinition {
  const input = MarketKeywordReconciliationPageInputSchema.parse({task:'keyword-reconciliation-page',anchor,priorEvaluationAttemptIds:[...priorEvaluationAttemptIds],offset:next?.offset ?? 0,...(next ? {previousPageAttemptId:next.previousPageAttemptId} : {})});
  return {stepKey:`keyword-reconcile-page/${digest({input,planHash:next?.planHash ?? null})}`,kind:'reconcile',subject:{task:input.task},input:json(input),
    inputRefs:[...marketKeywordReconciliationAnchorRefs(input.anchor),...priorEvaluationAttemptIds.map(id => ({kind:'step-output' as const,id})),...(next ? [{kind:'step-output' as const,id:next.previousPageAttemptId}] : [])]};
}
export function marketKeywordReconciliationPreparationDefinition(window: MarketKeywordReconciliationPageOutput['windows'][number]): MarketStepDefinition {
  return {stepKey:window.preparationStepKey,kind:'prepare-model-batches',subject:{task:'market-keyword-semantics'},
    input:{task:'market-keyword-semantics',inputSnapshotId:window.inputSnapshotId,selectionRevision:window.selectionRevision,dataCutoffAt:window.dataCutoffAt},inputRefs:[{kind:'input',id:window.inputSnapshotId}]};
}
/** Only admitted windows allocate snapshots; each is materialized exactly once. */
export function marketKeywordReconciliationPage(plan: ReturnType<typeof planMarketKeywordReconciliation>, offset: number) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % MARKET_KEYWORD_RECONCILIATION_PAGE_SIZE || (plan.status === 'needs-model' ? offset >= plan.windows.length : offset !== 0 || plan.windows.length !== 0)) throw new TypeError('Invalid keyword reconciliation page offset');
  const selected = plan.windows.slice(offset, offset + MARKET_KEYWORD_RECONCILIATION_PAGE_SIZE).map(w => ({window:w,snapshot:w.materializeSnapshot()}));
  const windows = selected.map(({window:w,snapshot:s}) => ({id:w.id,dimension:w.dimension,inputSnapshotId:s.snapshotId,selectionRevision:w.selectionRevision,memberIds:w.memberIds,candidateIds:w.candidateIds,
    preparationStepKey:`keyword-reconcile-model/${digest({snapshotId:s.snapshotId,selectionRevision:w.selectionRevision})}`,dataCutoffAt:s.collectedAt}));
  const output = MarketKeywordReconciliationPageOutputSchema.parse({version:MARKET_KEYWORD_RECONCILIATION_PAGE_VERSION,status:plan.status,planHash:plan.planHash,baseHash:plan.baseHash,initialResultHash:plan.initialResultHash,
    round:plan.round,offset,nextOffset:offset+windows.length<plan.windows.length?offset+windows.length:null,totalWindows:plan.windows.length,windows,resultHash:plan.result?.resultHash ?? null});
  const inputs = selected.map(({snapshot:s}) => json({scope:s.scope,kind:s.kind,sourceVersion:s.sourceVersion,ruleVersion:s.ruleVersion,collectedAt:s.collectedAt,expectedRecordIds:s.expectedRecordIds,records:s.records}));
  return {output,inputs,children:windows.map(marketKeywordReconciliationPreparationDefinition)};
}
