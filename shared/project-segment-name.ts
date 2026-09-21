/** Analysis project names also serve as the user-entered segment label. */
export function projectSegmentName(project: { name?: string | null; categoryLabel?: string | null; marketplace?: string | null }) {
  const name = project.name?.trim() ?? "";
  const category = project.categoryLabel?.trim();
  const marketplace = project.marketplace?.trim() || "US";
  if (!name || /^竞品分析(?:\s*·\s*[A-Z]{2})?$/.test(name)) return "";
  if (category && name === `${category} · ${marketplace}`) return "";
  return name;
}
