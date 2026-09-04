import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const EXPECTED_SHA256 = "4a148c24e74f22e0f8b79c4691115c99fb4931a6d226ed04a5916e2e847c5ad0";

test("Alexa VOC tutorial keeps the approved source screenshot unchanged", async () => {
  const image = await readFile(new URL("../../public/tutorials/alexa-voc-entry.png", import.meta.url));
  assert.equal(createHash("sha256").update(image).digest("hex"), EXPECTED_SHA256);
});
