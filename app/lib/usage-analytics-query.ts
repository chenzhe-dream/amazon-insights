import {UsageReportSchema,UsagePeopleResponseSchema,type UsageQuery} from "../../shared/usage-analytics-contracts";
import {localAgentFetch,localAgentErrorMessage} from "./local-agent-browser";
export const beijingToday=(now=new Date())=>new Date(now.getTime()+28_800_000).toISOString().slice(0,10);
export function usageQueryPath(query:UsageQuery){
  const params=new URLSearchParams({period:query.period,date:query.date});
  if(query.userId)params.set("userId",query.userId);if(query.pageKey)params.set("pageKey",query.pageKey);
  return "/v1/admin/usage?"+params;
}
async function read(path:string,signal:AbortSignal){
  const response=await localAgentFetch(path,{signal});
  const body=await response.json().catch(()=>null);
  if(!response.ok)throw new Error(localAgentErrorMessage(body,response.status===403?"无权查看使用统计":"统计读取失败，请重试"));
  return body;
}
export const fetchUsageReport=async(query:UsageQuery,signal:AbortSignal)=>UsageReportSchema.parse(await read(usageQueryPath(query),signal));
export const searchUsagePeople=async(text:string,signal:AbortSignal)=>UsagePeopleResponseSchema.parse(await read("/v1/admin/usage/people?"+new URLSearchParams({q:text.trim(),limit:"20"}),signal));
export function highlightParts(text:string,query:string){
  const needle=query.trim().toLowerCase();if(!needle)return[{text,hit:false}];
  const parts:{text:string;hit:boolean}[]=[];let start=0,index=text.toLowerCase().indexOf(needle);
  while(index>=0){if(index>start)parts.push({text:text.slice(start,index),hit:false});parts.push({text:text.slice(index,index+needle.length),hit:true});start=index+needle.length;index=text.toLowerCase().indexOf(needle,start)}
  if(start<text.length)parts.push({text:text.slice(start),hit:false});return parts;
}
