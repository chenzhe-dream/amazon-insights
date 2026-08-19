/** Parse Sorftime product_trend response: "2024年08月=4084,2024年09月=3322,..." */
function normalizeTrendParts(raw) {
  const value = typeof raw === "string" ? raw : raw?.data ?? raw?.content ?? raw;
  if (Array.isArray(value)) return value.map(item => String(item).trim());
  if (typeof value !== "string" || !value.trim()) return [];
  return value.split(",").map(part => part.trim());
}

export function parseSorftimeTrend(raw) {
  return normalizeTrendParts(raw).map(parseTrendPart).filter(Boolean);
}

/**
 * Parse Sorftime category_trend response.
 * Accepts `{ data: ["2024-08=127987", ...] }` or a comma-joined string.
 */
export function parseSorftimeCategoryTrend(raw) {
  return normalizeTrendParts(raw).map(parseTrendPart).filter(Boolean);
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
