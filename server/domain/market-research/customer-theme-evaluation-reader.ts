import { z } from 'zod';
import type { MarketInputSnapshot } from '../../../shared/market-analysis-contracts';
import { MarketThemeDecisionSchema, MarketThemeLabelSchema } from '../../../shared/market-theme-detail-contracts';
import { MARKET_THEME_EVALUATION_VERSION, MarketThemeEvaluationInputSchema } from './customer-theme-reconciliation-artifact';
import { MARKET_THEME_RECONCILIATION_VERSION } from './customer-theme-reconciliation';
import { createMarketInputSnapshot } from './snapshot';
import { restoreMarketThemeAggregate } from './customer-theme-aggregate-reader';
import type { CustomerThemesAsinSummary } from './customer-themes';
import { canonicalJsonSha256 as digest } from '../../runtime/model-request-accounting';
const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
function invalid():never{throw new TypeError('Theme evaluation differs from its saved round evidence');}
const same=(a:unknown,b:unknown)=>{if(digest(a)!==digest(b))invalid();};
const hash=z.string().regex(/^[a-f0-9]{64}$/),snapshotId=z.string().regex(/^market-input:[a-f0-9]{64}$/);
const modelDecisionSchema=MarketThemeDecisionSchema.extend({round:z.number().int().min(0).max(7).nullable(),inputDigest:hash.nullable(),outputDigest:hash.nullable()}).strict();
const batchSchema=z.object({batchId:z.string().uuid(),inputSnapshotId:snapshotId,inputDigest:hash,outputDigest:hash}).strict();
const auditSchema=z.object({agentRunId:z.string().uuid(),attemptId:z.string().uuid(),bindingId:z.string().uuid(),executionFingerprint:hash}).strict();
const summarySchema=z.object({version:z.literal(MARKET_THEME_EVALUATION_VERSION),input:MarketThemeEvaluationInputSchema,frontierHash:hash,
  completedRound:z.number().int().min(0).max(7),beforePlanHash:hash,afterPlanHash:hash,status:z.enum(['needs-model','ready','partial']),
  initialResultHash:hash,baseHash:hash,nextWindowCount:z.number().int().nonnegative(),result:z.unknown(),aggregation:z.unknown()}).strict();

function records(snapshot:MarketInputSnapshot){
  same(snapshot,createMarketInputSnapshot({scope:snapshot.scope,kind:snapshot.kind,sourceVersion:snapshot.sourceVersion,ruleVersion:snapshot.ruleVersion,
    collectedAt:snapshot.collectedAt,expectedRecordIds:snapshot.expectedRecordIds,records:snapshot.records}));
  if(snapshot.kind!=='customer-themes'||snapshot.ruleVersion!==MARKET_THEME_EVALUATION_VERSION||snapshot.coverage.status!=='complete')invalid();
  const permitted=new Set(['summary']),summary=summarySchema.parse(snapshot.records.find(r=>r.id==='summary')?.data);
  function chunks(kind:string,size=128){
    const rows=snapshot.records.filter(r=>r.id.startsWith(`${kind}:`)).sort((a,b)=>Number(a.id.slice(kind.length+1))-Number(b.id.slice(kind.length+1)));
    return rows.flatMap((r,i)=>{same(r.id,`${kind}:${i}`);same(obj(r.data).kind,kind);const items=z.array(z.unknown()).min(1).max(size).parse(obj(r.data).items);
      if(i<rows.length-1&&items.length!==size)invalid();permitted.add(r.id);return items;});
  }
  return {summary,chunks,permitted,done:()=>{if(snapshot.records.some(r=>!permitted.has(r.id)))invalid();}};
}

/** Historical read: accepts fixed evaluation snapshots, never consults latest
 * model attempts. Runtime callers authenticate their ordered attempt references.
 * Each final result hash includes every prior round and the complete T5 result. */
export function restoreMarketThemeEvaluation(snapshot:MarketInputSnapshot,priorSnapshots:readonly MarketInputSnapshot[]=[]){
  if(priorSnapshots.length>7)invalid();
  const chain=[...priorSnapshots,snapshot],rounds=[];let previous:ReturnType<typeof summarySchema.parse>|undefined;
  let final:ReturnType<typeof records>|undefined;
  const evidence=[];
  for(const [index,saved] of chain.entries()){
    same(saved.scope,snapshot.scope);same(saved.sourceVersion,snapshot.sourceVersion);same(saved.collectedAt,snapshot.collectedAt);
    const r=records(saved),s=r.summary;
    if(s.completedRound!==index||(s.input.priorEvaluationAttemptIds??[]).length!==index)invalid();
    if(previous){same(s.beforePlanHash,previous.afterPlanHash);same(s.baseHash,previous.baseHash);same(s.initialResultHash,previous.initialResultHash);same(s.input.initialRulesAttemptId,previous.input.initialRulesAttemptId);}
    const frontier=z.array(z.object({stepId:z.string().uuid(),attemptId:z.string().uuid().nullable(),status:z.enum(['succeeded','empty','failed']),inputHash:hash}).strict()).parse(r.chunks('frontier'));
    if(new Set(frontier.map(f=>f.stepId)).size!==frontier.length)invalid();same(digest(frontier),s.frontierHash);same(s.input.frontierHash,s.frontierHash);
    const batches=z.array(batchSchema).parse(r.chunks('batches')),missing=z.array(z.object({windowId:z.string(),sourceThemeId:z.string()}).strict()).parse(r.chunks('missing'));
    if(new Set(batches.map(b=>b.batchId)).size!==batches.length)invalid();
    const audits=z.array(auditSchema).parse(r.chunks('audits'));if(new Set(audits.map(a=>a.bindingId)).size!==audits.length)invalid();
    rounds.push({round:index,planHash:s.beforePlanHash,batches,missing});evidence.push({round:index,batches,audits});
    if(index<chain.length-1){if(s.status!=='needs-model'||s.nextWindowCount===0||s.result!==null||s.aggregation!==null)invalid();r.done();}
    else{if(!['ready','partial'].includes(s.status)||s.nextWindowCount!==0)invalid();final=r;}
    previous=s;
  }
  if(!final)invalid();const s=final.summary,metadata=obj(s.result),savedAggregate=obj(s.aggregation);
  same(metadata.version,MARKET_THEME_RECONCILIATION_VERSION);same(metadata.baseHash,s.baseHash);same(metadata.initialResultHash,s.initialResultHash);
  const selection=z.array(z.string().regex(/^[A-Z0-9]{10}$/)).max(20).parse(obj(savedAggregate.scope).selectedAsins);
  const perAsin=selection.map(asin=>{final!.permitted.add(`asin:${asin}`);return snapshot.records.find(r=>r.id===`asin:${asin}`)?.data as unknown as CustomerThemesAsinSummary;});
  const mappings=z.array(z.object({sourceThemeId:z.string(),groupId:z.string()}).strict()).parse(final.chunks('mappings'));
  const labels=z.array(MarketThemeLabelSchema).parse(final.chunks('labels')),modelDecisions=z.array(modelDecisionSchema).parse(final.chunks('decisions'));
  const aggregation=restoreMarketThemeAggregate(savedAggregate,perAsin,final.chunks('groups',32),mappings);final.done();
  const members=aggregation.perAsin.flatMap(a=>a.themes).map(t=>t.sourceThemeId).sort();same(modelDecisions.map(d=>d.sourceThemeId).sort(),members);
  same(metadata.unknownMemberIds,modelDecisions.filter(d=>d.status==='unknown').map(d=>d.sourceThemeId).sort());
  same(metadata.unavailableMemberIds,modelDecisions.filter(d=>d.status==='unavailable').map(d=>d.sourceThemeId).sort());
  same(modelDecisions.filter(d=>d.status==='mapped').map(d=>({sourceThemeId:d.sourceThemeId,groupId:d.groupId})).sort((a,b)=>a.sourceThemeId.localeCompare(b.sourceThemeId)),[...mappings].sort((a,b)=>a.sourceThemeId.localeCompare(b.sourceThemeId)));
  same(labels.map(l=>l.groupId).sort(),[...new Set(mappings.map(m=>m.groupId))].sort());
  for(const d of modelDecisions){
    if(d.status!=='mapped'&&d.groupId!==null)invalid();
    if(d.batchId===null){if(d.status==='mapped'||d.inputDigest!==null||d.outputDigest!==null)invalid();}
    else{if(d.round===null||d.status==='unavailable')invalid();const b=rounds[d.round]?.batches.find(b=>b.batchId===d.batchId);if(!b)invalid();same(d.inputDigest,b.inputDigest);same(d.outputDigest,b.outputDigest);}
  }
  const result={...metadata,resultHash:hash.parse(metadata.resultHash),aggregation,decisions:modelDecisions,groups:labels,rounds};
  const {resultHash,...body}=result;same(hash.parse(resultHash),digest(body));
  same(s.status,modelDecisions.some(d=>d.status!=='mapped')?'partial':'ready');
  const decisions=modelDecisions.map(({round:_round,inputDigest:_input,outputDigest:_output,...d})=>MarketThemeDecisionSchema.parse(d));
  return {result:{...result,resultHash:hash.parse(resultHash)},aggregation,labels,decisions,modelDecisions,evidence,summary:s};
}
