import {z} from 'zod';
import {MarketResearchScopeSchema} from './market-research-contracts';
import {MarketModuleIdSchema} from './market-module-contracts';
import {MarketKeywordStartRequestSchema} from './market-keyword-flow-contracts';

export const linkedModules=['overview','shapes','keywords','themes'] as const;
export type LinkedModule=typeof linkedModules[number];
export const linkedModuleLabels:Record<LinkedModule,string>={overview:'市场总览',shapes:'商品形态及价格带',keywords:'类目关键词洞察',themes:'买家评论见解'};
export const MarketLinkedRequestSchema=z.object({scope:MarketResearchScopeSchema,fromMonth:z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/),forceRefresh:z.boolean().optional()}).strict()
 .refine(v=>v.scope.month!=='last30'&&v.fromMonth<=v.scope.month,'四模块联动请选择完整自然月，最近30天只适用于单独总览');
export type MarketLinkedRequest=z.infer<typeof MarketLinkedRequestSchema>;
const moduleState=z.object({status:z.enum(['pending','started','blocked','failed']),runId:MarketModuleIdSchema.nullable(),message:z.string().nullable()}).strict();
export const MarketLinkedResponseSchema=z.object({batch:z.object({id:MarketModuleIdSchema,request:MarketLinkedRequestSchema,
 basicJobId:z.string().uuid(),basicRetryable:z.boolean(),basicStatus:z.enum(['queued','running','succeeded','partial','failed']).optional(),basicMessage:z.string().nullable().optional(),
 status:z.enum(['pending','started','partial','failed']),message:z.string().nullable(),categoryName:z.string().nullable(),categoryNameSource:z.enum(['sellersprite','sorftime']).nullable().optional(),resolvedNodeIdPath:z.string().regex(/^\d+(?::\d+)*$/).nullable(),
 modules:z.object({overview:moduleState,shapes:moduleState,keywords:moduleState,themes:moduleState}).strict()}).strict()}).strict();
export type MarketLinkedBatch=z.infer<typeof MarketLinkedResponseSchema>['batch'];
export const MarketLinkedRetrySchema=z.object({modules:z.array(z.enum(linkedModules)).max(4).default([]),basic:z.boolean().default(false)}).strict();
export function linkedModuleParams(module:LinkedModule,categoryName:string|null,newProductMonths:number,headTopN=10):unknown{
 if(module==='overview')return {headTopN,newProductMonths,sampleSize:100};
 if(module==='shapes')return {poolSize:100,newProductMonths,catalog:{task:'market-product-shape-suggestion',taxonomyVersion:'manual-after-collection/v1',allowedLabels:[]}};
 if(module==='themes')return {memberCount:20,poolSize:100,newProductMonths};
 const seed=categoryName?.trim();
 if(!seed||!/[\p{L}]/u.test(seed)||/^Node\s*[\d:]+$/i.test(seed))throw new Error('类目名称尚未取得，不能用类目数字代替关键词；可在关键词模块输入产品名称单独分析。');
 return MarketKeywordStartRequestSchema.parse({paginationMode:'until-short-page/v1',analysisMode:'global-reconciliation/v2',supplementalSources:'sif-aba/v1',plannedPages:Array.from({length:5},(_,i)=>({seed,page:i+1})),maxMembers:100,
 catalog:{task:'market-keyword-semantics',dictionaryVersion:'keyword-discovery-catalog/v1',discoveryMode:'labels-and-clusters/v1',outputProtocol:'explicit-shape/v1',categoryContext:seed,dimensionLabels:{W1:[],W2:[],W3:[],W4:[]},clusterCatalog:[]}});
}
