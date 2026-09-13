import type {MarketInputSnapshot} from '../../../shared/market-analysis-contracts';
import {MarketSemanticRecordSchema,MarketOverviewRequestRecordSchema} from '../../../shared/market-semantic-contracts';
import {createMarketInputSnapshot} from './snapshot';
import {canonicalJsonSha256 as digest} from '../../runtime/model-request-accounting';
import {validateOverviewAnalysisBrief} from './overview-analysis-validation';
import type {MarketOverviewAnalysisBrief} from '../../../shared/market-overview-analysis-contracts';
import {planMarketOverviewCompleteWindows,restoreMarketOverviewCompleteWindow} from './overview-complete-windows';

export const MARKET_OVERVIEW_WINDOWS_VERSION='market-overview-semantic-windows/v1';
export const MARKET_OVERVIEW_ANALYSIS_WINDOWS_VERSION='market-overview-semantic-windows/v2';
type Atom={kind:'fact'|'gap';id:string};
const atomKey=(a:Atom)=>`${a.kind}:${a.id}`;
/** Shared evidence connects dimensions: never strip a limitation to make a
 * request fit. Missing-only dimensions travel with a complete factual group.
 * Synthesis is always one complete request, never a series of local summaries. */
function analysisGroups(atoms:Atom[],brief:MarketOverviewAnalysisBrief):Atom[][]{
  if(brief.mode==='synthesis')return [atoms];
  const groups:Atom[][]=[];
  for(const d of brief.dimensions){
    let group=atoms.filter(a=>a.kind==='fact'?d.factIds.includes(a.id):d.gapIds.includes(a.id));
    for(let i=groups.length-1;i>=0;i--){
      const keys=new Set(group.map(atomKey));
      if(groups[i].some(a=>keys.has(atomKey(a))))group=[...group,...groups.splice(i,1)[0]];
    }
    const keys=new Set(group.map(atomKey));groups.push(atoms.filter(a=>keys.has(atomKey(a))));
  }
  const factual=groups.filter(g=>g.some(a=>a.kind==='fact'));
  const missing=groups.filter(g=>g.every(a=>a.kind==='gap')).flat();
  if(missing.length){const keys=new Set([...factual[0],...missing].map(atomKey));factual[0]=atoms.filter(a=>keys.has(atomKey(a)));}
  return factual;
}
/** Partition by the real native request meter, retaining every fact/gap. Each
 * window includes the full metric dependency closure; counts are never sliced.
 * Cross-window report synthesis is a separate consumer, not implied here. */
function overviewWindowFactory(full:MarketInputSnapshot){
  const {scope,kind,sourceVersion,ruleVersion,collectedAt,expectedRecordIds,records}=full;
  if(kind!=='overview'||records.length!==1)throw new TypeError('Expected one complete overview catalog');
  if(digest(full)!==digest(createMarketInputSnapshot({scope,kind,sourceVersion,ruleVersion,collectedAt,expectedRecordIds,records})))throw new TypeError('Overview catalog hash differs');
  const semantic=MarketSemanticRecordSchema.parse((records[0].data as {semantic?:unknown})?.semantic);
  if(semantic.task!=='market-overview-explanation')throw new TypeError('Expected overview semantics');
  const atoms:Atom[]=[...semantic.facts.map(f=>({kind:'fact' as const,id:f.factId})),...semantic.gaps.map(g=>({kind:'gap' as const,id:g.gapId}))];
  if(new Set(atoms.map(a=>`${a.kind}:${a.id}`)).size!==atoms.length)throw new TypeError('Duplicate overview atom');
  const brief=validateOverviewAnalysisBrief(semantic),version=brief?MARKET_OVERVIEW_ANALYSIS_WINDOWS_VERSION:MARKET_OVERVIEW_WINDOWS_VERSION;
  const groups=brief?analysisGroups(atoms,brief):atoms.map(a=>[a]);
  const metrics=new Map(semantic.metrics.map(m=>[m.metricId,m]));
  const window=(selected:Atom[])=>{
    if(brief){
      const keys=new Set(selected.map(atomKey));
      if(groups.some(g=>g.some(a=>keys.has(atomKey(a)))&&!g.every(a=>keys.has(atomKey(a)))))throw new TypeError('Overview analysis requires complete dimension evidence');
      // Stable canonical order is also used when restoring saved fact/gap lists.
      selected=atoms.filter(a=>keys.has(atomKey(a)));
    }
    const factIds=new Set(selected.filter(a=>a.kind==='fact').map(a=>a.id)),gapIds=new Set(selected.filter(a=>a.kind==='gap').map(a=>a.id));
    const facts=semantic.facts.filter(f=>factIds.has(f.factId));if(!facts.length)facts.push(semantic.facts[0]);
    const factSet=new Set(facts.map(f=>f.factId)),metricIds=new Set<string>();
    const visit=(id:string)=>{if(metricIds.has(id))return;const metric=metrics.get(id);if(!metric)throw new TypeError('Unknown overview metric');metricIds.add(id);if(metric.numeratorRef)visit(metric.numeratorRef);if(metric.denominatorRef)visit(metric.denominatorRef);};
    facts.forEach(f=>f.metricRefs.forEach(visit));
    const value={...semantic,metrics:semantic.metrics.filter(m=>metricIds.has(m.metricId)),facts,gaps:semantic.gaps.filter(g=>gapIds.has(g.gapId)),
      interpretationOptions:semantic.interpretationOptions.filter(o=>o.requiredFactIds.every(id=>factSet.has(id))&&o.requiredGapIds.every(id=>gapIds.has(id)))
        .map(o=>({...o,allowedFactIds:o.allowedFactIds.filter(id=>factSet.has(id)),allowedGapIds:o.allowedGapIds.filter(id=>gapIds.has(id))})),
      validationOptions:semantic.validationOptions.map(o=>({...o,allowedFactIds:o.allowedFactIds.filter(id=>factSet.has(id)),allowedGapIds:o.allowedGapIds.filter(id=>gapIds.has(id))}))};
    if(brief)value.analysisBrief={...brief,dimensions:brief.dimensions.filter(d=>d.factIds.every(id=>factSet.has(id))&&d.gapIds.every(id=>gapIds.has(id))),factLabels:brief.factLabels.filter(f=>factSet.has(f.factId))};
    const snapshot=createMarketInputSnapshot({scope,kind,sourceVersion,ruleVersion:`${version}:${digest({basis:full.snapshotId,selected})}`,collectedAt,
      expectedRecordIds:['overview'],records:[{id:'overview',scope,data:{semantic:MarketSemanticRecordSchema.parse(value)}}]});
    return {primaryFactIds:[...factIds],gapIds:[...gapIds],snapshot};
  };
  return {atoms,groups,window,version};
}
/** Rebuild a saved window from its exact atoms without calling a model or meter. */
export function restoreMarketOverviewSemanticWindow(full:MarketInputSnapshot,selected:Atom[]){
  if(['market-overview-source-catalog/v5','market-overview-source-catalog/v6'].includes(full.ruleVersion))return restoreMarketOverviewCompleteWindow(full,selected);
  const {atoms,window}=overviewWindowFactory(full),allowed=new Set(atoms.map(a=>`${a.kind}:${a.id}`));
  if(!selected.length||new Set(selected.map(a=>`${a.kind}:${a.id}`)).size!==selected.length||selected.some(a=>!allowed.has(`${a.kind}:${a.id}`)))throw new TypeError('Invalid overview window atoms');
  return window(selected);
}
export async function planMarketOverviewSemanticWindows(full:MarketInputSnapshot,fits:(snapshot:MarketInputSnapshot)=>Promise<boolean>){
  if(['market-overview-source-catalog/v5','market-overview-source-catalog/v6'].includes(full.ruleVersion))return planMarketOverviewCompleteWindows(full,fits);
  const {groups,window,version}=overviewWindowFactory(full);
  const windows:Array<ReturnType<typeof window>>=[],rejected:Array<Atom&{reason:'request-too-large'}>=[];
  const admitted=async(selected:Atom[])=>{const candidate=window(selected).snapshot;
    if(!MarketOverviewRequestRecordSchema.safeParse((candidate.records[0].data as {semantic:unknown}).semantic).success)return false;
    return fits(candidate);
  };
  let current:Atom[]=[];
  for(const group of groups){
    const candidate=[...current,...group];if(await admitted(candidate)){current=candidate;continue;}
    const hadCurrent=current.length>0;
    if(current.length){windows.push(window(current));current=[];}
    if(hadCurrent&&await admitted(group))current=group;else rejected.push(...group.map(a=>({...a,reason:'request-too-large' as const})));
  }
  if(current.length)windows.push(window(current));
  return {version,basisSnapshotId:full.snapshotId,windows,rejected};
}
