import assert from "node:assert/strict";
import test from "node:test";
import { resolveVariantColor, resolveColorName } from "../../app/lib/variant-color";

test("color names use stable swatches, including uncommon names", () => {
  assert.equal(resolveColorName("Blue").colors[0], "#0000ff");
  assert.equal(resolveColorName("White").textColor, "#000000");
  assert.equal(resolveColorName("Black").textColor, "#ffffff");
  assert.equal(resolveColorName(" Aqua Blue ").kind, "single");
  assert.match(resolveColorName("Aqua Blue").label, /蓝/);
  assert.equal(resolveColorName("After the Storm").kind, "single");
  assert.match(resolveColorName("After the Storm").label, /近似.*After the Storm/);
});

test("explicit composites are split without interpreting shades as two colors", () => {
  assert.deepEqual(resolveColorName("Black-Red").colors, ["#000000", "#ff0000"]);
  assert.equal(resolveColorName("Aqua Blue").colors.length, 1);
  assert.equal(resolveColorName("Black RGB").colors.length, 1);
  assert.equal(resolveColorName("Mystery Black / Nonsense Finish").kind, "unknown");
  assert.deepEqual(resolveColorName("blue-black").colors, ["#24313d"]);
  assert.deepEqual(resolveColorName("anti-flash white").colors, ["#f2f3f4"]);
  assert.deepEqual(resolveColorName("baker-miller pink").colors, ["#ff92ae"]);
  assert.equal(resolveColorName("off-white").kind, "single");
  assert.equal(resolveColorName("light-blue").kind, "single");
});

test("unknown and non-color attributes never borrow a sibling or random palette", () => {
  assert.equal(resolveColorName("Uncharted ZZZ Finish").kind, "unknown");
  assert.equal(resolveColorName("constructor").kind, "unknown");
  assert.equal(resolveColorName("__proto__").kind, "unknown");
  assert.equal(resolveVariantColor([{dimension:"Size", value:"Blue"}]).kind, "unknown");
  assert.equal(resolveColorName("Mystery Blue Finish").approximate, true);
  assert.match(resolveColorName("Brown Dimmable").label, /近似棕色.*Brown Dimmable/);
  assert.equal(resolveColorName("Clear").kind, "transparent");
  assert.deepEqual(resolveColorName("#fff").colors, ["#ffffff"]);
});

test("source labels and attributes survive without mutation", () => {
  const attrs = Object.freeze([Object.freeze({dimension:"Color",value:"Blue",labelZh:"品牌湖蓝"})]);
  assert.equal(resolveVariantColor(attrs).label, "品牌湖蓝");
  assert.equal(attrs[0].value, "Blue");
  assert.deepEqual(resolveVariantColor([...attrs].reverse()), resolveVariantColor(attrs));
});
