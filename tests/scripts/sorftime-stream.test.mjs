import assert from "node:assert/strict";
import test from "node:test";
import { runSorftimeCommand } from "../../scripts/lib/sorftime-stream.mjs";

test("progress is delivered before the owned child exits and hostile lines are ignored", async () => {
  const events = [];
  let finished = false;
  const code = `console.log('@@sorftime-progress@@'+JSON.stringify({asin:'B000000001',completed:1,total:2,state:'collecting'}));
    console.log('secret invalid progress'); setTimeout(()=>{},80);`;
  const result = await runSorftimeCommand({ args: ["-e", code], asins: ["B000000001"], timeoutMs: 2_000,
    onProgress: event => { assert.equal(finished, false); events.push(event); } });
  finished = true;
  assert.equal(result.succeeded, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].completed, 1);
});

test("owned direct child has a hard timeout", async () => {
  const result = await runSorftimeCommand({ args: ["-e", "setInterval(()=>{},1000)"], asins: ["B000000001"], timeoutMs: 50 });
  assert.equal(result.succeeded, false);
  assert.equal(result.diagnostics[0].failureKind, "timeout");
});
