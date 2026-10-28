import {z} from 'zod';
import type {MarketKeywordRunResponse} from '../../shared/market-keyword-public-contracts';
import {MarketStudyRequestSchema} from '../../shared/market-module-contracts';
const dimensions=['W1','W2','W3','W4'] as const;
const query=z.object({sourceMode:z.literal('category-keywords').optional(),selection:z.object({marketplace:MarketStudyRequestSchema.shape.marketplace,nodeIdPath:MarketStudyRequestSchema.shape.nodeIdPath,fromMonth:MarketStudyRequestSchema.shape.fromMonth,toMonth:MarketStudyRequestSchema.shape.toMonth}),seeds:z.string().max(20000),context:z.string().max(4000),pageCount:z.number().int().min(1).max(100),maxMembers:z.number().int().min(1).max(2000),labels:z.object({W1:z.string(),W2:z.string(),W3:z.string(),W4:z.string()}),paginationMode:z.literal('until-short-page/v1').optional()});
const entry=z.object({runId:z.string().uuid(),createdAt:z.string().datetime(),query,status:z.enum(['queued','running','partial','succeeded','failed','cancelled'])}).strict();
export type KeywordQuery=z.infer<typeof query>;
export type KeywordQueryEntry=z.infer<typeof entry>;
export const KEYWORD_QUERY_TTL=7*86400000;
export function keywordQueryFromRun(run:MarketKeywordRunResponse['run']):KeywordQuery{
 const {marketplace,nodeIdPath,fromMonth,toMonth}=run.scope;
 return {...(run.params.plannedPages[0]?.sourceMode?{sourceMode:run.params.plannedPages[0].sourceMode}:{}),selection:{marketplace,nodeIdPath,fromMonth,toMonth},seeds:[...new Set(run.params.plannedPages.map(p=>p.seed))].join('\n'),context:run.params.catalog.categoryContext,pageCount:Math.max(...run.params.plannedPages.map(p=>p.page)),maxMembers:run.params.maxMembers,
 labels:Object.fromEntries(dimensions.map(d=>[d,run.params.catalog.dimensionLabels[d].map(l=>`${l.label}|${l.definition}`).join('\n')])) as KeywordQuery['labels'],...(run.params.paginationMode?{paginationMode:run.params.paginationMode}:{})};
}
export function keywordQueryKey(q:KeywordQuery){
 return JSON.stringify({sourceMode:q.sourceMode??'seed-extensions',marketplace:q.selection.marketplace,node:q.selection.nodeIdPath.split(':').at(-1),from:q.selection.fromMonth,to:q.selection.toMonth,seeds:q.seeds.split('\n').map(s=>s.trim().replace(/\s+/g,' ')).filter(Boolean),context:q.context.trim(),pages:q.pageCount,max:q.maxMembers,labels:dimensions.map(d=>q.labels[d].trim()),pagination:q.paginationMode??'fixed'});
}
export function readKeywordQueries(raw:string|null):KeywordQueryEntry[]{try{const result=z.array(entry).max(20).safeParse(JSON.parse(raw??'[]'));return result.success?result.data:[];}catch{return [];}}
export function rememberKeywordQuery(entries:KeywordQueryEntry[],run:MarketKeywordRunResponse['run']){
 const next:KeywordQueryEntry={runId:run.id,createdAt:run.createdAt,query:keywordQueryFromRun(run),status:run.status};
 return [next,...entries.filter(e=>e.runId!==run.id)].slice(0,20);
}
export function findReusableKeywordQuery(entries:KeywordQueryEntry[],q:KeywordQuery,now=Date.now()){
 const key=keywordQueryKey(q);
 return entries.find(e=>e.status!=='failed'&&e.status!=='cancelled'&&Date.parse(e.createdAt)<=now&&now-Date.parse(e.createdAt)<KEYWORD_QUERY_TTL&&keywordQueryKey(e.query)===key);
}
