import type {UsageEvent,UsageQuery,UsageMetrics} from "../../shared/usage-analytics-contracts";
import {usageEmptyMetrics} from "../../shared/usage-analytics-contracts";
const DAY=86_400_000, OFFSET=28_800_000;
export const beijingDate=(ms:number)=>new Date(ms+OFFSET).toISOString().slice(0,10);
export function usageRange(query:Pick<UsageQuery,"period"|"date">){
  const base=Date.parse(query.date+"T00:00:00.000Z");
  if(!Number.isFinite(base)||new Date(base).toISOString().slice(0,10)!==query.date)throw new Error("日期无效");
  let start=base,end=base+DAY;
  if(query.period==="week"){start=base-((new Date(base).getUTCDay()+6)%7)*DAY;end=start+7*DAY}
  if(query.period==="month"){const d=new Date(base);start=Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),1);end=Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1)}
  return{start:new Date(start-OFFSET).toISOString(),end:new Date(end-OFFSET).toISOString()};
}
export function unionDuration(intervals:number[][]):number{
  let end=-Infinity,total=0;
  for(const [a,b] of intervals.toSorted((x,y)=>x[0]-y[0])){total+=Math.max(0,b-Math.max(a,end));end=Math.max(end,b)}
  return total;
}
export type UsageDaily=UsageMetrics&{day:string;scope:"user"|"page";pageKey:string;lastActivityAt:string|null};
export function aggregateUsageEvents(events:readonly UsageEvent[]):UsageDaily[]{
  const groups=new Map<string,{row:UsageDaily;visible:number[][];active:number[][]}>();
  function group(day:string,pageKey:string,scope:"user"|"page"){
    const key=day+"|"+scope+"|"+pageKey;
    if(!groups.has(key))groups.set(key,{row:{...usageEmptyMetrics(),day,scope,pageKey,lastActivityAt:null},visible:[],active:[]});
    return groups.get(key)!;
  }
  for(const event of events){
    const start=Date.parse(event.kind==="duration"?event.startedAt:event.at);
    const end=event.kind==="duration"?Date.parse(event.endedAt):start;
    for(let point=start;point<=end;){
      const day=beijingDate(point),boundary=Date.parse(day+"T00:00:00.000Z")-OFFSET+DAY;
      const segmentEnd=Math.min(end,boundary);
      if(event.kind==="duration"&&segmentEnd<=point)break;
      for(const g of [group(day,"","user"),group(day,event.pageKey,"page")]){
        if(event.kind==="duration")g[event.metric].push([point,segmentEnd]);
        else if(event.kind==="visit")g.row.visits++;
        else g.row.clicks+=event.count;
        const activity=event.kind==="duration"&&event.metric==="visible"?null:new Date(segmentEnd).toISOString();
        if(activity&&(!g.row.lastActivityAt||activity>g.row.lastActivityAt))g.row.lastActivityAt=activity;
      }
      if(event.kind!=="duration"||segmentEnd===end)break;
      point=boundary;
    }
  }
  return [...groups.values()].map(g=>({...g.row,visibleMs:unionDuration(g.visible),activeMs:unionDuration(g.active)}));
}
