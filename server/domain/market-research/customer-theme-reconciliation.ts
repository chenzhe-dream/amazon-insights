import { MarketInputRecordSchema, type MarketInputSnapshot } from '../../../shared/market-analysis-contracts';
import { MarketCustomerThemeMappingInputSchema, MarketSemanticRecordSchema } from '../../../shared/market-semantic-contracts';
import { calculateMarketThemeMappingRules } from './customer-theme-mapping-rules';
import { assembleMarketThemePool, MarketThemePoolCatalogSchema } from './customer-theme-source-pool';
import { aggregateCustomerThemes, type CustomerThemesAsinInput } from './customer-themes';
import { createMarketInputSnapshot } from './snapshot';
import { validateMarketCustomerThemeMapping } from './semantic-validation';
import { canonicalJsonSha256 as digest } from '../../runtime/model-request-accounting';

export const MARKET_THEME_RECONCILIATION_VERSION='market-theme-reconciliation/v2';
// A schema-valid 32-item catalogue can exhaust the native 12k request budget
// before even one source theme fits. Smaller windows retain all candidates;
// the native meter still sizes members and may reject oversized individual text.
export const MARKET_THEME_RECONCILIATION_CANDIDATE_WINDOW=8;
type Initial=Parameters<typeof calculateMarketThemeMappingRules>[0];
type Batch=Initial['batches'][number];
export type MarketThemeReconciliationRound={planHash:string;batches:readonly Batch[]};
type Candidate=ReturnType<typeof calculateMarketThemeMappingRules>['groups'][number];
type Decision={sourceThemeId:string;status:'mapped'|'unknown'|'unavailable';groupId:string|null;reason:string|null;round:number|null;batchId:string|null;inputDigest:string|null;outputDigest:string|null};
type Window={id:string;candidateIds:string[];memberIds:string[];selectionRevision:string;snapshot:MarketInputSnapshot};
type Audit={round:number;planHash:string;batches:{batchId:string;inputSnapshotId:string;inputDigest:string;outputDigest:string}[];missing:{windowId:string;sourceThemeId:string}[]};
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
const same=(a:unknown,b:unknown)=>{if(digest(a)!==digest(b))throw new TypeError('Theme reconciliation lineage differs');};
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};

/** Pure, finite candidate tournament. Existing A4 input/output validators and
 * source spans apply to every window. Persistence, budget admission and execution
 * remain the native runtime's responsibility; this function never calls a model. */
export function planMarketThemeReconciliation(options:Initial&{rounds:readonly MarketThemeReconciliationRound[]}) {
  const initial=calculateMarketThemeMappingRules({poolInput:options.poolInput,batches:options.batches});
  const pool=assembleMarketThemePool(options.poolInput),semantic=pool.semanticSnapshot;
  const candidateMap=new Map<string,Candidate>(MarketThemePoolCatalogSchema.parse(options.poolInput.catalog).groupCatalog.map(c=>[c.groupId,{...c,origin:'catalog',batchId:null,proposalId:null}]));
  for(const group of initial.groups){const previous=candidateMap.get(group.groupId);if(previous)same(previous,group);candidateMap.set(group.groupId,group);}
  const candidates=[...candidateMap.values()].sort((a,b)=>compare(a.groupId,b.groupId));
  const basis={version:MARKET_THEME_RECONCILIATION_VERSION,initialResultHash:initial.resultHash,sourceSnapshotId:semantic.snapshotId,candidates};
  const baseHash=digest(basis),expectedIds=[...semantic.expectedRecordIds].sort(compare);
  let maxRounds=0,size=candidates.length;while(size>0){maxRounds++;if(size<=MARKET_THEME_RECONCILIATION_CANDIDATE_WINDOW)break;size=Math.ceil(size/MARKET_THEME_RECONCILIATION_CANDIDATE_WINDOW);}
  const history:Audit[]=[],decisions=new Map<string,Decision>();
  const resultFor=(status:'needs-model'|'waiting-initial-models'|'ready'|'partial',round:number,windows:Window[],planHash:string,result:ReturnType<typeof finish>|null)=>
    freeze({version:MARKET_THEME_RECONCILIATION_VERSION,baseHash,initialResultHash:initial.resultHash,status,round,maxRounds,candidates,expectedMemberIds:expectedIds,windows,planHash,history,result});
  function finish(){
    const rows=[...decisions.values()].sort((a,b)=>compare(a.sourceThemeId,b.sourceThemeId));same(rows.map(r=>r.sourceThemeId),expectedIds);
    const mappings=rows.flatMap(r=>r.status==='mapped'?[{sourceThemeId:r.sourceThemeId,groupId:r.groupId!}]:[]);
    const aggregation=aggregateCustomerThemes({selectedAsins:pool.manifest.selectedAsins,results:pool.rawSnapshot.records.map(r=>(r.data as {result:CustomerThemesAsinInput}).result),mappings,topN:options.topN});
    same(aggregation.totals,initial.aggregation.totals);same(aggregation.coverage,initial.aggregation.coverage);
    const used=new Set(mappings.map(m=>m.groupId)),output={version:MARKET_THEME_RECONCILIATION_VERSION,baseHash,initialResultHash:initial.resultHash,
      rawInputSnapshotId:pool.rawSnapshot.snapshotId,semanticInputSnapshotId:semantic.snapshotId,decisions:rows,groups:candidates.filter(c=>used.has(c.groupId)),aggregation,rounds:history,
      unknownMemberIds:rows.filter(r=>r.status==='unknown').map(r=>r.sourceThemeId),unavailableMemberIds:rows.filter(r=>r.status==='unavailable').map(r=>r.sourceThemeId)};
    return {...output,resultHash:digest(output)};
  }
  if(initial.semantics.unavailableMemberIds.length){if(options.rounds.length)throw new TypeError('Initial theme model results are incomplete');return resultFor('waiting-initial-models',0,[],digest({...basis,waiting:true}),null);}
  let active=new Map(expectedIds.map(id=>[id,candidates.map(c=>c.groupId)]));
  if(!candidates.length){for(const id of expectedIds)decisions.set(id,{sourceThemeId:id,status:'unknown',groupId:null,reason:'no-candidates',round:null,batchId:null,inputDigest:null,outputDigest:null});active.clear();}
  function makeWindows(round:number){
    const previousRoundsHash=digest(history);
    const grouped=new Map<string,{candidateIds:string[];memberIds:string[]}>();
    for(const [id,ids] of active){const key=digest(ids),group=grouped.get(key)??{candidateIds:ids,memberIds:[]};group.memberIds.push(id);grouped.set(key,group);}
    const windows:Window[]=[];
    for(const group of [...grouped.values()].sort((a,b)=>compare(digest(a.candidateIds),digest(b.candidateIds)))){
      const allMembers=group.memberIds.sort(compare);
      // Bound both catalogue and member dimensions before constructing T1 JSON.
      // Repeating definitions over an entire large pool exceeds validation's
      // node limit even when each eventual provider batch contains only 12 themes.
      for(let memberStart=0;memberStart<allMembers.length;memberStart+=12){
      const memberIds=allMembers.slice(memberStart,memberStart+12),wanted=new Set(memberIds);
      for(let start=0;start<group.candidateIds.length;start+=MARKET_THEME_RECONCILIATION_CANDIDATE_WINDOW){
        const candidateIds=group.candidateIds.slice(start,start+MARKET_THEME_RECONCILIATION_CANDIDATE_WINDOW),key=digest({baseHash,round,previousRoundsHash,candidateIds,memberIds}),id=`theme-reconciliation-window:${key}`;
        const mappingVersion=`theme-reconciliation:${key}`,groupCatalog=candidateIds.map(id=>{const c=candidateMap.get(id)!;return {groupId:c.groupId,labelZh:c.labelZh,definition:c.definition};});
        const records=semantic.records.filter(r=>wanted.has(r.id)).map(r=>{const data=r.data as Record<string,unknown>,old=MarketSemanticRecordSchema.parse(data.semantic);
          if(old.task!=='market-customer-theme-mapping')throw new TypeError('Theme source required');
          return {...r,data:MarketInputRecordSchema.shape.data.parse({...data,semantic:{...old,mappingVersion,groupCatalog,mappingMode:'catalog-only'}})};});
        const snapshot=createMarketInputSnapshot({scope:semantic.scope,kind:'customer-themes',sourceVersion:semantic.sourceVersion,ruleVersion:`${MARKET_THEME_RECONCILIATION_VERSION}:${key}`,collectedAt:semantic.collectedAt,expectedRecordIds:memberIds,records});
        windows.push({id,candidateIds,memberIds,selectionRevision:`theme-reconciliation-selection:${key}`,snapshot});
      }
      }
    }
    return windows;
  }
  for(let round=0;;round++){
    if(!active.size){if(round!==options.rounds.length)throw new TypeError('Unexpected extra reconciliation round');const result=finish();return resultFor(result.unknownMemberIds.length||result.unavailableMemberIds.length?'partial':'ready',round,[],digest({baseHash,history,terminal:true}),result);}
    if(round>=maxRounds)throw new TypeError('Reconciliation did not reduce its candidate set');
    const windows=makeWindows(round),planHash=digest({baseHash,round,previousRoundsHash:digest(history),windows:windows.map(w=>({id:w.id,snapshotId:w.snapshot.snapshotId,memberIds:w.memberIds,candidateIds:w.candidateIds,selectionRevision:w.selectionRevision}))});
    const receipt=options.rounds[round];if(!receipt)return resultFor('needs-model',round,windows,planHash,null);same(receipt.planHash,planHash);
    const cells=new Map<string,{decision:ReturnType<typeof validateMarketCustomerThemeMapping>['themes'][number]['decision'];batchId:string;inputDigest:string;outputDigest:string}>();
    const audit:Audit={round,planHash,batches:[],missing:[]},batchIds=new Set<string>();
    for(const batch of receipt.batches){
      const input=MarketCustomerThemeMappingInputSchema.parse(batch.input),window=windows.find(w=>w.snapshot.snapshotId===input.contentSnapshotId);if(!window)throw new TypeError('Outside reconciliation window');
      if(batchIds.has(input.batchId))throw new TypeError('Duplicate reconciliation batch');batchIds.add(input.batchId);
      same(input.selectionRevision,window.selectionRevision);same(batch.binding.inputSnapshot,window.snapshot);same(input.selectedAsins,pool.manifest.selectedAsins);
      const output=validateMarketCustomerThemeMapping(input,batch.output,{...batch.binding,scope:semantic.scope,inputSnapshot:window.snapshot,sourceEvidenceByRef:options.poolInput.sources,
        sourceCatalog:Object.fromEntries(window.snapshot.records.map(r=>[r.id,MarketSemanticRecordSchema.parse((r.data as Record<string,unknown>).semantic)]))});
      if(output.proposals.length)throw new TypeError('Reconciliation cannot create new proposals');const outputDigest=digest(output);
      audit.batches.push({batchId:input.batchId,inputSnapshotId:window.snapshot.snapshotId,inputDigest:input.inputDigest,outputDigest});
      for(const item of output.themes){const key=`${window.id}/${item.sourceThemeId}`;if(cells.has(key))throw new TypeError('Overlapping reconciliation members');
        if(item.decision.status==='mapped'&&item.decision.target.kind!=='existing')throw new TypeError('Reconciliation needs a frozen group');
        cells.set(key,{decision:item.decision,batchId:input.batchId,inputDigest:input.inputDigest,outputDigest});}
    }
    const next=new Map<string,string[]>();
    for(const sourceThemeId of active.keys()){
      const related=windows.filter(w=>w.memberIds.includes(sourceThemeId)),matched=new Map<string,NonNullable<ReturnType<typeof cells.get>>>();
      let unavailable=false,unknown:NonNullable<ReturnType<typeof cells.get>>|null=null;
      for(const window of related){const cell=cells.get(`${window.id}/${sourceThemeId}`);if(!cell){unavailable=true;audit.missing.push({windowId:window.id,sourceThemeId});continue;}
        if(cell.decision.status==='mapped'){if(cell.decision.target.kind!=='existing')throw new TypeError('Invalid target');matched.set(cell.decision.target.groupId,cell);}
        else if(cell.decision.reason!=='outside-taxonomy')unknown??=cell;
      }
      const save=(status:Decision['status'],groupId:string|null,reason:string|null,cell:NonNullable<ReturnType<typeof cells.get>>|null)=>decisions.set(sourceThemeId,{sourceThemeId,status,groupId,reason,round,batchId:cell?.batchId??null,inputDigest:cell?.inputDigest??null,outputDigest:cell?.outputDigest??null});
      if(unavailable)save('unavailable',null,'model-result-unavailable',null);
      else if(unknown)save('unknown',null,unknown.decision.status==='unknown'?unknown.decision.reason:'ambiguous',unknown);
      else if(!matched.size)save('unknown',null,'outside-taxonomy',null);
      else if(matched.size===1){const [groupId,cell]=[...matched][0];save('mapped',groupId,null,cell);}
      else next.set(sourceThemeId,[...matched.keys()].sort(compare));
    }
    audit.batches.sort((a,b)=>compare(a.batchId,b.batchId));audit.missing.sort((a,b)=>compare(`${a.windowId}/${a.sourceThemeId}`,`${b.windowId}/${b.sourceThemeId}`));history.push(audit);active=next;
  }
}
