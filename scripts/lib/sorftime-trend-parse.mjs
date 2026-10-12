/** Parse Sorftime product_trend response: "2024年08月=4084,2024年09月=3322,..." */
function normalizeTrendParts(raw) {
  const value = typeof raw === "string" ? raw : raw?.data ?? raw?.content ?? raw;
  if (Array.isArray(value)) return value.map(item => String(item).trim());
  if (typeof value !== "string" || !value.trim()) return [];
  return value.split(",").map(part => part.trim());
}

export function parseSorftimeTrend(raw, options = {}) {
  if (isCurrentProductTrend(raw)) return parseSorftimeProductTrend(raw, options).monthly;
  return normalizeTrendParts(raw).map(parseTrendPart).filter(Boolean);
}

function isCurrentProductTrend(raw) {
  const value = raw?.data ?? raw?.content ?? raw;
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** Current product_trend observations retain their supplied calendar period. */
export function parseSorftimeProductTrend(raw, { asin, type } = {}) {
  if (!isCurrentProductTrend(raw)) {
    const monthly = parseSorftimeTrend(raw);
    return { period: monthly.length ? 'month' : null, monthly, daily: [] };
  }
  const value = raw?.data ?? raw;
  if (typeof value.asin !== 'string' || (asin && value.asin !== asin) ||
      typeof value.type !== 'string' || (type && value.type !== type) ||
      !Array.isArray(value.data) || value.data.length % 2 !== 0) {
    throw new Error('Invalid Sorftime trend identity or observation pairs');
  }
  let period = null;
  const points = new Map();
  for (let i = 0; i < value.data.length; i += 2) {
    const stamp = value.data[i];
    const amount = value.data[i + 1];
    if (!Number.isSafeInteger(stamp) || typeof amount !== 'number' ||
        !Number.isFinite(amount) || amount < -1 || (amount < 0 && amount !== -1)) {
      throw new Error('Invalid Sorftime trend observation');
    }
    const text = String(stamp);
    if (!/^\d{6}(?:\d{2})?$/.test(text)) throw new Error('Invalid Sorftime trend date');
    const nextPeriod = text.length === 8 ? 'day' : 'month';
    if (period && period !== nextPeriod) throw new Error('Mixed Sorftime trend periods');
    period = nextPeriod;
    const year = Number(text.slice(0, 4));
    const month = Number(text.slice(4, 6));
    const day = nextPeriod === 'day' ? Number(text.slice(6)) : 1;
    const date = new Date(Date.UTC(year, month - 1, day));
    if (year < 1000 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
      throw new Error('Invalid Sorftime trend calendar date');
    }
    const label = `${text.slice(0, 4)}-${text.slice(4, 6)}${nextPeriod === 'day' ? '-'+text.slice(6) : ''}`;
    if (points.has(label) && points.get(label) !== amount) throw new Error('Conflicting Sorftime trend observations');
    points.set(label, amount);
  }
  const observations = [...points].sort(([a], [b]) => a.localeCompare(b)).filter(([, amount]) => amount !== -1);
  return {
    period,
    monthly: period === 'month' ? observations.map(([month, value]) => ({ month, value })) : [],
    daily: period === 'day' ? observations.map(([date, value]) => ({ date, value })) : [],
  };
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
