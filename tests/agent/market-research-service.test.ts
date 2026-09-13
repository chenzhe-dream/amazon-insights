import assert from "node:assert/strict";
import test from "node:test";
import { MarketResearchService, MarketResearchWorker } from "../../server/services/market-research-service";
import type { MarketResearchClaim, MarketResearchRepository } from "../../server/db/market-research-repository";
import type { MarketOverviewReport, MarketResearchJob } from "../../shared/market-research-contracts";

const now=()=>new Date("2026-09-12T00:00:00.000Z");
const actor={userId:"user-a",organizationId:"org-a"};
const scope={marketplace:"US" as const,nodeQuery:"123:456",month:"2026-08",headTopN:10 as const,newProductMonths:6 as const};
const job:MarketResearchJob={id:"20000000-0000-4000-8000-000000000001",scope,status:"queued",attempts:0,createdAt:now().toISOString(),updatedAt:now().toISOString(),report:null,error:null};
function store(overrides:Partial<MarketResearchRepository>={}):MarketResearchRepository{return {create:async()=>({job,created:true}),find:async()=>job,list:async()=>[job],retry:async()=>job,claim:async()=>null,renew:async()=>true,finish:async()=>true,...overrides};}
test("service prevents organization spoofing and disabled users before storage",async()=>{
  let called=false;
  const service=new MarketResearchService({repository:store({list:async()=>{called=true;return [];}}),findUser:async()=>({organizationId:"another-org",status:"active"}),now});
  await assert.rejects(()=>service.list(actor),/权限/);assert.equal(called,false);
});
test("service rejects a current or future month without queuing a paid collection",async()=>{
  let called=false;
  const service=new MarketResearchService({repository:store({create:async()=>{called=true;return {job,created:true};}}),findUser:async()=>({organizationId:actor.organizationId,status:"active"}),now});
  await assert.rejects(()=>service.create(actor,{...scope,month:"2026-09"},job.id),/完整月份/);assert.equal(called,false);
});
test("a retry preserves principal scope and only delegates an authenticated request",async()=>{
  let actual:unknown;
  const service=new MarketResearchService({repository:store({retry:async input=>{actual=input;return job;}}),findUser:async()=>({organizationId:actor.organizationId,status:"active"}),now});
  await service.retry(actor,job.id);assert.deepEqual(actual,{...actor,id:job.id,now:now().toISOString()});
});
test("worker persists a safe failure and does not require an AI provider",async()=>{
  const claim:MarketResearchClaim={job:{...job,status:"running",attempts:1},...actor,ownerId:"owner",generation:1};
  let final:Parameters<MarketResearchRepository["finish"]>[0]|undefined;
  const worker=new MarketResearchWorker({repository:store({claim:async()=>claim,finish:async input=>{final=input;return true;}}),collect:async()=>{throw new Error("secret upstream response");},now,ownerId:"owner"});
  await worker.tick();assert.equal(final?.report,null);assert.ok(final?.error);assert.ok(!JSON.stringify(final?.error).includes("secret"));
});
test("worker forwards persisted scope and result to its lease-fenced completion",async()=>{
  const claim:MarketResearchClaim={job:{...job,status:"running",attempts:1},...actor,ownerId:"owner",generation:2};
  const report={schemaVersion:"market-overview/v1"} as MarketOverviewReport;
  let final:Parameters<MarketResearchRepository["finish"]>[0]|undefined;
  const worker=new MarketResearchWorker({repository:store({claim:async()=>claim,finish:async input=>{final=input;return true;}}),collect:async input=>{assert.deepEqual(input.scope,scope);assert.equal(input.organizationId,actor.organizationId);assert.equal(input.jobId,job.id);return report;},now,ownerId:"owner"});
  await worker.tick();assert.equal(final?.claim.generation,2);assert.equal(final?.report,report);assert.equal(final?.error,null);
});
