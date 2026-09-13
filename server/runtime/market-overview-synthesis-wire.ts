import {z} from 'zod';
import {MarketOverviewSynthesisInputSchema,MarketOverviewSynthesisStatementSchema,MarketOverviewSynthesisDimensionSectionSchema,MarketOverviewDimensionSynthesisOutputSchema,MarketOverviewFinalSynthesisOutputSchema,type MarketOverviewSynthesisInput} from '../../shared/market-overview-reduction-contracts';
import {canonicalJsonSha256 as digest} from './model-request-accounting';

const ref=z.string().min(1).max(240),index=z.number().int().nonnegative();
const metric=MarketOverviewSynthesisInputSchema.shape.metrics.element;
const part=z.tuple([z.enum(['t','m','f']),index]);
export const MarketOverviewSynthesisModelInputSchema=z.object({
 encoding:z.literal('overview-synthesis-local-refs/v1'),mode:z.enum(['dimension-reduce','final']),dimensionId:ref,scopeStatement:z.string(),
 // Fixed column descriptions travel with the data; input tuples are not output contracts.
 columns:z.object({children:z.literal('dim,data,meaning,conclusion,limits,verify'),statements:z.literal('parts,facts,gaps; t/m/f,index'),metrics:z.literal('value,context,numerator?,denominator?'),contexts:z.literal('unit,period,sources,formula,coverage'),facts:z.literal('kind,metrics,sources,template'),gaps:z.literal('dimension,reason,sources,field,scope,count'),names:z.literal('IDs join names by colon'),units:z.literal('unit,rawUnit,currency?')}).strict(),
 dimensions:z.array(z.array(index)),names:z.array(z.string()),sourceSets:z.array(z.array(index)),
 children:z.array(z.tuple([index,index,index,index,z.array(index),z.array(index)])),
 statements:z.array(z.tuple([z.array(part),z.array(index),z.array(index)])),texts:z.array(z.string()),
 metrics:z.array(z.tuple([z.number().finite(),index]).rest(index.nullable())),
 contexts:z.array(z.tuple([index,index,index,index,index])),units:z.array(z.tuple([z.enum(['count','ratio','percent','currency']),z.string()]).rest(z.string())),periods:z.array(metric.shape.period),formulas:z.array(z.array(index)),coverage:z.array(metric.shape.coverage),
 facts:z.array(z.tuple([index,z.array(index),index,index])),templates:z.array(z.array(index)),kinds:z.array(z.enum(['value','comparison','share','trend'])),labels:z.array(z.tuple([index,z.string()])),
 gaps:z.array(z.tuple([index,index,index,index,index,z.number().int().positive()])),reasons:z.array(ref),fields:z.array(z.array(index)),scopes:z.array(z.array(index)),
}).strict();
const outputPart=z.object({k:z.enum(['t','m','f']),v:z.union([z.string(),index])}).strict();
const outputStatement=z.object({p:z.array(outputPart),f:z.array(index),g:z.array(index)}).strict();
const outputSection=MarketOverviewSynthesisDimensionSectionSchema.extend({data:outputStatement,meaning:outputStatement,conclusion:outputStatement,limitations:z.array(outputStatement),verification:z.array(outputStatement)});
export const MarketOverviewSynthesisModelDimensionOutputSchema=MarketOverviewDimensionSynthesisOutputSchema.extend({dimensionSection:outputSection});
export const MarketOverviewSynthesisModelFinalOutputSchema=MarketOverviewFinalSynthesisOutputSchema.extend({summary:z.object({decision:MarketOverviewFinalSynthesisOutputSchema.shape.summary.shape.decision,statement:outputStatement}).strict(),conflicts:z.array(outputStatement),limitations:z.array(outputStatement),verification:z.array(outputStatement)});
export const MarketOverviewSynthesisModelSchemaDefinitions=Object.freeze({S:outputStatement});
const reject=():never=>{throw new z.ZodError([{code:'custom',path:[],message:'Output reference is not a supplied overview synthesis identifier'}]);};
function frozen<T>(value:T):T{if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.values(value).forEach(frozen);Object.freeze(value);}return value;}

/** Reversible evidence projection shared by request admission and execution.
 * Storage lineage stays canonical. Tables deduplicate repeated metadata and
 * statements; local references never confer authority beyond the saved node. */
export function createMarketOverviewSynthesisModelWire(value:MarketOverviewSynthesisInput){
 const canonical=MarketOverviewSynthesisInputSchema.parse(value);
 const forward=new Map<string,Map<string,string>>(),reverse=new Map<string,Map<string,string>>();
 function register(kind:string,ids:string[]){const a=new Map<string,string>(),b=new Map<string,string>();[...new Set(ids)].forEach((id,i)=>{a.set(id,`${kind}${i}`);b.set(`${kind}${i}`,id);});forward.set(kind,a);reverse.set(kind,b);}
 register('f',canonical.evidenceFacts.map(f=>f.factId));
 register('m',[...canonical.metrics.map(m=>m.metricId),...canonical.metrics.flatMap(m=>[...(m.numeratorRef?[m.numeratorRef]:[]),...(m.denominatorRef?[m.denominatorRef]:[])])]);
 register('g',canonical.gapGroups.map(g=>g.gapGroupId));
 register('s',[...canonical.metrics,...canonical.evidenceFacts,...canonical.gapGroups].flatMap(x=>x.sourceRefs));
 register('c',canonical.directChildIds);register('l',canonical.leafSectionIds);
 // Dimension keys and human labels preserve their meaning in the model input.
 const fields:Record<string,string>={factId:'f',factIds:'f',metricId:'m',metricRefs:'m',numeratorRef:'m',denominatorRef:'m',gapGroupId:'g',gapGroupIds:'g',sourceRefs:'s',childId:'c',leafSectionIds:'l'};
 function change(value:unknown,decode:boolean):unknown{
  const dictionaries=decode?reverse:forward;
  function ref(kind:string,v:unknown):unknown{return v===null?null:typeof v==='string'?dictionaries.get(kind)?.get(v)??reject():Array.isArray(v)?v.map(x=>ref(kind,x)):reject();}
  function walk(v:unknown):unknown{if(Array.isArray(v))return v.map(walk);if(v===null||typeof v!=='object')return v;return Object.fromEntries(Object.entries(v).map(([key,item])=>[key,fields[key]?ref(fields[key],item):walk(item)]));}
  return walk(value);
 }
 const aliased=MarketOverviewSynthesisInputSchema.parse(change(canonical,false));
 const statements:z.infer<typeof MarketOverviewSynthesisStatementSchema>[]=[],statementIds=new Map<string,number>();
 function statementIndex(value:z.infer<typeof MarketOverviewSynthesisStatementSchema>){const key=digest(value);let id=statementIds.get(key);if(id===undefined){id=statements.length;statementIds.set(key,id);statements.push(value);}return id;}
 function dictionary<T>(){const values:T[]=[],ids=new Map<string,number>();return {values,index:(value:T)=>{const key=digest(value);let id=ids.get(key);if(id===undefined){id=values.length;ids.set(key,id);values.push(value);}return id;}};}
 const dimensions=dictionary<string>(),sourceSets=dictionary<string[]>(),units=dictionary<z.infer<typeof metric>['unit']>(),periods=dictionary<z.infer<typeof metric>['period']>(),texts=dictionary<string>(),formulas=dictionary<string>(),coverage=dictionary<z.infer<typeof metric>['coverage']>(),contexts=dictionary<number[]>(),kinds=dictionary<MarketOverviewSynthesisInput['evidenceFacts'][number]['kind']>(),templates=dictionary<string>(),reasons=dictionary<string>(),fieldKinds=dictionary<string>(),scopes=dictionary<string>();
 const children=aliased.children.map(child=>[dimensions.index(child.section.dimensionId),statementIndex(child.section.data),statementIndex(child.section.meaning),statementIndex(child.section.conclusion),child.section.limitations.map(statementIndex),child.section.verification.map(statementIndex)]);
 const metrics=aliased.metrics.map(m=>[m.value,contexts.index([units.index(m.unit),periods.index(m.period),sourceSets.index(m.sourceRefs),formulas.index(m.formulaVersion),coverage.index(m.coverage)]),...(m.numeratorRef!==null||m.denominatorRef!==null?[m.numeratorRef===null?null:Number(m.numeratorRef.slice(1)),m.denominatorRef===null?null:Number(m.denominatorRef.slice(1))]:[])]);
 const facts=aliased.evidenceFacts.map(f=>[kinds.index(f.kind),f.metricRefs.map(id=>Number(id.slice(1))),sourceSets.index(f.sourceRefs),templates.index(f.statementTemplateId)]);
 const gaps=aliased.gapGroups.map(g=>[dimensions.index(g.dimensionId),reasons.index(g.reason),sourceSets.index(g.sourceRefs),fieldKinds.index(g.fieldKind),scopes.index(g.scopeKey),g.memberCount]);
 const names=dictionary<string>();const name=(value:string)=>value.split(':').map(names.index);
 const input=MarketOverviewSynthesisModelInputSchema.parse({encoding:'overview-synthesis-local-refs/v1',mode:aliased.mode,dimensionId:aliased.dimensionId,scopeStatement:aliased.scopeStatement,
 columns:{children:'dim,data,meaning,conclusion,limits,verify',statements:'parts,facts,gaps; t/m/f,index',metrics:'value,context,numerator?,denominator?',contexts:'unit,period,sources,formula,coverage',facts:'kind,metrics,sources,template',gaps:'dimension,reason,sources,field,scope,count',names:'IDs join names by colon',units:'unit,rawUnit,currency?'},
 dimensions:dimensions.values.map(name),sourceSets:sourceSets.values.map(set=>set.map(id=>Number(id.slice(1)))),children,
 statements:statements.map(s=>[s.parts.map(p=>[p.kind==='text'?'t':p.kind==='metric'?'m':'f',p.kind==='text'?texts.index(p.text):Number((p.kind==='metric'?p.metricId:p.factId).slice(1))]),s.factIds.map(id=>Number(id.slice(1))),s.gapGroupIds.map(id=>Number(id.slice(1)))]),
 texts:texts.values,metrics,contexts:contexts.values,units:units.values.map(u=>[u.unit,u.rawUnit,...(u.currency?[u.currency]:[])]),periods:periods.values,formulas:formulas.values.map(name),coverage:coverage.values,facts,templates:templates.values.map(name),kinds:kinds.values,labels:aliased.labels.map(l=>[Number(l.factId.slice(1)),l.label]),gaps,reasons:reasons.values,fields:fieldKinds.values.map(name),scopes:scopes.values.map(name),names:names.values});
 const outputSchema=canonical.mode==='final'?MarketOverviewSynthesisModelFinalOutputSchema:MarketOverviewSynthesisModelDimensionOutputSchema;
 const decodeStatement=(s:z.infer<typeof outputStatement>)=>MarketOverviewSynthesisStatementSchema.parse({parts:s.p.map(p=>p.k==='t'?typeof p.v==='string'?{kind:'text',text:p.v}:reject():typeof p.v==='number'?p.k==='m'?{kind:'metric',metricId:reverse.get('m')!.get(`m${p.v}`)??reject()}:{kind:'fact-label',factId:reverse.get('f')!.get(`f${p.v}`)??reject()}:reject()),factIds:s.f.map(i=>reverse.get('f')!.get(`f${i}`)??reject()),gapGroupIds:s.g.map(i=>reverse.get('g')!.get(`g${i}`)??reject())});
 frozen(input);
 return Object.freeze({input,inputSchema:MarketOverviewSynthesisModelInputSchema,outputSchema,schemaDefinitions:MarketOverviewSynthesisModelSchemaDefinitions,encoding:'overview-synthesis-local-refs/v1' as const,
  decode:(raw:unknown)=>{
   const output=outputSchema.parse(raw);
   if(output.mode==='final')return MarketOverviewFinalSynthesisOutputSchema.parse({...output,summary:{...output.summary,statement:decodeStatement(output.summary.statement)},conflicts:output.conflicts.map(decodeStatement),limitations:output.limitations.map(decodeStatement),verification:output.verification.map(decodeStatement)});
   const section=output.dimensionSection;return MarketOverviewDimensionSynthesisOutputSchema.parse({...output,dimensionSection:{...section,data:decodeStatement(section.data),meaning:decodeStatement(section.meaning),conclusion:decodeStatement(section.conclusion),limitations:section.limitations.map(decodeStatement),verification:section.verification.map(decodeStatement)}});
  }});
}
