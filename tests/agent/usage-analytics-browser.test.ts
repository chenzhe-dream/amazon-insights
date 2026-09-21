import test from "node:test";
import assert from "node:assert/strict";
test("click aggregation splits at Beijing midnight",async()=>{
  const {UsageAccumulator}=await import("../../app/lib/usage-analytics-browser");
  const a=new UsageAccumulator(()=>crypto.randomUUID()),before=Date.parse("2026-09-13T15:59:59Z");
  a.setPage("overview",before);a.setVisibility(true,true,before);
  a.action("button",before);a.action("button",before+2000);
  const clicks=a.drain().filter(e=>e.kind==="click");
  assert.equal(clicks.length,2);assert.deepEqual(clicks.map(e=>e.count),[1,1]);
});
test("collector measures visible and active time, ignores sleep, and counts logical transitions once",async()=>{
  const m=await import("../../app/lib/usage-analytics-browser").catch(()=>null);assert.ok(m);
  const a=new m.UsageAccumulator(()=>crypto.randomUUID());
  a.setPage("overview",0);a.setVisibility(true,true,0);
  a.sample(15000);a.sample(30000);a.setPage("overview",30000);
  a.setPage("voc",30000);a.setVisibility(false,false,40000);a.sample(50000);
  const events=a.drain();assert.equal(events.filter(e=>e.kind==="visit").length,2);
  assert.equal(events.reduce((n,e)=>n+(e.kind==="duration"&&e.metric==="active"?Date.parse(e.endedAt)-Date.parse(e.startedAt):0),0),40000);
  a.setVisibility(true,true,50000);a.sample(500000);
  assert.equal(a.drain().filter(e=>e.kind==="duration").length,0);
});
test("idle cutoff and 100 clicks are aggregated without sending requests",async()=>{
  const m=await import("../../app/lib/usage-analytics-browser").catch(()=>null);assert.ok(m);
  const a=new m.UsageAccumulator(()=>crypto.randomUUID());a.setPage("overview",0);a.setVisibility(true,true,0);
  for(let t=15000;t<=360000;t+=15000)a.sample(t);
  const e=a.drain();assert.equal(e.reduce((n,r)=>n+(r.kind==="duration"&&r.metric==="active"?Date.parse(r.endedAt)-Date.parse(r.startedAt):0),0),300000);
  for(let i=0;i<100;i++)a.action("button",360000);
  const clicks=a.drain().filter(r=>r.kind==="click");
  assert.equal(clicks.length,1);assert.equal(clicks[0].count,100);
});
