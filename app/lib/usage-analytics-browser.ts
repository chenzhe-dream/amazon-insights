import {USAGE_REPORT_INTERVAL_MS,USAGE_IDLE_THRESHOLD_MS,UsageActivityResponseSchema,type UsageEvent} from "../../shared/usage-analytics-contracts";
import {isUsagePage,type UsagePageKey,type USAGE_ACTIONS} from "../../shared/usage-page-catalog";
import {ActivityHeartbeatController,sendActivityHeartbeat} from "./activity-heartbeat";
import {localAgentFetch} from "./local-agent-browser";
import {UsageQueue} from "./usage-analytics-queue";
type Action=typeof USAGE_ACTIONS[number];
const timestamp=(ms:number)=>new Date(ms).toISOString();
export class UsageAccumulator{
  private page:UsagePageKey|null=null;
  private visible=false;private focused=false;private last=0;
  observedAt=0;
  private events:UsageEvent[]=[];
  private clicks=new Map<string,Extract<UsageEvent,{kind:"click"}>>();
  private segments=new Map<string,Extract<UsageEvent,{kind:"duration"}>>();
  constructor(private id:()=>string){}
  sample(now:number){
    const elapsed=now-this.last;
    if(this.page&&this.visible&&elapsed>0&&elapsed<=30_000){
      this.duration("visible",this.last,now);
      const end=Math.min(now,this.observedAt+USAGE_IDLE_THRESHOLD_MS);
      if(this.focused&&end>this.last)this.duration("active",this.last,end);
    }
    this.last=now;
  }
  private duration(metric:"visible"|"active",start:number,end:number){
    if(!this.page)return;const key=this.page+":"+metric,previous=this.segments.get(key);
    if(previous&&Date.parse(previous.endedAt)===start&&end-Date.parse(previous.startedAt)<=USAGE_REPORT_INTERVAL_MS)previous.endedAt=timestamp(end);
    else{const event={eventId:this.id(),kind:"duration" as const,pageKey:this.page,metric,startedAt:timestamp(start),endedAt:timestamp(end)};this.events.push(event);this.segments.set(key,event)}
  }
  setPage(page:UsagePageKey,now:number){
    if(page===this.page)return;
    this.sample(now);this.page=page;this.observedAt=now;
    this.events.push({eventId:this.id(),kind:"visit",pageKey:page,at:timestamp(now)});
  }
  setVisibility(visible:boolean,focused:boolean,now:number){
    this.sample(now);this.visible=visible;this.focused=focused;
    if(visible&&focused)this.observedAt=now;
  }
  interact(now:number){this.sample(now);this.observedAt=now}
  action(actionKey:Action,now:number){
    this.interact(now);if(!this.page||!this.visible)return;
    const key=this.page+":"+actionKey+":"+timestamp(now+8*60*60*1000).slice(0,10);
    const existing=this.clicks.get(key);
    if(existing&&existing.count<10000)existing.count++;
    else{const event={eventId:this.id(),kind:"click" as const,pageKey:this.page,actionKey,count:1,at:timestamp(now)};this.clicks.set(key,event);this.events.push(event)}
  }
  drain(){const events=this.events;this.events=[];this.clicks.clear();this.segments.clear();return events}
}
let lastPublished:UsagePageKey|null=null;
let activeFlush:(()=>Promise<void>)|null=null;
export function publishUsagePage(page:UsagePageKey){
  lastPublished=page;
  if(typeof window!=="undefined")window.dispatchEvent(new CustomEvent("usage-page",{detail:page}));
}
export async function flushUsageBeforeLogout(){
  await Promise.race([activeFlush?.(),new Promise(resolve=>setTimeout(resolve,300))]);
}
function uuid(){
  const b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;
  const s=[...b].map(n=>n.toString(16).padStart(2,"0")).join("");
  return s.slice(0,8)+"-"+s.slice(8,12)+"-"+s.slice(12,16)+"-"+s.slice(16,20)+"-"+s.slice(20);
}
function initialPage():UsagePageKey{
  const url=new URL(location.href);
  if(url.pathname.startsWith("/admin/users"))return url.searchParams.get("view")==="usage"?"admin-usage":"admin-users";
  const tab=url.searchParams.get("tab");
  if(tab==="market-overview"){const view=url.searchParams.get("themeView");return view==="shapes"?"market-shapes":view==="keywords"?"market-keywords":view==="themes"?"market-themes":"market-overview"}
  return isUsagePage(tab)?tab:"overview";
}
export function createUsageAnalyticsController(owner:{userId:string;organizationId:string}){
  const accountKey=JSON.stringify([owner.organizationId,owner.userId]),queue=new UsageQueue(accountKey),tabId=uuid(),acc=new UsageAccumulator(uuid);
  let stopped=false,unbound=false,blocked=false,sending:Promise<void>|null=null,saving=Promise.resolve();
  const persist=()=>{if(unbound||blocked){acc.drain();return saving}acc.sample(Date.now());const events=acc.drain();saving=saving.then(()=>queue.append(events)).catch(()=>undefined);return saving};
  async function send(reason:"scheduled"|"hidden"|"logout"){
    await persist();if(blocked)return;
    if(!await queue.claim(Date.now(),reason==="scheduled"?USAGE_REPORT_INTERVAL_MS:3000))return;
    let events=unbound?[]:await queue.read();
    const observedAt=timestamp(acc.observedAt||Date.now());
    // Smaller slices also fit keepalive's body quota; retain untouched IDs for retries.
    while(JSON.stringify(events).length>42000)events=events.slice(0,Math.max(1,Math.floor(events.length/2)));
    const response=await localAgentFetch("/v1/auth/activity",{method:"POST",keepalive:reason!=="scheduled",body:JSON.stringify(unbound?{}:{usage:{version:1,tabId,accountKey,observedAt,events}})});
    if(response.status===401){blocked=true;return}
    if(response.status===503){await sendActivityHeartbeat(new AbortController().signal);return}
    if(!response.ok)return;
    const parsed=UsageActivityResponseSchema.safeParse(await response.json());if(!parsed.success)return;
    if(parsed.data.usage?.status==="not_bound"){unbound=true;await queue.ack(events.map(e=>e.eventId));return}
    if(parsed.data.usage?.status==="recorded")await queue.ack(parsed.data.usage.acknowledgedEventIds);
  }
  function flush(reason:"scheduled"|"hidden"|"logout"):Promise<void>{
    if(sending)return sending;
    const work=()=>send(reason);
    const task=(async()=>{
      if(typeof navigator.locks?.request==="function")await navigator.locks.request("usage-send:"+accountKey,{ifAvailable:true},async lock=>{if(lock)await work()});
      else await work();
    })().catch(()=>{}).finally(()=>{sending=null});
    sending=task;return task;
  }
  const visible=()=>document.visibilityState==="visible";
  const onVisibility=()=>{acc.setVisibility(visible(),document.hasFocus(),Date.now());void persist();if(!visible())void flush("hidden")};
  const onFocus=()=>acc.setVisibility(visible(),document.hasFocus(),Date.now());
  const onPage=(event:Event)=>{const key=(event as CustomEvent).detail;if(isUsagePage(key))acc.setPage(key,Date.now())};
  const onInteract=()=>{if(visible()&&document.hasFocus())acc.interact(Date.now())};
  const onClick=(event:MouseEvent)=>{
    if(!(event.target instanceof Element))return;
    const element=event.target.closest("button,a");if(!element||element.closest("[data-usage-ignore]"))return;
    const explicit=element.getAttribute("data-usage-action");
    const action:Action=explicit==="start-analysis"||explicit==="save-voc"||explicit==="export"||explicit==="navigation"?explicit:element.tagName==="A"?"link":"button";
    acc.action(action,Date.now());
  };
  const heartbeat=new ActivityHeartbeatController({
    scheduler:{setTimeout:(fn,delay)=>window.setTimeout(fn,delay),clearTimeout:h=>window.clearTimeout(h as number)},
    visibility:{isVisible:visible,subscribe:listener=>{document.addEventListener("visibilitychange",listener);return()=>document.removeEventListener("visibilitychange",listener)}},
    send:()=>flush("scheduled"),intervalMs:USAGE_REPORT_INTERVAL_MS,
  });
  let sampler:ReturnType<typeof setInterval>|null=null;
  const logout=async()=>{if(stopped)return;await flush("logout")};
  return{
    start(){
      acc.setPage(lastPublished??initialPage(),Date.now());acc.setVisibility(visible(),document.hasFocus(),Date.now());
      document.addEventListener("visibilitychange",onVisibility);window.addEventListener("focus",onFocus);window.addEventListener("blur",onFocus);
      window.addEventListener("usage-page",onPage);document.addEventListener("click",onClick,true);
      for(const name of ["keydown","scroll","touchstart"])document.addEventListener(name,onInteract,{passive:true,capture:true});
      sampler=setInterval(()=>{if(!stopped)void persist()},15000);activeFlush=logout;heartbeat.start();
    },
    stop(){
      stopped=true;heartbeat.stop();if(sampler)clearInterval(sampler);
      document.removeEventListener("visibilitychange",onVisibility);window.removeEventListener("focus",onFocus);window.removeEventListener("blur",onFocus);window.removeEventListener("usage-page",onPage);document.removeEventListener("click",onClick,true);
      for(const name of ["keydown","scroll","touchstart"])document.removeEventListener(name,onInteract,true);
      void persist();if(activeFlush===logout)activeFlush=null;lastPublished=null;
    },
  };
}
