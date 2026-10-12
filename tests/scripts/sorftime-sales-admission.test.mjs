import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import {collectSalesTrendResponses} from '../../scripts/build-sorftime-sales-trend.mjs';

for (const [file, names, expected] of [
  ["price-strategy", "detailRaw, priceRaw", ["product_detail", "product_trend"]],
]) {
  test(`${file} does not compete with itself for the single Sorftime permit`, async () => {
    const source = fs.readFileSync(new URL(`../../scripts/build-sorftime-${file}.mjs`, import.meta.url), "utf8");
    const expression = source.split(`const [${names}] = `)[1].split(";")[0];
    let active = false;
    const result = await vm.runInNewContext(`(async () => ${expression})()`, {
      key: "fixture", asin: "B085DV8T75", marketplace: "US", Promise,
      callSorftimeTool: async (_key, tool) => {
        if (active) throw new Error("Local admission capacity exceeded");
        active = true;
        await new Promise(resolve => setTimeout(resolve, 5));
        active = false;
        return tool;
      },
    });
    assert.deepEqual(Array.from(result), expected);
  });
}

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
