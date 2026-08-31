import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getProjectRoot } from "./project-root.mjs";
import { isProjectSlug, marketplaceSlug, projectSlugBase, uniqueSlug } from "./project-slug.mjs";

const root = getProjectRoot();
export const projectsDir = path.join(root, "data", "projects");

export const PROJECT_KINDS = ["analysis", "keyword-compare", "traffic-promo", "checklist"];

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

function normalizeKind(value) {
  const kind = String(value ?? "analysis").trim();
  return PROJECT_KINDS.includes(kind) ? kind : "analysis";
}

function normalizeProject(raw) {
  if (!raw || typeof raw !== "object") return null;
  const slug = String(raw.slug ?? "").trim().toLowerCase();
  return {
    ...raw,
    kind: normalizeKind(raw.kind),
    slug: isProjectSlug(slug) ? slug : null,
    majorCategory: String(raw.majorCategory ?? "").trim() || null,
    categoryLabel: String(raw.categoryLabel ?? "").trim() || null,
  };
}

function readProjectFiles() {
  ensureProjectsDir();
  const files = fs.readdirSync(projectsDir).filter(name => name.endsWith(".json"));
  return files
    .map(name => {
      try {
        return normalizeProject(JSON.parse(fs.readFileSync(path.join(projectsDir, name), "utf8")));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function usedSlugs(exceptId) {
  return new Set(readProjectFiles().filter(item => item.id !== exceptId && item.slug).map(item => item.slug));
}

function ensureProjectSlug(project) {
  if (!project) return null;
  if (isProjectSlug(project.slug)) return project;
  project.slug = uniqueSlug(projectSlugBase(project), usedSlugs(project.id));
  return writeProject(project);
}

export function listProjects(options = {}) {
  const kindFilter = options.kind ? normalizeKind(options.kind) : null;
  return readProjectFiles()
    .map(ensureProjectSlug)
    .filter(project => (kindFilter ? project.kind === kindFilter : true))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export function readProjectReadonly(projectId) {
  const id = String(projectId ?? "").trim();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) {
    return null;
  }
  const file = projectFilePath(id);
  if (!fs.existsSync(file)) return null;
  try {
    return normalizeProject(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

export function readProject(idOrSlug) {
  const key = String(idOrSlug ?? "").trim();
  if (!key) return null;
  if (/^[a-f0-9-]{36}$/i.test(key)) {
    const file = projectFilePath(key);
    if (!fs.existsSync(file)) return null;
    try {
      return ensureProjectSlug(normalizeProject(JSON.parse(fs.readFileSync(file, "utf8"))));
    } catch {
      return null;
    }
  }
  if (!isProjectSlug(key)) return null;
  const listed = listProjects();
  const exact = listed.find(project => project.slug === key);
  if (exact) return exact;
  return (
    listed.find(
      project =>
        project.kind === "analysis" && project.slug === `${key}-${marketplaceSlug(project.marketplace)}`,
    ) ?? null
  );
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
  const kind = normalizeKind(input.kind);
  const requestedSlug = String(input.slug ?? "").trim().toLowerCase();
  const slug = uniqueSlug(
    isProjectSlug(requestedSlug)
      ? requestedSlug
      : projectSlugBase({
          kind,
          name,
          categoryLabel: input.categoryLabel,
          marketplace: input.marketplace,
          alias: input.alias,
        }),
    usedSlugs(),
  );
  const project = {
    id: randomUUID(),
    kind,
    slug,
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

  if (patch.kind != null) {
    existing.kind = normalizeKind(patch.kind);
  }
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
