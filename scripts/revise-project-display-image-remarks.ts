import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import { PostgresProjectDisplayVersionStore } from "../server/db/postgres/project-display-version-store";
import { PostgresQueryContext } from "../server/db/postgres/query-context";
import { ImageRemarkCandidateManifestSchema } from "../shared/image-remark-overlay";
import { readGeneratedExport } from "./lib/read-generated-image-source";

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function argsFrom(argv: readonly string[]) {
  const args = new Map<string, string>();
  let apply = false;
  const allowed = new Set(["--candidate", "--artifact", "--listing-source", "--expected-version-id",
    "--expected-manifest-sha256"]);
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--apply") { apply = true; continue; }
    if (!option || !allowed.has(option) || !argv[index + 1]) throw new Error(`Unknown or incomplete option: ${option}`);
    args.set(option, argv[++index]!);
  }
  for (const required of ["--candidate", "--artifact", "--expected-version-id"]) {
    if (!args.get(required)) throw new Error(`Missing ${required}`);
  }
  if (apply && !/^[a-f0-9]{64}$/.test(args.get("--expected-manifest-sha256") ?? "")) {
    throw new Error("--apply requires --expected-manifest-sha256 from a reviewed dry run");
  }
  return { apply, candidate: path.resolve(args.get("--candidate")!), artifact: path.resolve(args.get("--artifact")!),
    listingSource: args.get("--listing-source") ? path.resolve(args.get("--listing-source")!) : null,
    expectedVersionId: args.get("--expected-version-id")!, expectedManifestSha256: args.get("--expected-manifest-sha256") };
}

/** Default execution performs only SELECTs. Application requires an explicit flag and reviewed manifest hash. */
export async function reviseProjectDisplayImageRemarks(argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env, existingPool?: Pool) {
  const input = argsFrom(argv);
  const candidateBytes = await readFile(input.candidate);
  const manifestSha256 = sha256(candidateBytes);
  if (input.expectedManifestSha256 && manifestSha256 !== input.expectedManifestSha256) {
    throw new Error("Candidate manifest SHA256 changed since preview");
  }
  const manifest = ImageRemarkCandidateManifestSchema.parse(JSON.parse(candidateBytes.toString("utf8")));
  const artifactBytes = await readFile(input.artifact);
  const artifactSha256 = sha256(artifactBytes);
  if (artifactSha256 !== manifest.sourceArtifactSha256) throw new Error("Source artifact SHA256 mismatch");
  const sourceRemarks = readGeneratedExport(artifactBytes.toString("utf8"), "listingImageRemarks");
  const sourceMeta = readGeneratedExport(artifactBytes.toString("utf8"), "listingImageRemarksMeta");
  for (const slot of manifest.slots) {
    const notes = sourceRemarks[slot.asin];
    const note = Array.isArray(notes) ? notes[slot.index] as Record<string, unknown> | null : null;
    const sourceTypes = note?.image_types;
    const sourceUrls = (sourceMeta.imageUrlsByAsin as Record<string, unknown> | undefined)?.[slot.asin];
    const urlFromSource = Array.isArray(sourceUrls) ? sourceUrls[slot.index] : undefined;
    if (note?.remark !== slot.remark || note?.confidence !== slot.confidence ||
        !Array.isArray(sourceTypes) || JSON.stringify(sourceTypes) !== JSON.stringify(slot.imageTypes) ||
        (note.imageUrl !== undefined && note.imageUrl !== slot.imageUrl) ||
        (urlFromSource !== undefined && urlFromSource !== slot.imageUrl)) {
      throw new Error(`Source artifact does not attest image remark ${slot.asin}:${slot.index}`);
    }
    if (manifest.sourceKind === "supplemental-analysis" && note.imageUrl === undefined &&
        urlFromSource === undefined && manifest.sourceUrlBinding !== "persisted-listing-index") {
      throw new Error(`Supplemental source lacks URL binding for ${slot.asin}:${slot.index}`);
    }
  }
  if (manifest.sourceKind === "historical-generated-file") {
    const listingBytes = input.listingSource ? await readFile(input.listingSource) : null;
    if (!input.listingSource || !manifest.sourceListingSha256 ||
        !listingBytes || sha256(listingBytes) !== manifest.sourceListingSha256) {
      throw new Error("Historical source gallery file SHA256 mismatch");
    }
    const sourceListing = readGeneratedExport(listingBytes.toString("utf8"), "sorftimeListingContentData");
    for (const slot of manifest.slots) {
      const oldGallery = (sourceListing[slot.asin] as { galleryImages?: unknown } | undefined)?.galleryImages;
      if (!Array.isArray(oldGallery) || oldGallery[slot.index] !== slot.imageUrl ||
          manifest.sourceGalleryByAsin?.[slot.asin]?.[slot.index] !== slot.imageUrl) {
        throw new Error(`Historical source files do not attest image slot ${slot.asin}:${slot.index}`);
      }
    }
  }
  if (!environment.AGENT_DATABASE_URL && !existingPool) throw new Error("AGENT_DATABASE_URL is required");
  const pool = existingPool ?? new Pool({ connectionString: environment.AGENT_DATABASE_URL,
    max: 1, connectionTimeoutMillis: 5000,
    ...(!input.apply ? { options: "-c default_transaction_read_only=on -c statement_timeout=10000" } : {}) });
  try {
    const store = new PostgresProjectDisplayVersionStore(new PostgresQueryContext(pool));
    const request = { organizationId: manifest.organizationId, projectId: manifest.projectId,
      expectedCurrentVersionId: input.expectedVersionId, manifest,
      sourceRef: path.basename(input.artifact), sourceManifestSha256: manifestSha256 };
    const preview = await store.previewImageRemarkRevision(request);
    const summary = { mode: input.apply ? "applied" : "dry-run", projectId: manifest.projectId,
      expectedVersionId: input.expectedVersionId, currentVersionId: preview.currentVersionId,
      sourceKind: manifest.sourceKind, capturedAt: manifest.capturedAt,
      manifestSha256, artifactSha256, listingStageContentHash: manifest.listingStageContentHash,
      addedSlots: preview.addedSlots, totalOverlaySlots: preview.totalOverlaySlots,
      staticReady: manifest.staticReady, videoThumbnails: manifest.videoThumbnails,
      asins: manifest.asins, evidence: preview.evidence };
    if (!input.apply) return summary;
    const revised = await store.reviseCurrentImageRemarks(request);
    return { ...summary, versionId: revised.versionId, contentHash: revised.contentHash };
  } finally {
    if (!existingPool) await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  reviseProjectDisplayImageRemarks(process.argv.slice(2))
    .then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
