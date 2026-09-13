import { z } from 'zod';
import type { MarketModuleRunView, MarketExecutionStep, MarketStepDefinition } from '../../db/market-module-execution-repository';
import { MarketKeywordReconciliationAnchorSchema, MarketKeywordReconciliationPageOutputSchema, MarketKeywordReconciliationEvaluationInputSchema,
  MARKET_KEYWORD_RECONCILIATION_EVALUATION_VERSION, MARKET_KEYWORD_RECONCILIATION_PAGE_SIZE,
  marketKeywordReconciliationPageDefinition, marketKeywordReconciliationPreparationDefinition, marketKeywordReconciliationAnchorRefs,
  type MarketKeywordReconciliationAnchor } from './keyword-reconciliation-pages';
import { canonicalJsonSha256 as digest } from '../../runtime/model-request-accounting';
const obj = (v:unknown):Record<string,unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string,unknown> : {};
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const success=(s:MarketExecutionStep)=>s.status==='succeeded'||s.status==='empty';
const terminal=(s:MarketExecutionStep)=>success(s)||s.status==='failed';
function invalid():never {throw new TypeError('Keyword reconciliation flow lineage differs');}
const same=(a:unknown,b:unknown)=>{if(digest(a)!==digest(b))invalid();};
export type MarketKeywordReconciliationRoundFrontier = {stepId:string;attemptId:string|null;status:MarketExecutionStep['status'];inputHash:string};
export type MarketKeywordReconciliationFlowInspection = {children:MarketStepDefinition[];currentStepKeys:string[];status?:'ready'|'partial'|'waiting-initial-models';resultHash?:string|null;pageAttemptId?:string;evaluationAttemptId?:string};
/** Pure scheduler: native handlers independently audit saved snapshot contents. */
export function inspectMarketKeywordReconciliationFlow(view:MarketModuleRunView, initialAnchor:MarketKeywordReconciliationAnchor, current:Set<string>):MarketKeywordReconciliationFlowInspection {
  const anchor=MarketKeywordReconciliationAnchorSchema.parse(initialAnchor);
  const result=(children:MarketStepDefinition[]=[],extra:Partial<MarketKeywordReconciliationFlowInspection>={})=>({children,currentStepKeys:[...current],...extra});
  const attempt=(s:MarketExecutionStep)=>{const matches=view.attempts.filter(a=>a.id===s.latestAttemptId&&a.stepId===s.id);
    if(matches.length!==1||!(matches[0].status===s.status||matches[0].status==='interrupted'&&s.status==='failed'))invalid();return matches[0];};
  const find=(d:MarketStepDefinition,required=false)=>{current.add(d.stepKey);const found=view.steps.filter(s=>s.stepKey===d.stepKey);
    if(found.length>1||required&&!found.length)invalid();const s=found[0];if(s){same({stepKey:s.stepKey,kind:s.kind,subject:s.subject,input:s.input,inputRefs:s.inputRefs},d);same(s.inputHash,digest(d));if(s.latestAttemptId)attempt(s);else if(s.status!=='queued')invalid();}return s;};
  const priors:string[]=[];
  for(let round=0;round<64;round++){
    let next=marketKeywordReconciliationPageDefinition(anchor,priors),lastPageAttemptId='',planHash:string|undefined,baseHash:string|undefined,initialResultHash:string|undefined,totalWindows=0;
    const frontier:MarketKeywordReconciliationRoundFrontier[]=[],seenWindows=new Set<string>(),seenSteps=new Set<string>();
    const track=(s:MarketExecutionStep)=>{if(seenSteps.has(s.id))invalid();seenSteps.add(s.id);frontier.push({stepId:s.id,attemptId:s.latestAttemptId,status:s.status,inputHash:s.inputHash});};
    let pending=false;
    for(let offset=0;;){
      const s=find(next);if(!s)return result([next]);if(!success(s))return result();
      const a=attempt(s),page=MarketKeywordReconciliationPageOutputSchema.parse(a.output);
      if(page.round!==round||page.offset!==offset||(planHash&&page.planHash!==planHash)||(baseHash&&page.baseHash!==baseHash)||(initialResultHash&&page.initialResultHash!==initialResultHash)||(totalWindows&&page.totalWindows!==totalWindows))invalid();
      planHash=page.planHash;baseHash=page.baseHash;initialResultHash=page.initialResultHash;totalWindows=page.totalWindows;lastPageAttemptId=a.id;
      if(page.status!=='needs-model')return result([],{status:page.status,resultHash:page.resultHash,pageAttemptId:a.id});
      if(offset+page.windows.length>totalWindows||page.nextOffset!==(offset+page.windows.length<totalWindows?offset+page.windows.length:null)||page.nextOffset!==null&&page.windows.length!==MARKET_KEYWORD_RECONCILIATION_PAGE_SIZE)invalid();
      for(const window of page.windows){
        if(seenWindows.has(window.id)||window.preparationStepKey!==`keyword-reconcile-model/${digest({snapshotId:window.inputSnapshotId,selectionRevision:window.selectionRevision})}`)invalid();seenWindows.add(window.id);
        const prep=find(marketKeywordReconciliationPreparationDefinition(window),true)!;track(prep);
        if(!terminal(prep)){pending=true;continue;}const prepared=attempt(prep);if(!success(prep))continue;
        const output=obj(prepared.output);same(output.task,'market-keyword-semantics');same(output.inputSnapshotId,window.inputSnapshotId);
        const batches=z.array(z.object({bindingId:z.string().uuid(),batchKey:z.string().min(1),inputDigest:hash})).max(2000).parse(output.batches);
        if(new Set(batches.map(b=>b.bindingId)).size!==batches.length||new Set(batches.map(b=>b.batchKey)).size!==batches.length)invalid();
        for(const b of batches){const model=find({stepKey:`model/${b.batchKey}`,kind:'model-batch',subject:{task:'market-keyword-semantics'},input:{task:'market-keyword-semantics',bindingId:b.bindingId,inputDigest:b.inputDigest},inputRefs:[{kind:'input',id:window.inputSnapshotId}]},true)!;
          track(model);if(!terminal(model))pending=true;else attempt(model);}
      }
      if(page.nextOffset===null)break;
      offset=page.nextOffset;next=marketKeywordReconciliationPageDefinition(anchor,priors,{offset,planHash,previousPageAttemptId:a.id});
    }
    if(seenWindows.size!==totalWindows)invalid();if(pending)return result();
    frontier.sort((a,b)=>a.stepId.localeCompare(b.stepId));const frontierHash=digest(frontier);
    const input=MarketKeywordReconciliationEvaluationInputSchema.parse({task:'keyword-reconciliation-evaluate',anchor,priorEvaluationAttemptIds:[...priors],lastPageAttemptId,frontierHash});
    const d:MarketStepDefinition={stepKey:`keyword-reconcile-evaluate/${digest(input)}`,kind:'reconcile',subject:{task:input.task},input,
      inputRefs:[...marketKeywordReconciliationAnchorRefs(anchor),...priors.map(id=>({kind:'step-output' as const,id})),{kind:'step-output',id:lastPageAttemptId}]};
    const s=find(d);if(!s)return result([d]);if(!success(s))return result();
    const a=attempt(s),out=obj(a.output);
    if(out.version!==MARKET_KEYWORD_RECONCILIATION_EVALUATION_VERSION||out.completedRound!==round||out.anchorHash!==digest(anchor)||out.frontierHash!==frontierHash||!hash.safeParse(out.planHash).success||!z.string().regex(/^market-input:[a-f0-9]{64}$/).safeParse(out.inputSnapshotId).success)invalid();
    if(out.status==='needs-model'){if(out.resultHash!==null)invalid();priors.push(a.id);continue;}
    if(!['ready','partial'].includes(String(out.status))||!hash.safeParse(out.resultHash).success)invalid();
    return result([],{status:out.status as 'ready'|'partial',resultHash:out.resultHash as string,evaluationAttemptId:a.id,pageAttemptId:lastPageAttemptId});
  }
  throw new TypeError('Keyword reconciliation flow exceeded its finite round bound');
}
