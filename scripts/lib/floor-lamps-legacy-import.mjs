import { createHash } from "node:crypto";
import path from "node:path";

export const FLOOR_LAMPS_LEGACY_PROJECT_ID = "0e241789-648d-4f06-a897-6cab3ddb6e62";
export const FLOOR_LAMPS_ASINS = Object.freeze([
  "B08Z36X6B4", "B0D77D5WKD", "B0BVFX154J",
  "B09F9B3BCY", "B01NBPHPYF", "B0FSS6C79Z",
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireMatch(condition, message) {
  if (!condition) throw new Error(message);
}

/** A read-only plan. It never carries a report body or claims a completed sync. */
export function planFloorLampsLegacyImport(input) {
  const { projectBytes, backupBytes, preSwitchManifest, bindingManifest,
    binding, owner, databaseCounts } = input;
  const entry = preSwitchManifest?.entries?.find(item =>
    item.category === "live-data-projects"
    && path.basename(item.sourcePath ?? "") === `${FLOOR_LAMPS_LEGACY_PROJECT_ID}.json`
    && path.basename(item.backupPath ?? "") === `${FLOOR_LAMPS_LEGACY_PROJECT_ID}.json`);
  requireMatch(entry && /^[a-f0-9]{64}$/i.test(entry.sha256), "Pre-switch source manifest is missing");
  const sourceHash = sha256(projectBytes);
  requireMatch(sourceHash === entry.sha256 && projectBytes.length === entry.bytes,
    "Legacy project source hash does not match pre-switch manifest");
  requireMatch(sha256(backupBytes) === sourceHash, "Legacy project backup hash does not match source");
  requireMatch(bindingManifest?.projects?.some(([id, hash]) =>
    id === FLOOR_LAMPS_LEGACY_PROJECT_ID && hash === sourceHash),
    "Owner binding manifest does not match project source hash");

  const project = JSON.parse(projectBytes.toString("utf8"));
  requireMatch(project.id === FLOOR_LAMPS_LEGACY_PROJECT_ID
    && project.slug === "floor-lamps-us" && project.kind === "analysis"
    && project.marketplace === "US"
    && Array.isArray(project.asins)
    && project.asins.length === FLOOR_LAMPS_ASINS.length
    && project.asins.every((asin, index) => asin === FLOOR_LAMPS_ASINS[index]),
  "Legacy project scope does not match floor-lamps-us");
  requireMatch(typeof project.createdBy === "string" && project.createdBy.length > 0,
    "Legacy creator display label is missing");

  requireMatch(binding && binding.legacyProjectId === project.id
    && binding.organizationId === bindingManifest.organizationId
    && binding.ownerUserId === bindingManifest.ownerUserId
    && binding.boundAt === bindingManifest.boundAt,
  "Live owner binding does not match confirmed binding manifest");
  requireMatch(owner && owner.id === binding.ownerUserId
    && owner.organizationId === binding.organizationId && owner.status === "active",
  "Bound owner is not an active user in the bound organization");
  requireMatch(databaseCounts && ["projects", "analysisRuns", "syncJobs", "displayVersions"]
    .every(key => databaseCounts[key] === 0),
  "Existing canonical data requires a separate import review");

  const unavailable = {
    status: "unverified",
    reason: "No verified completed PostgreSQL run and scoped report source for this legacy project",
  };
  return {
    mode: "dry-run",
    plannedWrites: 0,
    reportBodyIncluded: false,
    source: {
      projectSha256: sourceHash,
      bytes: projectBytes.length,
      preSwitchGitHead: preSwitchManifest.gitHead,
      preSwitchBackupPath: entry.backupPath,
    },
    authority: {
      organizationId: binding.organizationId,
      ownerUserId: binding.ownerUserId,
      boundAt: binding.boundAt,
      source: "user-confirmed-legacy-owner-binding",
    },
    metadata: {
      id: project.id,
      slug: project.slug,
      kind: project.kind,
      name: project.name,
      majorCategory: project.majorCategory,
      categoryLabel: project.categoryLabel,
      marketplace: project.marketplace,
      asins: [...project.asins],
      note: project.note,
      createdBy: project.createdBy,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    },
    gaps: {
      fullReport: unavailable,
      catalog: unavailable,
      mainImage: unavailable,
      secondaryImages: unavailable,
      imageRemarks: unavailable,
      perAsin: project.asins.map(asin => ({ asin, status: "unverified", reason: unavailable.reason })),
    },
  };
}
