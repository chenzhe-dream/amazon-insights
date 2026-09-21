import assert from "node:assert/strict";
import test from "node:test";

import { orderAttributeLabel, orderColorMap } from "../../app/xydc-order-card";
import type { XydcVariantFamily } from "../../shared/xydc-variant-contract";

type VariantChild = XydcVariantFamily["children"][number];

function child(
  asin: string,
  attributes: VariantChild["attributes"],
): VariantChild {
  return {
    asin,
    attributes,
    title: `Fixture ${asin}`,
    imageUrl: null,
    price: null,
    currency: null,
    stars: null,
    productPageRatings: null,
    listingDate: null,
    infoStatus: "ready",
  };
}

test("translates known color features and Arc shape at the shared order label seam", () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ["Color", "Sand Black", "砂黑色"],
    ["Color", "Silver", "银色"],
    ["Color", "Black", "黑色"],
    ["Color", "White", "白色"],
    ["Color", "Gold", "金色"],
    ["Color", "Nickel", "镍色"],
    ["Color", "Gray", "灰色"],
    ["Color", "Brown", "棕色"],
    ["Color", "Black Remote Control", "黑色（遥控款）"],
    ["Color", "Black RGB", "黑色（RGB款）"],
    ["Color", "Black Dimmable", "黑色（可调光款）"],
    ["Color", "Black Shade", "黑色（灯罩款）"],
    ["Shape", "Arc", "弧形"],
  ];

  for (const [dimension, value, expected] of cases) {
    assert.equal(orderAttributeLabel(child("B000000001", [{ dimension, value }])), expected);
  }
});

test("translates bounded 22 and 26 inch compound colors while preserving numbers and separators", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["22“ -Yellowish and Brown", "22 英寸 - 淡黄色与棕色"],
    ["22“ -Brown and Gold", "22 英寸 - 棕色与金色"],
    ["22“ -Grayish and Dark Brown", "22 英寸 - 浅灰色与深棕色"],
    ["22“ -Grayish and Black", "22 英寸 - 浅灰色与黑色"],
    ["26\"-Grayish and Black", "26 英寸 - 浅灰色与黑色"],
    ["26\"-Yellowish and Brown", "26 英寸 - 淡黄色与棕色"],
    ["26\"-Grayish and Dark Brown", "26 英寸 - 浅灰色与深棕色"],
  ];

  for (const [value, expected] of cases) {
    assert.equal(orderAttributeLabel(child("B000000001", [{ dimension: "Color", value }])), expected);
  }
});

test("translates bounded standalone size attributes", () => {
  assert.equal(orderAttributeLabel(child("B000000001", [{ dimension: "Size", value: "22 inch" }])), "22 英寸");
  assert.equal(orderAttributeLabel(child("B000000001", [{ dimension: "Size", value: "26\"" }])), "26 英寸");
});

test("matches known labels case-insensitively with surrounding and repeated whitespace", () => {
  const fixture = child("B000000001", [
    { dimension: " color ", value: "  bLaCk   REMOTE   control  " },
    { dimension: " SHAPE", value: "  aRc " },
  ]);

  assert.equal(orderAttributeLabel(fixture), "黑色（遥控款） · 弧形");
});

test("falls back to the exact raw value for unknown or out-of-dimension labels", () => {
  assert.equal(
    orderAttributeLabel(child("B000000001", [{ dimension: "Color", value: "  Midnight Black  " }])),
    "近似黑色（Midnight Black）",
  );
  assert.equal(
    orderAttributeLabel(child("B000000001", [{ dimension: "Finish", value: "Black" }])),
    "Black",
  );
});

test("treats inherited object keys as unknown raw color and shape values", () => {
  for (const dimension of ["Color", "Shape"]) {
    for (const value of ["constructor", "__proto__"]) {
      assert.equal(orderAttributeLabel(child("B000000001", [{ dimension, value }])), value);
    }
  }
});

test("does not mutate raw child attributes or collapse distinct ASIN identity", () => {
  const first = child("B000000001", [{ dimension: "Color", value: "Sand Black" }]);
  const second = child("B000000002", [{ dimension: "Color", value: "sand black" }]);
  const before = structuredClone([first, second]);

  assert.equal(orderAttributeLabel(first), "砂黑色");
  assert.equal(orderAttributeLabel(second), "砂黑色");
  assert.deepEqual([first, second], before);
  const colors = orderColorMap([first.asin, second.asin], [first, second]);
  assert.equal(colors.size, 2);
  assert.equal(colors.get(first.asin), colors.get(second.asin));
  const reordered = orderColorMap([second.asin, "B000000003", first.asin], [second, first]);
  assert.equal(reordered.get(first.asin), colors.get(first.asin));
  assert.equal(reordered.get(second.asin), colors.get(second.asin));
  assert.notEqual(first.asin, second.asin);
});

test("Chinese source labels win and missing children use a neutral pattern", () => {
  assert.equal(orderAttributeLabel(child("B000000001", [{dimension: "Color", value: "Blue", labelZh: "品牌湖蓝"}])), "品牌湖蓝");
  assert.match(orderColorMap(["B000000001"]).get("B000000001")!, /repeating-linear-gradient/);
});
