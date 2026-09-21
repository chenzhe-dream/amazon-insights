import type { AnalysisProject } from "../../app/lib/project-server";
import { projectTimeValues, type ProjectTimeSort } from "../../shared/project-library-time";
import { amazonMajorCategoryLabel, normalizeAmazonMajorCategory } from "../../app/amazon-major-categories";

export function queryProjectLibrary(projects: AnalysisProject[], query: {
  page?: number; pageSize?: number; search?: string; category?: string; view?: "history" | "favorites";
  sort?: ProjectTimeSort;
}, favoriteIds: string[]) {
  const favorites = new Set(favoriteIds);
  const category = (project: AnalysisProject) => normalizeAmazonMajorCategory(project.majorCategory) ?? project.majorCategory;
  const scoped = query.view === "favorites" ? projects.filter(project => favorites.has(project.id)) : projects;
  const tokens = (query.search ?? "").trim().toLowerCase().split(/[\s,，、/|]+/).filter(Boolean);
  const matches = scoped.filter(project => {
    const major = category(project);
    if (query.category === "__none__" ? Boolean(major) : query.category && query.category !== "all" && major !== query.category) return false;
    const haystack = [project.name, project.slug, major, major ? amazonMajorCategoryLabel(major) : "",
      project.categoryLabel, project.createdBy, project.latestAnalystName, project.note, project.marketplace, ...project.asins].join(" ").toLowerCase();
    return tokens.every(token => haystack.includes(token));
  }).sort((a, b) => {
    const sort = query.sort ?? "updated_desc";
    const key = sort.startsWith("created") ? "created" : "effectiveUpdated";
    const delta = projectTimeValues(a)[key] - projectTimeValues(b)[key];
    return (sort.endsWith("asc") ? delta : -delta) || a.id.localeCompare(b.id);
  });
  const pageSize = query.pageSize ?? 10;
  const totalPages = Math.max(1, Math.ceil(matches.length / pageSize));
  const page = Math.min(query.page ?? 1, totalPages);
  return {
    projects: matches.slice((page - 1) * pageSize, page * pageSize),
    pagination: { page, pageSize, total: matches.length, totalPages,
      historyTotal: projects.length, favoritesTotal: projects.filter(project => favorites.has(project.id)).length,
      categories: [...new Set(projects.map(category).filter((value): value is string => Boolean(value)))].sort() },
  };
}
