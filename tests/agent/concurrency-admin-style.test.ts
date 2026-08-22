import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const cssUrl = new URL("../../app/comparison-layout.css", import.meta.url);

test("concurrency panel owns its dashboard and control layout", async () => {
  const css = await readFile(cssUrl, "utf8");
  for (const selector of [
    ".concurrency-admin-panel",
    ".concurrency-admin-heading",
    ".concurrency-admin-summary",
    ".concurrency-admin-metric",
    ".concurrency-admin-actions",
    ".concurrency-admin-control-group",
  ]) {
    assert.match(css, new RegExp(selector.replace(".", "\\.")));
  }
  assert.match(css, /grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /@media\(max-width:1100px\)[\s\S]*?repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /@media\(max-width:760px\)[\s\S]*?grid-template-columns:\s*1fr/);
});
