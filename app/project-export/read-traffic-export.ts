import { ApiErrorResponseSchema, GetReportResponseSchema, GetRunResponseSchema, ListReportsResponseSchema, LocalDataStageOutputResponseSchema, TrafficSnapshotReadResponseSchema, type AnalysisReport, type TrafficSnapshotReadResponse } from '../../shared/agent-contracts';
import { buildSavedAnalysisReportView } from '../lib/saved-analysis-reports';
import type { ExportModuleContext, ExportModuleRead } from './export-module-context';
import type { ExportSection } from './export-contracts';
import { buildTrafficExportSection } from './traffic-export-section';

function same(left: readonly string[], right: readonly string[]) { return left.length===right.length && new Set(left).size===left.length && [...left].sort().every((asin,index)=>asin===[...right].sort()[index]); }
function canonical(value: unknown): unknown { if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)]));return value; }
const signature=(value:unknown)=>JSON.stringify(canonical(value));

/** GET-only reads of the exact authorized run. A published traffic stage never falls back to dynamic/global values. */
export async function readTrafficExportSection(context: ExportModuleContext, fetcher: ExportModuleRead): Promise<ExportSection> {
  if(!context.asins.length || context.asins.some(asin=>!context.sourceAsins.includes(asin)))throw Error('流量导出范围不匹配');
  const read: ExportModuleRead=(path,init)=>fetcher(path,{...init,method:'GET',cache:'no-store'});
  const json=async(path:string)=>{
    const response=await read(path);let body:unknown;
    try{body=await response.json();}catch{throw Error('流量读取响应格式无效');}
    if(!response.ok)throw Error(`流量读取失败（${response.status}）`);
    return body;
  };
  const checkedRuns=new Set<string>();
  const verifyRun=async(runId:string)=>{
    if(checkedRuns.has(runId))return;
    const parsed=GetRunResponseSchema.safeParse(await json(`/v1/runs/${encodeURIComponent(runId)}`));
    if(!parsed.success||parsed.data.run.id!==runId||parsed.data.run.projectId!==context.projectId)throw Error('流量运行批次归属范围不匹配');
    checkedRuns.add(runId);
  };
  const version=context.version;
  if(version) {
    if(version.organizationId!==context.organizationId||version.projectId!==context.projectId||version.marketplace!==context.marketplace
      ||context.asins.some(asin=>!version.asins.includes(asin))||version.asins.some(asin=>!context.sourceAsins.includes(asin)))throw Error('流量发布版本范围不匹配');
    const stage=version.stageOutputs.traffic;
    if(stage&&stage.stageStatus!=='missing-output') {
      const parsed=LocalDataStageOutputResponseSchema.safeParse(stage);
      if(!parsed.success||parsed.data.stage!=='traffic'||parsed.data.projectId!==version.projectId||parsed.data.runId!==version.runId||parsed.data.jobId!==version.jobId)throw Error('流量阶段归属范围不匹配');
    }
  }
  const runId=context.currentRunId??null;
  if(runId)await verifyRun(runId);
  const readSnapshot=async():Promise<TrafficSnapshotReadResponse|null>=>{
    if(version||!runId)return null;
    const response=await read(`/v1/runs/${encodeURIComponent(runId)}/traffic-snapshot`);
    let body:unknown;try{body=await response.json();}catch{throw Error('流量快照响应格式无效');}
    if(response.status===404) {
      const error=ApiErrorResponseSchema.safeParse(body);
      if(error.success&&error.data.error.code==='NOT_FOUND')return null;
    }
    if(!response.ok)throw Error(`流量快照读取失败（${response.status}）`);
    const parsed=TrafficSnapshotReadResponseSchema.safeParse(body);
    if(!parsed.success||parsed.data.marketplace!==context.marketplace||!same(parsed.data.asins,context.sourceAsins))throw Error('流量快照范围或格式不匹配');
    const returned=parsed.data.traffic.competitors.map(item=>item.asin);
    if(new Set(returned).size!==returned.length||returned.some(asin=>!context.sourceAsins.includes(asin)))throw Error('流量快照商品范围不匹配');
    return parsed.data;
  };
  const snapshot=await readSnapshot();
  let report:AnalysisReport|null=null;
  if(runId) {
    const {reports}=ListReportsResponseSchema.parse(await json(`/v1/runs/${encodeURIComponent(runId)}/reports`));
    const slot=buildSavedAnalysisReportView(runId,reports).stages.find(item=>item.stage==='traffic-analysis');
    const selected=slot?.selected;
    if(selected) {
      // Comparative prose and evidence refer to the complete source project, not only listed competitors.
      if(!same(context.asins,context.sourceAsins))throw Error('已保存流量报告覆盖完整来源项目，当前导出范围不匹配');
      const result=GetReportResponseSchema.parse(await json(`/v1/reports/${encodeURIComponent(selected.id)}`)).report;
      if(result.id!==selected.id||result.runId!==runId||result.stage!=='traffic-analysis'||signature(result)!==signature(selected))throw Error('已保存流量报告来源不匹配或读取期间变化');
      const competitors=result.result.competitors;
      if(!Array.isArray(competitors)||competitors.some(item=>!item||typeof item!=='object'||!('asin'in item)||typeof item.asin!=='string'||!context.asins.includes(item.asin)))throw Error('已保存流量报告商品范围不匹配');
      report=result;
    }
  }
  if(!version&&runId&&signature(snapshot)!==signature(await readSnapshot()))throw Error('流量快照在准备期间变化，请重新准备');
  return buildTrafficExportSection(context,{snapshot,report});
}
