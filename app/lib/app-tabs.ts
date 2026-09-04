export const appTabIds = [
  "overview",
  "overview-images",
  "voc",
  "launch",
  "voc-positioning",
  "definition",
  "checklist",
  "keywords",
  "keyword-insight",
  "traffic",
  "projects",
  "keyword-compare",
  "traffic-promo",
  "checklist-library",
] as const;

export type TabId = typeof appTabIds[number];

export function isAppTab(value: string | null): value is TabId {
  return typeof value === "string" && (appTabIds as readonly string[]).includes(value);
}

export function tabFromParam(value: string | null): TabId {
  if (value === "traffic-conclusion") return "traffic";
  return isAppTab(value) ? value : "overview";
}
