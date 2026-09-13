import type {MarketInputSnapshot} from '../../../shared/market-analysis-contracts';
import {MarketSemanticRecordSchema,MarketOverviewRequestRecordSchema} from '../../../shared/market-semantic-contracts';
import {createMarketInputSnapshot} from './snapshot';
import {validateOverviewAnalysisBrief} from './overview-analysis-validation';
import {canonicalJsonSha256 as digest} from '../../runtime/model-request-accounting';

export const MARKET_OVERVIEW_COMPLETE_WINDOWS_VERSION='market-overview-semantic-windows/v3';
export const MARKET_OVERVIEW_TABLE_WINDOWS_VERSION='market-overview-semantic-windows/v4';
const versionFor=(full:MarketInputSnapshot)=>full.ruleVersion==='market-overview-source-catalog/v6'?MARKET_OVERVIEW_TABLE_WINDOWS_VERSION:MARKET_OVERVIEW_COMPLETE_WINDOWS_VERSION;
type Atom={kind:'fact'|'gap';id:string};
const key=(a:Atom)=>`${a.kind}:${a.id}`;
function factory(full:MarketInputSnapshot){
 const {scope,kind,sourceVersion,ruleVersion,collectedAt,expectedRecordIds,records}=full;
 if(kind!=='overview'||records.length!==1||digest(full)!==digest(createMarketInputSnapshot({scope,kind,sourceVersion,ruleVersion,collectedAt,expectedRecordIds,records})))throw new TypeError('Complete overview snapshot differs');
 const s=MarketSemanticRecordSchema.parse((records[0].data as {semantic:unknown}).semantic);if(s.task!=='market-overview-explanation')throw new TypeError('Expected overview');
 const brief=validateOverviewAnalysisBrief(s);if(!brief)throw new TypeError('Complete overview requires analysis scope');
 const atoms:Atom[]=[...s.facts.map(f=>({kind:'fact' as const,id:f.factId})),...s.gaps.map(g=>({kind:'gap' as const,id:g.gapId}))];
 const metrics=new Map(s.metrics.map(m=>[m.metricId,m])),gaps=new Map(s.gaps.map(g=>[g.gapId,g]));
 // Link missing row fields and scalar scope warnings to the same factual row.
 // An endpoint/group limitation applies to every fact in that dimension.
 const related=(gapId:string,factId:string)=>{const g=gaps.get(gapId)!,f=s.facts.find(f=>f.factId===factId)!;
   if(g.metricId===null)return true;
   const target=g.metricId.replace(/\/response-scope$/,'');
   if(f.metricRefs.includes(target)||f.factId===`fact:${target}`||f.factId===`fact:${target.replace(/:[^:]+$/,'')}`)return true;
   return !target.startsWith('dist:')&&!s.facts.some(f=>f.factId===`fact:${target}`||f.metricRefs.includes(target));
 };
 const contextGaps=(factId:string)=>brief.dimensions.filter(d=>d.factIds.includes(factId)).flatMap(d=>d.gapIds.filter(g=>related(g,factId)));
 const gapAnchor=(gapId:string)=>{const owners=brief.dimensions.filter(d=>d.gapIds.includes(gapId));return owners.flatMap(d=>d.factIds).find(f=>related(gapId,f))??owners.flatMap(d=>d.factIds)[0]??s.facts[0].factId;};
 const used=new Set<string>(),groups:Atom[][]=[];
 for(const f of s.facts){const group:Atom[]=[{kind:'fact',id:f.factId}];for(const id of new Set(contextGaps(f.factId)))if(!used.has(id)){group.push({kind:'gap',id});used.add(id);}groups.push(group);}
 for(const g of s.gaps)if(!used.has(g.gapId))groups.push([{kind:'gap',id:g.gapId}]);
 if(brief.mode==='synthesis')groups.splice(0,groups.length,atoms);
 const window=(selected:Atom[])=>{
   const selectedKeys=new Set(selected.map(key));
   if(!selected.length||selectedKeys.size!==selected.length||selected.some(a=>!atoms.some(b=>key(a)===key(b))))throw new TypeError('Invalid complete overview window atoms');
   if(brief.mode==='synthesis'&&selected.length!==atoms.length)throw new TypeError('Synthesis requires complete evidence');
   const primary=atoms.filter(a=>selectedKeys.has(key(a))),primaryFacts=primary.filter(a=>a.kind==='fact').map(a=>a.id),primaryGaps=primary.filter(a=>a.kind==='gap').map(a=>a.id);
   const factIds=new Set([...primaryFacts,...primaryGaps.map(gapAnchor)]);if(!factIds.size)factIds.add(s.facts[0].factId);
   const gapIds=new Set([...primaryGaps,...[...factIds].flatMap(contextGaps)]),metricIds=new Set<string>();
   const visit=(id:string)=>{if(metricIds.has(id))return;const m=metrics.get(id);if(!m)throw new TypeError('Missing numeric dependency');metricIds.add(id);if(m.numeratorRef)visit(m.numeratorRef);if(m.denominatorRef)visit(m.denominatorRef);};
   const facts=s.facts.filter(f=>factIds.has(f.factId));facts.forEach(f=>f.metricRefs.forEach(visit));
   const analysisBrief={...brief,referenceEncoding:full.ruleVersion==='market-overview-source-catalog/v6'?'metric-table/v1' as const:'local-identifiers/v1' as const,scopeStatement:brief.mode==='dimension'?`${brief.scopeStatement} 本请求为证据片段；coverage记录该维完整目录数量。结论仅限本片段，不能宣称全维或跨片段综合已完成。`:brief.scopeStatement,
     dimensions:brief.dimensions.map(d=>({...d,factIds:d.factIds.filter(id=>factIds.has(id)),gapIds:d.gapIds.filter(id=>gapIds.has(id)),coverage:{totalFactCount:d.factIds.length,totalGapCount:d.gapIds.length}})).filter(d=>d.factIds.length||d.gapIds.length),factLabels:brief.factLabels.filter(f=>factIds.has(f.factId))};
   const semantic=MarketSemanticRecordSchema.parse({...s,facts,gaps:s.gaps.filter(g=>gapIds.has(g.gapId)),metrics:s.metrics.filter(m=>metricIds.has(m.metricId)),analysisBrief,interpretationOptions:[],validationOptions:[]});
   if(semantic.task!=='market-overview-explanation')throw new TypeError('Expected overview');validateOverviewAnalysisBrief(semantic);
   const snapshot=createMarketInputSnapshot({scope,kind,sourceVersion,ruleVersion:`${versionFor(full)}:${digest({basis:full.snapshotId,selected:primary})}`,collectedAt,expectedRecordIds:['overview'],records:[{id:'overview',scope,data:{semantic}}]});
   return {primaryFactIds:primaryFacts,gapIds:primaryGaps,snapshot};
 };
 return {groups,window};
}
export function restoreMarketOverviewCompleteWindow(full:MarketInputSnapshot,selected:Atom[]){return factory(full).window(selected);}
export async function planMarketOverviewCompleteWindows(full:MarketInputSnapshot,fits:(snapshot:MarketInputSnapshot)=>Promise<boolean>){
 const {groups,window}=factory(full),windows:Array<ReturnType<typeof window>>=[],rejected:Array<Atom&{reason:'request-too-large'}>=[];let current:Atom[]=[];
 const admitted=async(a:Atom[])=>{const snapshot=window(a).snapshot;return MarketOverviewRequestRecordSchema.safeParse((snapshot.records[0].data as {semantic:unknown}).semantic).success&&await fits(snapshot);};
 for(const group of groups){if(await admitted([...current,...group])){current.push(...group);continue;}const hadCurrent=current.length>0;if(hadCurrent){windows.push(window(current));current=[];}
   if(hadCurrent&&await admitted(group))current=group;else rejected.push(...group.map(a=>({...a,reason:'request-too-large' as const})));
 }
 if(current.length)windows.push(window(current));return {version:versionFor(full),basisSnapshotId:full.snapshotId,windows,rejected};
}
