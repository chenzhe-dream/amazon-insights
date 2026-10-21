import assert from "node:assert/strict";
import test from "node:test";
import {collectSalesTrendResponses} from '../../scripts/build-sorftime-sales-trend.mjs';
import {runSorftimePriceStrategyCli} from '../../scripts/build-sorftime-price-strategy.mjs';

test("price-strategy does not compete with itself for the single Sorftime permit", async () => {
    let active = false;
    const asin="B085DV8T75";
    const calls=[];
    const oldExit=process.exitCode;
    try {
      await runSorftimePriceStrategyCli({key:'fixture',jobId:'test-job',asins:[asin],marketplace:'US',
        fetchedAt:'2026-10-12',existing:{},repair:true,env:{},wait:async()=>{},readEvidence:()=>({}),
        writeFileSync:()=>{},callTool:async (_key, tool) => {
        if (active) throw new Error("Local admission capacity exceeded");
        active = true;
        await new Promise(resolve => setTimeout(resolve, 5));
        active = false;
        calls.push(tool);
        return tool==='product_detail'?{data:{asin,price:59.99,coupon:0}}:
          {data:{asin,type:'Price',data:[202609,60]}};
      }});
    } finally {process.exitCode=oldExit;}
    assert.deepEqual(calls,["product_detail", "product_trend"]);
});

test("sales collection completes all four metrics with a single provider permit", async () => {
  let active = 0;
  const calls = [];
  const result = await collectSalesTrendResponses({
    key: "fixture", asin: "B085DV8T75", marketplace: "US",
    callTool: async (_key, _tool, args) => {
      if (active) throw new Error("Local admission capacity exceeded");
      active++;
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      calls.push(args.type);
      return args.type;
    },
  });
  assert.deepEqual(Object.values(result.responses), ["SalesVolume", "SalesAmount", "Price", "Rank"]);
  assert.equal(calls.length, 4);
});
