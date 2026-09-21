import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { xydcVariantAttributeLabel } from "../../app/xydc-variant-label";
import { translateXydcVariantLabels, readXydcTranslatedAttribute } from "../../scripts/lib/xydc-label-translation";

test("dictionary handles screenshot colors and cached model fallback preserves raw attributes", async () => {
  assert.equal(xydcVariantAttributeLabel({ dimension: "Color", value: "Amber" }), "琥珀色");
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "xydc-labels-"));
  try {
    const attribute = { dimension: "Color", value: "Ocean Mist 22" };
    let calls = 0;
    const translate = async (items: Array<{ id: string; dimension: string; value: string }>) => {
      calls++;
      assert.equal(items.length, 1);
      return items.map(item => ({ id: item.id, labelZh: "海雾色 22" }));
    };
    const input = { dataRoot, attributes: [attribute, attribute, { dimension: "Color", value: "Black" }], translate };
    await translateXydcVariantLabels(input);
    await translateXydcVariantLabels(input);
    assert.equal(calls, 1);
    const result = readXydcTranslatedAttribute(dataRoot, attribute);
    assert.equal(result.value, attribute.value);
    assert.equal(xydcVariantAttributeLabel(result), "海雾色 22");
    assert.equal(xydcVariantAttributeLabel({ dimension: "Color", value: "Black", labelZh: "错误" }), "黑色");
  } finally { await fs.rm(dataRoot, { recursive: true, force: true }); }
});

test("failure retains originals and suppresses repeated calls during cooldown", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "xydc-labels-"));
  try {
    const attribute = { dimension: "Finish", value: "Ocean Mist" };
    let calls = 0;
    const translate = async () => { calls++; throw new Error("unavailable"); };
    const input = { dataRoot, attributes: [attribute], translate, now: new Date("2026-09-15T00:00:00Z") };
    await translateXydcVariantLabels(input);
    await translateXydcVariantLabels(input);
    assert.equal(calls, 1);
    assert.equal(xydcVariantAttributeLabel(readXydcTranslatedAttribute(dataRoot, attribute)), attribute.value);
    await translateXydcVariantLabels({ ...input, now: new Date("2026-09-15T00:11:00Z") });
    assert.equal(calls, 2);
  } finally { await fs.rm(dataRoot, { recursive: true, force: true }); }
});

test("rejects changed specifications, duplicate IDs and unknown result IDs", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "xydc-labels-"));
  try {
    const attributes = [{ dimension: "Size", value: "Tall 22" }, { dimension: "Finish", value: "Ocean Mist" }];
    await translateXydcVariantLabels({ dataRoot, attributes, translate: async items => [
      { id: items[0]!.id, labelZh: "高款 26" },
      { id: items[1]!.id, labelZh: "海雾色" },
      { id: items[1]!.id, labelZh: "其他色" },
      { id: "unexpected", labelZh: "任意色" },
    ] });
    for (const attribute of attributes) assert.equal(readXydcTranslatedAttribute(dataRoot, attribute).labelZh, undefined);
  } finally { await fs.rm(dataRoot, { recursive: true, force: true }); }
});
