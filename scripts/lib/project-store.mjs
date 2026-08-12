import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const root = path.resolve(import.meta.dirname, "../..");
export const projectsDir = path.join(root, "data", "projects");

export function ensureProjectsDir() {
  fs.mkdirSync(projectsDir, { recursive: true });
}

function projectFilePath(id) {
  return path.join(projectsDir, `${id}.json`);
}

function isValidAsin(value) {
  return /^[A-Z0-9]{10}$/.test(value);
}

export function normalizeProjectAsins(values) {
  if (!Array.isArray(values)) return null;
  const asins = values.map(item => String(item).trim().toUpperCase()).filter(Boolean);
  if (asins.length < 3 || asins.length > 10) return null;
  if (asins.some(asin => !isValidAsin(asin))) return null;
  if (new Set(asins).size !== asins.length) return null;
  return asins;
}

function normalizeProject(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    ...raw,
    majorCategory: String(raw.majorCategory ?? "").trim() || null,
    categoryLabel: String(raw.categoryLabel ?? "").trim() || null,
  };
}

export function listProjects() {
  ensureProjectsDir();
  const files = fs.readdirSync(projectsDir).filter(name => name.endsWith(".json"));
  const projects = files
    .map(name => {
      try {
        return normalizeProject(JSON.parse(fs.readFileSync(path.join(projectsDir, name), "utf8")));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return projects.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export function readProject(id) {
  if (!id || !/^[a-f0-9-]{36}$/i.test(id)) return null;
  const file = projectFilePath(id);
  if (!fs.existsSync(file)) return null;
  try {
    return normalizeProject(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

export function writeProject(project) {
  ensureProjectsDir();
  project.updatedAt = new Date().toISOString();
  fs.writeFileSync(projectFilePath(project.id), JSON.stringify(project, null, 2), "utf8");
  return project;
}

export function createProject(input) {
  const asins = normalizeProjectAsins(input.asins);
  if (!asins) throw new Error("asins must be 3–10 unique 10-char codes");

  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("name is required");

  const now = new Date().toISOString();
  const project = {
    id: randomUUID(),
    name,
    majorCategory: String(input.majorCategory ?? "").trim() || null,
    categoryLabel: String(input.categoryLabel ?? "").trim() || null,
    marketplace: String(input.marketplace ?? "US").trim().toUpperCase() || "US",
    asins,
    note: String(input.note ?? "").trim() || null,
    createdBy: String(input.createdBy ?? "").trim() || null,
    createdAt: now,
    updatedAt: now,
  };
  return writeProject(project);
}

export function updateProject(id, patch) {
  const existing = readProject(id);
  if (!existing) return null;

  if (patch.name != null) {
    const name = String(patch.name).trim();
    if (!name) throw new Error("name cannot be empty");
    existing.name = name;
  }
  if (patch.majorCategory !== undefined) {
    existing.majorCategory = String(patch.majorCategory ?? "").trim() || null;
  }
  if (patch.categoryLabel !== undefined) {
    existing.categoryLabel = String(patch.categoryLabel ?? "").trim() || null;
  }
  if (patch.marketplace != null) {
    existing.marketplace = String(patch.marketplace).trim().toUpperCase() || "US";
  }
  if (patch.note !== undefined) {
    existing.note = String(patch.note ?? "").trim() || null;
  }
  if (patch.createdBy !== undefined) {
    existing.createdBy = String(patch.createdBy ?? "").trim() || null;
  }
  if (patch.asins != null) {
    const asins = normalizeProjectAsins(patch.asins);
    if (!asins) throw new Error("asins must be 3–10 unique 10-char codes");
    existing.asins = asins;
  }

  return writeProject(existing);
}

export function deleteProject(id) {
  const file = projectFilePath(id);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}
