import {localAgentFetch} from './local-agent-browser';
import {isSyncJobScopeMatch} from './asin-sync-session';

type ProjectScope={id:string;kind?:string;marketplace:string;asins:string[];sourceProjectId?:string|null};
export type HistoricalSyncPointer=Readonly<{projectId:string;runId:string;jobId:string}>;
// Incident recovery stays scoped until the remaining saved projects are inventoried.
export const priorityRecoveryProjectId='75a3f965-07e8-468e-aec7-bce265515023';
type Fetcher=(path:string)=>Promise<Response>;
class SyncPointerError extends Error {}
async function readJson(fetcher:Fetcher,path:string,label:string){
 const response=await fetcher(path);
 if(!response.ok){
  if(response.status===401)throw new SyncPointerError('登录已失效，请重新登录后处理图片');
  if(response.status===403)throw new SyncPointerError('当前账号没有读取该项目同步记录的权限');
  if(response.status===404)throw new SyncPointerError(`${label}不存在或已无权访问；收藏页请先打开来源分析项目`);
  throw new SyncPointerError(`读取${label}失败（${response.status}），请稍后重试`);
 }
 try{return await response.json();}catch{throw new SyncPointerError(`${label}返回格式异常，请稍后重试`);}
}
export async function readHistoricalSyncPointer(project:ProjectScope,options:{fetcher?:Fetcher;strict?:boolean}={}):Promise<HistoricalSyncPointer|null>{
 try{
  if(project.kind&&project.kind!=='analysis')throw new SyncPointerError('当前是收藏项目，请先打开来源分析项目再处理图片');
  const fetcher=options.fetcher??localAgentFetch;
  const {project:p}=await readJson(fetcher,`/v1/projects/${encodeURIComponent(project.id)}`,'分析项目');
  if(p?.id!==project.id)throw new SyncPointerError('分析项目与当前页面不匹配');
  const versionResponse=await fetcher(`/v1/local-data/projects/${encodeURIComponent(project.id)}/current-display-version`);
  if(versionResponse.status!==404&&!versionResponse.ok)throw new SyncPointerError(`读取当前报告失败（${versionResponse.status}），请稍后重试`);
  const version=versionResponse.ok?await versionResponse.json():null;
  if(version&&(version.projectId!==project.id||version.marketplace!==project.marketplace||!Array.isArray(version.asins)||
    version.asins.length!==project.asins.length||!project.asins.every(asin=>version.asins.includes(asin))))
    throw new SyncPointerError('当前报告与分析项目范围不匹配');
  const currentResponse=!version&&project.id===priorityRecoveryProjectId
   ? await fetcher(`/v1/local-data/projects/${encodeURIComponent(project.id)}/current-sync-job`)
   : null;
  let runId:string,jobId:string;
  if(version){
   if(typeof version.runId!=='string'||!version.runId||typeof version.jobId!=='string'||!version.jobId)throw new SyncPointerError('当前报告编号无效');
   runId=version.runId;
   jobId=version.jobId;
  }else if(!currentResponse||currentResponse.status===404){
   if(p.currentRunId===null)return null;
   if(typeof p.currentRunId!=='string'||!p.currentRunId)throw new SyncPointerError('分析项目缺少有效运行编号');
   runId=p.currentRunId;
   const {run}=await readJson(fetcher,`/v1/runs/${encodeURIComponent(runId)}`,'分析运行记录');
   if(run?.id!==runId||run.projectId!==project.id||typeof run.idempotencyKey!=='string'||!run.idempotencyKey)throw new SyncPointerError('分析运行记录与当前项目不匹配');
   jobId=run.idempotencyKey;
  }else{
   if(!currentResponse.ok)throw new SyncPointerError(`读取当前同步结果失败（${currentResponse.status}），请稍后重试`);
   const current=await currentResponse.json();
   if(typeof current?.runId!=='string'||!current.runId||typeof current?.jobId!=='string'||!current.jobId)throw new SyncPointerError('当前同步结果编号无效');
   runId=current.runId;
   jobId=current.jobId;
  }
  const job=await readJson(fetcher,`/v1/local-data/sync-asins/${encodeURIComponent(jobId)}`,'基础同步任务');
  if(job?.jobId!==jobId||job.scope?.runId!==runId||!Array.isArray(job.asins)||!isSyncJobScopeMatch(job,{...project,projectId:project.id,runId}))throw new SyncPointerError('同步记录与当前项目、站点或商品范围不匹配');
  return {projectId:project.id,runId,jobId};
 }catch(error){
  if(options.strict)throw error instanceof SyncPointerError?error:new SyncPointerError('网络连接异常，未能读取同步记录，请重试');
  return null;
 }
}
export function eligibleImageSourceProjects<T extends ProjectScope>(collection:ProjectScope,local:T[],registered:Array<ProjectScope&{currentRunId?:string|null}>):T[]{
 return local.filter(candidate=>{
  if(candidate.kind&&candidate.kind!=='analysis')return false;
  if(collection.sourceProjectId&&collection.sourceProjectId!==candidate.id)return false;
  const authorized=registered.find(item=>item.id===candidate.id);
  return Boolean(authorized?.currentRunId&&authorized.marketplace===collection.marketplace&&candidate.marketplace===collection.marketplace&&collection.asins.every(asin=>authorized.asins.includes(asin)&&candidate.asins.includes(asin)));
 });
}
export async function sourceProjectIdForSave(projectId:string|null):Promise<string|null>{
 if(!projectId)return null;
 const {project}=await readJson(localAgentFetch,`/v1/local-data/projects/${encodeURIComponent(projectId)}`,'当前项目');
 if(project?.id!==projectId)throw new SyncPointerError('当前项目不匹配，请刷新后保存');
 if(project.kind&&project.kind!=='analysis')return project.sourceProjectId??null;
 const response=await localAgentFetch(`/v1/projects/${encodeURIComponent(projectId)}`);
 if(response.status===404)return null; // A saved ASIN pool can legitimately have no analysis yet.
 if(!response.ok)throw new SyncPointerError(`读取来源分析项目失败（${response.status}），请重试`);
 const payload=await response.json();
 return payload.project?.id===projectId?projectId:null;
}
