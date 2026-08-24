import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  getListingImageRemark,
  listingImageRemarks,
} from "../../app/listing-image-remarks.ts";

const root = path.resolve(import.meta.dirname, "../..");
const generatorSource = fs.readFileSync(
  path.join(root, "scripts", "build-listing-image-remarks.mjs"),
  "utf8",
);
const generatedSource = fs.readFileSync(
  path.join(root, "app", "listing-image-remarks.ts"),
  "utf8",
);

test("generator emits a nullable slot type that matches inherited sparse remarks", () => {
  const nullableDeclaration = "Record<string, Array<ListingImageRemark | null>>";
  assert.match(generatorSource, new RegExp(nullableDeclaration.replace(/[|[\]().*+?{}\\]/g, "\\$&")));
  assert.match(generatedSource, new RegExp(nullableDeclaration.replace(/[|[\]().*+?{}\\]/g, "\\$&")));

  for (const asin of ["B09ZY6M8XH", "B0CCYMV1T1"]) {
    assert.deepEqual(listingImageRemarks[asin].slice(0, 6), Array(6).fill(null));
    assert.equal(getListingImageRemark(asin, 0), null);
    assert.match(getListingImageRemark(asin, 6)?.remark ?? "", /视频位缩略图/);
  }

  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "node_modules", "typescript", "bin", "tsc"),
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--target",
      "ES2022",
      "--module",
      "ESNext",
      "--moduleResolution",
      "Bundler",
      path.join(root, "app", "listing-image-remarks.ts"),
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test("image analysis prompt requires visible text before functional or scenario claims", () => {
  const prompt = generatorSource.match(/const SKILL_PROMPT = `([\s\S]*?)`;/)?.[1] ?? "";
  assert.match(prompt, /可见文字明确/);
  assert.match(prompt, /不得声称防漏、无滴漏、耐用、安全/);
  assert.match(prompt, /不得推断使用场景或使用时机/);
  assert.match(prompt, /只描述可见结构、设计与呈现/);
});
