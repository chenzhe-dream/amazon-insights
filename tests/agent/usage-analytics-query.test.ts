import test from "node:test";import assert from "node:assert/strict";
test("usage query preserves exact selected day and encodes person identity",async()=>{
  const m=await import("../../app/lib/usage-analytics-query").catch(()=>null);assert.ok(m);
  assert.equal(m.beijingToday(new Date("2026-09-13T16:01:00Z")),"2026-09-14");
  const u=m.usageQueryPath({period:"day",date:"2026-09-10",userId:"u + ?"});
  const parsed=new URL(u,"http://test");assert.equal(parsed.searchParams.get("userId"),"u + ?");
  assert.equal(parsed.searchParams.get("date"),"2026-09-10");
  assert.deepEqual(m.highlightParts("<script>林晓","林"),[{text:"<script>",hit:false},{text:"林",hit:true},{text:"晓",hit:false}]);
});
