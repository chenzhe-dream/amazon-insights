export function parseImageList(raw) {
  if (Array.isArray(raw)) {
    return raw.map(item => String(item ?? "").trim()).filter(Boolean);
  }
  if (typeof raw !== "string" || !raw.trim()) return [];
  const value = raw.trim();
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map(item => String(item ?? "").trim()).filter(Boolean);
    }
  } catch {
    return /^https?:\/\//i.test(value) ? [value] : [];
  }
  return [];
}
