import {z} from 'zod';
import {compactOverviewMetrics,expandOverviewMetrics,MarketOverviewMetricTableSchema} from './market-overview-metric-table';
import {MarketOverviewExplanationInputSchema,type MarketSemanticInput} from '../../shared/market-semantic-contracts';

const reject=():never=>{throw new z.ZodError([{code:'custom',path:[],message:'Output reference is not a supplied local identifier'}]);};
/** A reversible transport encoding, never a new evidence source. Canonical
 * IDs remain in the saved binding. Text, numbers, units and relations are intact;
 * output IDs are decoded before the ordinary input-bound validation and audit. */
export function marketOverviewWire(input:MarketSemanticInput){
 if(input.task!=='market-overview-explanation'||!input.analysisBrief?.referenceEncoding)return {input,encoding:'canonical/v1',decode:(value:unknown)=>value};
 const aliases=new Map<string,Map<string,string>>(),originals=new Map<string,Map<string,string>>();
 const register=(kind:string,ids:string[],suffix=false)=>{const unique=[...new Set(ids)],forward=new Map<string,string>(),reverse=new Map<string,string>();unique.forEach((id,i)=>{const tail=suffix?'_'+id.split(/[/:]/).at(-1)!.replace(/[^A-Za-z0-9_-]/g,'').slice(0,input.analysisBrief?.referenceEncoding==='metric-table/v1'?48:undefined):'';const alias=`${kind}${i}${tail}`;forward.set(id,alias);reverse.set(alias,id);});aliases.set(kind,forward);originals.set(kind,reverse);};
 register('m',[...input.metrics.map(m=>m.metricId),...input.gaps.flatMap(g=>g.metricId?[g.metricId]:[])],true);
 register('f',input.facts.map(f=>f.factId));register('g',input.gaps.map(g=>g.gapId));register('s',input.sourceRefs);register('d',input.analysisBrief.dimensions.map(d=>d.id));register('o',input.interpretationOptions.map(o=>o.optionId));register('a',input.validationOptions.map(a=>a.actionId));
 const fields:Record<string,string>={metricId:'m',metricRefs:'m',numeratorRef:'m',denominatorRef:'m',factId:'f',factIds:'f',allowedFactIds:'f',requiredFactIds:'f',gapId:'g',gapIds:'g',allowedGapIds:'g',requiredGapIds:'g',sourceRef:'s',sourceRefs:'s',evidenceRefs:'s',dimensionId:'d',optionId:'o',actionId:'a'};
 const change=(value:unknown,decode:boolean):unknown=>{
  const dictionaries=decode?originals:aliases;
  const ref=(kind:string,v:unknown):unknown=>v===null?null:typeof v==='string'?dictionaries.get(kind)?.get(v)??reject():Array.isArray(v)?v.map(x=>ref(kind,x)):reject();
  const walk=(v:unknown):unknown=>{if(Array.isArray(v))return v.map(walk);if(v===null||typeof v!=='object')return v;
    const row=v as Record<string,unknown>;return Object.fromEntries(Object.entries(row).map(([k,value])=>[k,fields[k]?ref(fields[k],value):k==='id'&&'factIds' in row&&'gapIds' in row?ref('d',value):walk(value)]));};
  return walk(value);
 };
 const canonical=MarketOverviewExplanationInputSchema.parse(change(input,false));
 if(input.analysisBrief.referenceEncoding==='metric-table/v1')return {input:compactOverviewMetrics(canonical),inputSchema:MarketOverviewMetricTableSchema,encoding:'metric-table/v1',decode:(value:unknown)=>change(value&&typeof value==='object'&&'metricColumns' in value?expandOverviewMetrics(value):value,true)};
 return {input:canonical,encoding:'local-identifiers/v1',decode:(value:unknown)=>change(value,true)};
}
