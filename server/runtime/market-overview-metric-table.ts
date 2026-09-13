import {z} from 'zod';
import {MarketOverviewExplanationInputSchema,MarketOverviewMetricSchema,type MarketOverviewExplanationInput} from '../../shared/market-semantic-contracts';
import {canonicalJsonSha256 as digest} from './model-request-accounting';

const id=z.string().min(1).max(160),ref=id.nullable();
const context=MarketOverviewMetricSchema.omit({metricId:true,value:true,numeratorRef:true,denominatorRef:true}).extend({contextId:id});
const columns=z.tuple([z.literal('metricId'),z.literal('value'),z.literal('contextId'),z.literal('numeratorRef'),z.literal('denominatorRef')]);
// Input schemas are local validators, not provider output schemas. Tuples here
// are JSON table rows; the provider still receives the normal analysis output schema.
export const MarketOverviewMetricTableSchema=z.object({...MarketOverviewExplanationInputSchema.shape,
 metrics:z.array(z.tuple([id,z.number().finite(),id,ref,ref])).max(128),metricColumns:columns,metricContexts:z.array(context).max(128),
}).strict();
export function compactOverviewMetrics(input:MarketOverviewExplanationInput){
 const contexts:z.infer<typeof context>[]=[],known=new Map<string,string>();
 const metrics=input.metrics.map(({metricId,value,numeratorRef,denominatorRef,...metadata})=>{const hash=digest(metadata);let contextId=known.get(hash);if(!contextId){contextId=`c${contexts.length}`;known.set(hash,contextId);contexts.push({contextId,...metadata});}return [metricId,value,contextId,numeratorRef,denominatorRef] as const;});
 return MarketOverviewMetricTableSchema.parse({...input,metrics,metricColumns:['metricId','value','contextId','numeratorRef','denominatorRef'],metricContexts:contexts});
}
export function expandOverviewMetrics(value:unknown){
 const {metricColumns:_columns,metricContexts,metrics,...input}=MarketOverviewMetricTableSchema.parse(value),contexts=new Map(metricContexts.map(c=>[c.contextId,c]));
 if(contexts.size!==metricContexts.length)throw new TypeError('Duplicate metric context');
 const used=new Set<string>();
 const expanded=metrics.map(([metricId,value,contextId,numeratorRef,denominatorRef])=>{const c=contexts.get(contextId);if(!c)throw new TypeError('Unknown metric context');used.add(contextId);const {contextId:_id,...metadata}=c;return {...metadata,metricId,value,numeratorRef,denominatorRef};});
 if(used.size!==contexts.size)throw new TypeError('Unused metric context');
 return MarketOverviewExplanationInputSchema.parse({...input,metrics:expanded});
}
