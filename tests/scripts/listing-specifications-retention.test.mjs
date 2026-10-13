import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { readCachedDataExport } from "../../scripts/lib/sync-cache.mjs";
import { createDirectListingProvenance } from "../../scripts/lib/sorftime-listing-parse.mjs";

test("actual image refresh retains only current-job specs and their original evidence timestamp", t => {
  const codeRoot = path.resolve(import.meta.dirname, "../..");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "listing-specs-retention-"));
  t.after(() => { const target = path.resolve(dir); assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(target, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(dir, "app")); fs.mkdirSync(path.join(dir, "scripts"));
  for (const sub of ["config", "connectors"]) fs.cpSync(path.join(codeRoot, "server", sub), path.join(dir, "server", sub), { recursive: true });
  fs.symlinkSync(path.join(codeRoot, "node_modules"), path.join(dir, "node_modules"), "junction");
  fs.cpSync(path.join(codeRoot, "scripts/lib"), path.join(dir, "scripts/lib"), { recursive: true });
  fs.copyFileSync(path.join(codeRoot, "scripts/build-sorftime-listing-content.mjs"), path.join(dir, "scripts/build-sorftime-listing-content.mjs"));
  const asin = "B0BT9F1F72", jobId = "spec-retention-job", collected = "2026-10-01T10:00:00.000Z";
  const record = { asin, marketplace: "US", source: "Sorftime", status: "ready", fetchedAt: collected, mainImage: "https://img.test/old.jpg", galleryImages: ["https://img.test/old.jpg"], specifications: ["材质：Wood"], provenance: createDirectListingProvenance({ asin, marketplace: "US", jobId, fetchedAt: collected, operation: "product_content" }) };
  const preload = path.join(dir, "mock.mjs");
  fs.writeFileSync(preload, `globalThis.fetch=async(_url,init)=>{const body=JSON.parse(init.body);return Response.json({jsonrpc:'2.0',id:body.id,result:{content:[{type:'text',text:JSON.stringify({asin:'${asin}',main_image:['https://img.test/new.jpg'],a_plus:true})}]}});};`);
  for (const oldJob of [jobId, "older-job"]) {
    fs.writeFileSync(path.join(dir, "app/sorftime-listing-content-data.ts"), `export const sorftimeListingContentData = ${JSON.stringify({ [asin]: { ...record, provenance: { ...record.provenance, jobId: oldJob } } })};`);
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: dir, TMP: dir, AGENT_SYNC_JOB_ID: jobId, AGENT_SYNC_REPAIR_INCOMPLETE: "1", AGENT_SYNC_IMAGE_ACTION: "refresh", AGENT_CHILD_RESOURCE_GOVERNOR_REQUIRED: "0", SORFTIME_MCP_KEY: "fixture", SORFTIME_ASINS: asin, SORFTIME_MARKETPLACE: "US" };
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, path.join(dir, "scripts/build-sorftime-listing-content.mjs")], { cwd: dir, encoding: "utf8", env, timeout: 20_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const next = readCachedDataExport(path.join(dir, "app/sorftime-listing-content-data.ts"), "sorftimeListingContentData")[asin];
    assert.deepEqual(next.galleryImages, ["https://img.test/new.jpg"]);
    if (oldJob === jobId) { assert.deepEqual(next.specifications, record.specifications); assert.equal(next.specificationsProvenance.fetchedAt, collected); }
    else { assert.equal(next.specifications, undefined); assert.equal(next.specificationsProvenance, undefined); }
  }
});
