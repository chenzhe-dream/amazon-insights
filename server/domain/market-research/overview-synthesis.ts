import type {MarketOverviewSynthesisBasis} from '../../../shared/market-overview-synthesis-contracts';
import {MarketOverviewSynthesisInputSchema,MarketOverviewSynthesisChildSchema,MarketOverviewDimensionSynthesisOutputSchema,MarketOverviewFinalSynthesisOutputSchema,type MarketOverviewSynthesisInput,type MarketOverviewSynthesisChild,type MarketOverviewGapGroup,type MarketOverviewSynthesisStatement,type MarketOverviewSynthesisDimensionSection,type MarketOverviewDimensionSynthesisOutput} from '../../../shared/market-overview-reduction-contracts';
import {canonicalJsonSha256 as digest} from '../../runtime/model-request-accounting';

type Basis=MarketOverviewSynthesisBasis;
export type MarketOverviewGapGroupRegistryEntry=MarketOverviewGapGroup & {originalGapIds:string[]};
export type MarketOverviewSynthesisFits=(input:MarketOverviewSynthesisInput)=>boolean|Promise<boolean>;
export class MarketOverviewSynthesisRequestTooLargeError extends Error {
  readonly code='request-too-large';
  constructor(readonly phase:'dimension'|'minimum-pair'|'final'='dimension') {
    super(`Market overview synthesis ${phase==='minimum-pair'?'minimum pair':phase+' input'} too large`);
    this.name='MarketOverviewSynthesisRequestTooLargeError';
  }
}
const fail=(reason:string):never=>{throw new TypeError(`Invalid overview synthesis: ${reason}`);};
const unique=(values:readonly string[],name:string)=>{if(new Set(values).size!==values.length||values.some(v=>!v.trim()))fail(`duplicate or empty ${name}`);return new Set(values);};
const exact=(actual:readonly string[],expected:readonly string[],name:string)=>{const a=unique(actual,name),e=unique(expected,`expected ${name}`);if(a.size!==e.size||expected.some(v=>!a.has(v)))fail(`incomplete or foreign ${name}`);};
const subset=(actual:readonly string[],allowed:Set<string>,name:string)=>{unique(actual,name);if(actual.some(v=>!allowed.has(v)))fail(`foreign ${name}`);};
const statements=(s:MarketOverviewSynthesisDimensionSection)=>[s.data,s.meaning,s.conclusion,...s.limitations,...s.verification];
const aborted=(signal?:AbortSignal)=>{signal?.throwIfAborted();};

/** Recognize only the frozen distribution ID grammar. Unknown semantics never
 * become equivalent merely because their reason or endpoint resembles another. */
function gapMeaning(gap:Basis['gaps'][number],dimensionId:string){
  const operations=new Set(['market_price_distribution','market_ratings_count_distribution','market_rating_distribution','market_listing_date_distribution','market_listing_trend_distribution','market_brand_concentration','market_seller_concentration','market_seller_country_distribution','market_seller_type_concentration','market_ebc_distribution','market_product_demand_trend']);
  const raw=(gap.metricId??gap.gapId).replace(/^gap:/,''),parts=raw.split(':');
  if(parts[0]==='dist'&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(parts[1]??'')&&operations.has(parts[2])){
    const [,,operation,group]=parts;
    if(gap.metricId&&parts.length>=6&&['sample','new-products','summary','unclassified'].includes(group)&&dimensionId===`${operation}:${group}`&&['products','units','revenue'].includes(parts.at(-1)!)){
      return {fieldKind:parts.at(-1)!,scopeKey:`dist:${parts[1]}:${operation}:${group}`};
    }
    if(!gap.metricId&&parts.length===5&&['sample','new-products','summary','unclassified'].includes(group)&&dimensionId===`${operation}:${group}`&&['response-scope','not-disjoint','group-limitations'].includes(parts[4])){
      return {fieldKind:parts[4],scopeKey:`dist:${parts[1]}:${operation}:${group}`};
    }
    if(!gap.metricId&&parts.length===4&&group==='unavailable'&&dimensionId===`${operation}:sample`)return {fieldKind:'unavailable',scopeKey:`dist:${parts[1]}:${operation}:sample`};
  }
  return {fieldKind:gap.metricId?`metric:${gap.metricId}`:'unknown-gap',scopeKey:`exact-gap:${gap.gapId}`};
}

export function buildMarketOverviewGapGroupRegistry(basis:Basis):MarketOverviewGapGroupRegistryEntry[]{
  unique(basis.gaps.map(g=>g.gapId),'basis gaps');unique(basis.dimensions.map(d=>d.id),'basis dimensions');
  const gaps=new Map(basis.gaps.map(g=>[g.gapId,g])),groups=new Map<string,MarketOverviewGapGroupRegistryEntry>();
  const covered=new Set<string>();
  for(const dimension of basis.dimensions)for(const gapId of dimension.gapIds){
    const gap=gaps.get(gapId);if(!gap)fail('dimension references unknown gap');covered.add(gapId);
    const meaning={dimensionId:dimension.id,reason:gap!.reason,sourceRefs:[...new Set(gap!.sourceRefs)].sort(),...gapMeaning(gap!,dimension.id)};
    const key=digest(meaning),previous=groups.get(key);
    if(previous){if(!previous.originalGapIds.includes(gapId)){previous.originalGapIds.push(gapId);previous.memberCount++;}}
    else groups.set(key,{gapGroupId:`overview-gap-group:${key}`,...meaning,memberCount:1,originalGapIds:[gapId]});
  }
  exact([...covered],basis.gaps.map(g=>g.gapId),'registry gaps');
  return [...groups.values()].map(g=>({...g,originalGapIds:g.originalGapIds.sort()}));
}

export function createMarketOverviewSynthesisChildren(basis:Basis):MarketOverviewSynthesisChild[]{
  const registry=buildMarketOverviewGapGroupRegistry(basis);
  unique(basis.leaves.map(l=>l.leafId),'basis leaves');
  return basis.leaves.map(leaf=>{
    const groupId=(gapId:string)=>registry.find(g=>g.dimensionId===leaf.dimensionId&&g.originalGapIds.includes(gapId))?.gapGroupId??fail('leaf gap has no registry group');
    const convert=(s:Basis['leaves'][number]['section']['data'])=>({parts:s.parts.map(part=>({...part})),factIds:[...s.factIds],gapGroupIds:[...new Set(s.gapIds.map(groupId))]});
    const section={dimensionId:leaf.dimensionId,data:convert(leaf.section.data),meaning:convert(leaf.section.meaning),conclusion:convert(leaf.section.conclusion),limitations:leaf.section.limitations.map(convert),verification:leaf.section.verification.map(convert)};
    const visible=[...new Set(leaf.coveredGapIds.map(groupId))];
    requireLimitations(section.limitations,visible);
    return MarketOverviewSynthesisChildSchema.parse({childId:leaf.leafId,leafSectionIds:[leaf.leafId],section});
  });
}

function metricClosure(basis:Pick<Basis,'metrics'>,seeds:Iterable<string>):Set<string>{
  const byId=new Map(basis.metrics.map(m=>[m.metricId,m])),result=new Set<string>(),active=new Set<string>();
  const visit=(id:string)=>{if(active.has(id))fail('cyclic metric dependency');if(result.has(id))return;const m=byId.get(id);if(!m)fail('missing metric dependency');active.add(id);for(const dep of [m!.numeratorRef,m!.denominatorRef])if(dep!==null)visit(dep);active.delete(id);result.add(id);};
  for(const id of seeds)visit(id);return result;
}
function requireLimitations(limitations:readonly MarketOverviewSynthesisStatement[],expected:readonly string[]){
  const covered=new Set(limitations.flatMap(s=>s.gapGroupIds));if(expected.some(id=>!covered.has(id)))fail('limitations omit material gap groups');
}
function checkStatement(input:Pick<MarketOverviewSynthesisInput,'evidenceFacts'|'metrics'|'labels'|'gapGroups'>,s:MarketOverviewSynthesisStatement,factIds:Set<string>,gapIds:Set<string>){
  subset(s.factIds,factIds,'statement facts');subset(s.gapGroupIds,gapIds,'statement gap groups');
  if(!s.factIds.length&&!s.gapGroupIds.length)fail('statement requires evidence citations');
  const facts=new Map(input.evidenceFacts.map(f=>[f.factId,f])),labels=new Set(input.labels.map(l=>l.factId));
  const metrics=metricClosure(input,s.factIds.flatMap(id=>facts.get(id)?.metricRefs??fail('unknown cited fact')));
  for(const part of s.parts){
    if(part.kind==='metric'&&!metrics.has(part.metricId))fail('metric token lacks cited fact dependency');
    if(part.kind==='fact-label'&&(!s.factIds.includes(part.factId)||!labels.has(part.factId)))fail('foreign fact-label token');
    if(part.kind==='text'&&/([零〇一二两三四五六七八九十百千万亿]+\s*(成|倍|元|美元|人民币|条|个|件|款|家|天|日|月|年|点|%|％)|百分之|千分之|一半|半数)/.test(part.text))fail('numeric prose requires metric token');
  }
}
function checkSection(input:Pick<MarketOverviewSynthesisInput,'evidenceFacts'|'metrics'|'labels'|'gapGroups'>,section:MarketOverviewSynthesisDimensionSection,factIds:Set<string>,gapIds:Set<string>,requireAllGaps=true){
  for(const s of statements(section))checkStatement(input,s,factIds,gapIds);
  if(factIds.size&&!section.data.factIds.length)fail('dimension data requires an observed fact');
  if(requireAllGaps)requireLimitations(section.limitations,[...gapIds]);
}

/** Authorization is external: children must come from validated persisted runs.
 * Hashes below make a deterministic identity and never attest authorization. */
function canonicalInput(basis:Basis,mode:'dimension-reduce'|'final',dimensionId:string,childrenInput:readonly MarketOverviewSynthesisChild[],expectedLeaves:readonly string[]):MarketOverviewSynthesisInput{
  if(mode==='dimension-reduce'&&childrenInput.length<2)fail('dimension reduction requires at least two children');
  if(mode==='final'&&dimensionId!=='final')fail('invalid final dimension');
  const children=childrenInput.map(c=>MarketOverviewSynthesisChildSchema.parse(c)).sort((a,b)=>a.childId.localeCompare(b.childId));
  unique(children.map(c=>c.childId),'children');
  const registry=buildMarketOverviewGapGroupRegistry(basis),byLeaf=new Map(basis.leaves.map(l=>[l.leafId,l]));
  const suppliedLeaves=children.flatMap(c=>c.leafSectionIds);
  exact(suppliedLeaves,expectedLeaves,'leaf-section coverage');
  subset(expectedLeaves,new Set(byLeaf.keys()),'expected leaves');
  const sourceFacts=new Map(basis.facts.map(f=>[f.factId,f]));
  const allEvidence={evidenceFacts:structuredClone(basis.facts) as MarketOverviewSynthesisInput['evidenceFacts'],metrics:structuredClone(basis.metrics) as MarketOverviewSynthesisInput['metrics'],labels:structuredClone(basis.factLabels) as MarketOverviewSynthesisInput['labels'],gapGroups:registry};
  const initial=new Map(createMarketOverviewSynthesisChildren(basis).map(c=>[c.childId,c]));
  for(const child of children){
    if(mode==='dimension-reduce'&&child.section.dimensionId!==dimensionId)fail('child dimension differs');
    const dimension=basis.dimensions.find(d=>d.id===child.section.dimensionId);if(!dimension)fail('unknown child dimension');
    if(child.leafSectionIds.some(id=>byLeaf.get(id)?.dimensionId!==child.section.dimensionId))fail('leaf dimension differs');
    if(initial.has(child.childId)&&digest(initial.get(child.childId))!==digest(child))fail('forged initial child');
    const leafFacts=new Set(child.leafSectionIds.flatMap(id=>byLeaf.get(id)!.coveredFactIds));
    const allowedFacts=new Set(dimension!.factIds.filter(id=>leafFacts.has(id)));
    const leafGaps=new Set(child.leafSectionIds.flatMap(id=>byLeaf.get(id)!.coveredGapIds));
    const allowedGroups=new Set(registry.filter(g=>g.dimensionId===dimension!.id&&g.originalGapIds.some(id=>leafGaps.has(id))).map(g=>g.gapGroupId));
    checkSection(allEvidence,child.section,allowedFacts,allowedGroups);
  }
  if(mode==='final'){
    exact(expectedLeaves,basis.leaves.map(l=>l.leafId),'final complete leaves');
    exact(children.map(c=>c.section.dimensionId),basis.dimensions.map(d=>d.id),'final dimension children');
  }
  const referencedFacts=new Set(children.flatMap(c=>statements(c.section).flatMap(s=>s.factIds)));
  const evidenceFacts=basis.facts.filter(f=>referencedFacts.has(f.factId));
  for(const id of referencedFacts)if(!sourceFacts.has(id))fail('unknown child fact');
  const metricIds=metricClosure(basis,evidenceFacts.flatMap(f=>[...f.metricRefs]));
  const visibleGaps=new Set(suppliedLeaves.flatMap(id=>byLeaf.get(id)!.coveredGapIds));
  const visibleDimensions=new Set(children.map(c=>c.section.dimensionId));
  const gapGroups=registry.filter(g=>visibleDimensions.has(g.dimensionId)&&(mode==='final'||g.originalGapIds.some(id=>visibleGaps.has(id)))).map(({originalGapIds,...g})=>{void originalGapIds;return g;});
  const leafSectionIds=basis.leaves.filter(l=>new Set(suppliedLeaves).has(l.leafId)).map(l=>l.leafId);
  const content={version:'market-overview-synthesis-input/v1' as const,basisId:basis.basisId,mode,dimensionId,children,directChildIds:children.map(c=>c.childId),leafSectionIds,evidenceFacts,metrics:basis.metrics.filter(m=>metricIds.has(m.metricId)),labels:basis.factLabels.filter(l=>referencedFacts.has(l.factId)),gapGroups,scopeStatement:basis.scopeStatement};
  const inputDigest=digest(content);
  return MarketOverviewSynthesisInputSchema.parse({...content,inputDigest,nodeId:`overview-synthesis-node:${inputDigest}`});
}

export function validateMarketOverviewSynthesisInputEvidence(basis:Basis,candidate:unknown,authorizedChildren:readonly MarketOverviewSynthesisChild[],expectedLeaves:readonly string[]):MarketOverviewSynthesisInput{
  const input=MarketOverviewSynthesisInputSchema.parse(candidate);
  const rebuilt=canonicalInput(basis,input.mode,input.dimensionId,authorizedChildren,expectedLeaves);
  if(digest(input)!==digest(rebuilt))fail('input differs from authorized children or canonical evidence');
  return input;
}
export async function buildMarketOverviewDimensionSynthesisInput(basis:Basis,dimensionId:string,children:readonly MarketOverviewSynthesisChild[],expectedLeaves:readonly string[],fits:MarketOverviewSynthesisFits,signal?:AbortSignal){
  aborted(signal);const input=canonicalInput(basis,'dimension-reduce',dimensionId,children,expectedLeaves);
  const accepted=await fits(input);aborted(signal);if(!accepted)throw new MarketOverviewSynthesisRequestTooLargeError('dimension');return input;
}
export async function buildMarketOverviewFinalSynthesisInput(basis:Basis,children:readonly MarketOverviewSynthesisChild[],expectedLeaves:readonly string[],fits:MarketOverviewSynthesisFits,signal?:AbortSignal){
  aborted(signal);const input=canonicalInput(basis,'final','final',children,expectedLeaves);
  const accepted=await fits(input);aborted(signal);if(!accepted)throw new MarketOverviewSynthesisRequestTooLargeError('final');return input;
}

/** Greedy bounded contiguous groups, measured using the caller's real native
 * request. Every input merges >=2 children; at most one singleton is carried.
 * Meter exceptions propagate and cannot masquerade as a budget rejection. */
export async function planMarketOverviewDimensionSynthesisRound(basis:Basis,dimensionId:string,childrenInput:readonly MarketOverviewSynthesisChild[],expectedLeaves:readonly string[],fits:MarketOverviewSynthesisFits,signal?:AbortSignal):Promise<{inputs:MarketOverviewSynthesisInput[];carry:MarketOverviewSynthesisChild[]}>{
  aborted(signal);
  const children=[...childrenInput].sort((a,b)=>a.childId.localeCompare(b.childId));
  exact(children.flatMap(c=>c.leafSectionIds),expectedLeaves,'round leaf-section coverage');
  exact(expectedLeaves,basis.leaves.filter(l=>l.dimensionId===dimensionId).map(l=>l.leafId),'round complete dimension leaves');
  unique(children.map(c=>c.childId),'round children');
  if(children.length<2)fail('reduction round requires at least two children');
  const inputs:MarketOverviewSynthesisInput[]=[],carry:MarketOverviewSynthesisChild[]=[];
  let offset=0;
  while(offset<children.length){
    aborted(signal);
    if(offset===children.length-1){carry.push(children[offset]);break;}
    let accepted:MarketOverviewSynthesisInput|undefined,end=offset+2;
    for(;end<=children.length;end++){
      aborted(signal);const group=children.slice(offset,end),input=canonicalInput(basis,'dimension-reduce',dimensionId,group,group.flatMap(c=>c.leafSectionIds));
      const fitsBudget=await fits(input);aborted(signal);
      if(!fitsBudget){if(!accepted)throw new MarketOverviewSynthesisRequestTooLargeError('minimum-pair');break;}
      accepted=input;
    }
    inputs.push(accepted!);offset+=accepted!.children.length;
  }
  if(inputs.length+carry.length>=children.length)fail('reduction round did not strictly decrease');
  return {inputs,carry};
}
export function validateMarketOverviewDimensionSynthesisOutput(input:MarketOverviewSynthesisInput,candidate:unknown){
  if(input.mode!=='dimension-reduce')fail('dimension output mode differs');
  const result=MarketOverviewDimensionSynthesisOutputSchema.parse(candidate);
  if(result.dimensionSection.dimensionId!==input.dimensionId)fail('output dimension differs');
  checkSection(input,result.dimensionSection,new Set(input.evidenceFacts.map(f=>f.factId)),new Set(input.gapGroups.map(g=>g.gapGroupId)));
  return result;
}
export function validateMarketOverviewFinalSynthesisOutput(input:MarketOverviewSynthesisInput,candidate:unknown){
  if(input.mode!=='final')fail('final output mode differs');
  const result=MarketOverviewFinalSynthesisOutputSchema.parse(candidate),facts=new Set(input.evidenceFacts.map(f=>f.factId)),gaps=new Set(input.gapGroups.map(g=>g.gapGroupId));
  for(const s of [result.summary.statement,...result.conflicts,...result.limitations,...result.verification])checkStatement(input,s,facts,gaps);
  requireLimitations(result.limitations,[...gaps]);return result;
}
export function createMarketOverviewSynthesisChild(input:MarketOverviewSynthesisInput,output:MarketOverviewDimensionSynthesisOutput):MarketOverviewSynthesisChild{
  const result=validateMarketOverviewDimensionSynthesisOutput(input,output);
  return MarketOverviewSynthesisChildSchema.parse({childId:input.nodeId,leafSectionIds:input.leafSectionIds,section:result.dimensionSection});
}
