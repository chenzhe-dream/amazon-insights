export const PROJECT_TIME_SORT_OPTIONS = [
  { value: "updated_desc", label: "修改时间：倒序（最新在前）" },
  { value: "updated_asc", label: "修改时间：正序（最早在前）" },
  { value: "created_desc", label: "开始时间：倒序（最新在前）" },
  { value: "created_asc", label: "开始时间：正序（最早在前）" },
] as const;
export type ProjectTimeSort = typeof PROJECT_TIME_SORT_OPTIONS[number]["value"];

export function projectTimeValues(project: { createdAt: string; updatedAt?: string | null }) {
  const created = Date.parse(project.createdAt);
  const updated = project.updatedAt ? Date.parse(project.updatedAt) : NaN;
  const modified = Number.isFinite(updated) && updated > created ? updated : null;
  return { created, modified, effectiveUpdated: modified ?? created };
}
