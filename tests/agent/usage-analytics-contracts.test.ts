import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";

test("usage batches accept bounded events and reject identity injection, invalid pages and intervals", async () => {
  const module = await import("../../shared/usage-analytics-contracts").catch(() => null);
  assert.ok(module, "usage contracts must exist");
  const event = {eventId:randomUUID(),kind:"visit",pageKey:"overview",at:"2026-09-14T01:00:00.000Z"};
  const batch = {version:1,tabId:randomUUID(),accountKey:'["o1","u1"]',observedAt:event.at,events:[event]};
  assert.equal(module.UsageBatchSchema.safeParse(batch).success,true);
  for (const invalid of [
    {...batch,userId:"someone-else"},
    {...batch,events:[{...event,pageKey:"arbitrary"}]},
    {...batch,events:Array.from({length:257},()=>event)},
    {...batch,events:[{...event,kind:"click",actionKey:"button",count:-1}]},
    {...batch,events:[{eventId:event.eventId,kind:"duration",pageKey:"overview",metric:"active",startedAt:event.at,endedAt:"2026-09-14T01:11:00.000Z"}]},
  ]) assert.equal(module.UsageBatchSchema.safeParse(invalid).success,false);
});
