import { refreshedCatalog } from "../competitor-data";
import { inferAmazonMajorCategory, normalizeAmazonMajorCategory } from "../amazon-major-categories";

export type ProjectKind = "analysis" | "keyword-compare" | "traffic-promo" | "checklist";

export type AnalysisProject = {
  id: string;
  sourceProjectId?: string | null;
  kind: ProjectKind;
  slug?: string | null;
  name: string;
  /** Amazon BSR 大类，如 Sports & Outdoors */
  majorCategory: string | null;
  categoryLabel: string | null;
  marketplace: string;
  asins: string[];
  note: string | null;
  createdBy: string | null;
  latestAnalystName?: string | null;
  createdAt: string;
  updatedAt: string;
};

function catalogProductsForAsins(asins: string[]) {
  return asins
    .map(asin => refreshedCatalog.find(item => item.asin === asin))
    .filter((item): item is (typeof refreshedCatalog)[number] => Boolean(item));
}

function resolveMajorCategory(asins: string[], raw: unknown) {
  const fromCatalog = inferAmazonMajorCategory(catalogProductsForAsins(asins));
  if (fromCatalog) return fromCatalog;
  const fromInput = normalizeAmazonMajorCategory(typeof raw === "string" ? raw : "");
  if (fromInput) return fromInput;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function enrichProject(project: AnalysisProject | null): AnalysisProject | null {
  if (!project) return null;
  return {
    ...project,
    majorCategory: resolveMajorCategory(project.asins, project.majorCategory),
  };
}

async function importStore() {
  return import("../../scripts/lib/project-store.mjs") as Promise<{
    listProjects: (options?: { kind?: string }) => AnalysisProject[];
    readProject: (id: string) => AnalysisProject | null;
    createProject: (input: Record<string, unknown>) => AnalysisProject;
    updateProject: (id: string, patch: Record<string, unknown>, options?: { preserveUpdatedAt?: boolean }) => AnalysisProject | null;
    deleteProject: (id: string) => boolean;
    normalizeProjectAsins: (values: unknown) => string[] | null;
  }>;
}

export async function fetchProjects(options?: { kind?: ProjectKind }) {
  const store = await importStore();
  return store.listProjects(options).map(project => {
    const enriched = enrichProject(project)!;
    if (enriched.majorCategory && enriched.majorCategory !== project.majorCategory) {
      store.updateProject(project.id, { majorCategory: enriched.majorCategory }, { preserveUpdatedAt: true });
    }
    return enriched;
  });
}

export async function fetchProject(id: string) {
  const store = await importStore();
  return enrichProject(store.readProject(id));
}

export async function createAnalysisProject(input: Record<string, unknown>) {
  const store = await importStore();
  const asins = Array.isArray(input.asins) ? input.asins.map(item => String(item)) : [];
  const project = store.createProject({
    ...input,
    majorCategory: resolveMajorCategory(asins, input.majorCategory),
  });
  return enrichProject(project)!;
}

export async function updateAnalysisProject(id: string, patch: Record<string, unknown>) {
  const store = await importStore();
  const existing = store.readProject(id);
  if (!existing) return null;
  const asins = Array.isArray(patch.asins) ? patch.asins.map(item => String(item)) : existing.asins;
  const nextPatch =
    patch.majorCategory !== undefined || patch.asins != null
      ? {
          ...patch,
          majorCategory: resolveMajorCategory(
            asins,
            patch.majorCategory !== undefined ? patch.majorCategory : existing.majorCategory
          ),
        }
      : patch;
  return enrichProject(store.updateProject(id, nextPatch));
}

export async function deleteAnalysisProject(id: string) {
  const store = await importStore();
  return store.deleteProject(id);
}

export async function normalizeAsins(values: unknown) {
  const store = await importStore();
  return store.normalizeProjectAsins(values);
}
