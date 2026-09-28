import { z } from 'zod';
import { MarketSourceIdentityValueSchemas } from './market-source-contracts';
import { MarketKeywordSemanticsInputSchema } from './market-semantic-contracts';

export const MARKET_KEYWORD_FLOW_VERSION = 'market-keyword-flow/v1';
export const MARKET_KEYWORD_RULES_FLOW_VERSION = 'market-keyword-flow/rules-v1';
export const isMarketKeywordGlobalMode=(value:unknown):value is 'global-reconciliation/v1'|'global-reconciliation/v2'=>value==='global-reconciliation/v1'||value==='global-reconciliation/v2';
const plannedPages = z.array(z.object({ seed: MarketSourceIdentityValueSchemas.keyword, page: MarketSourceIdentityValueSchemas.page }).strict())
  .min(1).max(100).refine(pages => new Set(pages.map(p => JSON.stringify([p.seed, p.page]))).size === pages.length, 'Duplicate planned page');
export const MarketKeywordStartRequestSchema = z.object({
  paginationMode:z.literal('until-short-page/v1').optional(),
  supplementalSources:z.literal('sif-aba/v1').optional(),
  analysisMode:z.enum(['global-reconciliation/v1','global-reconciliation/v2']).optional(),
  plannedPages,
  maxMembers: z.number().int().min(1).max(2000),
  catalog: MarketKeywordSemanticsInputSchema.pick({ task: true, dictionaryVersion: true, categoryContext: true, dimensionLabels: true, clusterCatalog: true, discoveryMode:true,outputProtocol:true }),
}).strict().superRefine((v,ctx)=>{
  if(v.paginationMode){
    const counts=new Map<string,number>();
    for(const p of v.plannedPages){const next=(counts.get(p.seed)??0)+1;if(p.page!==next)ctx.addIssue({code:'custom',path:['plannedPages'],message:'Automatic pages must start at one and be consecutive per seed'});counts.set(p.seed,next);}
  }
  if((v.analysisMode==='global-reconciliation/v2')!==(v.catalog.outputProtocol==='explicit-shape/v1')||v.analysisMode==='global-reconciliation/v2'&&v.catalog.discoveryMode!=='labels-and-clusters/v1')
    ctx.addIssue({code:'custom',path:['catalog','outputProtocol'],message:'Explicit output protocol requires the versioned discovery/reconciliation flow'});
});
export const MarketKeywordFlowParamsSchema = MarketKeywordStartRequestSchema.safeExtend({ flow: z.enum([MARKET_KEYWORD_FLOW_VERSION, MARKET_KEYWORD_RULES_FLOW_VERSION]) });
