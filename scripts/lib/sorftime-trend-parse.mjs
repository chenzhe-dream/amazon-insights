/** Parse Sorftime product_trend response: "2024年08月=4084,2024年09月=3322,..." */
export function parseSorftimeTrend(raw) {
  const text = typeof raw === "string" ? raw : raw?.data ?? raw?.content ?? "";
  if (!text || typeof text !== "string") return [];

  return text
    .split(",")
    .map(part => parseTrendPart(part.trim()))
    .filter(Boolean);
}

/**
 * Parse Sorftime category_trend response.
 * Accepts `{ data: ["2024-08=127987", ...] }` or a comma-joined string.
 */
export function parseSorftimeCategoryTrend(raw) {
  if (Array.isArray(raw?.data)) {
    return raw.data.map(item => parseTrendPart(String(item).trim())).filter(Boolean);
  }
  if (Array.isArray(raw)) {
    return raw.map(item => parseTrendPart(String(item).trim())).filter(Boolean);
  }
  const text = typeof raw === "string" ? raw : raw?.data ?? raw?.content ?? "";
  if (!text || typeof text !== "string") return [];
  return text
    .split(",")
    .map(part => parseTrendPart(part.trim()))
    .filter(Boolean);
}

function parseTrendPart(part) {
  if (!part) return null;
  const [monthRaw, valueRaw] = part.split("=");
  if (!monthRaw || valueRaw == null) return null;

  const cnMatch = monthRaw.match(/(\d{4})年(\d{2})月/);
  const isoMatch = monthRaw.match(/^(\d{4})-(\d{2})$/);
  const match = cnMatch ?? isoMatch;
  if (!match) return null;

  const value = Number(valueRaw);
  if (!Number.isFinite(value) || value < 0) return null;
  return { month: `${match[1]}-${match[2]}`, value };
}
