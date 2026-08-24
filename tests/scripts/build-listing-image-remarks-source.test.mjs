import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { readCachedDataExport } from "../../scripts/lib/sync-cache.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const generatorSource = fs.readFileSync(
  path.join(root, "scripts", "build-listing-image-remarks.mjs"),
  "utf8",
);
test("generator emits a nullable slot type that matches inherited sparse remarks", () => {
  const nullableDeclaration = "Record<string, Array<ListingImageRemark | null>>";
  assert.match(generatorSource, new RegExp(nullableDeclaration.replace(/[|[\]().*+?{}\\]/g, "\\$&")));
  assert.match(generatorSource, /return listingImageRemarks\[asin\]\?\.\[slotIndex\] \?\? null;/);

  const fixtureRemarks = {
    inherited: [
      null,
      null,
      {
        remark: "Listing 视频位缩略图，非静态辅图分析范围。",
        image_types: ["其他"],
        confidence: "high",
      },
    ],
  };
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "image-remarks-output-"));
  const fixturePath = path.join(tempRoot, "listing-image-remarks.ts");
  fs.writeFileSync(fixturePath, `export type ListingImageRemark = {
  remark: string;
  image_types: string[];
  confidence: "high" | "medium" | "low";
};
export const listingImageRemarks: ${nullableDeclaration} = ${JSON.stringify(fixtureRemarks, null, 2)};
export function getListingImageRemark(asin: string, slotIndex: number): ListingImageRemark | null {
  return listingImageRemarks[asin]?.[slotIndex] ?? null;
}
`, "utf8");

  try {
    const parsed = readCachedDataExport(fixturePath, "listingImageRemarks");
    assert.deepEqual(parsed.inherited.slice(0, 2), [null, null]);
    assert.equal(parsed.inherited[0] ?? null, null);
    assert.match(parsed.inherited[2]?.remark ?? "", /视频位缩略图/);

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
        fixturePath,
      ],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("image analysis prompt requires visible text before functional or scenario claims", () => {
  const prompt = generatorSource.match(/const SKILL_PROMPT = `([\s\S]*?)`;/)?.[1] ?? "";
  assert.match(prompt, /可见文字明确/);
  assert.match(prompt, /不得声称防漏、无滴漏、耐用、安全/);
  assert.match(prompt, /不得推断使用场景或使用时机/);
  assert.match(prompt, /只描述可见结构、设计与呈现/);
});
