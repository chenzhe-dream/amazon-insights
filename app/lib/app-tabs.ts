export const appTabIds = [
  "market-overview",
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

export function buildAppTabHref(tabId: TabId, current: URLSearchParams | { toString(): string }, basePath = "/") {
  const params = new URLSearchParams(current.toString());
  if (tabId === "market-overview") {
    const independent = new URLSearchParams({ tab: tabId });
    const artifact = params.get("webArtifact");
    if (artifact) independent.set("webArtifact", artifact);
    return `/?${independent.toString()}`;
  }
  if (tabId === "overview") params.delete("tab");
  else params.set("tab", tabId);
  params.delete("sub");
  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}
