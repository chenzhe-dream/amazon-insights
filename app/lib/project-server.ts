export type AnalysisProject = {
  id: string;
  name: string;
  /** 大类目，便于按赛道筛选，如：Scooters / Outdoor Toys */
  majorCategory: string | null;
  categoryLabel: string | null;
  marketplace: string;
  asins: string[];
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

async function importStore() {
  return import("../../scripts/lib/project-store.mjs") as Promise<{
    listProjects: () => AnalysisProject[];
    readProject: (id: string) => AnalysisProject | null;
    createProject: (input: Record<string, unknown>) => AnalysisProject;
    updateProject: (id: string, patch: Record<string, unknown>) => AnalysisProject | null;
    deleteProject: (id: string) => boolean;
    normalizeProjectAsins: (values: unknown) => string[] | null;
  }>;
}

export async function fetchProjects() {
  const store = await importStore();
  return store.listProjects();
}

export async function fetchProject(id: string) {
  const store = await importStore();
  return store.readProject(id);
}

export async function createAnalysisProject(input: Record<string, unknown>) {
  const store = await importStore();
  return store.createProject(input);
}

export async function updateAnalysisProject(id: string, patch: Record<string, unknown>) {
  const store = await importStore();
  return store.updateProject(id, patch);
}

export async function deleteAnalysisProject(id: string) {
  const store = await importStore();
  return store.deleteProject(id);
}

export async function normalizeAsins(values: unknown) {
  const store = await importStore();
  return store.normalizeProjectAsins(values);
}
