import {MarketShapeDraftResponseSchema,MarketShapeDraftSaveRequestSchema,type MarketShapeDraft,type MarketShapeDraftItem} from '../../shared/market-shape-draft-contracts';
import {MarketModuleIdSchema} from '../../shared/market-module-contracts';
import type {MarketAnalysisScope} from '../../shared/market-analysis-contracts';
import {localAgentErrorMessage,localAgentFetch} from './local-agent-browser';

export function shapeDraftStorageKey(scope:MarketAnalysisScope,userId:string){
  return `market-shape-draft/v1/${scope.organizationId}/${userId}/${scope.marketplace}/${scope.nodeIdPath}`;
}

export function projectShapeDraft(asins:readonly string[],items:readonly MarketShapeDraftItem[]){
  const byAsin=new Map(items.map(item=>[item.asin,item]));
  return {
    selectedAsins:asins.filter(asin=>byAsin.get(asin)?.included!==false),
    assignments:Object.fromEntries(asins.flatMap(asin=>{
      const label=byAsin.get(asin)?.label;
      return label===null||label===undefined?[]:[[asin,label]];
    })) as Record<string,string>,
  };
}

export function restoreShapeDraftItems(previous:readonly MarketShapeDraftItem[],snapshotAsins:readonly string[],selectedAsins:readonly string[],assignments:readonly {asin:string;label:string|null}[]):MarketShapeDraftItem[]{
  const inSnapshot=new Set(snapshotAsins),selected=new Set(selectedAsins),names=new Map(assignments.map(item=>[item.asin,item.label]));
  return [...previous.filter(item=>!inSnapshot.has(item.asin)),...snapshotAsins.map(asin=>({asin,included:selected.has(asin),label:names.get(asin)??null}))].sort((a,b)=>a.asin.localeCompare(b.asin));
}

export async function readShapeDraft(runId:string,signal?:AbortSignal):Promise<MarketShapeDraft>{
  const id=MarketModuleIdSchema.parse(runId);
  const response=await localAgentFetch(`/v1/market-analysis/runs/${id}/shape-price/draft`,{signal,cache:'no-store'});
  const body:unknown=await response.json().catch(()=>null);
  if(!response.ok)throw Object.assign(new Error(localAgentErrorMessage(body,'草稿读取失败')), {status:response.status});
  return MarketShapeDraftResponseSchema.parse(body).draft;
}

export async function saveShapeDraft(runId:string,request:unknown,idempotencyKey:string,signal?:AbortSignal):Promise<MarketShapeDraft>{
  const id=MarketModuleIdSchema.parse(runId),key=MarketModuleIdSchema.parse(idempotencyKey),input=MarketShapeDraftSaveRequestSchema.parse(request);
  const response=await localAgentFetch(`/v1/market-analysis/runs/${id}/shape-price/draft`,{method:'PUT',headers:{'idempotency-key':key},body:JSON.stringify(input),signal,cache:'no-store'});
  const body:unknown=await response.json().catch(()=>null);
  if(!response.ok)throw Object.assign(new Error(localAgentErrorMessage(body,'草稿保存失败，已保留本地编辑')), {status:response.status});
  return MarketShapeDraftResponseSchema.parse(body).draft;
}
