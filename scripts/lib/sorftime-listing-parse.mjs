function normalizeImageList(items) {
  return items
    .map(item => String(item ?? "").trim())
    .filter(item => /^https?:\/\//i.test(item));
}

export function parseImageList(raw) {
  if (Array.isArray(raw)) {
    return normalizeImageList(raw);
  }
  if (typeof raw !== "string" || !raw.trim()) return [];
  const value = raw.trim();
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return normalizeImageList(parsed);
    }
  } catch {
    return normalizeImageList([value]);
  }
  return [];
}
