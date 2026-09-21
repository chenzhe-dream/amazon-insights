import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { SellingPointTranslationService, validateSellingTranslation, readOriginalSellingPoints } from "../../server/services/selling-point-translation";

test("uses full listing bullets, rejects truncated legacy text, and validates numbers", () => {
  assert.deepEqual(readOriginalSellingPoints({ listingBullets: ["Timer: 2/4/8 hours"], strengths: ["different"] }), { original: ["Timer: 2/4/8 hours"], sourceComplete: true });
  const legacy = { strengths: ["Full original", "Truncated…"], sellingPoints: ["made-up summary"] };
  assert.equal(readOriginalSellingPoints(legacy).original.length, 1);
  assert.deepEqual(validateSellingTranslation(["One of our four brightness modes"], ["我们的四档亮度模式之一"]), ["我们的四档亮度模式之一"]);
  assert.throws(() => validateSellingTranslation(["Timer: 2/4/8 hours"], ["支持 2、4、12 小时定时"]));
  assert.throws(() => validateSellingTranslation(["No certifications"], ["获得 ETL 认证"]));
  assert.deepEqual(validateSellingTranslation(["Timer: 2/4/8 hours"], ["支持 2、4、8 小时定时"]), ["支持 2、4、8 小时定时"]);
});

test("translation shares in-flight work, survives reload and invalidates when original changes", async t => {
  const root = mkdtempSync(join(tmpdir(), "selling-translation-"));
  t.after(() => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  let calls = 0, source = "Timer: 2 hours";
  const identity = { organizationId: "org-a", projectId: "project-a", runId: "run-a", asin: "B000000001", original: [source], sourceComplete: true };
  let release!: () => void;
  const options = { root, modelIdentity: "test", resolveSource: async () => ({ ...identity, original: [source] }), translate: async () => { calls++; await new Promise<void>(r => { release = r; }); return ["定时 2 小时"]; } };
  const service = new SellingPointTranslationService(options);
  assert.equal((await service.read("org-a", "project-a", identity.asin)).state, "missing");
  assert.equal((await service.start("org-a", "project-a", identity.asin)).state, "pending");
  assert.equal((await service.start("org-a", "project-a", identity.asin)).state, "pending");
  assert.equal(calls, 1);
  release(); await service.drain();
  const reloaded = new SellingPointTranslationService(options);
  assert.equal((await reloaded.read("org-a", "project-a", identity.asin)).state, "ready");
  source = "Timer: 4 hours";
  assert.equal((await reloaded.read("org-a", "project-a", identity.asin)).state, "missing");
});

test("failed model output is not cached as success and does not retry itself", async t => {
  const root = mkdtempSync(join(tmpdir(), "selling-translation-"));
  t.after(() => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  let calls = 0;
  const service = new SellingPointTranslationService({ root, modelIdentity: "test",
    resolveSource: async () => ({ organizationId: "org", projectId: "p", runId: "r", asin: "B000000001", original: ["Timer: 2 hours"], sourceComplete: true }),
    translate: async () => { calls++; return ["定时 9 小时"]; } });
  await service.start("org", "p", "B000000001"); await service.drain();
  assert.equal((await service.read("org", "p", "B000000001")).state, "failed");
  assert.equal(calls, 1);
});
