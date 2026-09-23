import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { captureGeneratedSyncCatalog } from "../../server/services/sync-catalog-capture";
import { captureCatalogForSyncJob } from "../../scripts/lib/catalog-sync.mjs";
import { runCatalogPhase } from "../../scripts/run-asin-sync-job.mjs";

test("captures exact scoped catalog bytes and preserves fallback nulls with file provenance", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "catalog-capture-"));
  try {
    const file = path.join(directory, "competitor-data.ts");
    const entries = [
      { asin: "B07YGQVKDY", catalogSource: "sellerSprite", synced: true, brand: "Brand", price: 99 },
      { asin: "B00BCX842K", catalogSource: "sorftime-fallback", synced: false, brand: null, price: null },
      { asin: "B000000000", catalogSource: "sellerSprite", synced: true, brand: "Unrelated" },
    ];
    const content = `export const refreshedCatalog = ${JSON.stringify(entries)};\n`;
    await writeFile(file, content);
    await utimes(file, new Date("2026-09-23T05:44:00.000Z"), new Date("2026-09-23T05:44:00.000Z"));
    const capture = await captureGeneratedSyncCatalog({ catalogPath: file,
      asins: ["B07YGQVKDY", "B00BCX842K"], capturedAt: "2026-09-23T05:51:00.000Z" });
    assert.deepEqual(capture.catalog, entries.slice(0, 2));
    assert.equal(capture.catalog[1]?.price, null);
    assert.equal(capture.evidence.sourceSha256, createHash("sha256").update(await readFile(file)).digest("hex"));
    assert.equal(capture.evidence.sourceUpdatedAt, "2026-09-23T05:44:00.000Z");
    assert.equal(capture.evidence.sourceJobId, undefined);
    const runnerCapture = captureCatalogForSyncJob(["B07YGQVKDY", "B00BCX842K"], file,
      "2026-09-23T05:51:00.000Z");
    assert.deepEqual(runnerCapture, capture);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("catalog phase persists its scoped candidate before later enrichment", () => {
  const captured = { catalog: [], evidence: { sourceKind: "generated-file", sourceRef: "app/competitor-data.ts#refreshedCatalog",
    sourceSha256: "a".repeat(64), sourceUpdatedAt: "2026-09-23T05:44:00.000Z", capturedAt: "2026-09-23T05:51:00.000Z" } };
  let mirrored: unknown = null;
  runCatalogPhase({ jobId: "job", job: { stages: [] }, asins: ["B07YGQVKDY"], marketplace: "US",
    catalogPending: [], catalogProviderPlan: null, providers: {},
    shouldRun: () => false, captureCatalog: () => captured,
    patch: (_jobId: string, patch: Record<string, unknown>) => { mirrored = patch.catalogCapture; return null; },
    runXydc: () => { assert.deepEqual(mirrored, captured); return { succeeded: true }; },
  });
});
