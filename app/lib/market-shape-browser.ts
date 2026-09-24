import {MarketShapeReferenceRevisionResponseSchema,MarketShapeReferenceRevisionRequestSchema} from '../../shared/market-shape-reference-revision-contracts';
import { z } from 'zod';
import { MarketModuleIdSchema } from '../../shared/market-module-contracts';
import { MarketShapeStartRequestSchema, MarketShapeRevisionRequestSchema } from '../../shared/market-shape-price-contracts';
import { MarketShapeRunResponseSchema, MarketShapeRevisionResponseSchema, MarketShapeRevisionIdSchema } from '../../shared/market-shape-public-contracts';
import { localAgentFetch, localAgentErrorMessage } from './local-agent-browser';
import {MarketShapeExplanationRunResponseSchema} from '../../shared/market-shape-explanation-public-contracts';
export { createThemeStudy as createShapeStudy, retryThemeSteps as retryShapeSteps, cancelThemeRun as cancelShapeRun } from './market-theme-browser';
async function request<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}) {
    init.signal?.throwIfAborted();
    const response = await localAgentFetch(`/v1/market-analysis/${path}`, { ...init, cache: 'no-store' }), body: unknown = await response.json().catch(() => null);
    init.signal?.throwIfAborted();
    if (!response.ok)
        throw new Error(localAgentErrorMessage(body, '形态分析请求失败，请保留输入并重试。'));
    const parsed = schema.safeParse(body);
    if (!parsed.success)
        throw new Error('形态分析响应格式不正确，未加载该结果。');
    return parsed.data;
}
const post = (body: unknown, key: string, signal?: AbortSignal): RequestInit => ({ method: 'POST', headers: { 'idempotency-key': MarketModuleIdSchema.parse(key) }, signal, body: JSON.stringify(body) });
export async function startShapeRun(studyId: string, body: unknown, key: string, signal?: AbortSignal) {
    const study = MarketModuleIdSchema.parse(studyId), params = MarketShapeStartRequestSchema.parse(body), result = await request(`studies/${study}/shape-price`, MarketShapeRunResponseSchema, post(params, key, signal));
    if (result.run.scope.researchId !== study || JSON.stringify(result.run.params) !== JSON.stringify(params))
        throw new Error('研究范围或参数不一致。');
    return result.run;
}
export async function readShapeRun(id: string, signal?: AbortSignal) { const runId = MarketModuleIdSchema.parse(id), result = await request(`runs/${runId}/shape-price`, MarketShapeRunResponseSchema, { signal }); if (result.run.id !== runId)
    throw new Error('任务身份不一致。'); return result.run; }
export async function saveShapeRevision(id: string, body: unknown, key: string, signal?: AbortSignal) {
    return (await saveShapeRevisionAnalysis(id,body,key,signal)).revision;
}
export async function saveShapeRevisionAnalysis(id: string, body: unknown, key: string, signal?: AbortSignal) {
    const params = MarketShapeRevisionRequestSchema.parse(body), result = await request(`runs/${MarketModuleIdSchema.parse(id)}/shape-price/revisions`, MarketShapeRevisionResponseSchema, post(params, key, signal));
    if (result.revision.parentRevisionId !== params.expectedParentRevisionId || result.revision.taxonomyVersion !== params.taxonomyVersion || [...result.revision.selectedAsins].sort().join() !== [...params.selectedAsins].sort().join())
        throw new Error('保存版本与人工选择不一致。');
    return result;
}
export async function readShapeRevision(id: string, revisionId: string, signal?: AbortSignal) {
    return (await readShapeRevisionAnalysis(id,revisionId,signal)).revision;
}
export async function readShapeRevisionAnalysis(id: string, revisionId: string, signal?: AbortSignal) {
    const revision = MarketShapeRevisionIdSchema.parse(revisionId), result = await request(`runs/${MarketModuleIdSchema.parse(id)}/shape-price/revisions/${encodeURIComponent(revision)}`, MarketShapeRevisionResponseSchema, { signal });
    if (result.revision.revisionId !== revision)
        throw new Error('报告版本不一致。');
    return result;
}
export async function readShapeExplanation(id:string,revisionId:string,signal?:AbortSignal){
 const runId=MarketModuleIdSchema.parse(id),revision=MarketShapeRevisionIdSchema.parse(revisionId);
 const {run}=await request(`runs/${runId}/shape-explanation`,MarketShapeExplanationRunResponseSchema,{signal});
 if(run.id!==runId||run.revisionId!==revision||run.report&&(run.report.moduleRunId!==runId||run.report.revisionId!==revision||run.report.explanation.revisionId!==revision)||run.presentation&&(run.presentation.revisionId!==revision||run.presentation.explanationCatalogId!==run.report?.explanationCatalogId))throw new Error('解释任务或报告版本不一致，未加载该结果。');
 return run;
}

export async function saveShapeReferenceRevision(id:string,body:unknown,key:string,signal?:AbortSignal){
 const params=MarketShapeReferenceRevisionRequestSchema.parse(body),result=await request(`runs/${MarketModuleIdSchema.parse(id)}/shape-price/revisions`,MarketShapeReferenceRevisionResponseSchema,post(params,key,signal));
 if(result.revision.parentRevisionId!==params.expectedParentRevisionId||[...result.revision.selectedAsins].sort().join()!==[...params.selectedAsins].sort().join())throw Error('保存版本与人工选择不一致。');
 return result.revision;
}
export async function readShapeReferenceRevision(id:string,revisionId:string,signal?:AbortSignal){
 const revision=MarketShapeRevisionIdSchema.parse(revisionId),result=await request(`runs/${MarketModuleIdSchema.parse(id)}/shape-price/revisions/${encodeURIComponent(revision)}`,MarketShapeReferenceRevisionResponseSchema,{signal});
 if(result.revision.revisionId!==revision)throw Error('报告版本不一致。');return result.revision;
}
