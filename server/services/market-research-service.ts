import { randomUUID } from "node:crypto";
import { MarketResearchScopeSchema, MarketResearchIdempotencyKeySchema, type MarketResearchScope, type MarketOverviewReport } from "../../shared/market-research-contracts";
import type { MarketResearchActor, MarketResearchRepository } from "../db/market-research-repository";
import { marketResearchFailure } from "./market-overview-collector";

export class MarketResearchServiceError extends Error {
  constructor(readonly statusCode:400|403|404|503,message:string){super(message);}
}
export class MarketResearchService {
  constructor(private readonly deps:{
    repository:MarketResearchRepository;
    findUser:(id:string)=>Promise<{organizationId:string;status:string}|null>;
    now?:()=>Date;
  }){}
  private async authorize(actor:MarketResearchActor){
    const user=await this.deps.findUser(actor.userId);
    if(!user || user.status!=="active" || user.organizationId!==actor.organizationId) throw new MarketResearchServiceError(403,"没有该组织的市场调研权限");
  }
  private now(){return (this.deps.now?.()??new Date()).toISOString();}
  async create(actor:MarketResearchActor,value:unknown,key:unknown){
    await this.authorize(actor);
    const parsed=MarketResearchScopeSchema.safeParse(value);
    const idempotency=MarketResearchIdempotencyKeySchema.safeParse(key);
    if(!parsed.success || !idempotency.success) throw new MarketResearchServiceError(400,"请填写有效的类目、月份和调研参数");
    const now=this.now();
    if(parsed.data.month!=='last30'&&parsed.data.month>=now.slice(0,7)) throw new MarketResearchServiceError(400,"请选择当前月份之前的完整月份");
    return this.deps.repository.create({...actor,id:randomUUID(),scope:parsed.data,idempotencyKey:idempotency.data,now});
  }
  async list(actor:MarketResearchActor){await this.authorize(actor);return this.deps.repository.list(actor);}
  async find(actor:MarketResearchActor,id:string){
    await this.authorize(actor);
    const job=await this.deps.repository.find({...actor,id});
    if(!job)throw new MarketResearchServiceError(404,"未找到该市场调研任务");
    return job;
  }
  async retry(actor:MarketResearchActor,id:string){
    await this.authorize(actor);
    const job=await this.deps.repository.retry({...actor,id,now:this.now()});
    if(!job)throw new MarketResearchServiceError(404,"未找到该市场调研任务");
    return job;
  }
}

type CollectInput={scope:MarketResearchScope;organizationId:string;jobId:string;signal:AbortSignal};
export class MarketResearchWorker {
  private timer:ReturnType<typeof setInterval>|null=null;
  private running:Promise<void>|null=null;
  private controller:AbortController|null=null;
  private stopped=false;
  private readonly ownerId:string;
  constructor(private readonly deps:{repository:MarketResearchRepository;collect:(input:CollectInput)=>Promise<MarketOverviewReport>;now?:()=>Date;ownerId?:string;onError?:()=>void}){
    this.ownerId=deps.ownerId??`market-${randomUUID()}`;
  }
  private now(){return this.deps.now?.()??new Date();}
  start(){
    if(this.timer)return;
    this.stopped=false;
    const poll=()=>{void this.tick().catch(()=>this.deps.onError?.());};
    this.timer=setInterval(poll,1000);this.timer.unref();poll();
  }
  async stop(){
    this.stopped=true;
    if(this.timer)clearInterval(this.timer);this.timer=null;
    this.controller?.abort();await this.running;
  }
  tick():Promise<void>{
    if(this.running)return this.running;
    if(this.stopped)return Promise.resolve();
    this.running=this.runOne().finally(()=>{this.running=null;});return this.running;
  }
  private async runOne(){
    const now=this.now();
    const claim=await this.deps.repository.claim({ownerId:this.ownerId,now:now.toISOString(),leaseUntil:new Date(now.getTime()+120_000).toISOString()});
    if(!claim)return;
    const controller=new AbortController();this.controller=controller;
    if(this.stopped)controller.abort();
    let heartbeat:Promise<void>=Promise.resolve();
    const renew=setInterval(()=>{
      heartbeat=heartbeat.then(async()=>{
        const time=this.now();
        const renewed=await this.deps.repository.renew({claim,now:time.toISOString(),leaseUntil:new Date(time.getTime()+120_000).toISOString()});
        if(!renewed)controller.abort();
      }).catch(()=>{controller.abort();});
    },20_000);renew.unref();
    try {
      const report=await this.deps.collect({scope:claim.job.scope,organizationId:claim.organizationId,jobId:claim.job.id,signal:controller.signal});
      controller.signal.throwIfAborted();
      clearInterval(renew);await heartbeat;
      controller.signal.throwIfAborted();
      await this.deps.repository.finish({claim,now:this.now().toISOString(),report,error:null});
    } catch(error){
      clearInterval(renew);await heartbeat;
      await this.deps.repository.finish({claim,now:this.now().toISOString(),report:null,error:controller.signal.aborted
        ?{dataset:"research",code:"interrupted",message:"采集已中断，可以重试",retryable:true}
        :marketResearchFailure(error)});
    } finally {clearInterval(renew);this.controller=null;}
  }
}
