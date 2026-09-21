import assert from "node:assert/strict";
import test from "node:test";
test("Beijing boundaries include midnight, Monday weeks and leap dates",async()=>{
  const m=await import("../../server/services/usage-analytics-service").catch(()=>null);
  assert.ok(m,"usage aggregation must exist");
  assert.equal(m.usageRange({period:"day",date:"2026-09-14"}).start,"2026-09-13T16:00:00.000Z");
  assert.equal(m.usageRange({period:"week",date:"2026-09-16"}).start,"2026-09-13T16:00:00.000Z");
  assert.equal(m.usageRange({period:"month",date:"2024-02-29"}).end,"2024-02-29T16:00:00.000Z");
  assert.throws(()=>m.usageRange({period:"day",date:"2026-02-30"}));
  assert.equal(m.unionDuration([[0,600000],[300000,900000]]),900000);
});
test("cross-midnight duration splits and overlapping pages deduplicate personal time",async()=>{
  const m=await import("../../server/services/usage-analytics-service").catch(()=>null);assert.ok(m);
  const event=(pageKey:string,start:string,end:string)=>({eventId:crypto.randomUUID(),kind:"duration" as const,pageKey:pageKey as "overview",metric:"active" as const,startedAt:start,endedAt:end});
  const results=m.aggregateUsageEvents([event("overview","2026-09-13T15:59:00.000Z","2026-09-13T16:01:00.000Z"),event("voc","2026-09-13T16:00:00.000Z","2026-09-13T16:02:00.000Z")]);
  assert.equal(results.find(r=>r.day==="2026-09-13"&&r.scope==="user")?.activeMs,60000);
  assert.equal(results.find(r=>r.day==="2026-09-14"&&r.scope==="user")?.activeMs,120000);
  assert.equal(results.find(r=>r.day==="2026-09-14"&&r.pageKey==="overview")?.activeMs,60000);
});
