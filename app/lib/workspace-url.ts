export function projectWorkspacePath(slug?: string | null) {
  const value = String(slug ?? "").trim();
  return value ? `/p/${encodeURIComponent(value)}` : "/";
}

export function workspaceHref(
  slug: string | null | undefined,
  params: URLSearchParams | { toString(): string },
) {
  const query = params.toString();
  const path = projectWorkspacePath(slug);
  return query ? `${path}?${query}` : path;
}
