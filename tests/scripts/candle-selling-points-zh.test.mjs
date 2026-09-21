import assert from "node:assert/strict";
import test from "node:test";
import { localizeSellingPoints, localizeCatalogSellingPoints } from "../../scripts/lib/selling-point-zh.mjs";

test("candle warmers use Chinese evidence-based summaries, not floor-lamp templates", () => {
  const result = localizeSellingPoints([
    "Flame-Free Candle Warmer: No flame, no smoke, no soot. Suitable for bedrooms and offices.",
    "Dimmable Candle Warmer with Timer: Four brightness settings and timer function.",
    "Height Adjustable Wax Warmer: Twist the knob to adjust the lampshade height for different candle sizes.",
    "Sleek Design: A metal base and glass lampshade for living rooms and bedrooms.",
  ], { family: "lighting", title: "Candle Warmer Lamp" });
  assert.equal(result.length, 4);
  for (const point of result) assert.doesNotMatch(point, /[A-Za-z]|布艺|亚麻|床头柜|置物架/);
  assert.match(result[0], /无明火/);
  assert.match(result[1], /四档.*定时/);
  assert.match(result[2], /高度/);
  assert.match(result[3], /玻璃/);
});

test("existing mixed-language catalog uses retained original bullets to replace incorrect summaries", () => {
  const result = localizeCatalogSellingPoints({ title: "Candle Warmer Lamp", productFamily: "lighting",
    sellingPoints: ["标配 LED 灯泡，色温/亮度可按场景切换", "timer supports 2/4/8 hours", "可兼作床头柜", "adjustable height range of 3.4–6 inches between base and glass shade"],
    strengths: ["Flameless candle lamp melts wax via bulb heat with zero flame, smoke or soot", "3-Speed Timing Auto Shutoff: timer supports 2/4/8 hours", "4-Level Dimmable Light & Heat Control"],
  });
  assert.equal(result.length, 4);
  assert.match(result[1], /2、4、8 小时/);
  assert.match(result[2], /四档/);
  assert.match(result[3], /3.4–6 英寸/);
  assert.doesNotMatch(result.join(""), /[A-Za-z]|床头柜|色温/);
});

test("already verified Chinese bullets and unrelated product families remain unchanged", () => {
  const points = ["无明火加热，均匀释放香气"];
  assert.deepEqual(localizeCatalogSellingPoints({ title: "Candle Warmer Lamp", sellingPoints: points }), points);
  assert.deepEqual(localizeCatalogSellingPoints({ title: "Scooter", sellingPoints: ["原有卖点"] }), ["原有卖点"]);
});
