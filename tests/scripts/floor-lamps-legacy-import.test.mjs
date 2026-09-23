import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { planFloorLampsLegacyImport } from "../../scripts/lib/floor-lamps-legacy-import.mjs";

const projectId = "0e241789-648d-4f06-a897-6cab3ddb6e62";
const organizationId = "22222222-2222-4222-8222-222222222222";
const ownerUserId = "ee45b324-9052-4554-8ef6-fccf856a21a3";
const boundAt = "2026-09-10T05:41:13.000Z";
const asins = ["B08Z36X6B4", "B0D77D5WKD", "B0BVFX154J", "B09F9B3BCY", "B01NBPHPYF", "B0FSS6C79Z"];

function fixture() {
  const projectBytes = Buffer.from(JSON.stringify({
    id: projectId, slug: "floor-lamps-us", kind: "analysis", name: "层架灯",
    majorCategory: "Tools & Home Improvement", categoryLabel: "Floor Lamps",
    marketplace: "US", asins, note: null, createdBy: "IVANYAO",
    createdAt: "2026-08-13T07:20:17.072Z", updatedAt: "2026-08-13T07:20:17.072Z",
  }));
  const sha256 = createHash("sha256").update(projectBytes).digest("hex");
  return {
    projectBytes,
    backupBytes: Buffer.from(projectBytes),
    preSwitchManifest: { gitHead: "a6a2bc44ab52c4fd3a1676a3ea457eeaab13d8f0", entries: [{
      category: "live-data-projects", sourcePath: `C:/old/data/projects/${projectId}.json`,
      backupPath: `C:/backup/live-data/projects/${projectId}.json`, sha256,
      bytes: projectBytes.length,
    }] },
    bindingManifest: { organizationId, ownerUserId, boundAt, projects: [[projectId, sha256]] },
    binding: { legacyProjectId: projectId, organizationId, ownerUserId, operatorUserId: ownerUserId, boundAt },
    owner: { id: ownerUserId, organizationId, status: "active" },
    databaseCounts: { projects: 0, analysisRuns: 0, syncJobs: 0, displayVersions: 0 },
  };
}

test("verified historical project plans metadata and explicit gaps without a report or writes", () => {
  const input = fixture();
  const preview = planFloorLampsLegacyImport(input);
  assert.equal(preview.mode, "dry-run");
  assert.equal(preview.plannedWrites, 0);
  assert.equal(preview.reportBodyIncluded, false);
  assert.equal(preview.source.projectSha256, input.preSwitchManifest.entries[0].sha256);
  assert.equal(preview.authority.ownerUserId, ownerUserId);
  assert.equal(preview.metadata.createdBy, "IVANYAO");
  assert.deepEqual(preview.metadata.asins, asins);
  assert.equal(preview.gaps.fullReport.status, "unverified");
  assert.equal(preview.gaps.imageRemarks.status, "unverified");
});

test("dry run rejects modified source or mismatched provenance manifests", () => {
  const input = fixture();
  assert.throws(() => planFloorLampsLegacyImport({ ...input, projectBytes: Buffer.from(`${input.projectBytes} `) }), /source hash/i);
  assert.throws(() => planFloorLampsLegacyImport({ ...input, backupBytes: Buffer.from(`${input.backupBytes} `) }), /backup hash/i);
  assert.throws(() => planFloorLampsLegacyImport({ ...input, bindingManifest: { ...input.bindingManifest, projects: [[projectId, "0".repeat(64)]] } }), /binding manifest/i);
});

test("dry run rejects missing or foreign ownership and existing canonical data", () => {
  const input = fixture();
  assert.throws(() => planFloorLampsLegacyImport({ ...input, binding: null }), /binding/i);
  assert.throws(() => planFloorLampsLegacyImport({ ...input, binding: { ...input.binding, ownerUserId: "someone-else" } }), /binding/i);
  assert.throws(() => planFloorLampsLegacyImport({ ...input, owner: { ...input.owner, status: "disabled" } }), /active/i);
  assert.throws(() => planFloorLampsLegacyImport({ ...input, databaseCounts: { ...input.databaseCounts, syncJobs: 1 } }), /existing canonical data/i);
});
