import { z } from 'zod';
import type { MarketModuleRunView, MarketExecutionStep, MarketStepDefinition } from '../../db/market-module-execution-repository';
import { MARKET_THEME_RECONCILIATION_PAGE_VERSION, MARKET_THEME_RECONCILIATION_PAGE_SIZE, marketThemeReconciliationPageDefinition } from './customer-theme-reconciliation-pages';
import { MARKET_THEME_EVALUATION_VERSION, type MarketThemeRoundFrontier } from './customer-theme-reconciliation-artifact';
import { canonicalJsonSha256 as digest } from '../../runtime/model-request-accounting';

const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const hash=z.string().regex(/^[a-f0-9]{64}$/),inputId=z.string().regex(/^market-input:[a-f0-9]{64}$/);
const pageSchema=z.object({version:z.literal(MARKET_THEME_RECONCILIATION_PAGE_VERSION),planHash:hash,baseHash:hash,initialResultHash:hash,
  round:z.number().int().nonnegative().max(7),offset:z.number().int().nonnegative(),nextOffset:z.number().int().positive().nullable(),totalWindows:z.number().int().positive(),
  windows:z.array(z.object({id:z.string(),inputSnapshotId:inputId,selectionRevision:z.string(),memberIds:z.array(z.string()).min(1).max(12),
    candidateIds:z.array(z.string()).min(1).max(32),preparationStepKey:z.string()}).strict()).min(1).max(MARKET_THEME_RECONCILIATION_PAGE_SIZE)}).strict();
const success=(s:MarketExecutionStep)=>s.status==='succeeded'||s.status==='empty';
const terminal=(s:MarketExecutionStep)=>success(s)||s.status==='failed';
function invalid():never{throw new TypeError('Theme reconciliation flow lineage differs');}
const same=(a:unknown,b:unknown)=>{if(digest(a)!==digest(b))invalid();};

/** Pure scheduling under the existing run lock. Audits and snapshot contents are
 * revalidated by the native page/evaluation handlers, never by the browser. */
export function inspectMarketThemeReconciliationFlow(view:MarketModuleRunView,initialRulesAttemptId:string,current:Set<string>){
  const result=(children:MarketStepDefinition[]=[])=>({children,currentStepKeys:[...current]});
  const one=(found:MarketExecutionStep[])=>{if(found.length!==1)invalid();return found[0];};
  const attempt=(s:MarketExecutionStep)=>{const a=view.attempts.find(a=>a.id===s.latestAttemptId&&a.stepId===s.id);
    if(!a||!(a.status===s.status||(a.status==='interrupted'&&s.status==='failed')))invalid();return a;};
  const definition=(s:MarketExecutionStep)=>({stepKey:s.stepKey,kind:s.kind,subject:s.subject,input:s.input,inputRefs:s.inputRefs});
  const priors:string[]=[];
  for(let round=0;round<8;round++){
    let next=marketThemeReconciliationPageDefinition(initialRulesAttemptId,priors),lastPageAttemptId='',planHash:string|undefined,totalWindows=0;
    const frontier:MarketThemeRoundFrontier[]=[],seenWindows=new Set<string>(),seenSteps=new Set<string>();
    const track=(s:MarketExecutionStep)=>{if(seenSteps.has(s.id))invalid();seenSteps.add(s.id);current.add(s.stepKey);
      frontier.push({stepId:s.id,attemptId:s.latestAttemptId,status:s.status,inputHash:s.inputHash});};
    let pending=false;
    for(let offset=0;;){
      current.add(next.stepKey);const step=view.steps.find(s=>s.stepKey===next.stepKey);
      if(!step)return result([next]);same(definition(step),next);if(!success(step))return result();
      const a=attempt(step),page=pageSchema.parse(a.output);
      if(page.round!==round||page.offset!==offset||(planHash&&page.planHash!==planHash)||(totalWindows&&page.totalWindows!==totalWindows))invalid();
      planHash=page.planHash;totalWindows=page.totalWindows;lastPageAttemptId=a.id;
      if(offset+page.windows.length>totalWindows||page.nextOffset!==(offset+page.windows.length<totalWindows?offset+page.windows.length:null))invalid();
      if(page.nextOffset!==null&&page.windows.length!==MARKET_THEME_RECONCILIATION_PAGE_SIZE)invalid();
      for(const window of page.windows){
        if(seenWindows.has(window.id))invalid();seenWindows.add(window.id);
        const prep=one(view.steps.filter(s=>s.stepKey===window.preparationStepKey));
        if(prep.kind!=='prepare-model-batches'||obj(prep.input).inputSnapshotId!==window.inputSnapshotId||obj(prep.input).selectionRevision!==window.selectionRevision)invalid();
        track(prep);if(!terminal(prep)){pending=true;continue;}
        const prepared=attempt(prep);if(!success(prep))continue;
        const batches=z.array(z.object({bindingId:z.string().uuid(),inputDigest:hash})).max(2000).parse(obj(prepared.output).batches);
        for(const b of batches){const model=one(view.steps.filter(s=>s.kind==='model-batch'&&obj(s.input).bindingId===b.bindingId&&obj(s.input).inputDigest===b.inputDigest));
          track(model);if(!terminal(model))pending=true;else attempt(model);}
      }
      if(page.nextOffset===null)break;
      offset=page.nextOffset;next=marketThemeReconciliationPageDefinition(initialRulesAttemptId,priors,{offset,planHash,previousPageAttemptId:a.id});
    }
    if(seenWindows.size!==totalWindows)invalid();if(pending)return result();
    frontier.sort((a,b)=>a.stepId.localeCompare(b.stepId));const frontierHash=digest(frontier);
    const input={task:'customer-theme-reconciliation-evaluate',initialRulesAttemptId,priorEvaluationAttemptIds:[...priors],lastPageAttemptId,frontierHash};
    const evaluation:MarketStepDefinition={stepKey:`theme-reconcile-evaluate/${digest(input)}`,kind:'reconcile',subject:{task:input.task},input,
      inputRefs:[{kind:'step-output',id:initialRulesAttemptId},{kind:'step-output',id:lastPageAttemptId},...priors.map(id=>({kind:'step-output' as const,id}))]};
    current.add(evaluation.stepKey);const step=view.steps.find(s=>s.stepKey===evaluation.stepKey);
    if(!step)return result([evaluation]);same(definition(step),evaluation);if(!success(step))return result();
    const evaluated=attempt(step),out=obj(evaluated.output);
    if(out.version!==MARKET_THEME_EVALUATION_VERSION||out.completedRound!==round||out.initialRulesAttemptId!==initialRulesAttemptId||out.frontierHash!==frontierHash)invalid();
    if(out.status==='needs-model'){priors.push(evaluated.id);continue;}
    if(!['ready','partial'].includes(String(out.status))||!hash.safeParse(out.resultHash).success)invalid();
    const report:MarketStepDefinition={stepKey:`theme-flow/reconciled-report:${digest({evaluationAttemptId:evaluated.id})}`,kind:'report',subject:{flow:z.string().parse(obj(view.run.params).flow)},
      input:{task:'customer-theme-report',basis:'reconciliation-evaluation',evaluationAttemptId:evaluated.id,inputSnapshotId:inputId.parse(out.inputSnapshotId)},
      inputRefs:[{kind:'step-output',id:evaluated.id},{kind:'input',id:inputId.parse(out.inputSnapshotId)}]};
    current.add(report.stepKey);const saved=view.steps.find(s=>s.stepKey===report.stepKey);
    if(saved)same(definition(saved),report);return result(saved?[]:[report]);
  }
  throw new TypeError('Theme reconciliation flow exceeded its finite round bound');
}
