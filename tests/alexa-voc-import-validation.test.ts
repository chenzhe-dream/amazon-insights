import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { hasManualAlexaVocText } from "../app/alexa-voc-import-validation";

test("accepts a non-empty manual report shorter than 600 characters", () => {
  assert.equal(hasManualAlexaVocText("1️⃣ 顾客关注点\n安装简单"), true);
});

test("rejects an empty manual report", () => {
  assert.equal(hasManualAlexaVocText("   \n\t"), false);
  assert.equal(hasManualAlexaVocText(undefined), false);
});

test("manual import consumers use presence validation instead of a length threshold", () => {
  const panel = fs.readFileSync(new URL("../app/alexa-voc-import-panel.tsx", import.meta.url), "utf8");
  const route = fs.readFileSync(new URL("../app/api/alexa-voc/import/route.ts", import.meta.url), "utf8");

  assert.match(panel, /!hasManualAlexaVocText\(text\)/);
  assert.match(route, /!hasManualAlexaVocText\(text\)/);
  assert.doesNotMatch(panel, /length\s*<\s*600/);
  assert.doesNotMatch(route, /length\s*<\s*600/);
});
