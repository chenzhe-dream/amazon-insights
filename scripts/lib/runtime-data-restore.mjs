import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const PROJECT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function projectJsonPaths(dataRoot) {
  const projectsRoot = path.join(dataRoot, "projects");
  let entries;
  try {
    entries = await readdir(projectsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(projectsRoot, entry.name))
    .sort();
}

async function inventoryProjects(dataRoot) {
  const projects = [];
  for (const sourcePath of await projectJsonPaths(dataRoot)) {
    const content = await readFile(sourcePath);
    let value;
    try {
      value = JSON.parse(content.toString("utf8"));
    } catch {
      continue;
    }
    const id = String(value?.id ?? "").trim();
    if (!PROJECT_ID.test(id)) continue;
    projects.push(Object.freeze({
      id,
      name: String(value.name ?? "").trim(),
      scope: JSON.stringify([
        String(value.marketplace ?? "").trim().toUpperCase(),
        ...(Array.isArray(value.asins) ? value.asins.map((asin) => String(asin).trim().toUpperCase()) : []),
      ]),
      sourcePath,
      sourceHash: sha256(content),
      value,
    }));
  }
  return projects;
}

function restoredContent(project, duplicateIds) {
  const value = duplicateIds.length === 0
    ? project.value
    : {
        ...project.value,
        runtimeRestore: {
          status: "duplicate-pending-review",
          sameScopeProjectIds: duplicateIds,
        },
      };
  return Buffer.from(JSON.stringify(value, null, 2), "utf8");
}

export async function planRuntimeRestore({ sourceRoot, destinationRoot, activeCount }) {
  if (activeCount !== 0) {
    throw new Error("Runtime restore requires active count to be 0");
  }
  const resolvedSourceRoot = path.resolve(sourceRoot);
  const resolvedDestinationRoot = path.resolve(destinationRoot);
  const sourceProjects = await inventoryProjects(resolvedSourceRoot);
  const destinationProjects = await inventoryProjects(resolvedDestinationRoot);
  const destinationById = new Map(destinationProjects.map((project) => [project.id, project]));
  const sourceIds = new Set(sourceProjects.map((project) => project.id));
  const destinationIds = new Set(destinationProjects.map((project) => project.id));
  const commonCount = [...sourceIds].filter((id) => destinationIds.has(id)).length;
  const sameScopeDifferentId = [];
  const conflicts = [];
  const missingProjects = [];

  for (const source of sourceProjects) {
    const existing = destinationById.get(source.id);
    if (existing) {
      if (existing.sourceHash !== source.sourceHash) {
        conflicts.push({ type: "same-id-different-content", sourceId: source.id });
      }
      continue;
    }
    const duplicateIds = destinationProjects
      .filter((candidate) => candidate.id !== source.id && candidate.scope === source.scope)
      .map((candidate) => candidate.id)
      .sort();
    if (duplicateIds.length > 0) {
      sameScopeDifferentId.push({
        sourceId: source.id,
        destinationIds: duplicateIds,
        action: "preserve-and-mark-duplicate",
      });
    }
    const sameNameIds = destinationProjects
      .filter((candidate) => candidate.id !== source.id && candidate.name === source.name && source.name !== "")
      .map((candidate) => candidate.id)
      .sort();
    if (sameNameIds.length > 0) {
      conflicts.push({ type: "same-name-different-id", sourceId: source.id, destinationIds: sameNameIds });
    }
    const content = restoredContent(source, duplicateIds);
    missingProjects.push(Object.freeze({
      id: source.id,
      sourcePath: source.sourcePath,
      destinationPath: path.join(resolvedDestinationRoot, "projects", `${source.id}.json`),
      sourceHash: source.sourceHash,
      outputHash: sha256(content),
      duplicateOf: duplicateIds,
    }));
  }

  return Object.freeze({
    sourceRoot: resolvedSourceRoot,
    destinationRoot: resolvedDestinationRoot,
    sourceCount: sourceIds.size,
    destinationCount: destinationIds.size,
    commonCount,
    unionCount: new Set([...sourceIds, ...destinationIds]).size,
    requiresActiveCount: 0,
    missingProjects: Object.freeze(missingProjects),
    sameScopeDifferentId: Object.freeze(sameScopeDifferentId),
    conflicts: Object.freeze(conflicts),
    copyPaths: Object.freeze(missingProjects.map((project) => project.destinationPath)),
  });
}

async function createProjectBackup(destinationRoot, backupRoot) {
  const resolvedBackupRoot = path.resolve(backupRoot);
  await mkdir(path.dirname(resolvedBackupRoot), { recursive: true });
  await mkdir(resolvedBackupRoot);
  const backupProjectsRoot = path.join(resolvedBackupRoot, "projects");
  await mkdir(backupProjectsRoot);
  const entries = [];
  for (const sourcePath of await projectJsonPaths(destinationRoot)) {
    const content = await readFile(sourcePath);
    const backupPath = path.join(backupProjectsRoot, path.basename(sourcePath));
    await writeFile(backupPath, content, { flag: "wx" });
    const copied = await readFile(backupPath);
    const hash = sha256(content);
    if (sha256(copied) !== hash) throw new Error("Project backup hash verification failed");
    entries.push({ sourcePath, backupPath, sha256: hash });
  }
  const manifestPath = path.join(resolvedBackupRoot, "backup-manifest.json");
  await writeFile(manifestPath, JSON.stringify({ destinationRoot, entries }, null, 2), { flag: "wx" });
  return Object.freeze({ manifestPath, entries: Object.freeze(entries) });
}

async function writeRollbackManifest(manifestPath, manifest, { exclusive = false } = {}) {
  await mkdir(path.dirname(manifestPath), { recursive: true });
  const serialized = JSON.stringify(manifest, null, 2);
  if (exclusive) {
    await writeFile(manifestPath, serialized, { flag: "wx" });
    return;
  }
  const temporaryPath = `${manifestPath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporaryPath, serialized, { flag: "wx" });
  await rename(temporaryPath, manifestPath);
}

export async function applyRuntimeRestore({ plan, backupRoot, rollbackManifestPath }) {
  if (plan?.requiresActiveCount !== 0) throw new Error("Invalid runtime restore plan");
  const backup = await createProjectBackup(plan.destinationRoot, backupRoot);
  const manifestPath = path.resolve(rollbackManifestPath);
  const manifest = {
    destinationRoot: plan.destinationRoot,
    backupManifestPath: backup.manifestPath,
    created: [],
  };
  await writeRollbackManifest(manifestPath, manifest, { exclusive: true });

  for (const entry of plan.missingProjects) {
    const sourceContent = await readFile(entry.sourcePath);
    if (sha256(sourceContent) !== entry.sourceHash) {
      throw new Error("Source project hash changed after planning");
    }
    const sourceValue = JSON.parse(sourceContent.toString("utf8"));
    const content = restoredContent({ value: sourceValue }, entry.duplicateOf);
    if (sha256(content) !== entry.outputHash) {
      throw new Error("Planned project content hash mismatch");
    }
    await mkdir(path.dirname(entry.destinationPath), { recursive: true });
    await writeFile(entry.destinationPath, content, { flag: "wx" });
    const copied = await readFile(entry.destinationPath);
    if (sha256(copied) !== entry.outputHash) {
      throw new Error("Restored project hash verification failed");
    }
    manifest.created.push({ path: entry.destinationPath, sha256: entry.outputHash });
    await writeRollbackManifest(manifestPath, manifest);
  }

  return Object.freeze({
    backupManifestPath: backup.manifestPath,
    rollbackManifestPath: manifestPath,
    created: Object.freeze(manifest.created),
  });
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export async function rollbackRuntimeRestore({ manifestPath }) {
  const manifest = JSON.parse(await readFile(path.resolve(manifestPath), "utf8"));
  const projectsRoot = path.join(path.resolve(manifest.destinationRoot), "projects");
  const removed = [];
  const skippedChanged = [];
  for (const entry of manifest.created ?? []) {
    const target = path.resolve(entry.path);
    if (!isWithin(projectsRoot, target)) throw new Error("Rollback manifest path is outside projects root");
    let content;
    try {
      content = await readFile(target);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (sha256(content) !== entry.sha256) {
      skippedChanged.push(target);
      continue;
    }
    await unlink(target);
    removed.push(target);
  }
  return Object.freeze({ removed: Object.freeze(removed), skippedChanged: Object.freeze(skippedChanged) });
}
