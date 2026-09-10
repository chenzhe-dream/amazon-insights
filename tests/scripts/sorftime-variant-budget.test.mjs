import assert from "node:assert/strict";
import test from "node:test";
import * as variant from "../../scripts/build-sorftime-variant-data.mjs";
import { runWithProviderDiagnostics } from "../../scripts/lib/provider-diagnostics.mjs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readCachedDataExport } from "../../scripts/lib/sync-cache.mjs";
import { fetchAllVariations as fetchChildSales, syncSorftimeChildSales } from "../../scripts/build-sorftime-child-sales.mjs";

test("core child sales checkpoints ready siblings before a later timeout", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sales-checkpoint-"));
  const outputPath = path.join(root, "data.ts");
  const exitCode = process.exitCode;
  let checkpointObserved = false;
  const diagnostics = [];
  t.mock.method(console, "error", line => diagnostics.push(line));
  try {
    await syncSorftimeChildSales({ outputPath, asins: ["B000000001", "B000000003"], key: "fixture",
      callTool: async (_key, _name, args) => {
        if (args.asin === "B000000003") {
          checkpointObserved = readCachedDataExport(outputPath, "sorftimeChildSales30d").B000000001?.[0]?.sales === 12;
          throw new DOMException("timeout", "TimeoutError");
        }
        return [{ Asin: "B000000001", SalesAmount: 12 }];
      },
    });
    assert.equal(checkpointObserved, true);
    assert.ok(diagnostics.some(line => line.includes('"failureKind":"timeout"')));
    assert.equal(readCachedDataExport(outputPath, "sorftimeChildSales30d").B000000001[0].sales, 12);
    assert.equal(readCachedDataExport(outputPath, "sorftimeChildSales30d").B000000003, undefined);
  } finally { process.exitCode = exitCode; await rm(root, { recursive: true, force: true }); }
});

test("child sales shares the group deadline instead of starting a fresh request budget", async () => {
  let calls = 0;
  await assert.rejects(() => fetchChildSales("fixture", "B000000001", "US", {
    deadline: Date.now()-1, callTool: async () => { calls++; return []; },
  }), { name: "TimeoutError" });
  assert.equal(calls, 0);
});

test("each parent is checkpointed before the next parent request can fail", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "variant-checkpoint-"));
  const outputPath = path.join(root, "data.ts");
  let checkpointObserved = false;
  try {
    await variant.syncSorftimeVariants({ outputPath, asins: ["B000000001", "B000000003"], key: "fixture",
      callTool: async (_key, name, args) => {
        if (args.asin === "B000000003") {
          checkpointObserved = readCachedDataExport(outputPath, "sorftimeVariantData").B000000001?.[0]?.childSales === 12;
          throw new DOMException("second parent timeout", "TimeoutError");
        }
        if (name === "product_detail") return { parent_asin: "B000000001" };
        if (name === "product_variations") return [{ Asin: "B000000001", SalesAmount: 12 }];
        return [];
      },
    });
    assert.equal(checkpointObserved, true);
    assert.equal(readCachedDataExport(outputPath, "sorftimeVariantMeta").outcomes.B000000003.reasonCode, "REQUEST_TIMEOUT");
    assert.equal(readCachedDataExport(outputPath, "sorftimeVariantData").B000000001[0].childSales, 12);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("repair optional failures preserve existing variant details and original provenance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "variant-repair-"));
  const outputPath = path.join(root, "data.ts");
  const oldMode = process.env.AGENT_SYNC_REPAIR_INCOMPLETE;
  const oldExit = process.exitCode;
  const row = { asin: "B000000002", image: "https://example.test/old.jpg", launch: "2020-01", reviewShare: null, reviewSamples: 0, childSales: 3, salesMonth: "2026-08" };
  const outcome = { state: "partial", fetchedAt: "2026-08-01" };
  try {
    process.env.AGENT_SYNC_REPAIR_INCOMPLETE = "1";
    for (const emptyResponse of [false, true, "empty-variations"]) {
    await writeFile(outputPath, `export const sorftimeVariantMeta = ${JSON.stringify({ outcomes: { B000000001: outcome } })};\nexport const sorftimeVariantData = ${JSON.stringify({ B000000001: [row] })};`);
    await variant.syncSorftimeVariants({ outputPath, asins: ["B000000001"], key: "fixture", callTool: async (_key, name, args) => {
      if (name === "product_variations") return emptyResponse === "empty-variations" ? [] : [{ Asin: "B000000002", SalesAmount: 12 }];
      if (name === "product_reviews") { if (emptyResponse) return []; throw new Error("optional unavailable"); }
      if (args.asin === "B000000001") return { parent_asin: "B000000001" };
      if (emptyResponse) return {};
      throw new Error("optional detail unavailable");
    } });
    assert.deepEqual(readCachedDataExport(outputPath, "sorftimeVariantData").B000000001, [row]);
    assert.equal(readCachedDataExport(outputPath, "sorftimeVariantMeta").outcomes.B000000001.fetchedAt, outcome.fetchedAt);
    }
  } finally {
    if (oldMode === undefined) delete process.env.AGENT_SYNC_REPAIR_INCOMPLETE; else process.env.AGENT_SYNC_REPAIR_INCOMPLETE = oldMode;
    process.exitCode = oldExit;
    await rm(root, { recursive: true, force: true });
  }
});

test("cached and unrelated runs preserve durable partial outcomes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "variant-outcomes-"));
  const outputPath = path.join(root, "data.ts");
  const partial = { state: "partial", fetchedAt: "2026-09-10" };
  const row = { asin: "B000000002", reviewSamples: 1, reviewShare: 100 };
  try {
    await writeFile(outputPath, `export const sorftimeVariantMeta = ${JSON.stringify({ outcomes: { B000000001: partial } })};\nexport const sorftimeVariantData = ${JSON.stringify({ B000000001: [row], B000000003: [row] })};`);
    for (const asin of ["B000000001", "B000000003"]) {
      await variant.syncSorftimeVariants({ outputPath, asins: [asin], key: "" });
      assert.deepEqual(readCachedDataExport(outputPath, "sorftimeVariantMeta").outcomes.B000000001, partial);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("optional enrichment timeout does not open the connector breaker for core sales", async () => {
  const input = { connector: "sorftime", stage: "child_sales", asin: "B000000001", operation: "product_detail",
    env: { AGENT_SYNC_JOB_ID: "optional-budget-test" }, emitDiagnostics: false };
  await assert.rejects(() => runWithProviderDiagnostics({ ...input, optionalEnrichment: true }, async () => {
    throw new DOMException("optional budget", "TimeoutError");
  }));
  assert.equal(await runWithProviderDiagnostics(input, async () => "core sales"), "core sales");
});

test("optional detail timeout preserves discovered sales and emits incremental progress", async () => {
  const progress = [];
  let childCalls = 0;
  const rows = await variant.syncParentVariants("fixture", "B000000001", "US", "2026-09-10", {
    requestTimeoutMs: 30, optionalTimeoutMs: 10, deadline: Date.now()+500,
    onProgress: value => progress.push(value),
    callTool: async (_key, name, args, { signal }) => {
      if (name === "product_variations") return [{ Asin: "B000000002", SalesAmount: 12 }];
      if (name === "product_reviews") return [];
      if (args.asin === "B000000001") return { parent_asin: "B000000001" };
      childCalls++;
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  });
  assert.equal(childCalls, 1);
  assert.equal(rows[0].childSales, 12);
  assert.equal(rows[0].image, null);
  assert.ok(progress.some(value => value.state === "partial"));
});

test("expired group budget prevents dispatch of any new provider request", async () => {
  let calls = 0;
  await assert.rejects(() => variant.syncParentVariants("fixture", "B000000001", "US", "2026-09-10", {
    deadline: Date.now()-1, callTool: async () => { calls++; },
  }), { name: "TimeoutError" });
  assert.equal(calls, 0);
});

test("later variation page failure preserves earlier discovered children as partial", async () => {
  const progress = [];
  const rows = await variant.syncParentVariants("fixture", "B000000001", "US", "2026-09-10", {
    onProgress: value => progress.push(value), callTool: async (_key, name, args) => {
      if (name === "product_detail") return { parent_asin: "B000000001" };
      if (name === "product_reviews") return [];
      if (args.page === 1) return { data: [{ Asin: "B000000002", SalesAmount: 12, ItemTotal: 21 }] };
      throw new DOMException("page timeout", "TimeoutError");
    },
  });
  assert.equal(rows[0].childSales, 12);
  assert.equal(progress.at(-1).state, "partial");
});
