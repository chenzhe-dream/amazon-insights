import type { MarketInputSnapshot } from '../../../shared/market-analysis-contracts';
import { MarketInputRecordSchema } from '../../../shared/market-analysis-contracts';
import type { MarketSourceEvidence } from '../../../shared/market-source-contracts';
import { MarketSemanticRecordSchema, MarketKeywordSemanticsInputSchema, type MarketKeywordSemanticsInput, type MarketKeywordSemanticsOutput, type MarketTextSpanRef } from '../../../shared/market-semantic-contracts';
import { createMarketInputSnapshot } from './snapshot';
import { validateMarketKeywordSemantics } from './semantic-validation';
import { canonicalJsonSha256 as digest } from '../../runtime/model-request-accounting';

export const MARKET_KEYWORD_RECONCILIATION_VERSION='market-keyword-reconciliation/v1';
export const MARKET_KEYWORD_RECONCILIATION_CANDIDATE_WINDOW=4;
export const MARKET_KEYWORD_RECONCILIATION_MEMBER_WINDOW=20;
const dimensions=['W1','W2','W3','W4','cluster'] as const;
export type MarketKeywordReconciliationDimension=typeof dimensions[number];
export type MarketKeywordReconciliationBatch={input:MarketKeywordSemanticsInput;output:MarketKeywordSemanticsOutput};
export type MarketKeywordReconciliationRound={planHash:string;batches:readonly MarketKeywordReconciliationBatch[]};
export type MarketKeywordReconciliationCandidate={candidateId:string;dimension:MarketKeywordReconciliationDimension;label:string;definition:string;origin:{kind:'catalog'|'proposal';snapshotId:string;sourceId:string;batchId:string|null;inputDigest:string|null;outputDigest:string|null};evidence:MarketTextSpanRef[]};
type Observation={round:number;planHash:string;windowId:string;inputSnapshotId:string;batchId:string;inputDigest:string;outputDigest:string;decision:MarketKeywordSemanticsOutput['keywords'][number][MarketKeywordReconciliationDimension]};
type Decision={status:'supported'|'unknown'|'unavailable';candidateIds:string[];reason:string|null;observations:Observation[]};
type Window={id:string;dimension:MarketKeywordReconciliationDimension;candidateIds:string[];memberIds:string[];selectionRevision:string;readonly snapshot:MarketInputSnapshot;materializeSnapshot:()=>MarketInputSnapshot};
type Audit={round:number;planHash:string;batches:{batchId:string;inputSnapshotId:string;inputDigest:string;outputDigest:string}[];missing:{windowId:string;keywordId:string;dimension:MarketKeywordReconciliationDimension}[]};
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
const same=(a:unknown,b:unknown)=>{if(digest(a)!==digest(b))throw new TypeError('Keyword reconciliation lineage differs');};
const freeze=<T>(x:T):T=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const catalogOf=(s:MarketInputSnapshot)=>Object.fromEntries(s.records.map(r=>[r.id,MarketSemanticRecordSchema.parse((r.data as Record<string,unknown>).semantic)]));
function validate(snapshot:MarketInputSnapshot,sources:Record<string,MarketSourceEvidence>,batch:MarketKeywordReconciliationBatch){
  const input=MarketKeywordSemanticsInputSchema.parse(batch.input);
  return validateMarketKeywordSemantics(input,batch.output,{scope:snapshot.scope,inputSnapshot:snapshot,sourceEvidenceByRef:sources,sourceCatalog:catalogOf(snapshot),expectedIds:input.keywords.map(k=>k.keywordId),selectionRevision:input.selectionRevision,batchKey:input.batchKey,inputDigest:input.inputDigest});
}
/** Pure finite tournament: native execution meters and splits these windows. No text-similarity merging or numeric recomputation. */
export function planMarketKeywordReconciliation(options:{snapshot:MarketInputSnapshot;sources:Record<string,MarketSourceEvidence>;initialBatches:readonly MarketKeywordReconciliationBatch[];rounds:readonly MarketKeywordReconciliationRound[]}){
  const original=options.snapshot;
  const snapshot=createMarketInputSnapshot({scope:original.scope,kind:original.kind,sourceVersion:original.sourceVersion,ruleVersion:original.ruleVersion,collectedAt:original.collectedAt,expectedRecordIds:original.expectedRecordIds,records:original.records});
  same(original,snapshot);
  if(snapshot.kind!=='keywords')throw new TypeError('Keyword snapshot required');
  const sourceCatalog=catalogOf(snapshot),expectedIds=[...snapshot.expectedRecordIds].sort(compare);
  let catalog:Omit<MarketKeywordSemanticsInput,'keywords'|'schemaVersion'|'task'|'batchId'|'inputDigest'|'scopeDigest'|'scope'|'contentSnapshotId'|'selectionRevision'|'batchKey'|'dataCutoffAt'|'sourceRefs'>|null=null;
  for(const [id,record] of Object.entries(sourceCatalog)){
    if(record.task!=='market-keyword-semantics'||record.keyword.keywordId!==id||record.reconciliationDimension)throw new TypeError('Original keyword semantic pool required');
    const {task:_task,keyword:_keyword,...current}=record;
    if(catalog)same(catalog,current);else catalog=current;
  }
  const candidateMap=new Map<string,MarketKeywordReconciliationCandidate>();
  function add(dimension:MarketKeywordReconciliationDimension,sourceId:string,label:string,definition:string,batch:MarketKeywordReconciliationBatch|null,evidence:MarketTextSpanRef[]){
    const origin={kind:batch?'proposal' as const:'catalog' as const,snapshotId:snapshot.snapshotId,sourceId,batchId:batch?.input.batchId??null,inputDigest:batch?.input.inputDigest??null,outputDigest:batch?digest(batch.output):null};
    const candidateId=`keyword-candidate:${digest({dimension,origin})}`;
    if(candidateMap.has(candidateId))throw new TypeError('Duplicate candidate identity');
    candidateMap.set(candidateId,{candidateId,dimension,label,definition,origin,evidence});
  }
  if(catalog){for(const d of dimensions){const entries=d==='cluster'?catalog.clusterCatalog:catalog.dimensionLabels[d];const ids=new Set<string>();for(const c of entries){const id='clusterId' in c?c.clusterId:c.labelId;if(ids.has(id))throw new TypeError('Duplicate original catalog identity');ids.add(id);add(d,id,c.label,c.definition,null,[]);}}}
  const initialSeen=new Set<string>(),initialBatchIds=new Set<string>(),initialAudit:{batchId:string;inputDigest:string;outputDigest:string}[]=[];
  for(const batch of options.initialBatches){
    if(initialBatchIds.has(batch.input.batchId))throw new TypeError('Duplicate initial batch');initialBatchIds.add(batch.input.batchId);
    const output=validate(snapshot,options.sources,batch);
    for(const k of output.keywords){if(initialSeen.has(k.keywordId))throw new TypeError('Overlapping initial members');initialSeen.add(k.keywordId);}
    initialAudit.push({batchId:batch.input.batchId,inputDigest:batch.input.inputDigest,outputDigest:digest(output)});
    for(const proposal of output.labelProposals??[]){if(output.keywords.some(k=>{const d=k[proposal.dimension];return d.status==='supported'&&d.labelIds.includes(proposal.labelId);}))add(proposal.dimension,proposal.labelId,proposal.label,proposal.definition,batch,proposal.evidence);}
    for(const proposal of output.proposals){if(output.keywords.some(k=>k.cluster.status==='proposed'&&k.cluster.proposalId===proposal.proposalId))add('cluster',proposal.proposalId,proposal.labelZh,proposal.definition,batch,proposal.evidence);}
  }
  initialAudit.sort((a,b)=>compare(a.batchId,b.batchId));
  const candidates=[...candidateMap.values()].sort((a,b)=>compare(a.candidateId,b.candidateId));
  const initialResultHash=digest({snapshotId:snapshot.snapshotId,initialAudit});
  const baseHash=digest({version:MARKET_KEYWORD_RECONCILIATION_VERSION,snapshotId:snapshot.snapshotId,sources:options.sources,candidates,initialResultHash});
  const history:Audit[]=[],decisions=new Map<string,Decision>(),observations=new Map<string,Observation[]>();
  const key=(id:string,d:MarketKeywordReconciliationDimension)=>JSON.stringify([id,d]);
  let active=new Map<string,{keywordId:string;dimension:MarketKeywordReconciliationDimension;candidateIds:string[]}>();
  let maxRounds=0;
  for(const d of dimensions){let n=candidates.filter(c=>c.dimension===d).length,rounds=0;while(n){rounds++;if(n<=4)break;n=Math.floor(n/4)*(d==='cluster'?1:3)+Math.min(n%4,d==='cluster'?1:3);}maxRounds=Math.max(maxRounds,rounds);}
  const resultFor=(status:'waiting-initial-models'|'needs-model'|'ready'|'partial',round:number,windows:Window[],planHash:string,result:ReturnType<typeof finish>|null)=>freeze({version:MARKET_KEYWORD_RECONCILIATION_VERSION,baseHash,initialResultHash,status,round,maxRounds,candidates,expectedMemberIds:expectedIds,windows,planHash,history,result});
  function finish(){
    const rows=expectedIds.map(keywordId=>({keywordId,...Object.fromEntries(dimensions.map(d=>[d,decisions.get(key(keywordId,d))!]))})) as ({keywordId:string}&Record<MarketKeywordReconciliationDimension,Decision>)[];
    const memberDimensions=(status:Decision['status'])=>rows.flatMap(r=>dimensions.filter(d=>r[d].status===status).map(d=>({keywordId:r.keywordId,dimension:d})));
    const used=new Set(rows.flatMap(r=>dimensions.flatMap(d=>r[d].candidateIds)));
    const out={version:MARKET_KEYWORD_RECONCILIATION_VERSION,baseHash,initialResultHash,inputSnapshotId:snapshot.snapshotId,decisions:rows,usedCatalog:candidates.filter(c=>used.has(c.candidateId)),unknownMemberDimensions:memberDimensions('unknown'),unavailableMemberDimensions:memberDimensions('unavailable'),evidenceAudit:history};
    return {...out,resultHash:digest(out)};
  }
  if(expectedIds.some(id=>!initialSeen.has(id))){if(options.rounds.length)throw new TypeError('Initial keyword results incomplete');return resultFor('waiting-initial-models',0,[],digest({baseHash,waiting:true}),null);}
  for(const keywordId of expectedIds)for(const dimension of dimensions){const candidateIds=candidates.filter(c=>c.dimension===dimension).map(c=>c.candidateId);if(candidateIds.length)active.set(key(keywordId,dimension),{keywordId,dimension,candidateIds});else decisions.set(key(keywordId,dimension),{status:'unknown',candidateIds:[],reason:'no-candidates',observations:[]});}
  function windowsFor(round:number){
    const groups=new Map<string,{dimension:MarketKeywordReconciliationDimension;candidateIds:string[];memberIds:string[]}>();
    for(const cell of active.values()){const k=digest({dimension:cell.dimension,candidateIds:cell.candidateIds}),group=groups.get(k)??{dimension:cell.dimension,candidateIds:cell.candidateIds,memberIds:[]};group.memberIds.push(cell.keywordId);groups.set(k,group);}
    const windows:Window[]=[];
    for(const [groupId,group] of [...groups].sort(([a],[b])=>compare(a,b)))for(let m=0;m<group.memberIds.length;m+=20)for(let c=0;c<group.candidateIds.length;c+=4){
      const memberIds=group.memberIds.slice(m,m+20).sort(compare),candidateIds=group.candidateIds.slice(c,c+4),dimension=group.dimension;
      const hash=digest({baseHash,round,history,groupId,memberIds,candidateIds}),id=`keyword-window:${hash}`,selectionRevision=`keyword-selection:${hash}`;
      const materializeSnapshot=()=>{
      const selected=candidateIds.map(id=>candidateMap.get(id)!);
      const dimensionLabels={W1:[],W2:[],W3:[],W4:[]} as MarketKeywordSemanticsInput['dimensionLabels'];
      if(dimension!=='cluster')dimensionLabels[dimension]=selected.map(c=>({labelId:c.candidateId,label:c.label,definition:c.definition}));
      const clusterCatalog=dimension==='cluster'?selected.map(c=>({clusterId:c.candidateId,label:c.label,definition:c.definition})):[];
      const records=snapshot.records.filter(r=>memberIds.includes(r.id)).map(r=>{const old=sourceCatalog[r.id];if(old.task!=='market-keyword-semantics')throw new TypeError('Keyword required');const {discoveryMode:_mode,...original}=old;return {...r,data:MarketInputRecordSchema.shape.data.parse({...r.data as Record<string,unknown>,semantic:{...original,dictionaryVersion:`keyword-reconcile:${hash}`,dimensionLabels,clusterCatalog,reconciliationDimension:dimension}})};});
      const windowSnapshot=createMarketInputSnapshot({scope:snapshot.scope,kind:'keywords',sourceVersion:snapshot.sourceVersion,ruleVersion:`${MARKET_KEYWORD_RECONCILIATION_VERSION}:${hash}`,collectedAt:snapshot.collectedAt,expectedRecordIds:memberIds,records});
      return windowSnapshot;
      };
      // Non-enumerable compatibility accessor deliberately does not cache. Native
      // callers materialize only their admitted page; freezing/hashing a plan
      // never allocates all source snapshots.
      const window={id,dimension,candidateIds,memberIds,selectionRevision,materializeSnapshot} as Window;
      Object.defineProperty(window,'snapshot',{get:materializeSnapshot,enumerable:false});
      windows.push(window);
    }
    return windows;
  }
  for(let round=0;;round++){
    if(!active.size){if(options.rounds.length!==round)throw new TypeError('Unexpected reconciliation history');const result=finish();return resultFor(result.unknownMemberDimensions.length||result.unavailableMemberDimensions.length?'partial':'ready',round,[],digest({baseHash,history,terminal:true}),result);}
    if(round>=maxRounds)throw new TypeError('Keyword tournament failed to reduce');
    const windows=windowsFor(round),planHash=digest({baseHash,round,history,windows:windows.map(w=>({id:w.id,dimension:w.dimension,candidateIds:w.candidateIds,memberIds:w.memberIds,selectionRevision:w.selectionRevision}))});
    const receipt=options.rounds[round];if(!receipt)return resultFor('needs-model',round,windows,planHash,null);same(receipt.planHash,planHash);
    const cells=new Map<string,Observation>(),batchIds=new Set<string>(),audit:Audit={round,planHash,batches:[],missing:[]};
    for(const batch of receipt.batches){
      const window=windows.find(w=>w.id===batch.input.dictionaryVersion.replace('keyword-reconcile:','keyword-window:'));if(!window)throw new TypeError('Outside planned keyword window');
      same(batch.input.selectionRevision,window.selectionRevision);
      if(batchIds.has(batch.input.batchId))throw new TypeError('Duplicate reconciliation batch');batchIds.add(batch.input.batchId);
      const windowSnapshot=window.materializeSnapshot();
      const output=validate(windowSnapshot,options.sources,batch),outputDigest=digest(output);
      audit.batches.push({batchId:batch.input.batchId,inputSnapshotId:windowSnapshot.snapshotId,inputDigest:batch.input.inputDigest,outputDigest});
      for(const k of output.keywords){const cellKey=JSON.stringify([window.id,k.keywordId]);if(cells.has(cellKey))throw new TypeError('Duplicate keyword window output');cells.set(cellKey,{round,planHash,windowId:window.id,inputSnapshotId:windowSnapshot.snapshotId,batchId:batch.input.batchId,inputDigest:batch.input.inputDigest,outputDigest,decision:k[window.dimension]});}
    }
    const next:typeof active=new Map();
    for(const [cellKey,cell] of active){
      const related=windows.filter(w=>w.dimension===cell.dimension&&w.memberIds.includes(cell.keywordId)),matched=new Set<string>(),all=[...(observations.get(cellKey)??[])];let missing=false,uncertain:string|null=null;
      for(const window of related){const observation=cells.get(JSON.stringify([window.id,cell.keywordId]));if(!observation){missing=true;audit.missing.push({windowId:window.id,keywordId:cell.keywordId,dimension:cell.dimension});continue;}all.push(observation);const decision=observation.decision;if(decision.status==='unknown'){if(decision.reason!=='outside-taxonomy')uncertain??=decision.reason;}else if(decision.status==='supported')decision.labelIds.forEach(id=>matched.add(id));else if(decision.status==='existing')matched.add(decision.clusterId);else throw new TypeError('Reconciliation cannot propose');}
      observations.set(cellKey,all);
      const save=(status:Decision['status'],candidateIds:string[],reason:string|null)=>decisions.set(cellKey,{status,candidateIds,reason,observations:all});
      if(missing)save('unavailable',[],'model-result-unavailable');else if(uncertain)save('unknown',[],uncertain);else if(!matched.size)save('unknown',[],'outside-taxonomy');
      // Finality requires a common window, including when separate windows collectively select <=3.
      else if(related.length===1)save('supported',[...matched].sort(compare),null);
      else next.set(cellKey,{...cell,candidateIds:[...matched].sort(compare)});
    }
    audit.batches.sort((a,b)=>compare(a.batchId,b.batchId));audit.missing.sort((a,b)=>compare(JSON.stringify(a),JSON.stringify(b)));history.push(audit);active=next;
  }
}
