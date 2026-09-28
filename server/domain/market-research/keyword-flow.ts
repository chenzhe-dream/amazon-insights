import { z } from 'zod';
import { MarketAnalysisScopeSchema } from '../../../shared/market-analysis-contracts';
import { MARKET_SOURCE_HANDLER_VERSION } from '../../../shared/market-source-contracts';
import { MARKET_KEYWORD_FLOW_VERSION, MARKET_KEYWORD_RULES_FLOW_VERSION, MarketKeywordFlowParamsSchema,isMarketKeywordGlobalMode } from '../../../shared/market-keyword-flow-contracts';
export { MARKET_KEYWORD_FLOW_VERSION, MARKET_KEYWORD_RULES_FLOW_VERSION, MarketKeywordFlowParamsSchema, MarketKeywordStartRequestSchema } from '../../../shared/market-keyword-flow-contracts';
import type { CreateMarketModuleRunInput, MarketExecutionStep, MarketModuleRunView, MarketStepDefinition } from '../../db/market-module-execution-repository';
import { MARKET_KEYWORD_POOL_VERSION } from './keyword-source-pool';
import { canonicalJsonSha256 as digest } from '../../runtime/model-request-accounting';
import {inspectMarketKeywordReconciliationFlow} from './keyword-reconciliation-flow';

const obj = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const inputId = z.string().regex(/^market-input:[a-f0-9]{64}$/);
const sourceId = z.string().regex(/^market-source:[a-f0-9]{64}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const success = (s: MarketExecutionStep) => s.status === 'succeeded' || s.status === 'empty';
const terminal = (s: MarketExecutionStep) => success(s) || s.status === 'failed';
const key = (phase: string, basis: unknown) => `keyword-flow/${phase}:${digest(basis)}`;
const same = (a: unknown, b: unknown) => { if (digest(a) !== digest(b)) throw new TypeError('Keyword frontier binding differs'); };
type Request = Pick<CreateMarketModuleRunInput, 'scope' | 'moduleKind' | 'params' | 'versions'>;
function params(request: Request) {
  const p = MarketKeywordFlowParamsSchema.parse(request.params);
  MarketAnalysisScopeSchema.parse(request.scope);
  const v = request.versions;
  const noModel = v.model === null && v.prompt === null && v.configuration === null;
  if (request.moduleKind !== 'keywords' || v.source !== MARKET_SOURCE_HANDLER_VERSION || v.rule !== MARKET_KEYWORD_POOL_VERSION ||
    v.planner !== p.flow || v.mapping !== p.catalog.dictionaryVersion ||
    !(noModel || v.model === 'market.semantic.text.v1' && v.prompt && v.configuration)) throw new TypeError('Keyword flow versions differ');
  return p;
}
export const isMarketKeywordFlow = (run: { params: unknown }) => [MARKET_KEYWORD_FLOW_VERSION, MARKET_KEYWORD_RULES_FLOW_VERSION].includes(String(obj(run.params).flow));
export function marketKeywordFlowInitialSteps(request: Request): MarketStepDefinition[] {
  const p = params(request);
  return p.plannedPages.filter(page=>!p.paginationMode||page.page===1).map(page => ({ stepKey: key('page', page), kind: 'collect-keyword-page', subject: { flow: p.flow }, input: page, inputRefs: [] }));
}

/** Only the source/model frontier: no rules, human revisions or final report.
 * Failed pages remain current retry targets; their new attempts invalidate the
 * old pool and every descendant. Existing handlers publish children atomically. */
export function inspectMarketKeywordContinuation(view: MarketModuleRunView, now: string, options: { readCancelled?: boolean } = {}): { children: MarketStepDefinition[]; currentStepKeys: string[] } {
  const current = new Set<string>();
  const result = (children: MarketStepDefinition[] = []) => ({ children: view.run.status === 'cancelled' ? [] : children, currentStepKeys: [...current] });
  if (!isMarketKeywordFlow(view.run) || view.run.status === 'cancelled' && !options.readCancelled) return result();
  const p = params(view.run);
  z.string().datetime().parse(now);
  function find(definition: MarketStepDefinition, required = false) {
    current.add(definition.stepKey);
    const matches = view.steps.filter(s => s.stepKey === definition.stepKey);
    if (matches.length > 1 || required && !matches.length) throw new TypeError('Keyword frontier missing or ambiguous');
    if (matches[0]) {
      const { stepKey, kind, subject, input, inputRefs } = matches[0];
      same({ stepKey, kind, subject, input, inputRefs }, definition);
      if (matches[0].inputHash !== digest(definition)) throw new TypeError('Keyword frontier input hash differs');
    }
    return matches[0];
  }
  function attempt(step: MarketExecutionStep) {
    const matches = view.attempts.filter(a => a.id === step.latestAttemptId && a.stepId === step.id);
    if (matches.length !== 1 || matches[0].status !== step.status && !(step.status === 'failed' && matches[0].status === 'interrupted'))
      throw new TypeError('Keyword current attempt differs');
    return matches[0];
  }
  const pages:MarketExecutionStep[]=[];
  if(p.paginationMode){
    const stopped=new Set<string>(),waiting=new Set<string>(),children:MarketStepDefinition[]=[];
    for(const page of p.plannedPages){
      if(stopped.has(page.seed)||waiting.has(page.seed))continue;
      const definition:MarketStepDefinition={stepKey:key('page',page),kind:'collect-keyword-page',subject:{flow:p.flow},input:page,inputRefs:[]};
      const step=find(definition,page.page===1);
      if(!step){children.push(definition);waiting.add(page.seed);continue;}
      pages.push(step);
      if(!terminal(step)){waiting.add(page.seed);continue;}
      if(step.status==='failed'){stopped.add(page.seed);continue;}
      const count=z.number().int().min(0).parse(obj(attempt(step).output).receivedCount);
      if(count<20)stopped.add(page.seed);
    }
    if(children.length||waiting.size)return result(children);
  }else pages.push(...marketKeywordFlowInitialSteps(view.run).map(d=>find(d,true)!));
  const collectedPages=pages.map(s=>({seed:String(obj(s.input).seed),page:Number(obj(s.input).page)}));
  if (pages.some(s => !terminal(s))) return result();
  const attempts = pages.map(attempt);
  const sourceBasis = attempts.map(a => ({ id: a.id, status: a.status }));
  const poolKey = key('pool', sourceBasis);
  const savedPool = view.steps.find(s => s.stepKey === poolKey);
  // The view intentionally carries no attempt timestamps. Freeze the first
  // cutoff in the durable definition and reuse it on every later inspection.
  const dataCutoffAt = savedPool ? z.string().datetime().parse(obj(savedPool.input).dataCutoffAt) : now;
  const selectionRevision = `keyword-selection:${digest(sourceBasis)}`;
  const observations = attempts.filter(a => a.status === 'succeeded' || a.status === 'empty').map(a => ({
    inputSnapshotId: inputId.parse(obj(a.output).inputSnapshotId), sourceRef: sourceId.parse(obj(a.output).sourceRef),
  }));
  const poolDefinition: MarketStepDefinition = { stepKey: poolKey, kind: 'prepare-keyword-pool', subject: { flow: p.flow, frontierHash: digest(sourceBasis) },
    input: { phase: 'assemble', plannedPages: collectedPages, maxMembers: p.maxMembers, pages: observations, catalog: p.catalog, selectionRevision, dataCutoffAt },
    inputRefs: [...attempts.map(a => ({ kind: 'step-output' as const, id: a.id })),
      ...observations.flatMap(o => [{ kind: 'input' as const, id: o.inputSnapshotId }, { kind: 'source' as const, id: o.sourceRef }])] };
  const poolStep = find(poolDefinition);
  if (!poolStep) return result([poolDefinition]);
  if (!success(poolStep)) return result();
  const poolAttempt = attempt(poolStep), pool = obj(poolAttempt.output);
  const raw = inputId.parse(pool.rawInputSnapshotId), semantic = inputId.parse(pool.semanticInputSnapshotId);
  if (raw === semantic) throw new TypeError('Keyword raw and semantic pools differ in purpose');
  const pageBindings = collectedPages.map((page, i) => ({ ...page,
    inputSnapshotId: success(pages[i]) ? inputId.parse(obj(attempts[i].output).inputSnapshotId) : null,
    sourceRef: success(pages[i]) ? sourceId.parse(obj(attempts[i].output).sourceRef) : null,
  })).sort((a, b) => a.seed < b.seed ? -1 : a.seed > b.seed ? 1 : a.page - b.page);
  const basisHash = digest({ version: MARKET_KEYWORD_POOL_VERSION, scope: view.run.scope, catalog: p.catalog, dataCutoffAt, maxMembers: p.maxMembers, pageBindings });
  same(pool.poolVersion, MARKET_KEYWORD_POOL_VERSION); same(pool.basisHash, basisHash);
  same(pool.scope, view.run.scope); same(pool.catalogHash, digest(p.catalog)); same(pool.dataCutoffAt, dataCutoffAt);
  same(pool.pageBindings, pageBindings); same(pool.maxMembers, p.maxMembers);
  const memberIds = z.array(z.string().min(1)).max(p.maxMembers).parse(pool.selectedMemberIds);
  const keywords = z.array(z.string().min(1)).max(p.maxMembers).parse(pool.selectedKeywords);
  if (memberIds.length !== keywords.length || new Set(memberIds).size !== memberIds.length || new Set(keywords).size !== keywords.length)
    throw new TypeError('Keyword pool members differ');
  if (!memberIds.length) return result();
  if(p.supplementalSources==='sif-aba/v1'){
    const children:MarketStepDefinition[]=[];
    for(let offset=0;offset<memberIds.length;offset+=10){
      const members=memberIds.slice(offset,offset+10).map((keywordId,i)=>({keywordId,keyword:keywords[offset+i]}));
      const definition:MarketStepDefinition={stepKey:key('aba',{pool:raw,members,source:p.supplementalSources}),kind:'collect-keyword-aba',
        subject:{source:p.supplementalSources},input:{poolInputSnapshotId:raw,members,referenceMonth:view.run.scope.toMonth},
        inputRefs:[{kind:'input',id:raw},{kind:'step-output',id:poolAttempt.id}]};
      if(!find(definition))children.push(definition);
    }
    if(children.length)return result(children);
  }
  const trends = find({ stepKey: `pool-trends/${basisHash}`, kind: 'prepare-keyword-pool', subject: {},
    input: { phase: 'dispatch-trends', inputSnapshotId: raw, basisHash }, inputRefs: [{ kind: 'input', id: raw }, { kind: 'step-output', id: poolAttempt.id }] }, true)!;
  if (success(trends)) {
    const dispatched = obj(attempt(trends).output);
    same(dispatched.poolInputSnapshotId, raw);
    const scheduledKeywordIds = z.array(z.string().min(1)).max(p.maxMembers).parse(dispatched.scheduledKeywordIds);
    const scheduledKeywordIdSet = new Set(scheduledKeywordIds);
    if (scheduledKeywordIds.length !== memberIds.length || scheduledKeywordIdSet.size !== scheduledKeywordIds.length ||
      memberIds.some(id => !scheduledKeywordIdSet.has(id))) throw new TypeError('Keyword scheduled members differ');
    memberIds.forEach((id, i) => find({ stepKey: `trend/${digest({ pool: raw, keywordId: id })}`, kind: 'collect-keyword-trend', subject: { keywordId: id },
      input: { keywordId: id, keyword: keywords[i], poolInputSnapshotId: raw }, inputRefs: [{ kind: 'input', id: raw }] }, true));
  }
  if (!view.run.versions.model || p.flow === MARKET_KEYWORD_RULES_FLOW_VERSION) return result();
  const preparation = find({ stepKey: `pool-model/${basisHash}`, kind: 'prepare-model-batches', subject: { task: p.catalog.task },
    input: { task: p.catalog.task, inputSnapshotId: semantic, selectionRevision, dataCutoffAt }, inputRefs: [{ kind: 'input', id: semantic }] }, true)!;
  if (!success(preparation)) return result();
  const prepared = obj(attempt(preparation).output);
  same(prepared.task, p.catalog.task); same(prepared.inputSnapshotId, semantic);
  const batches = z.array(z.object({ bindingId: z.string().uuid(), batchKey: z.string().min(1), inputDigest: hash })).max(2000).parse(prepared.batches);
  if (new Set(batches.map(b => b.bindingId)).size !== batches.length || new Set(batches.map(b => b.batchKey)).size !== batches.length)
    throw new TypeError('Duplicate keyword model binding');
  const models=batches.map(b=>find({ stepKey: `model/${b.batchKey}`, kind: 'model-batch', subject: { task: p.catalog.task },
    input: { task: p.catalog.task, bindingId: b.bindingId, inputDigest: b.inputDigest }, inputRefs: [{ kind: 'input', id: semantic }] }, true)!);
  if(isMarketKeywordGlobalMode(p.analysisMode)&&models.every(terminal))return inspectMarketKeywordReconciliationFlow(view,
    {poolAttemptId:poolAttempt.id,preparationAttemptId:attempt(preparation).id,modelAttemptIds:models.map(s=>attempt(s).id).sort()},current);
  return result();
}
